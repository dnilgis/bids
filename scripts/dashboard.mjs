#!/usr/bin/env node
/* Bake index.html: what every elevator is posting, and whether we are still
 * reading it.
 *
 * WHAT THIS IS FOR. This repository exists to read elevators that are not in
 * the Barchart feed. That set only grows -- Emmert's own two join it the day
 * they cancel their website service -- so the page has to work at one source
 * and at forty without being rewritten in between.
 *
 * WHAT IT IS NOT FOR. The version this replaces spent most of its four
 * hundred lines drawing basis sparklines from four hundred commits of git
 * history. That is a trends calculator, it was the source of the worst bug
 * this page has had (x-coordinates at minus five hundred billion, rendered as
 * a flat dash rather than an error), and nobody asked for it. There is no
 * chart here and no history walk. Status and data, and nothing else.
 *
 * HOW IT GROWS. Every data/<name>.json is a source. Adding an elevator means
 * adding a poller that writes one; this file does not change. It reads what
 * it finds, shows what it can, and says plainly when a file is not something
 * it understands rather than guessing.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.DATA_DIR || "data";
const OUT = process.env.OUT_FILE || "index.html";

/* Both clocks, and what they mean. checkedAt is reader health; pricedAt is
   the age of the price itself and is not a fault. A board can sit unchanged
   all weekend and be perfectly correct on Monday. */
const HEARTBEAT_H = 6;      // the reader writes at least this often
const CONSUMER_MAX_H = 14;  // past this, the Emmert sites withdraw the price

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ABSOLUTE TIMES, NEVER RELATIVE. This page is baked and then sits there. A
   line reading "4 minutes ago" is a lie the moment it is written and gets
   worse all day; a timestamp stays true for ever. Ages are computed against
   the bake time and labelled as such. */
const CT = { timeZone: "America/Chicago" };
const stamp = (iso) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    ...CT, weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit",
  }).replace(",", "");
};
const hoursBetween = (a, b) => (a.getTime() - Date.parse(b)) / 36e5;
const span = (h) =>
  h < 1 ? `${Math.round(h * 60)} min`
  : h < 48 ? `${h.toFixed(1)} h`
  : `${Math.floor(h / 24)} d`;
const ago = (h) => (h < 0 ? span(-h) : span(h));
/* A clock ahead of ours is not "in the future before this page was made",
   which is what gluing "ago" to a fixed suffix produced. */
const relative = (h) =>
  h < 0 ? `${span(-h)} AHEAD of when this page was made`
        : `${span(h)} before this page was made`;

/* ---- reading one source ------------------------------------------------ */

/* Deliberately forgiving about shape and unforgiving about pretending. A
   file this does not understand is shown as unreadable, with its name, not
   skipped and not guessed at. Sources will arrive from platforms that are
   not Big River and not FarmCentric; the day one of them writes something
   unexpected, the page should say so. */
export function readSource(name, text, now) {
  const base = { id: name.replace(/\.json$/, ""), file: name };
  let j;
  try { j = JSON.parse(text); } catch (e) {
    return { ...base, state: "unreadable", why: "the file is not valid JSON", bids: null };
  }
  if (!j || typeof j !== "object")
    return { ...base, state: "unreadable", why: "the file is not an object", bids: null };

  const src = j.source ?? {};
  const title = src.name || src.location || base.id;
  const where = src.location && src.name ? src.location : null;
  const checkedAt = typeof j.checkedAt === "string" ? j.checkedAt : null;
  const pricedAt = typeof j.pricedAt === "string" ? j.pricedAt : (j.observed ?? null);
  const bids = Array.isArray(j.bids) ? j.bids : [];

  if (!checkedAt || !Number.isFinite(Date.parse(checkedAt)))
    return { ...base, title, where, state: "unreadable",
             why: "no readable checkedAt, so its age cannot be known", bids };

  const checkAge = hoursBetween(now, checkedAt);
  const priceAge = pricedAt && Number.isFinite(Date.parse(pricedAt))
    ? hoursBetween(now, pricedAt) : null;

  /* The order matters: a clock in the future is not fresh, it is broken, and
     it used to read as perpetually current because the subtraction went
     negative. */
  let state, why;
  /* ORDER MATTERS, AND IT IS NOT ARBITRARY.
     Reader health outranks what the source is posting, because everything
     the file says about the board is a claim about when it was last read. A
     source we have not reached for a day is COLD; saying "it is posting no
     rows" would be a statement about yesterday dressed up as one about now. */
  if (checkAge < -0.25) { state = "broken"; why = `its clock is ${ago(checkAge)} ahead of ours`; }
  else if (checkAge > CONSUMER_MAX_H) { state = "cold"; why = `last read ${ago(checkAge)} ago, past the ${CONSUMER_MAX_H}h any consumer will accept`; }
  else if (!bids.length) { state = "withdrawn"; why = "it is posting no rows"; }
  else if (j.status && j.status !== "ok") { state = "flagged"; why = `the reader marked it "${j.status}"`; }
  else if (checkAge > HEARTBEAT_H) { state = "late"; why = `last read ${ago(checkAge)} ago, past the ${HEARTBEAT_H}h heartbeat`; }
  else { state = "live"; why = null; }

  /* A quote we could not verify is published as null upstream. Counted, not
     hidden: it is the difference between a row we can vouch for and one we
     merely copied. */
  const unverified = bids.filter((b) => b.futuresPriceCents == null).length;

  return { ...base, title, where, state, why, checkedAt, pricedAt,
           checkAge, priceAge, bids, unverified,
           status: j.status ?? null, schema: j.schema ?? null };
}

/* ---- rendering --------------------------------------------------------- */

/* The reserved status palette. Every one of these ships with a word beside
   it -- the colour never carries the meaning on its own, which matters on a
   page somebody glances at, and matters more for the two steps that do not
   clear 3:1 against a light surface. */
const STATE = {
  live:       { word: "Live",        tone: "good" },
  late:       { word: "Late",        tone: "warning" },
  flagged:    { word: "Flagged",     tone: "warning" },
  cold:       { word: "Cold",        tone: "serious" },
  withdrawn:  { word: "No rows",     tone: "serious" },
  broken:     { word: "Clock wrong", tone: "critical" },
  unreadable: { word: "Unreadable",  tone: "critical" },
};

/* Their boards carry quarter cents, so 4.1125 must survive; 4.44 must not
   become $4.4400, which claims a precision nobody published. Written by
   trimming rather than by testing `n * 100 % 1`, because 4.44 * 100 is
   444.00000000000006 in binary floating point and that test says "fractional"
   — which is exactly how $4.4400 got onto the page. */
export function money(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const t = n.toFixed(4).replace(/0+$/, "");
  return "$" + (t.endsWith(".") ? t + "00" : /\.\d$/.test(t) ? t + "0" : t);
}
const basis = (n) => (typeof n === "number"
  ? (n < 0 ? "−" : n > 0 ? "+" : "") + Math.abs(n).toFixed(2) : "—");

function boardRows(s) {
  /* A source that could not be read has no rows at all, not an empty list.
     Guarded here rather than trusted upstream: this function is the last
     thing between a malformed file and a blank page, and the whole point of
     the unreadable state is that the page still renders and says so. */
  const rows = Array.isArray(s.bids) ? s.bids : [];
  if (!rows.length) return `<tr><td colspan="5" class="none">No rows posted.</td></tr>`;
  return rows.map((b) => `
        <tr><td class="mo">${esc(b.delivery ?? "—")}</td>
            <td class="r">${money(b.cash)}</td>
            <td class="r">${basis(b.basisDollars ?? b.basis)}</td>
            <td>${esc(b.futuresMonth ?? "—")}</td>
            <td class="r${b.futuresPriceCents == null ? " unver" : ""}">${
              b.futuresPriceCents == null
                ? '<span title="not verified against cash minus basis, so not published">—</span>'
                : money(b.futuresPriceCents / 100)}</td></tr>`).join("");
}

function card(s, now) {
  const st = STATE[s.state] ?? STATE.unreadable;
  const lead = Array.isArray(s.bids) ? s.bids[0] : null;
  return `
    <section class="src" data-state="${s.state}">
      <header>
        <div class="who">
          <h2>${esc(s.title ?? s.id)}</h2>
          ${s.where ? `<p class="where">${esc(s.where)}</p>` : ""}
        </div>
        <span class="pill t-${st.tone}"><span class="dot" aria-hidden="true"></span>${st.word}</span>
      </header>

      ${s.why ? `<p class="why">${esc(s.why)}</p>` : ""}

      <dl class="clocks">
        <div><dt>Last read</dt><dd>${s.checkedAt ? esc(stamp(s.checkedAt)) : "—"}
          ${s.checkAge != null ? `<span class="age">${relative(s.checkAge)}</span>` : ""}</dd></div>
        <div><dt>Price last moved</dt><dd>${s.pricedAt ? esc(stamp(s.pricedAt)) : "—"}
          ${s.priceAge != null ? `<span class="age">${relative(s.priceAge)}</span>` : ""}</dd></div>
        <div><dt>Rows</dt><dd>${Array.isArray(s.bids) ? s.bids.length : "—"}
          ${s.unverified ? `<span class="age">${s.unverified} without a verified quote</span>` : ""}</dd></div>
        <div><dt>Front month</dt><dd>${lead ? esc(lead.delivery ?? "—") + " " + money(lead.cash) : "—"}</dd></div>
      </dl>

      <table class="board">
        <thead><tr><th>Delivery</th><th class="r">Cash</th><th class="r">Basis</th>
                   <th>Contract</th><th class="r">Futures</th></tr></thead>
        <tbody>${boardRows(s)}</tbody>
      </table>
      <p class="file">${esc(s.file)}${s.schema ? " &middot; " + esc(s.schema) : ""}</p>
    </section>`;
}

export function render(sources, now) {
  const counted = Object.entries(
    sources.reduce((a, s) => ((a[s.state] = (a[s.state] || 0) + 1), a), {})
  ).sort((a, b) => b[1] - a[1]);

  /* Anything not live first. A page you glance at should put the thing that
     needs you at the top, and there is no other ordering that survives the
     list getting long. */
  const rank = { unreadable: 0, broken: 1, cold: 2, withdrawn: 3, flagged: 4, late: 5, live: 6 };
  const ordered = [...sources].sort((a, b) =>
    (rank[a.state] ?? 9) - (rank[b.state] ?? 9) ||
    String(a.title ?? a.id).localeCompare(String(b.title ?? b.id)));

  const tiles = counted.map(([state, n]) => {
    const st = STATE[state] ?? STATE.unreadable;
    return `<div class="tile t-${st.tone}"><span class="n">${n}</span>
      <span class="lbl"><span class="dot" aria-hidden="true"></span>${st.word}</span></div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en" data-palette="#0ca30c,#fab219,#ec835a,#d03b3b">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Bids — what we are reading</title>
<style>
:root{
  --ink:#16150f; --ink-2:#4a4740; --ink-3:#75716a;
  --surface:#fcfcfb; --card:#fff; --line:#e4e2dc; --line-2:#f0eee9;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --radius:10px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);
  font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:74rem;margin:0 auto;padding:2.2rem 1.2rem 4rem}
h1{font-size:1.5rem;margin:0 0 .2rem;letter-spacing:-.01em}
.sub{color:var(--ink-3);margin:0 0 1.6rem;font-size:.95rem}

/* The KPI row. Counts, not a chart: a bar chart of five integers is a table
   with extra steps. */
.tiles{display:flex;flex-wrap:wrap;gap:.7rem;margin:0 0 1.8rem}
.tile{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:.7rem 1rem;min-width:7.5rem}
.tile .n{display:block;font-size:1.9rem;font-weight:650;line-height:1.1;
  font-variant-numeric:tabular-nums}
.tile .lbl{display:flex;align-items:center;gap:.4rem;color:var(--ink-2);font-size:.85rem}

/* Status colour never travels alone: every dot has its word beside it. */
.dot{width:.55rem;height:.55rem;border-radius:50%;background:var(--ink-3);flex:none}
.t-good .dot{background:var(--good)} .t-warning .dot{background:var(--warning)}
.t-serious .dot{background:var(--serious)} .t-critical .dot{background:var(--critical)}

.src{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.1rem 1.2rem;margin:0 0 1rem}
.src[data-state="unreadable"],.src[data-state="broken"]{border-color:var(--critical)}
.src[data-state="cold"],.src[data-state="withdrawn"]{border-color:var(--serious)}
.src>header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}
.src h2{font-size:1.12rem;margin:0;letter-spacing:-.01em}
.where{margin:.1rem 0 0;color:var(--ink-3);font-size:.9rem}
.pill{display:inline-flex;align-items:center;gap:.45rem;white-space:nowrap;
  border:1px solid var(--line);border-radius:999px;padding:.22rem .7rem;
  font-size:.85rem;font-weight:600;color:var(--ink-2);background:var(--surface)}
.why{margin:.7rem 0 0;color:var(--ink-2);font-size:.92rem}

.clocks{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));
  gap:.9rem;margin:1rem 0 0;padding:0}
.clocks div{margin:0}
.clocks dt{color:var(--ink-3);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.clocks dd{margin:.15rem 0 0;font-variant-numeric:tabular-nums}
.age{display:block;color:var(--ink-3);font-size:.82rem;font-variant-numeric:tabular-nums}

.board{width:100%;border-collapse:collapse;margin:1.1rem 0 0;font-size:.94rem}
.board th{text-align:left;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;
  color:var(--ink-3);font-weight:600;padding:.4rem .55rem;border-bottom:1px solid var(--line)}
.board td{padding:.42rem .55rem;border-bottom:1px solid var(--line-2);
  font-variant-numeric:tabular-nums}
.board tr:last-child td{border-bottom:0}
.board .mo{font-weight:600}
.board .r{text-align:right}
.board .unver{color:var(--ink-3)}
.board .none{color:var(--ink-3);text-align:center;padding:1.1rem}
.file{margin:.9rem 0 0;color:var(--ink-3);font-size:.78rem;font-family:ui-monospace,monospace}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:var(--radius);
  padding:2rem;text-align:center;color:var(--ink-2)}
@media(max-width:640px){
  .src>header{flex-direction:column}
  .board{font-size:.88rem}
  .board th:nth-child(4),.board td:nth-child(4){display:none}
}
</style>
</head>
<body>
<div class="wrap">
  <h1>What we are reading</h1>
  <p class="sub">${sources.length} source${sources.length === 1 ? "" : "s"} &middot;
     page made ${esc(stamp(now.toISOString()))} Central</p>

  <div class="tiles">${tiles || ""}</div>

  ${sources.length ? ordered.map((s) => card(s, now)).join("") : `
  <div class="empty">No sources yet. Every <code>data/*.json</code> a poller writes
  appears here on its own; nothing needs adding to this page.</div>`}
</div>
</body>
</html>
`;
}

/* ---- what runs --------------------------------------------------------- */

export function collect(dir, now, fs = { readdirSync, readFileSync }) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readSource(f, fs.readFileSync(join(dir, f), "utf8"), now));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = new Date();
  const sources = collect(DATA, now);
  writeFileSync(OUT, render(sources, now));
  const by = sources.reduce((a, s) => ((a[s.state] = (a[s.state] || 0) + 1), a), {});
  console.log(`${OUT}: ${sources.length} source(s) — ` +
    Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", "));
  for (const s of sources.filter((x) => x.state !== "live"))
    console.log(`  ${s.state.toUpperCase().padEnd(11)} ${s.title ?? s.id}: ${s.why ?? ""}`);
}

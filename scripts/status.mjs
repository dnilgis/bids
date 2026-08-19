#!/usr/bin/env node
/**
 * THE STATUS BOARD — every source, one screen, 2 to 300.
 *
 * Supersedes scripts/dashboard.mjs the same way poll.mjs supersedes fetch.mjs:
 * both write index.html, so only ONE may be scheduled.
 *
 * THE PROBLEM THIS SOLVES
 * A row per elevator is readable at two and unreadable at two hundred. So the
 * page answers two questions in two different registers:
 *
 *   "is anything wrong, and how much?"   -> the tiles and the grid, at a glance
 *   "what exactly is wrong?"             -> the named list, only when non-empty
 *
 * The grid scales by shrinking tiles, not by growing the page. Nothing scrolls.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL. Every tile carries a glyph, every state has
 * a written label, and a full table sits underneath for screen readers and for
 * anyone who wants the numbers. Three states, because the status steps that
 * survive colour-blind separation are three: measured ΔE 11.3 worst-case under
 * protanopia and 27.6 in normal vision against this surface. A fourth step
 * (#ec835a) sits 13.6 from the amber in normal vision and was cut for it.
 *
 * NO RELATIVE TIMES. "2 hours ago" is a lie the moment the page is cached.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "data", "index.json");
const OUT = join(ROOT, "index.html");

/* Matches the consumers. A source read successfully but older than this is
   late; past withdrawal the consumers drop the price entirely. */
export const LATE_H = 6;        // the heartbeat: fresher than this is normal
export const WITHDRAW_H = 14;   // FEED_MAX_AGE_H downstream

/* A clock more than this far ahead of ours is not fresh, it is wrong. Runner
   clocks drift by seconds; a quarter of an hour is slack, not skew. */
export const MAX_SKEW_H = 0.25;

export function ageHours(iso, now) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 3.6e6 : Infinity;
}

/** live | late | down. Three, because three is what stays distinguishable. */
export function stateOf(s, now) {
  /* `health` ONLY. No fallback to `state`.
     The manifest's `state` is the US state ("WI"), and poll.mjs emits the read
     result as `health` with the place preserved as `usState`. A tolerant
     fallback here was written first and was UNFALSIFIABLE -- no US state
     equals a health word, so reverting it changed no behaviour and the test
     covering it could not fail. A guard whose mutation is a no-op is not a
     guard. Strict, so the contract is one field with one meaning. */
  const h = s.health;
  if (h === "broken" || h === "refused") {
    /* A refused source is not down until its last good price goes stale. Up to
       then the site is still serving a real number and the refusal is a
       warning; past withdrawal it is an outage. */
    return ageHours(s.checkedAt, now) >= WITHDRAW_H ? "down" : "late";
  }
  const age = ageHours(s.checkedAt, now);
  /* A CLOCK AHEAD OF OURS IS BROKEN, NOT FRESH.
     A negative age sails past every "older than" test and lands on "live" --
     the freshest possible verdict handed to the one file we have most reason
     to distrust. The old dashboard test asserted this and was deleted with the
     script it covered; status.mjs shipped without it. */
  if (age < -MAX_SKEW_H) return "down";
  if (age >= WITHDRAW_H) return "down";
  if (age >= LATE_H) return "late";
  return "live";
}

const GLYPH = { live: "✓", late: "!", down: "×" };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stamp = (iso) => (iso ? String(iso).replace("T", " ").replace(/\.\d+Z$/, "Z") : "never");

/** Tile size band. The page must not scroll, so density follows the count. */
export function density(n) {
  if (n <= 8) return { min: 215, label: "full" };
  if (n <= 40) return { min: 92, label: "compact" };
  if (n <= 120) return { min: 46, label: "dense" };
  return { min: 26, label: "micro" };
}

export function render(index, nowMs) {
  const sources = [...(index.sources ?? [])]
    .map((s) => ({ ...s, ui: stateOf(s, nowMs) }))
    /* Problems first. At three hundred tiles the eye should not have to hunt. */
    .sort((a, b) => (["down", "late", "live"].indexOf(a.ui) - ["down", "late", "live"].indexOf(b.ui))
      || String(a.id).localeCompare(String(b.id)));

  const n = sources.length;
  const c = { live: 0, late: 0, down: 0 };
  for (const s of sources) c[s.ui]++;
  const d = density(n);
  const problems = sources.filter((s) => s.ui !== "live");

  const tile = (s) => {
    const detail = [`${s.operator ?? ""} ${s.location ?? ""}`.trim(),
      `${s.rows ?? 0} rows`, `checked ${stamp(s.checkedAt)}`,
      `priced ${stamp(s.pricedAt)}`, s.error ? `ERROR ${s.error}` : ""]
      .filter(Boolean).join(" · ");
    /* At full density the tile carries the facts; past that there is no room
       for them and the tile is a status pixel, with the table underneath and
       the hover title holding the detail. */
    const body = d.label === "full"
      ? `<span class="th"><span class="g" aria-hidden="true">${GLYPH[s.ui]}</span>` +
        `<span class="tn">${esc(s.location ?? s.id)}</span></span>` +
        `<span class="to">${esc(s.operator ?? "")}</span>` +
        `<span class="tm">${s.rows ?? 0} rows · read ${stamp(s.checkedAt).slice(11, 16)}Z</span>`
      : `<span class="g" aria-hidden="true">${GLYPH[s.ui]}</span>` +
        `<span class="tn">${esc(s.location ?? s.id)}</span>`;
    return `<a class="t t-${s.ui}" href="#r-${esc(s.id)}" title="${esc(detail)}">${body}` +
      `<span class="sr">${esc(s.id)}: ${s.ui}</span></a>`;
  };

  const row = (s) => `<tr id="r-${esc(s.id)}"><td><span class="dot d-${s.ui}" aria-hidden="true"></span>${s.ui}</td>` +
    `<td>${esc(s.operator ?? "")}</td><td>${esc(s.location ?? "")}</td>` +
    `<td>${esc(s.health ?? "")}</td><td class="n">${s.rows ?? 0}</td>` +
    `<td class="m">${stamp(s.pricedAt)}</td><td class="m">${stamp(s.checkedAt)}</td>` +
    `<td>${esc(s.platform ?? "")}</td><td class="e">${esc(s.error ?? "")}</td></tr>`;

  /* A BOARD THAT READ NOTHING IS NOT A HEALTHY BOARD.
     With no sources the counters are all zero, which fell through to the green
     "ALL SOURCES LIVE" — so a manifest that failed to load, or every source
     disabled, rendered as an all-clear. Nothing read is its own state. */
  const verdict = n === 0 ? "down" : c.down ? "down" : c.late ? "late" : "live";
  const headline = n === 0 ? "NO SOURCES READ"
    : c.down ? `${c.down} DOWN` : c.late ? `${c.late} NEED A LOOK` : "ALL SOURCES LIVE";

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Bid sources — ${headline}</title>
<style>
  :root{--bg:#141613;--card:#1c1f1b;--line:#2c302a;--ink:#e9ece7;--dim:#9aa295;
        --live:#0ca30c;--late:#fab219;--down:#d03b3b;--mono:ui-monospace,"JetBrains Mono",Menlo,monospace}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;flex-direction:column;padding:14px;gap:12px;overflow:hidden}
  header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;flex:none}
  h1{font:600 15px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;margin:0;color:var(--dim)}
  .when{font:11px/1 var(--mono);color:var(--dim);margin-left:auto}
  .verdict{font:700 15px/1 var(--mono);letter-spacing:.06em}
  .verdict.live{color:var(--live)}.verdict.late{color:var(--late)}.verdict.down{color:var(--down)}
  .tiles{display:flex;gap:8px;flex:none;flex-wrap:wrap}
  .s{background:var(--card);border:1px solid var(--line);border-radius:10px;
     padding:8px 14px;min-width:104px}
  .s b{display:block;font:700 26px/1.1 var(--mono)}
  .s span{font:11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
  .s.live b{color:var(--live)}.s.late b{color:var(--late)}.s.down b{color:var(--down)}
  .attn{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--late);
        border-radius:8px;padding:8px 12px;flex:none;max-height:22vh;overflow:auto}
  .attn h2{font:700 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;
           color:var(--dim);margin:0 0 6px}
  .attn li{list-style:none;font:12px/1.5 var(--mono);display:flex;gap:8px}
  .attn ul{margin:0;padding:0}
  .attn .id{color:var(--ink);min-width:16em}
  .attn .msg{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* flex 0-1-auto and NOT 1-1-auto: a grid that grows reserves the whole
     viewport and then draws its tiles at the top, which is where the acre of
     empty space under three tiles came from. It shrinks when crowded, never
     grows. The spacer below takes the slack and the legend pins to the floor. */
  .grid{flex:0 1 auto;min-height:0;display:grid;gap:4px;align-content:start;overflow:auto;
        grid-template-columns:repeat(auto-fill,minmax(${d.min}px,1fr))}
  .spacer{flex:1 1 auto;min-height:0}
  .t{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;
     border-radius:6px;text-decoration:none;border:1px solid transparent;padding:8px}
  .th{display:flex;align-items:center;gap:7px}
  .to{font:11px/1.3 var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tm{font:11px/1.3 var(--mono);color:var(--dim);opacity:.8}
  .t-live{background:color-mix(in srgb,var(--live) 22%,var(--card));border-color:color-mix(in srgb,var(--live) 45%,transparent);color:var(--live)}
  .t-late{background:color-mix(in srgb,var(--late) 22%,var(--card));border-color:color-mix(in srgb,var(--late) 55%,transparent);color:var(--late)}
  .t-down{background:color-mix(in srgb,var(--down) 26%,var(--card));border-color:color-mix(in srgb,var(--down) 60%,transparent);color:var(--down)}
  .g{font:700 15px/1 var(--mono)}
  .tn{font:11px/1.2 var(--mono);color:var(--ink);opacity:.85;max-width:100%;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  ${d.label === "full"
      ? ".t{flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;min-height:74px}.g{font-size:14px}"
      : ".t{flex-direction:column;gap:2px;aspect-ratio:1;padding:2px}"}
  ${d.label === "dense" ? ".tn{display:none}.g{font-size:13px}" : ""}
  ${d.label === "micro" ? ".tn{display:none}.g{font-size:10px}.grid{gap:3px}" : ""}
  details{flex:0 1 auto;min-height:0;overflow:auto;border-top:1px solid var(--line);padding-top:8px}
  summary{font:11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);cursor:pointer}
  table{width:100%;border-collapse:collapse;margin-top:8px;font:12px/1.5 var(--mono)}
  th{text-align:left;color:var(--dim);font-weight:600;border-bottom:1px solid var(--line);padding:4px 8px 4px 0}
  td{padding:3px 8px 3px 0;border-bottom:1px solid var(--line);vertical-align:top}
  td.n{text-align:right}td.m{color:var(--dim)}td.e{color:var(--late);max-width:34ch}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .d-live{background:var(--live)}.d-late{background:var(--late)}.d-down{background:var(--down)}
  .legend{display:flex;gap:14px;font:11px/1 var(--mono);color:var(--dim);flex:none;align-items:center}
  .legend b{font-weight:700}
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  @media (max-width:640px){body{padding:10px;gap:9px}.s{min-width:78px;padding:6px 10px}.s b{font-size:20px}}
</style></head><body>
<header>
  <h1>Bid sources</h1>
  <span class="verdict ${verdict}">${esc(headline)}</span>
  <span class="when">read ${stamp(index.generated)}</span>
</header>

<div class="tiles">
  <div class="s ${c.live ? "live" : ""}"><b>${c.live}</b><span>Live</span></div>
  <div class="s ${c.late ? "late" : ""}"><b>${c.late}</b><span>Need a look</span></div>
  <div class="s ${c.down ? "down" : ""}"><b>${c.down}</b><span>Down</span></div>
  <div class="s"><b>${n}</b><span>Sources</span></div>
</div>

${n === 0 ? `<section class="attn" style="border-left-color:var(--down)"><h2>Nothing was read</h2>` +
  `<ul><li><span class="msg">data/index.json lists no sources. Either the manifest failed to load, ` +
  `or every source in sources/ is disabled. This is not an all-clear.</span></li></ul></section>` : ""}
${problems.length ? `<section class="attn"><h2>Needs attention</h2><ul>` +
  problems.map((s) => `<li><span class="g" aria-hidden="true">${GLYPH[s.ui]}</span>` +
    `<span class="id">${esc(s.id)}</span>` +
    `<span class="msg">${esc(s.error || `${s.state} · last read ${stamp(s.checkedAt)}`)}</span></li>`).join("") +
  `</ul></section>` : ""}

<main class="grid">${sources.map(tile).join("")}</main>

<details><summary>All ${n} sources as a table</summary>
<table><thead><tr><th>State</th><th>Operator</th><th>Location</th><th>Read</th>
<th>Rows</th><th>Priced at (UTC)</th><th>Checked at (UTC)</th><th>Platform</th><th>Note</th></tr></thead>
<tbody>${sources.map(row).join("")}</tbody></table></details>

<div class="spacer"></div>

<div class="legend">
  <span><b style="color:var(--live)">${GLYPH.live}</b> live — read inside ${LATE_H}h</span>
  <span><b style="color:var(--late)">${GLYPH.late}</b> needs a look — stale or refusing</span>
  <span><b style="color:var(--down)">${GLYPH.down}</b> down — past ${WITHDRAW_H}h, consumers have withdrawn</span>
</div>

</body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(INDEX)) { console.error(`FAILED: ${INDEX} not found. Run poll.mjs first.`); process.exit(1); }
  const index = JSON.parse(readFileSync(INDEX, "utf8"));
  writeFileSync(OUT, render(index, Date.now()));
  console.log(`status board -> ${OUT}  (${index.sources?.length ?? 0} sources)`);
}

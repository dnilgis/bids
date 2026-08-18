#!/usr/bin/env node
/**
 * Bake index.html — the Boyceville board dashboard — from data/boyceville.json
 * plus this repo's own git history.
 *
 *     node scripts/dashboard.mjs            write index.html
 *     node scripts/dashboard.mjs --check    verify only, exit 1 if stale
 *     node scripts/dashboard.mjs --out X    write somewhere else
 *
 * Run by .github/workflows/poll.yml, inside the same run that commits a price.
 * A push made with the Actions GITHUB_TOKEN cannot start another workflow, so a
 * dashboard.yml listening for data/boyceville.json would look like coverage and
 * provide none. dashboard.yml exists only for a manual rebake and for changes
 * to this file.
 *
 * IT MUST NEVER BLOCK THE COMMIT. poll.yml runs this behind an `if` for that
 * reason: a deterministic bake failure used to abort the step before the price
 * was committed, and since the fault repeats, every later poll failed the same
 * way until both Emmert sites dropped their price. Over a chart.
 *
 *
 * WHY THE HISTORY COMES FROM GIT AND NOT FROM A FILE
 *
 * The repo's whole doctrine is that the git history of data/boyceville.json IS
 * the price record. A separate history.json would be a second copy of the same
 * facts that could disagree with the first. `git log` already has it. This is
 * why poll.yml deepens the clone before baking — on the shallow checkout
 * actions/checkout gives you by default, this would build a chart from one
 * commit and would not complain.
 *
 *
 * NO JAVASCRIPT, NO OUTSIDE REQUESTS, NO WEB FONTS.
 *
 * Everything is inlined and the chart is server-rendered SVG. Partly house
 * style, partly because a dashboard that needs a CDN to tell you whether your
 * price feed is alive has a second thing that can be dead.
 *
 *
 * NO RELATIVE TIMES. THIS IS THE IMPORTANT ONE.
 *
 * A static page cannot say "checked 2 hours ago" — it would say it forever,
 * and it would be a lie within minutes of the bake. Worse, it would be a
 * REASSURING lie on exactly the page you would open to find out whether the
 * reader had died.
 *
 * So every time here is absolute, and the freshness section is expressed as a
 * DEADLINE rather than an age: "the Emmert sites stop publishing this price
 * after <timestamp>". A deadline printed once stays true. The reader compares
 * it against their own clock, which is the one thing a static page can rely on
 * being current.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "boyceville.json");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const OUT = args.includes("--out")
  ? resolve(args[args.indexOf("--out") + 1])
  : join(ROOT, "index.html");

/* How far back the chart looks. A cap, not a policy: at a few price changes a
   day this is months of board. */
const MAX_COMMITS = 400;

/* Must match lib/decide.mjs. If the heartbeat is retuned there and not here,
   this page reports gaps that are not gaps. */
const HEARTBEAT_H = 6;
/* Must match the Emmert Worker's FEED_MAX_AGE_H. This is the number that
   decides whether badgergrain.com and midwestcommodity.com keep showing a
   price or fall back to "Call for today's price". */
const FEED_MAX_AGE_H = 14;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
           .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6 });

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

export function seriesFrom(commits) {
  return buildSeries(commits);
}

function history() {
  let log;
  try {
    log = git("log", `-${MAX_COMMITS}`, "--format=%H\t%aI\t%s", "--", "data/boyceville.json");
  } catch {
    return { points: [], commits: [], shallow: true };
  }
  const rows = log.trim().split("\n").filter(Boolean).map((l) => {
    const [sha, when, ...rest] = l.split("\t");
    return { sha, when, subject: rest.join("\t") };
  });

  const commits = [];
  for (const r of rows) {
    let doc = null;
    try { doc = JSON.parse(git("show", `${r.sha}:data/boyceville.json`)); } catch { continue; }
    commits.push({ ...r, doc });
  }
  commits.reverse();                                    // oldest first

  /* One series per delivery month, keyed by the label THEY use. A month only
     appears while it is on their board, so series start and end at different
     times.
     
     X IS pricedAt, AND THAT IS WHY THIS IS A MAP AND NOT A PUSH.
     
     pricedAt is when the board last showed something different, so a heartbeat
     commit carries an OLD pricedAt on purpose. Appending one point per commit
     in commit order therefore walks x BACKWARDS every time a heartbeat lands,
     and adjacent-only dedupe does not catch it because the repeat is not
     adjacent. The first cut of this file did exactly that and produced x
     coordinates around -518,000,000,000. It did not throw; SVG happily drew a
     path far off-canvas and the panel rendered as a small dash that looked
     like a flat market.
     
     Keying on the timestamp collapses every repeat of a price to one point
     wherever it appears in the log, and the explicit sort means the line is
     drawn in time order rather than in commit order. */
  /* "One commit so far" and "the clone was truncated" are different facts and
     used to share a flag, so the very first index.html ever baked told you the
     history was truncated and to set fetch-depth: 0 -- on a clone the workflow
     had just deepened. Only claim truncation when we hit the cap. */
  return { ...buildSeries(commits), commits, shallow: commits.length >= MAX_COMMITS };
}

/* Split out so the tests can drive it with a hand-built commit list. The bug
   it exists to prevent shipped once and was invisible on the rendered page. */
export function buildSeries(commits) {
  const byMonth = new Map();
  for (const c of commits) {
    const t = Date.parse(c.doc.pricedAt ?? c.doc.checkedAt ?? c.when);
    if (!Number.isFinite(t)) continue;
    for (const b of c.doc.bids ?? []) {
      if (b.basisDollars == null) continue;
      if (!byMonth.has(b.delivery)) byMonth.set(b.delivery, new Map());
      byMonth.get(b.delivery).set(t, b.basisDollars);
    }
  }
  const series = new Map();
  for (const [month, m] of byMonth) {
    series.set(month, [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ t, v })));
  }
  return { byMonth: series };
}

/* ------------------------------------------------------------------ */
/* reader health, inferred from what ISN'T there                       */
/* ------------------------------------------------------------------ */

export function gaps(commits) {
  /* A refused read writes nothing, so a failure leaves NO commit. There is no
     positive record of it anywhere in this repo. The only evidence a refusal
     ever happened is a heartbeat that did not arrive.

     So: walk consecutive commits and flag any interval longer than the
     heartbeat plus slack. GitHub's scheduler is best effort and runs drift by
     ten to twenty minutes under load, so the slack is generous — this is to catch
     "the reader has been down since Friday", not "one poll ran late". */
  /* Three, not two. At SLACK_H = 2 the threshold is 8.00h and the weekend
     cadence produced commits at exactly 8.00h, so ordinary scheduler drift
     flagged a false gap nearly every Monday. A gap alarm that fires weekly is
     one nobody reads. */
  const SLACK_H = 3;
  const out = [];
  for (let i = 1; i < commits.length; i++) {
    const a = Date.parse(commits[i - 1].when);
    const b = Date.parse(commits[i].when);
    const h = (b - a) / 36e5;
    if (h > HEARTBEAT_H + SLACK_H) out.push({ from: commits[i - 1].when, to: commits[i].when, hours: h });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* svg small multiples                                                 */
/* ------------------------------------------------------------------ */

/* SEVEN DELIVERY MONTHS IS PAST THE POINT WHERE COLOR CAN CARRY IDENTITY.
 *
 * Seven lines on one axis needs seven distinguishable hues, and seven hues do
 * not survive colour-blind checking; the honest options are to fold the tail
 * into "Other" (meaningless here — every month is a real contract) or to
 * facet. So: one panel per delivery month, one series per panel, identity from
 * the panel title. No legend, no colour coding, nothing to tell apart.
 *
 * The panels share a y-scale so they can be compared by eye. That is the whole
 * point of small multiples and it is easy to get wrong by scaling each panel
 * to its own data. */
export function sparkline(series, { w = 232, h = 74, lo, hi }) {
  const padL = 4, padR = 4, padT = 10, padB = 12;
  const iw = w - padL - padR, ih = h - padT - padB;
  if (series.length === 0)
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="no data"></svg>`;

  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const span = Math.max(t1 - t0, 1);
  const range = Math.max(hi - lo, 0.01);
  const x = (t) => padL + ((t - t0) / span) * iw;
  const y = (v) => padT + (1 - (v - lo) / range) * ih;

  const pts = series.map((p) => [x(p.t), y(p.v)]);

  /* REFUSE TO DRAW A PATH THAT LEAVES THE PANEL.
     A chart with a coordinate outside its own viewBox is not a chart with a
     cosmetic problem, it is a chart built from the wrong numbers -- and SVG
     will render it without complaint as something that looks like data. Fail
     the bake instead; the workflow goes red and index.html keeps its last
     good version. */
  for (const [px, py] of pts) {
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < -1 || px > w + 1 || py < -1 || py > h + 1)
      throw new Error(
        `sparkline point (${px}, ${py}) falls outside the ${w}x${h} panel. ` +
        `The series is not in time order, or a timestamp did not parse.`);
  }
  for (let i = 1; i < series.length; i++)
    if (series[i].t < series[i - 1].t)
      throw new Error("sparkline series is not sorted ascending by time");

  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");

  /* Zero line, because basis is a signed number against futures and "is it
     wider or narrower than nothing" is the first thing the eye wants. Only
     drawn when zero is actually inside the panel's range. */
  const zero = lo <= 0 && hi >= 0
    ? `<line class="zero" x1="${padL}" x2="${w - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`
    : "";

  const last = pts[pts.length - 1];
  /* One direct label, on the current value only. A number on every point is
     the classic unreadable sparkline. */
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="basis history">
${zero}<path class="line" d="${d}"/><circle class="dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5"/></svg>`;
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

const fmtT = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
};
const fmtCT = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }) + " CT";
};
const money = (n) => (n == null ? "n/a" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00"));
const basisStr = (n) => (n == null ? "n/a" : (n > 0 ? "+" : "") + n.toFixed(2));

export function render(doc, hist) {
  const bids = (doc.bids ?? []).slice().sort((a, b) => a.seq - b.seq);
  const checked = Date.parse(doc.checkedAt);
  const deadline = Number.isFinite(checked)
    ? new Date(checked + FEED_MAX_AGE_H * 36e5).toISOString()
    : null;
  const nextBeat = Number.isFinite(checked)
    ? new Date(checked + HEARTBEAT_H * 36e5).toISOString()
    : null;

  /* Shared y-scale across every panel, padded so the line never touches the
     edge. Small multiples that each scale to their own data are a lie. */
  const all = [...(hist.byMonth?.values() ?? [])].flat().map((p) => p.v);
  const lo0 = all.length ? Math.min(...all) : -1;
  const hi0 = all.length ? Math.max(...all) : 0;
  const pad = Math.max((hi0 - lo0) * 0.15, 0.02);
  const lo = lo0 - pad, hi = hi0 + pad;

  const panels = bids.map((b) => {
    const s = (hist.byMonth?.get(b.delivery) ?? []);
    const first = s.length ? s[0].v : null;   // oldest point, series is sorted
    const move = first != null && s.length > 1 ? b.basisDollars - first : null;
    return `      <figure class="panel">
        <figcaption>
          <span class="pm">${esc(b.delivery)}</span>
          <span class="pv">${esc(basisStr(b.basisDollars))}</span>
        </figcaption>
        ${sparkline(s, { lo, hi })}
        <div class="pf">${s.length > 1
            ? `${s.length} readings${move != null ? ` &middot; ${move >= 0 ? "+" : ""}${move.toFixed(2)} over the window` : ""}`
            : "first reading"}</div>
      </figure>`;
  }).join("\n");

  const rows = bids.map((b) => `        <tr>
          <td class="n">${b.seq}</td>
          <td><b>${esc(b.delivery)}</b></td>
          <td class="num">${esc(money(b.cash))}</td>
          <td class="num">${esc(basisStr(b.basisDollars))}</td>
          <td>${esc(b.futuresMonth ?? "n/a")}</td>
          <td class="num">${b.futuresPriceCents == null ? "n/a" : esc(b.futuresPriceCents.toFixed(2))}</td>
        </tr>`).join("\n");

  /* The identity check, re-run here on the published file. If this page ever
     shows a row that fails, the guard in lib/board.mjs did not run. */
  /* A ROW WITH A BLANK CELL IS UNVERIFIABLE, NOT FAILING.
   *
   * lib/board.mjs publishes a row that is missing one of the three values --
   * checkIdentity skips it, and the build only refuses if NO row was testable.
   * This re-check used to count a missing value as a failure, so an ordinary
   * "N/A" in their Futures column produced a red banner reading "1 row(s) fail
   * cash minus basis equals futures... Do not trust these numbers", every
   * clause of which was false. This is the panel that would have to carry a
   * real column-shift alarm; it must not cry wolf on an upstream blank.
   *
   * Tolerance matches board.mjs's 0.05c rather than being ten orders of
   * magnitude tighter, for the same reason. */
  const TOL = 0.05 / 100;
  const verifiable = bids.filter(
    (b) => b.cash != null && b.basisDollars != null && b.futuresPriceCents != null);
  const unverifiable = bids.length - verifiable.length;
  const idFails = verifiable.filter(
    (b) => Math.abs((b.cash - b.basisDollars) - b.futuresPriceCents / 100) > TOL);

  const g = gaps(hist.commits ?? []);
  const recent = (hist.commits ?? []).slice(-12).reverse();

  const idBlock = idFails.length
    ? `<p class="s-bad"><b>${idFails.length} row(s) fail cash minus basis equals futures.</b>
       That should be impossible: <code>lib/board.mjs</code> refuses to build a file whose rows
       fail this check. Seeing it here means the published file was written by something other
       than that code path. Do not trust these numbers.</p>`
    : `<p class="s-ok"><b>All ${verifiable.length} verifiable rows satisfy cash minus basis equals futures.</b>
       Re-checked here against the published file, independently of the reader that wrote it.
       This is the only check that proves a number came out of the right column rather than
       merely looking like a price.</p>`
      + (unverifiable
        ? `<p class="s-warn"><b>${unverifiable} of ${bids.length} rows could not be checked</b> because their board left a cell blank.
           That is normal and the rows are published as posted, but the column guard cannot
           speak for them.</p>`
        : "");

  const gapBlock = g.length
    ? `<p class="s-warn"><b>${g.length} gap${g.length === 1 ? "" : "s"} longer than ${HEARTBEAT_H + 2} hours
       in the record.</b> A refused read writes nothing at all, so a failure leaves no commit.
       A missing heartbeat is the only trace it ever leaves.</p>
       <ul class="gaps">${g.slice(-6).reverse().map((x) =>
         `<li>${esc(fmtT(x.from))} to ${esc(fmtT(x.to))} &mdash; ${x.hours.toFixed(1)} hours</li>`).join("")}</ul>`
    : `<p class="s-ok"><b>No heartbeat gaps in the last ${(hist.commits ?? []).length} commits.</b>
       The reader has written at least every ${HEARTBEAT_H + 2} hours throughout the record below.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Boyceville board ${esc(fmtT(doc.checkedAt))}</title>
<style>
:root{--ink:#111;--bg:#fff;--grey:#f2f2f2;--rule:#e2e2e2;--mute:#666;--accent:#f5cf4e;
      --ok:#15803d;--warn:#a16207;--bad:#b91c1c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
     font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:940px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:21px;margin:0 0 2px;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute);
   margin:36px 0 12px;font-weight:600}
.sub{color:var(--mute);font-size:13px;margin:0 0 4px}
.hero{display:flex;flex-wrap:wrap;gap:26px;align-items:baseline;
      border-top:3px solid var(--ink);padding-top:16px;margin-top:16px}
.hero .big{font-size:44px;line-height:1;font-weight:650;letter-spacing:-.02em}
.hero .big small{font-size:15px;font-weight:400;color:var(--mute);letter-spacing:0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--mute);font-weight:600}
td.num,th.num{text-align:right}
td.n{color:var(--mute);width:1%}
tbody tr:nth-child(odd){background:var(--grey)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:18px 16px}
.panel{margin:0;border:1px solid var(--rule);padding:10px 10px 8px}
figcaption{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.pm{font-weight:650;font-size:13px}
.pv{font-variant-numeric:tabular-nums;font-size:13px;color:var(--mute)}
.pf{font-size:11px;color:var(--mute);margin-top:2px}
.spark{display:block;width:100%;height:auto;margin-top:4px}
.spark .line{fill:none;stroke:var(--ink);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.spark .dot{fill:var(--ink)}
.spark .zero{stroke:var(--rule);stroke-width:1}
.k{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:14px;margin:0}
.k dt{color:var(--mute)}
.k dd{margin:0;font-variant-numeric:tabular-nums}
p{margin:0 0 10px}
.s-ok,.s-warn,.s-bad{border-left:3px solid;padding:9px 0 9px 13px;font-size:14px}
.s-ok{border-color:var(--ok)} .s-ok b{color:var(--ok)}
.s-warn{border-color:var(--warn)} .s-warn b{color:var(--warn)}
.s-bad{border-color:var(--bad)} .s-bad b{color:var(--bad)}
.gaps{margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--mute)}
code{background:var(--grey);padding:1px 4px;font-size:.9em}
.log{font-size:13px;width:100%}
.log td{padding:5px 10px}
.log .subj{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.note{color:var(--mute);font-size:13px;border-top:1px solid var(--rule);margin-top:40px;padding-top:14px}
</style>
</head>
<body>
<div class="wrap">

<h1>Big River Resources, Boyceville</h1>
<p class="sub">Posted cash corn board, read by arrangement. This page is baked from
<code>data/boyceville.json</code> and this repo's git history. It carries no JavaScript and makes
no outside requests.</p>

<div class="hero">
  <div>
    <div class="big">${esc(basisStr(bids[0]?.basisDollars))}<small> basis</small></div>
    <p class="sub">${esc(bids[0]?.delivery ?? "n/a")} delivery, the front month</p>
  </div>
  <div>
    <div class="big">${esc(money(bids[0]?.cash))}<small> cash</small></div>
    <p class="sub">against ${esc(bids[0]?.futuresMonth ?? "n/a")} at ${
      bids[0]?.futuresPriceCents == null ? "n/a" : esc(bids[0].futuresPriceCents.toFixed(2)) }c</p>
  </div>
</div>

<h2>The two clocks</h2>
<dl class="k">
  <dt>Price last moved</dt><dd>${esc(fmtT(doc.pricedAt))} &nbsp;<span style="color:var(--mute)">${esc(fmtCT(doc.pricedAt))}</span></dd>
  <dt>Board last read</dt><dd>${esc(fmtT(doc.checkedAt))} &nbsp;<span style="color:var(--mute)">${esc(fmtCT(doc.checkedAt))}</span></dd>
  <dt>Next heartbeat due</dt><dd>${nextBeat ? esc(fmtT(nextBeat)) : "n/a"}</dd>
  <dt>Emmert sites drop this price after</dt><dd><b>${deadline ? esc(fmtT(deadline)) : "n/a"}</b> &nbsp;<span style="color:var(--mute)">${deadline ? esc(fmtCT(deadline)) : ""}</span></dd>
</dl>
<p class="sub" style="margin-top:10px">Every time on this page is absolute, deliberately. This is a
static file, so any elapsed-time phrasing would be frozen at the moment it was baked and would go on
reassuring you long after it stopped being true &mdash; on the one page you would open to find out
whether the reader had died. Compare the deadline above against your own clock.</p>
<p class="sub">A price being old is normal; their board sits still most of the day and all weekend.
Not having <i>looked</i> is the problem, which is why the two clocks are separate.</p>

<h2>Basis by delivery month</h2>
<div class="grid">
${panels}
</div>
<p class="sub" style="margin-top:14px">One panel per delivery month, all on the same vertical
scale so they can be compared by eye. Faint horizontal rule is zero basis. The dot is the most recent
reading in the record. Seven months is more than colour can tell apart reliably, so identity comes from the panel
title rather than from seven hues.</p>

<h2>The board</h2>
<table>
  <thead><tr><th>#</th><th>Delivery</th><th class="num">Cash</th><th class="num">Basis</th><th>Futures</th><th class="num">Quote, cents</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<p class="sub" style="margin-top:10px">In their page order, nearest delivery first. Not sorted by
month name: alphabetical order puts April first and would price the wrong month in ten months of
the year.</p>

<h2>Reader health</h2>
${idBlock}
${gapBlock}

<table class="log">
  <thead><tr><th>When</th><th>Commit</th></tr></thead>
  <tbody>
${recent.map((c) => `    <tr><td>${esc(fmtT(c.when))}</td><td class="subj">${esc(c.subject)}</td></tr>`).join("\n")}
  </tbody>
</table>
<p class="sub" style="margin-top:10px">A commit naming a price is a price change. A commit saying
heartbeat means the board was read and had not moved. There is no commit for a failed read, by
design &mdash; a bad read writes nothing and leaves the last good price in place.</p>

<p class="note">Cash and basis are Big River's own posted numbers. The futures quote is carried only
so a consumer can re-check cash minus basis. Baked ${esc(fmtT(new Date().toISOString()))} from
${(hist.commits ?? []).length} commits${hist.shallow ? " (shallow clone: history is truncated, set fetch-depth: 0)" : ""}.</p>

</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* cli                                                                 */
/* ------------------------------------------------------------------ */

/* Guarded so the tests can import the functions above without the module
   writing index.html as a side effect of being imported. */
const isCli = process.argv[1] && process.argv[1].endsWith("dashboard.mjs");
if (!isCli) { /* imported for tests */ } else {

if (!existsSync(DATA)) {
  console.error(`FAILED: ${DATA} does not exist`);
  process.exit(1);
}
const doc = JSON.parse(readFileSync(DATA, "utf8"));
const hist = history();
const html = render(doc, hist);

if (checkOnly) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  /* The bake stamp moves every run, so compare everything else. */
  const strip = (s) => s.replace(/Baked [^<]*/, "");
  if (strip(cur) === strip(html)) { console.log("index.html in sync."); process.exit(0); }
  console.log("index.html OUT OF SYNC with data/boyceville.json — run the baker.");
  process.exit(1);
}

writeFileSync(OUT, html);
console.log(`Baked ${OUT} — ${doc.count} rows, ${(hist.commits ?? []).length} commits, ` +
            `${[...(hist.byMonth?.keys() ?? [])].length} delivery months charted.`);

}

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
/* THE BOARD IS READ IN WISCONSIN, SO IT KEEPS WISCONSIN TIME.
 *
 * Every timestamp in data/ is UTC and stays UTC -- that is the record, and it
 * must not move. This is the display layer, and it was showing 22:47 for a
 * board read at 5:47 in the afternoon. Nobody standing at an elevator does that
 * subtraction in their head, and a five-hour error is exactly the size that
 * makes a fresh read look like a stale one.
 *
 * The zone is named, not an offset: America/Chicago handles CDT and CST without
 * anyone remembering to change anything in November. The abbreviation is read
 * from the formatter rather than hardcoded, so the header says CDT today and
 * CST in the winter, by itself.
 *
 * Everything that COMPARES times still works in UTC milliseconds -- stateOf,
 * ageHours, the skew check. Only what a human reads is converted. */
/* ---- WHEN IS THE NEXT ONE DUE? ------------------------------------------
 *
 * Asked for on 2026-08-20, and the reason it is worth having is what was
 * measured that day: the cron asks for six runs an hour through the trading
 * day and GitHub delivered ONE in the 13:00 UTC hour and TWO in the 14:00
 * hour. Nothing was broken and nothing said so. The board showed every source
 * green, which was true -- each one had been read successfully -- while the
 * whole thing quietly ran at a sixth of its stated rate.
 *
 * "Green" answers "did the last read work". It does not answer "when was it",
 * and that is the question a stale price actually turns on.
 *
 * THE SCHEDULE IS READ FROM THE WORKFLOW FILE, not restated here. A cadence
 * written in two places is a cadence that disagrees with itself, and this page
 * exists to be believed.
 */
export function cronField(spec, value, min, max) {
  for (const part of String(spec).split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isFinite(step) || step < 1) return false;
    let lo, hi;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) { const [a, b] = range.split("-").map(Number); lo = a; hi = b; }
    else { lo = hi = Number(range); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (value < lo || value > hi) continue;
    if ((value - lo) % step === 0) return true;
  }
  return false;
}

/** Does this 5-field UTC cron fire at this instant (to the minute)? */
export function cronMatches(cron, d) {
  const f = String(cron).trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [min, hr, dom, mon, dow] = f;
  if (!cronField(min, d.getUTCMinutes(), 0, 59)) return false;
  if (!cronField(hr, d.getUTCHours(), 0, 23)) return false;
  if (!cronField(mon, d.getUTCMonth() + 1, 1, 12)) return false;
  /* Cron's own oddity: when BOTH day-of-month and day-of-week are restricted
     it is an OR, not an AND. Every cron in this repository leaves day-of-month
     as `*`, so this never fires today -- but silently getting it backwards
     later is exactly the kind of thing that shows up as "the board lies". */
  const dowNow = d.getUTCDay();
  const domOn = dom !== "*", dowOn = dow !== "*";
  const domHit = cronField(dom, d.getUTCDate(), 1, 31);
  const dowHit = cronField(dow, dowNow, 0, 7) || (dowNow === 0 && cronField(dow, 7, 0, 7));
  if (domOn && dowOn) return domHit || dowHit;
  if (domOn) return domHit;
  if (dowOn) return dowHit;
  return true;
}

/** The first minute at or after `fromMs` + 1 when any of these crons fires. */
export function nextFire(crons, fromMs, limitMinutes = 8 * 24 * 60) {
  const list = (crons ?? []).filter(Boolean);
  if (!list.length || !Number.isFinite(fromMs)) return null;
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;   // the next whole minute
  for (let i = 0; i < limitMinutes; i++, t += 60000) {
    const d = new Date(t);
    for (const c of list) if (cronMatches(c, d)) return t;
  }
  return null;
}

/** Every cron in a workflow file, in order, without a YAML parser. */
export function cronsOf(yaml) {
  return [...String(yaml ?? "").matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
}

/* MINUTES, IN WORDS A PERSON READS RATHER THAN A TIMESTAMP THEY SUBTRACT.
   "read 9:49am CDT" makes you do arithmetic; "read 47 minutes ago" does not,
   and the whole point is to notice at a glance that 47 is not 10. */
export function agoWords(mins) {
  if (!Number.isFinite(mins)) return "at an unknown time";
  const m = Math.max(0, Math.round(mins));
  if (m < 1) return "just now";
  if (m === 1) return "1 minute ago";
  if (m < 90) return `${m} minutes ago`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h}h ${String(r).padStart(2, "0")}m ago`;
}

export function dueWords(mins) {
  if (!Number.isFinite(mins)) return "next run: no schedule found";
  const m = Math.round(mins);
  if (m > 1) return `next run due in ${m} minutes`;
  if (m === 1) return "next run due in a minute";
  if (m === 0) return "next run due now";
  const late = Math.abs(m);
  if (late < 90) return `next run was due ${late} minute${late === 1 ? "" : "s"} ago`;
  const h = Math.floor(late / 60), r = late % 60;
  return `next run was due ${h}h ${String(r).padStart(2, "0")}m ago`;
}

export const ZONE = "America/Chicago";

const fmtParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const fmtAbbr = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "short" });

/** An ISO instant as local wall time: `{ day: "2026-08-19", time: "19:47:53" }`. */
export function local(iso) {
  const ms = Date.parse(iso);
  if (!iso || Number.isNaN(ms)) return null;
  const p = Object.fromEntries(fmtParts.formatToParts(ms).map((x) => [x.type, x.value]));
  /* en-CA gives 24-hour time but renders midnight as "24" in some ICU builds. */
  const hour = p.hour === "24" ? "00" : p.hour;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}:${p.second}` };
}

/** "CDT" or "CST", whichever is in force at that instant. */
export function zoneAbbr(iso) {
  const ms = Date.parse(iso);
  const at = Number.isNaN(ms) ? Date.now() : ms;
  return fmtAbbr.formatToParts(at).find((x) => x.type === "timeZoneName")?.value ?? "";
}

const stamp = (iso) => { const l = local(iso); return l ? `${l.day} ${l.time}` : "never"; };

/* THE DATE IS THE SAME ON ALMOST EVERY ROW, SO STOP PRINTING IT.
 * Two full timestamps per row is 40 characters of which 22 are "2026-08-19"
 * twice over. Rows from the day of the read show the time alone; anything from
 * another day keeps its date, which is exactly the row you want to notice.
 * The reference date is stated once, in the header -- and both are now local,
 * so a row that rolls past local midnight changes day when the elevator's day
 * changes, not five hours early. */
const clock = (iso, refDay) => {
  const l = local(iso);
  if (!l) return iso ? String(iso) : "never";
  return l.day === refDay ? l.time : `${l.day.slice(5)} ${l.time.slice(0, 5)}`;
};

export function render(index, nowMs, crons = []) {
  const sources = [...(index.sources ?? [])]
    .map((s) => ({ ...s, ui: stateOf(s, nowMs) }))
    /* PROBLEMS FIRST, ALWAYS. At three hundred rows the table scrolls; what
       must never scroll out of reach is the thing that is wrong. Anything not
       live sorts to the top, so the first screen is the only screen anybody
       needs on a bad day. */
    .sort((a, b) => (["down", "late", "live"].indexOf(a.ui) - ["down", "late", "live"].indexOf(b.ui))
      || String(a.operator || "").localeCompare(String(b.operator || ""))
      || String(a.location || "").localeCompare(String(b.location || "")));

  const n = sources.length;
  const c = { live: 0, late: 0, down: 0 };
  for (const s of sources) c[s.ui]++;
  const problems = c.late + c.down;

  const verdict = n === 0 ? "down" : c.down ? "down" : c.late ? "late" : "live";
  const headline = n === 0 ? "NO SOURCES READ"
    : problems ? `${problems} of ${n} NEED A LOOK` : `ALL ${n} LIVE`;

  const refDay = local(index.generated)?.day ?? String(index.generated ?? "").slice(0, 10);

  /* When the schedule says the next one is due, and how far apart it puts them
     here. Both computed from the workflow file itself -- a cadence written in
     two places is a cadence that disagrees with itself. */
  const readMs = Date.parse(index.generated ?? "");
  const dueMs = nextFire(crons, readMs);
  const dueIso = dueMs ? new Date(dueMs).toISOString() : null;
  const afterMs = dueMs ? nextFire(crons, dueMs) : null;
  const everyMins = afterMs && dueMs ? Math.round((afterMs - dueMs) / 60000) : null;
  const tickText = `read ${agoWords((nowMs - readMs) / 60000)}` +
    (dueMs ? ` · ${dueWords((dueMs - nowMs) / 60000)}` : "");
  const note = (s) => {
    if (s.error) return esc(s.error);
    if (s.withheld?.length)
      return "withheld: " + s.withheld.map((w) => `${esc(w.commodity)} (${w.rows})`).join(", ");
    if (s.note) return esc(s.note);
    return "";
  };

  const row = (s) => `<tr class="r-${s.ui}">` +
    `<td class="st"><span class="g" aria-hidden="true">${GLYPH[s.ui]}</span>${s.ui}</td>` +
    `<td class="op">${esc(s.operator ?? "")}</td>` +
    `<td class="lo">${esc(s.location ?? "")}${s.usState ? `<span class="dim">, ${esc(s.usState)}</span>` : ""}</td>` +
    `<td class="cm">${esc((s.commodities ?? []).join(" "))}</td>` +
    `<td class="n">${s.rows ?? 0}</td>` +
    `<td class="m">${clock(s.pricedAt, refDay)}</td>` +
    `<td class="m">${clock(s.checkedAt, refDay)}</td>` +
    `<td class="pf">${esc(s.platform ?? "")}</td>` +
    `<td class="ct">${s.phone ? esc(s.phone) : ""}</td>` +
    `<td class="no">${note(s)}</td></tr>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Bid sources — ${headline}</title>
<style>
  :root{--bg:#141613;--line:#282c26;--line2:#1e211c;--ink:#e9ece7;--dim:#8d9488;
        --live:#0ca30c;--late:#fab219;--down:#d03b3b;
        --mono:ui-monospace,"JetBrains Mono",Menlo,monospace}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font:12px/1.4 var(--mono);
       display:flex;flex-direction:column;padding:10px 12px;gap:8px;overflow:hidden}
  /* WRAPS, so the cadence line gets a row of its own instead of fighting the
     title for space on a narrow screen. flex-basis:100% on .tick only does
     anything if the container is allowed to wrap. */
  header{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px 12px;flex:none}
  h1{font:600 12px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;margin:0;color:var(--dim)}
  .v{font:700 12px/1 var(--mono);letter-spacing:.06em}
  .v.live{color:var(--live)}.v.late{color:var(--late)}.v.down{color:var(--down)}
  .when{margin-left:auto;color:var(--dim);font-size:11px}
  /* Shrink to the rows, cap at the viewport. flex 1-1-auto drew a full-height
     frame around three rows; this hugs the content and still scrolls at three
     hundred. The spacer takes the slack so the legend stays on the floor. */
  .wrap{flex:0 1 auto;min-height:0;overflow:auto;border:1px solid var(--line);border-radius:6px}
  .spacer{flex:1 1 auto;min-height:0}
  table{width:100%;border-collapse:collapse;font:12px/1 var(--mono)}
  thead th{position:sticky;top:0;z-index:1;background:#1b1e19;text-align:left;
           color:var(--dim);font-weight:600;font-size:11px;letter-spacing:.08em;
           text-transform:uppercase;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:4px 10px;border-bottom:1px solid var(--line2);white-space:nowrap;
     max-width:34ch;overflow:hidden;text-overflow:ellipsis}
  tbody tr:hover{background:#1a1d18}
  .st{font-weight:700}
  .r-live .st{color:var(--live)}.r-late .st{color:var(--late)}.r-down .st{color:var(--down)}
  /* Anything not live gets a rail as well as a colour: at a glance down the
     left edge you can count the problems without reading a word. */
  .r-late td:first-child{box-shadow:inset 3px 0 var(--late)}
  .r-down td:first-child{box-shadow:inset 3px 0 var(--down)}
  .r-late,.r-down{background:#1a1c17}
  .g{margin-right:6px}
  .n{text-align:right;color:var(--dim)}
  .m,.pf,.cm,.ct{color:var(--dim)}
  .cm{font-size:11px}
  .dim{color:var(--dim)}
  .no{color:var(--late);max-width:52ch}
  .r-live .no{color:var(--dim)}
  /* THE CADENCE, IN WORDS, TICKING. Green answers "did the last read work".
     It does not answer "when was it", and on 2026-08-20 every source was green
     while the whole job ran at a sixth of its stated rate. */
  .tick{flex-basis:100%;color:var(--dim);font-size:12px;margin-top:2px}
  .tick.overdue{color:var(--late);font-weight:600}
  .legend{flex:none;display:flex;gap:14px;color:var(--dim);font-size:11px}
  .legend b{font-weight:700}
  .empty{padding:14px;color:var(--down)}
  @media(max-width:820px){.pf,.ct,.m:nth-of-type(6){display:none}
    thead th:nth-child(6),thead th:nth-child(8),thead th:nth-child(9){display:none}}
</style></head><body>
<header><h1>Bid sources</h1><span class="v ${verdict}">${esc(headline)}</span>
<span class="when">${esc(refDay)} · read ${clock(index.generated, refDay)} ${esc(zoneAbbr(index.generated))}</span>
<span class="tick" id="tick"
      data-read="${esc(index.generated ?? "")}"
      data-due="${esc(dueIso ?? "")}"
      data-every="${esc(String(everyMins ?? ""))}">${esc(tickText)}</span></header>

<div class="wrap">${n === 0
  ? `<div class="empty"><strong>Nothing was read.</strong> data/index.json lists no sources —
     either the manifest failed to load or every source is disabled. This is not an all-clear.</div>`
  : `<table><thead><tr>
<th>State</th><th>Operator</th><th>Location</th><th>Commodities</th><th>Rows</th>
<th>Priced</th><th>Checked</th><th>Platform</th><th>Phone</th><th>Note</th>
</tr></thead><tbody>${sources.map(row).join("")}</tbody></table>`}</div>

<div class="spacer"></div>

<script>
/* Ticks the two numbers in the header. Everything it needs is in the data-
   attributes above: when the last run finished, when the schedule says the
   next one is due, and how far apart the schedule puts them in this window.
   No fetch, no clock but yours, and if it throws the baked-in words stay. */
(function () {
  try {
    var el = document.getElementById("tick");
    if (!el) return;
    var read = Date.parse(el.getAttribute("data-read"));
    var due = Date.parse(el.getAttribute("data-due"));
    var every = Number(el.getAttribute("data-every"));
    if (!read) return;
    function ago(m) {
      m = Math.max(0, Math.round(m));
      if (m < 1) return "just now";
      if (m === 1) return "1 minute ago";
      if (m < 90) return m + " minutes ago";
      var h = Math.floor(m / 60), r = m % 60;
      return h + "h " + (r < 10 ? "0" : "") + r + "m ago";
    }
    function tick() {
      var now = Date.now();
      var since = (now - read) / 60000;
      var text = "read " + ago(since);
      var overdue = false;
      if (due) {
        var left = Math.round((due - now) / 60000);
        if (left > 1) text += " \u00b7 next run due in " + left + " minutes";
        else if (left === 1) text += " \u00b7 next run due in a minute";
        else if (left === 0) text += " \u00b7 next run due now";
        else {
          var late = Math.abs(left);
          text += " \u00b7 next run was due " + (late < 90 ? late + " minute" + (late === 1 ? "" : "s")
                  : Math.floor(late / 60) + "h " + (late % 60 < 10 ? "0" : "") + (late % 60) + "m") + " ago";
          /* One missed slot is GitHub being GitHub. Past two, say so in colour:
             the schedule is not being honoured and the price is older than the
             page implies. */
          overdue = every > 0 ? late > every : late > 5;
        }
      }
      el.textContent = text;
      el.className = "tick" + (overdue ? " overdue" : "");
    }
    tick();
    setInterval(tick, 15000);
  } catch (e) { /* the baked-in words were true when they were written */ }
})();
</script>

<div class="legend">
  <span><b style="color:var(--live)">${GLYPH.live}</b> live — read inside ${LATE_H}h</span>
  <span><b style="color:var(--late)">${GLYPH.late}</b> needs a look — stale or refusing</span>
  <span><b style="color:var(--down)">${GLYPH.down}</b> down — past ${WITHDRAW_H}h, consumers have withdrawn</span>
  <span>“due” is what the schedule asks for; GitHub's scheduler is best effort and
        drops runs under load</span>
  <span style="margin-left:auto">${n} source${n === 1 ? "" : "s"}</span>
</div>
</body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(INDEX)) { console.error(`FAILED: ${INDEX} not found. Run poll.mjs first.`); process.exit(1); }
  const index = JSON.parse(readFileSync(INDEX, "utf8"));
  /* The schedule comes from the workflow, so the board cannot claim a cadence
     the repository is not asking for. A missing file is not fatal: the page
     then says how long ago it was read and nothing about what is next. */
  const WF = join(ROOT, ".github", "workflows", "poll.yml");
  const crons = existsSync(WF) ? cronsOf(readFileSync(WF, "utf8")) : [];
  if (!crons.length) console.warn("::warning::no cron found in .github/workflows/poll.yml; the board will not show when the next run is due");
  writeFileSync(OUT, render(index, Date.now(), crons));
  console.log(`status board -> ${OUT}  (${index.sources?.length ?? 0} sources)`);
}

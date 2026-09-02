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

/* ONE DEFINITION, IN lib/freshness.mjs.
 *
 * These four lived here and here only, with the comment "Matches the
 * consumers" -- while the consumer that mattered most, merge_bids.mjs, could
 * not import them and did not match. It withdrew on `status !== "ok"` instead,
 * and on 2026-09-02 that dropped 151 sources holding 1,706 bids aged 6.2-6.7h
 * out of the merged feed. See the header of lib/freshness.mjs.
 *
 * Re-exported so that every existing importer of this module keeps working and
 * there is still exactly one number. */
export { LATE_H, WITHDRAW_H, MAX_SKEW_H, HELD, ageHours, stateOf, feedVerdict } from "../lib/freshness.mjs";
import { LATE_H, WITHDRAW_H, ageHours, stateOf } from "../lib/freshness.mjs";

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
export function rawCronsOf(yaml) {
  return [...String(yaml ?? "").matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
}

/* A CRON IS NO LONGER THE SAME THING AS A READ -- 2026-08-26.
 *
 * The trading-window job used to fire six times an hour and read once each
 * time, so "when does the cron next fire" and "when is the board next read"
 * were the same question. They are not any more. GitHub was measured
 * delivering one or two of those six, so the workflow now asks ONCE an hour
 * and the job READS EVERY TEN MINUTES INSIDE ITSELF for fifty minutes.
 *
 * This page exists to be believed. Left alone it would have read the hourly
 * cron and told somebody at 14:12 that the next read was forty-five minutes
 * away, when the truth is three -- which is exactly the kind of confident
 * wrong answer the file header warns about.
 *
 * So the loop is read out of the workflow too, from the same file and by the
 * same rule: a cadence written in two places is a cadence that disagrees with
 * itself. A cron whose job loops is expanded into the minutes it will actually
 * read at -- "7 12-21 * * 1-5" with a 50-minute loop every 10 becomes
 * "7,17,27,37,47 12-21 * * 1-5", which is not a guess about the schedule, it
 * is a statement of when the reads happen.
 *
 * A workflow with no loop settings expands to itself, so nothing else moves. */
export function loopOf(yaml) {
  const y = String(yaml ?? "");
  const every = Number((y.match(/EVERY_MINUTES:\s*["']?(\d+)/) || [])[1]);
  /* The workflow names the ONE cron whose job loops. Reading that name here is
     what stops this page claiming the overnight and weekend crons read every
     ten minutes as well -- they do not, deliberately, and an earlier version of
     this function said they did. */
  const m = y.match(/event\.schedule == '([^']+)' && '(\d+)'/);
  const cron = m ? m[1] : null;
  const mins = Number(m ? m[2] : NaN);
  return (Number.isFinite(every) && every > 0 && Number.isFinite(mins) && mins > 0 && cron)
    ? { every, mins, cron } : null;
}

export function expandLoop(cron, loop) {
  if (!loop) return cron;
  const f = String(cron).trim().split(/\s+/);
  if (f.length !== 5) return cron;
  /* Only a cron that fires at ONE minute of the hour can be expanded: a list
     is already several reads and doubling them would overstate the cadence. */
  if (!/^\d+$/.test(f[0])) return cron;
  const start = Number(f[0]);
  const at = [];
  for (let m = 0; m <= loop.mins - loop.every; m += loop.every) {
    const v = start + m;
    if (v > 59) break;              // a read that spills past the hour is not this cron's
    at.push(v);
  }
  return at.length > 1 ? [at.join(","), ...f.slice(1)].join(" ") : cron;
}

/* What the crons mean once the loop is taken into account. The loop only runs
   on the SCHEDULED trading-window fire, and that is the only cron this touches:
   the hourly and weekend ones read once and are returned unchanged. */
export function cronsOf(yaml) {
  const loop = loopOf(yaml);
  return rawCronsOf(yaml).map((c) => (loop && c === loop.cron ? expandLoop(c, loop) : c));
}

/* MINUTES, IN WORDS A PERSON READS RATHER THAN A TIMESTAMP THEY SUBTRACT.
   "read 9:49am CDT" makes you do arithmetic; "read 47 minutes ago" does not,
   and the whole point is to notice at a glance that 47 is not 10. */
/* HOW MANY READS THE SCHEDULE ASKED FOR AND DID NOT GET.
 *
 * Sig, 2026-09-01: "that timing in the header has always been out of sequence."
 * He was right, and the bug is nastier than a wrong number because both halves
 * were arithmetically correct. The header computed the due time as the next fire
 * after the last READ — so when several were missed it kept naming the FIRST one
 * and calling it "next":
 *
 *     read 1h 54m ago · next run was due 1h 50m ago
 *
 * Twelve fires had been missed and the next was genuinely thirty-two minutes
 * AWAY. A reader saw one missed run where there were twelve, and learned nothing
 * about when to expect the next.
 *
 * Three separate facts, so three numbers: when it last read, how many reads the
 * schedule asked for since, and when the next one is actually due. */
export function missedRuns(crons, fromMs, toMs, cap = 500) {
  if (!crons.length || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  let n = 0, t = fromMs;
  while (n < cap) {
    const f = nextFire(crons, t);
    if (!f || f > toMs) break;
    n++; t = f;
  }
  return n;
}

/* ── ONE FAULT, NOT NINETEEN ROWS OF IT ──────────────────────────────────────
 *
 * On 2026-09-01 the board read "45 of 357 NEED A LOOK" over nineteen consecutive
 * rows of CHS High Plains, each saying the same sentence, each with the sentence
 * cut off at the right edge. Forty-five rows carried FIVE facts. The eye cannot
 * find five things in forty-five lines, and the one column that would have told
 * you which five was the one being clipped.
 *
 * Sources are grouped by what is actually wrong with them: the operator, the
 * platform, and the first clause of the reason. Nineteen locations behind one
 * dead page is one problem with nineteen addresses, and that is how it reads. */
/* THE KIND OF A FAULT, WITH THE EVIDENCE STRIPPED OFF.
 *
 * Grouping on the whole message splits one fault into as many groups as it has
 * distinct numbers in it. Measured on the 02:11 board: eight locations across
 * six operators all failed `cash - basis = futures` by exactly -0.25c on the
 * same @C6Z contract -- one DTN quote a tick behind, which is ONE finding --
 * and grouping by message made it six. Grouping by operator was worse: it made
 * one CHS outage into eighteen rows.
 *
 * So the key is what KIND of thing went wrong, and the numbers that differ
 * between boards are exactly the thing to throw away:
 *   - a leading "5 of 8 testable row(s)" is a count, not a kind
 *   - everything after the first colon is evidence, not a kind
 *   - a url's query string and ids vary per source; its path does not
 *
 * The full message is still carried on the group, and every row is still in
 * the table underneath. This decides only what gets its own LINE.
 */
export function faultKind(msg) {
  let t = String(msg ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  t = t.replace(/^\d+ of \d+ (testable )?row\(s\)/i, "rows");
  t = t.replace(/^all \d+ row\(s\)/i, "rows");
  t = t.replace(/^parsed \d+ bids but none for location \S+\.?/i,
                "parsed the page but the location id we ask for is not on it.");
  /* A PARENTHESISED LIST IS EVIDENCE, NOT A KIND. The trip message names the
     operators that spent the strikes, which is exactly right in the log and
     exactly wrong in a grouping key. */
  t = t.replace(/\s*\([^()]{12,}\)/g, "");
  /* A url identifies the endpoint, not the tenant. Keep host+path, drop the rest. */
  t = t.replace(/https?:\/\/([^\/\s]+)(\/[^\s?]*)?\S*/g, (_, h, path) => h + (path ?? ""));
  t = t.replace(/\bwithin \d+ms\b/g, "on time");
  t = t.replace(/\b\d+ request\(s\)/g, "N request(s)");
  /* CUT AT THE COLON ONLY IF WHAT IS LEFT STILL SAYS SOMETHING.
     "skipped: bushel returned an empty page three times" cut at the colon is
     the word "skipped", which is the label the row already carries and not a
     reason at all. A fragment shorter than this is a prefix, not a sentence,
     so the cut moves on to the next boundary. */
  const MIN = 24;
  /* THE EARLIEST USABLE BOUNDARY WINS, NOT THE FIRST RULE THAT MATCHES.
     Trying sentence-end before colon returned the whole of
     "rows fail cash - basis = futures: New crop 2026 @C6Z cash 4.91 basis
     -0.5 -> 541c but quoted 540.75c (-0.25c)" for one board and the bare
     "rows fail cash - basis = futures" for its six neighbours -- one fault,
     two groups, because one message happened to contain a full stop and a
     space further along. Both candidates are computed and the shorter one is
     taken, so the cut depends on the shape of the sentence and not on the
     order I happened to write the rules in. */
  let best = null;
  for (const m of [/(?<=\.)\s/, /:\s?/]) {
    const head = t.split(m)[0].trim();
    if (head.length >= MIN && head.length < t.length && (best == null || head.length < best.length))
      best = head;
  }
  if (best) return best.slice(0, 90).trim();
  /* No usable boundary: take the head and stop on a word, never mid-word. */
  if (t.length <= 90) return t;
  return t.slice(0, 90).replace(/\s+\S*$/, "") + "…";
}

export function faultGroups(sources, nowMs) {
  const g = new Map();
  for (const s of sources) {
    if (s.ui === "live") continue;
    const why = String(s.error || s.note || "").replace(/\s+/g, " ").trim();
    const kind = faultKind(why);
    /* PLATFORM AND KIND. Not operator: an outage at one host hits every tenant
       on it, and eighteen CHS lines saying the same sentence is the failure
       mode this band exists to end. The operators are counted and named inside
       the group instead, which is where that detail belongs. */
    const key = `${s.platform ?? ""}\u241f${kind}`;
    if (!g.has(key)) {
      g.set(key, { platform: s.platform ?? "", kind, why, health: s.health ?? "",
                   ui: s.ui, at: [], ops: new Map(), lastGood: null });
    }
    const e = g.get(key);
    e.at.push(s);
    const op = s.operator ?? "—";
    e.ops.set(op, (e.ops.get(op) ?? 0) + 1);
    if (s.ui === "down") e.ui = "down";      // the worst state in the group wins
    /* A group of mixed health is named by the more actionable half: "skipped"
       is a statement about us, "broken" and "refused" about them. */
    if (s.health && s.health !== "skipped") e.health = s.health;
    /* checkedAt stops advancing the moment a source stops reading, so it IS
       the answer to "how long has this been dark". */
    const c = Date.parse(s.checkedAt ?? "");
    if (Number.isFinite(c) && (e.lastGood == null || c > e.lastGood)) e.lastGood = c;
  }
  return [...g.values()]
    .map((e) => {
      const ops = [...e.ops.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { ...e, ops, opCount: ops.length, n: e.at.length,
               /* Name at most two, then count the rest. "CHS Ag Services,
                  CHS High Plains +20 more" is readable; twenty-two names is a
                  paragraph. */
               who: ops.length <= 2 ? ops.map(([o]) => o).join(", ")
                 : `${ops.slice(0, 2).map(([o]) => o).join(", ")} +${ops.length - 2} more`,
               darkMins: e.lastGood == null ? null : (nowMs - e.lastGood) / 60000 };
    })
    .sort((a, b) => (["down", "late"].indexOf(a.ui) - ["down", "late"].indexOf(b.ui)) || b.n - a.n);
}

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
  /* THE ROW COUNT IS NOT THE PROBLEM COUNT. 164 rows needed a look on the
     02:11 board and they were six faults; one of them accounted for 127. A
     headline that only counts rows makes a single outage look like a collapse
     and gives no sense of how many things there are to go and fix. */
  const headline = n === 0 ? "NO SOURCES READ" : problems ? `${problems} of ${n} NEED A LOOK` : `ALL ${n} LIVE`;

  const refDay = local(index.generated)?.day ?? String(index.generated ?? "").slice(0, 10);

  /* When the schedule says the next one is due, and how far apart it puts them
     here. Both computed from the workflow file itself -- a cadence written in
     two places is a cadence that disagrees with itself. */
  const readMs = Date.parse(index.generated ?? "");

  /* "NEXT" MEANS NEXT FROM NOW. THIS SAID NEXT-FROM-THE-READ.
   *
   * `nextFire(crons, readMs)` is the first fire after the last successful run.
   * On a healthy board those are the same instant and nothing shows. On a board
   * that has missed four runs they are forty minutes apart, and the header
   * named the FIRST MISSED FIRE and labelled it "next" -- so a page loaded at
   * 15:36 announced a run "due 43 minutes ago" when the genuinely next one was
   * four minutes out, and every intervening miss went unmentioned. Reported as
   * "that timing in the header has always been out of sequence", which is
   * exactly what it was: the two clocks in the sentence were not the same
   * clock.
   *
   * Three facts, each measured from the right instant:
   *   read      how old the data is           (now - read)
   *   missed    how many fires went by unread (read -> now)
   *   next      when the schedule fires again (from now)
   * The middle one is the whole diagnosis and it was the one being thrown away.
   */
  const dueMs = nextFire(crons, nowMs);
  const dueIso = dueMs ? new Date(dueMs).toISOString() : null;
  const afterMs = dueMs ? nextFire(crons, dueMs) : null;
  const everyMins = afterMs && dueMs ? Math.round((afterMs - dueMs) / 60000) : null;
  /* The read itself is a fire, so a board read on time has missed nothing.
     Counting from readMs would count the run that produced this page. */
  const missed = crons.length ? missedRuns(crons, readMs, nowMs) : 0;
  const tickText = `read ${agoWords((nowMs - readMs) / 60000)}`
    + (missed ? ` · ${missed} run${missed === 1 ? "" : "s"} missed` : "")
    + (dueMs ? ` · ${dueWords((dueMs - nowMs) / 60000)}` : "");

  /* ── THE FAULTS, GROUPED, ABOVE THE TABLE ────────────────────────────────
     45 problem rows on the 02:11 board carried five distinct facts: nineteen
     identical "CHS High Plains / bushel / skipped" lines in a column clipped
     at 52ch, so the one useful thing -- WHY -- was the part cut off. The band
     says each fault once, with how many locations it covers and how long they
     have been dark, and the table below is still there for the detail. */
  const faults = faultGroups(sources, nowMs);
  const darkWords = (m) => m == null ? "never read"
    : m < 90 ? `dark ${Math.round(m)}m`
    : `dark ${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
  const faultBand = faults.length === 0 ? "" : `<div class="faults">${faults.map((g) => `
    <div class="f f-${g.ui}"><span class="g" aria-hidden="true">${GLYPH[g.ui]}</span>
      <span class="fc"><b>${g.n}</b> loc${g.opCount > 1 ? ` · ${g.opCount} op` : ""}</span>
      <span class="fd">${darkWords(g.darkMins)}</span>
      <span class="fp">${esc(g.platform || "")}</span>
      <span class="fo" title="${esc(g.ops.map(([o, k]) => `${o} (${k})`).join(", "))}">${esc(g.who)}</span>
      <span class="fw" title="${esc(g.why)}">${esc(g.kind)}</span></div>`).join("")}</div>`;

  const noteText = (s) => {
    if (s.error) return s.error;
    if (s.withheld?.length)
      return "withheld: " + s.withheld.map((w) => `${w.commodity} (${w.rows})`).join(", ");
    return s.note ?? "";
  };
  const note = (s) => {
    if (s.error) return esc(s.error);
    if (s.withheld?.length)
      return "withheld: " + s.withheld.map((w) => `${esc(w.commodity)} (${w.rows})`).join(", ");
    if (s.note) return esc(s.note);
    return "";
  };

  /* EVERY CLIPPED CELL CARRIES ITS FULL TEXT ON A title=.
     Fixed layout means a long operator or commodity list ends in an ellipsis,
     and an ellipsis with nothing behind it is information destroyed rather
     than folded. Measured at 1440: 76 operators, 88 commodity lists, 16
     locations and 164 notes are clipped on this board -- so this is the normal
     case, not the edge one. */
  const row = (s) => `<tr class="r-${s.ui}">` +
    `<td class="st"><span class="g" aria-hidden="true">${GLYPH[s.ui]}</span>${s.ui}</td>` +
    `<td class="op" title="${esc(s.operator ?? "")}">${esc(s.operator ?? "")}</td>` +
    `<td class="lo" title="${esc([s.location, s.usState].filter(Boolean).join(", "))}">` +
      `${esc(s.location ?? "")}${s.usState ? `<span class="dim">, ${esc(s.usState)}</span>` : ""}</td>` +
    `<td class="cm" title="${esc((s.commodities ?? []).join(" "))}">${esc((s.commodities ?? []).join(" "))}</td>` +
    `<td class="n">${s.rows ?? 0}</td>` +
    `<td class="m pr">${clock(s.pricedAt, refDay)}</td>` +
    `<td class="m ck">${clock(s.checkedAt, refDay)}</td>` +
    `<td class="pf" title="${esc(s.platform ?? "")}">${esc(s.platform ?? "")}</td>` +
    `<td class="ct" title="${esc(s.phone ?? "")}">${s.phone ? esc(s.phone) : ""}</td>` +
    /* THE COLUMN IS CLIPPED; THE FACT MUST NOT BE. `.no` is capped at 52ch with
       an ellipsis, and what gets cut is always the end of the reason -- the
       part that says what to do. The band above carries the grouped version;
       this makes the full text reachable on the row itself. */
    `<td class="no" title="${esc(noteText(s))}">${note(s)}</td></tr>`;

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
  /* FIXED LAYOUT, SO THE NOTE COLUMN GETS THE SLACK INSTEAD OF THE OVERFLOW.
     With auto layout the nine fixed-content columns each took what they wanted,
     the total came out wider than the frame, and NOTE -- last, and the only
     column that says what is WRONG -- was pushed off the right edge entirely.
     It was reachable by horizontal scrolling, which is to say it was not read.
     Fixed widths for the nine that have a known shape; whatever is left is the
     reason, ellipsised in place with the full text on the cell's title. */
  table{width:100%;border-collapse:collapse;font:12px/1 var(--mono);table-layout:fixed}
  /* MEASURED AGAINST THE WIDEST REAL VALUE IN EACH COLUMN, not guessed:
     "down" plus its glyph is 6 characters, "08-31 22:21" is 11, "graindesk"
     is 9, and every one of these was clipped to an ellipsis on the first
     attempt -- a fixed column narrower than its own content is a worse bug
     than the overflow it replaced, because it looks deliberate. */
  /* THE WIDTHS LIVE ON THE HEADER CELLS, NOT ON A <colgroup>.
     A colgroup was tried first and could not be made to hide a column: cells
     hidden with display:none slide onto the wrong <col> (at 820px NOTE
     inherited CHECKED's width and CHECKED's header disappeared), and
     visibility:collapse -- the mechanism the spec provides for exactly this --
     is not honoured by the browser this board is read in. MEASURED: it
     collapsed NOTE instead and left the table 122px short of its frame.
     With table-layout:fixed the first row's cells define the columns, so the
     widths go there, and hiding a column is then one display:none per column
     applied to a th and a td that carry the SAME class. Nothing to keep in
     sync by position. */
  th.h-st{width:9ch}  th.h-op{width:26ch} th.h-lo{width:22ch}
  th.h-cm{width:15ch} th.h-n{width:7ch}   th.h-pr{width:14ch}
  th.h-ck{width:14ch} th.h-pf{width:13ch} th.h-ph{width:15ch}
  /* h-no takes the remainder: no width, and it is the only one without one. */
  thead th{position:sticky;top:0;z-index:1;background:#1b1e19;text-align:left;
           color:var(--dim);font-weight:600;font-size:11px;letter-spacing:.08em;
           text-transform:uppercase;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:4px 10px;border-bottom:1px solid var(--line2);white-space:nowrap;
     overflow:hidden;text-overflow:ellipsis}
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
  .no{color:var(--late)}
  .r-live .no{color:var(--dim)}
  /* THE CADENCE, IN WORDS, TICKING. Green answers "did the last read work".
     It does not answer "when was it", and on 2026-08-20 every source was green
     while the whole job ran at a sixth of its stated rate. */
  .tick{flex-basis:100%;color:var(--dim);font-size:12px;margin-top:2px}
  .tick.overdue{color:var(--late);font-weight:600}
  .legend{flex:none;display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--dim);font-size:11px;
          white-space:nowrap}
  /* THE FAULT BAND. One row per distinct fault, not per affected location.
     Grid, not flex: the five columns line up down the band so three faults can
     be compared by eye, which is the entire point of grouping them. */
  .faults{flex:none;display:flex;flex-direction:column;gap:2px;
          max-height:22vh;overflow-y:auto;overscroll-behavior:contain}
  .f{display:grid;grid-template-columns:1.2em 15ch 13ch 10ch minmax(18ch,30ch) 1fr;
     gap:10px;align-items:baseline;padding:4px 6px;border-left:2px solid var(--line);
     background:var(--line2);font-size:11px;white-space:nowrap}
  .f-late{border-left-color:var(--late)}
  .f-down{border-left-color:var(--down)}
  .f .g{font-weight:700}
  .f-late .g{color:var(--late)}.f-down .g{color:var(--down)}
  .f b{font-weight:700;color:var(--ink)}
  .f .fc,.f .fp,.f .fd{color:var(--dim);overflow:hidden;text-overflow:ellipsis}
  .f .fc,.f .fd{font-variant-numeric:tabular-nums}
  .f .fo{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* THE REASON GETS THE REST OF THE ROW AND WRAPS TO TWO LINES.
     Clipping it to one line is what made the table's NOTE column useless. */
  .f .fw{color:var(--ink);white-space:normal;display:-webkit-box;-webkit-line-clamp:2;
         -webkit-box-orient:vertical;overflow:hidden}
  /* Under 900 the reason gets its own line beneath the counts rather than
     being hidden: it is the one thing on the row that cannot be inferred. */
  @media(max-width:900px){.f{grid-template-columns:1.2em 15ch 13ch 1fr}
    .f .fp{display:none}
    .f .fw{grid-column:2/-1;-webkit-line-clamp:3}}
  .legend b{font-weight:700}
  .empty{padding:14px;color:var(--down)}
  /* NARROW: DROP PRICED, PLATFORM AND PHONE -- BY COLLAPSING THE COLUMN, NOT
     BY HIDING THE CELLS.
     display:none on a <td> removes it from the row, and with a <colgroup>
     the remaining cells then slide onto the WRONG columns: at 820px the seven
     surviving cells landed on cols 1-7, so NOTE inherited the width meant for
     CHECKED, CHECKED's header vanished, and a 200px gutter opened on the right.
     visibility:collapse on the <col> is the mechanism actually designed for
     this -- the column goes and the table reflows -- and it cannot desynchronise
     the header from the body because there is only one thing being hidden. */
  @media(max-width:820px){.pr,.h-pr,.pf,.h-pf,.ct,.h-ph{display:none}}
  /* Below 660 the fixed widths add up to more than the frame and NOTE, having
     no width of its own, is what collapses to nothing -- measured at 600px:
     a 616px table inside a 574px box with a zero-wide reason column. Drop the
     two columns that repeat what the fault band already says, and give the
     other three less room, so the reason keeps a column at every width. */
  @media(max-width:660px){.cm,.h-cm,.ck,.h-ck{display:none}
    th.h-st{width:7ch}th.h-op{width:17ch}th.h-lo{width:14ch}th.h-n{width:5ch}
    td{padding:4px 6px}}
</style></head><body>
<header><h1>Bid sources</h1><span class="v ${verdict}">${esc(headline)}</span>
<span class="when">${esc(refDay)} · read ${clock(index.generated, refDay)} ${esc(zoneAbbr(index.generated))}</span>
<span class="tick" id="tick"
      data-read="${esc(index.generated ?? "")}"
      data-due="${esc(dueIso ?? "")}"
      data-every="${esc(String(everyMins ?? ""))}">${esc(tickText)}</span></header>

${faultBand}
<div class="wrap">${n === 0
  ? `<div class="empty"><strong>Nothing was read.</strong> data/index.json lists no sources —
     either the manifest failed to load or every source is disabled. This is not an all-clear.</div>`
  : `<table><thead><tr>
<th class="h-st">State</th><th class="h-op">Operator</th><th class="h-lo">Location</th>
<th class="h-cm">Commodities</th><th class="h-n">Rows</th><th class="h-pr">Priced</th>
<th class="h-ck">Checked</th><th class="h-pf">Platform</th><th class="h-ph">Phone</th>
<th class="h-no">Note</th>
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
  <span><b style="color:var(--late)">${GLYPH.late}</b> needs a look — held price, still published</span>
  <span><b style="color:var(--down)">${GLYPH.down}</b> down — past ${WITHDRAW_H}h, withdrawn from the feed</span>
  <span>“due” is asked for, not promised — GitHub's scheduler is best effort</span>
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

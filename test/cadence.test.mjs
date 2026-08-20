/* The board says how long since the last run and when the next is due.
 *
 * Asked for on 2026-08-20, and the reason it earns its place is what was
 * measured that day: the cron asks for six runs an hour through the trading
 * day, and GitHub delivered ONE in the 13:00 UTC hour and TWO in the 14:00
 * hour. Every source was green — truthfully, each had been read successfully —
 * while the whole job quietly ran at a sixth of its stated rate. "Green"
 * answers "did the last read work". It does not answer "when was it", and that
 * is the question a stale price actually turns on.
 *
 * THE SCHEDULE IS READ FROM THE WORKFLOW FILE. A cadence written in two places
 * is a cadence that disagrees with itself, and this page exists to be believed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cronsOf, cronField, cronMatches, nextFire, agoWords, dueWords, render } from "../scripts/status.mjs";

const WF = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
const CRONS = cronsOf(WF);

test("the schedule is read out of the workflow, not restated here", () => {
  assert.deepEqual(CRONS, [
    "3,13,23,33,43,53 12-21 * * 1-5",
    "25 0-11,22-23 * * 1-5",
    "25 */3 * * 6,0",
  ]);
  assert.deepEqual(cronsOf("no crons here"), []);
  assert.deepEqual(cronsOf(undefined), []);
});

test("a cron field understands lists, ranges, steps and stars", () => {
  assert.equal(cronField("3,13,23", 13, 0, 59), true);
  assert.equal(cronField("3,13,23", 14, 0, 59), false);
  assert.equal(cronField("12-21", 12, 0, 23), true);
  assert.equal(cronField("12-21", 21, 0, 23), true);
  assert.equal(cronField("12-21", 22, 0, 23), false);
  assert.equal(cronField("*/3", 0, 0, 23), true);
  assert.equal(cronField("*/3", 3, 0, 23), true);
  assert.equal(cronField("*/3", 4, 0, 23), false);
  assert.equal(cronField("*", 17, 0, 23), true);
  assert.equal(cronField("0-11,22-23", 23, 0, 23), true);
  assert.equal(cronField("0-11,22-23", 12, 0, 23), false);
  /* Junk must not match. A cadence claim built on a misparse is worse than no
     claim, because somebody will believe it. */
  assert.equal(cronField("nonsense", 5, 0, 59), false);
  assert.equal(cronField("*/0", 5, 0, 59), false);
});

test("the trading-day cron fires on the tens past, on weekdays, in its own hours", () => {
  const at = (iso) => cronMatches(CRONS[0], new Date(iso));
  assert.equal(at("2026-08-20T14:53:00Z"), true, "Thursday 14:53 UTC");
  assert.equal(at("2026-08-20T14:54:00Z"), false);
  assert.equal(at("2026-08-20T11:53:00Z"), false, "before the window");
  assert.equal(at("2026-08-20T22:53:00Z"), false, "after the window");
  assert.equal(at("2026-08-22T14:53:00Z"), false, "Saturday");
});

test("the weekend cron is three-hourly and only at the weekend", () => {
  const at = (iso) => cronMatches(CRONS[2], new Date(iso));
  assert.equal(at("2026-08-22T15:25:00Z"), true, "Saturday 15:25");
  assert.equal(at("2026-08-23T00:25:00Z"), true, "Sunday 00:25");
  assert.equal(at("2026-08-22T16:25:00Z"), false, "not on the off hours");
  assert.equal(at("2026-08-20T15:25:00Z"), false, "Thursday is not the weekend");
});

test("the next run is found in each of the three windows", () => {
  const next = (iso) => {
    const t = nextFire(CRONS, Date.parse(iso));
    return { iso: new Date(t).toISOString(), inMins: Math.round((t - Date.parse(iso)) / 60000) };
  };
  /* Mid trading day: ten minutes, which is what the cron promises. */
  assert.deepEqual(next("2026-08-20T14:49:00Z"), { iso: "2026-08-20T14:53:00.000Z", inMins: 4 });
  /* Just after the window closes, it falls through to the hourly one. */
  assert.equal(next("2026-08-20T21:58:00Z").iso, "2026-08-20T22:25:00.000Z");
  /* Saturday lunchtime: three-hourly, so a long wait — and the board should
     say so rather than implying ten minutes. */
  assert.equal(next("2026-08-22T13:00:00Z").iso, "2026-08-22T15:25:00.000Z");
  /* Before the trading window opens on a weekday. */
  assert.equal(next("2026-08-20T11:40:00Z").iso, "2026-08-20T12:03:00.000Z");
});

test("no schedule, no claim", () => {
  assert.equal(nextFire([], Date.now()), null);
  assert.equal(nextFire(CRONS, NaN), null);
  assert.equal(nextFire(["nonsense"], Date.parse("2026-08-20T14:00:00Z")), null);
});

test("the words are words, not arithmetic homework", () => {
  assert.equal(agoWords(0), "just now");
  assert.equal(agoWords(1), "1 minute ago");
  assert.equal(agoWords(47), "47 minutes ago");
  assert.equal(agoWords(95), "1h 35m ago");
  assert.equal(agoWords(NaN), "at an unknown time");
  assert.equal(dueWords(6), "next run due in 6 minutes");
  assert.equal(dueWords(1), "next run due in a minute");
  assert.equal(dueWords(0), "next run due now");
  assert.equal(dueWords(-1), "next run was due 1 minute ago");
  assert.equal(dueWords(-41), "next run was due 41 minutes ago");
  assert.equal(dueWords(-125), "next run was due 2h 05m ago");
  assert.equal(dueWords(NaN), "next run: no schedule found");
});

/* ---- what actually lands on the page ------------------------------------ */

const INDEX = {
  generated: "2026-08-20T14:49:30.654Z",
  counts: { total: 1, live: 1, refused: 0, broken: 0 },
  sources: [{ id: "boyceville", operator: "Big River", location: "Boyceville", usState: "WI",
              health: "live", status: "ok", rows: 7, platform: "cashbidssingle",
              checkedAt: "2026-08-20T14:49:30.654Z", pricedAt: "2026-08-20T14:49:30.654Z" }],
};

test("the page carries the three numbers the ticker needs, and nothing else", () => {
  const html = render(INDEX, Date.parse("2026-08-20T14:51:00Z"), CRONS);
  assert.match(html, /data-read="2026-08-20T14:49:30\.654Z"/);
  assert.match(html, /data-due="2026-08-20T14:53:00\.000Z"/);
  assert.match(html, /data-every="10"/, "ten minutes is what the trading-day cron asks for");
  /* The baked words are true at bake time and are what a reader with no
     JavaScript sees. */
  assert.match(html, /read 1 minute ago · next run due in 2 minutes/);
});

test("an overdue board says so in the baked HTML too, not only once the script runs", () => {
  const html = render(INDEX, Date.parse("2026-08-20T15:36:00Z"), CRONS);
  /* 14:49:30.654 to 15:36:00.000 is 46 min 29 s, which rounds to 46. The first
     draft of this test said 47 because the arithmetic was done in my head
     without the .654. The code was right. */
  assert.match(html, /read 46 minutes ago · next run was due 43 minutes ago/);
});

test("with no schedule the board still says how old the read is and claims nothing more", () => {
  const html = render(INDEX, Date.parse("2026-08-20T14:51:00Z"), []);
  /* Assert on the TICK SPAN, not the document: the inline script necessarily
     contains the phrase "next run due in", so a whole-page doesNotMatch is a
     test of the wrong thing and passes or fails for the wrong reason. */
  const tick = html.match(/<span class="tick"[\s\S]*?>([^<]*)<\/span>/)[1];
  assert.equal(tick, "read 1 minute ago");
  assert.match(html, /data-due=""/);
  assert.match(html, /data-every=""/);
});

test("the legend says plainly that due is not the same as will", () => {
  /* The whole reason this line exists is that the schedule is not being
     honoured. A countdown that implies it is would be a new way to mislead. */
  const html = render(INDEX, Date.now(), CRONS);
  assert.match(html, /best effort/);
});

test("day-of-month and day-of-week are an OR when both are set, as cron defines it", () => {
  /* Nothing in this repository restricts day-of-month, so no schedule here can
     tell the OR from an AND — which means only a direct test can. Getting it
     backwards later would show up as "the board lies about when the next run
     is", which is the one thing this page must not do. */
  const c = "0 12 1 * 1";                 // noon on the 1st, OR any Monday
  assert.equal(cronMatches(c, new Date("2026-09-01T12:00:00Z")), true, "the 1st, a Tuesday");
  assert.equal(cronMatches(c, new Date("2026-09-07T12:00:00Z")), true, "a Monday, not the 1st");
  assert.equal(cronMatches(c, new Date("2026-09-08T12:00:00Z")), false, "neither");
  /* Only day-of-month set: it is the only thing that matters. */
  assert.equal(cronMatches("0 12 1 * *", new Date("2026-09-01T12:00:00Z")), true);
  assert.equal(cronMatches("0 12 1 * *", new Date("2026-09-07T12:00:00Z")), false);
  /* Only day-of-week set: likewise. */
  assert.equal(cronMatches("0 12 * * 1", new Date("2026-09-07T12:00:00Z")), true);
  assert.equal(cronMatches("0 12 * * 1", new Date("2026-09-01T12:00:00Z")), false);
  /* Cron lets Sunday be 0 or 7. */
  assert.equal(cronMatches("0 12 * * 7", new Date("2026-09-06T12:00:00Z")), true, "Sunday as 7");
  assert.equal(cronMatches("0 12 * * 0", new Date("2026-09-06T12:00:00Z")), true, "Sunday as 0");
});

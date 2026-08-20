/* THE BOARD KEEPS CENTRAL TIME.
 *
 * data/ is UTC and stays UTC. This is the display layer, which was printing
 * 22:47 for a board read at 5:47 in the afternoon — a five-hour error, which is
 * exactly the size that makes a fresh read look stale to the person reading it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, stateOf, local, zoneAbbr, ZONE } from "../scripts/status.mjs";

test("the zone is named, not an offset", () => {
  assert.equal(ZONE, "America/Chicago");
});

test("a UTC instant is shown as central wall time", () => {
  /* The 2026-08-19 22:47:53Z read. On the board it must say 17:47:53. */
  assert.deepEqual(local("2026-08-19T22:47:53.569Z"), { day: "2026-08-19", time: "17:47:53" });
  assert.equal(zoneAbbr("2026-08-19T22:47:53.569Z"), "CDT");
});

test("winter is CST and summer is CDT, without anyone changing anything", () => {
  /* A hardcoded -5 would be an hour wrong for four months of the year. */
  assert.deepEqual(local("2026-01-15T22:47:53Z"), { day: "2026-01-15", time: "16:47:53" });
  assert.equal(zoneAbbr("2026-01-15T22:47:53Z"), "CST");
  assert.equal(zoneAbbr("2026-07-15T22:47:53Z"), "CDT");
});

test("the day rolls at LOCAL midnight, not five hours early", () => {
  /* 2026-08-20T02:00Z is still the evening of the 19th here. A row stamped
     06:00Z is the small hours of the 20th. The header day and the row's day
     must both agree with the elevator's calendar, or the row that "keeps its
     date because it is from another day" fires five hours off. */
  assert.equal(local("2026-08-20T02:00:00Z").day, "2026-08-19");
  assert.equal(local("2026-08-20T06:00:00Z").day, "2026-08-20");
});

test("an unparseable or missing timestamp does not throw", () => {
  assert.equal(local(null), null);
  assert.equal(local("never"), null);
  assert.equal(local(undefined), null);
});

const index = (over = {}) => ({
  generated: "2026-08-19T22:47:53.569Z",
  counts: { total: 1, live: 1, refused: 0, broken: 0 },
  sources: [{
    id: "boyceville", operator: "Big River Resources", location: "Boyceville",
    usState: "WI", health: "live", rows: 7, platform: "cashbidssingle",
    pricedAt: "2026-08-19T21:04:57.097Z", checkedAt: "2026-08-19T22:47:53.569Z",
    commodities: ["Corn"], ...over,
  }],
});

test("the rendered header carries the local date and the zone, and never says UTC", () => {
  const html = render(index(), Date.parse("2026-08-19T22:50:00Z"));
  assert.match(html, /2026-08-19 · read 17:47:53 CDT/);
  assert.ok(!/UTC/.test(html), "the board still says UTC somewhere");
});

test("row clocks are local too", () => {
  const html = render(index(), Date.parse("2026-08-19T22:50:00Z"));
  assert.match(html, />16:04:57</, "pricedAt 21:04:57Z should read 16:04:57");
  assert.match(html, />17:47:53</, "checkedAt 22:47:53Z should read 17:47:53");
});

test("a row from another LOCAL day keeps its date", () => {
  const i = index({ pricedAt: "2026-08-19T04:00:00Z" });   // 23:00 on the 18th, here
  const html = render(i, Date.parse("2026-08-19T22:50:00Z"));
  assert.match(html, />08-18 23:00</);
});

test("freshness is still judged in UTC milliseconds", () => {
  /* The conversion is display-only. If it ever leaked into stateOf, every
     source would read five hours old and the whole board would go late. */
  const now = Date.parse("2026-08-19T22:50:00Z");
  assert.equal(stateOf({ health: "live", checkedAt: "2026-08-19T22:47:53Z" }, now), "live");
  assert.equal(stateOf({ health: "live", checkedAt: "2026-08-19T14:00:00Z" }, now), "late");   // 8.8h
  assert.equal(stateOf({ health: "live", checkedAt: "2026-08-19T04:00:00Z" }, now), "down");   // 18.8h
  /* And the giveaway if the conversion ever leaked in: a five-hour shift would
     turn this 1-hour-old read into a 6-hour-old one and flip it to late. */
  assert.equal(stateOf({ health: "live", checkedAt: "2026-08-19T21:50:00Z" }, now), "live");
});

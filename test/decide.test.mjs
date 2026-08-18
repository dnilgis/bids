/* The write-or-skip decision, and the two clocks.
 *
 * These are the tests for the bug that was shipped and caught: one timestamp
 * that only moved on a price change made a quiet weekend look identical to a
 * dead reader. Every case below is a state that actually occurs on a real
 * calendar, not a synthetic edge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, commitMessage, HEARTBEAT_H } from "../lib/decide.mjs";

const bid = (cash) => ({
  seq: 0, commodity: "Corn", delivery: "August", futuresMonth: "Sep 26",
  cash, basisDollars: -0.52, basisCents: -52, futuresPriceCents: (cash + 0.52) * 100,
});

const fileAt = (iso, cash = 4.075) => ({
  schema: "bigriver-boyceville/2",
  source: { location: "Boyceville" },
  checkedAt: iso, pricedAt: iso, status: "ok", count: 1, bids: [bid(cash)],
});

const hoursLater = (iso, h) => new Date(Date.parse(iso) + h * 36e5).toISOString();

const T0 = "2026-08-14T18:00:00.000Z";   // Friday afternoon

test("the first run always writes", () => {
  const v = decide(null, fileAt(T0));
  assert.equal(v.write, true);
  assert.equal(v.changed, true);
  assert.match(v.reason, /first run/);
});

test("a moved price writes and stamps a new pricedAt", () => {
  const prev = fileAt(T0, 4.075);
  const next = fileAt(hoursLater(T0, 0.2), 4.125);
  const v = decide(prev, next);
  assert.equal(v.write, true);
  assert.equal(v.changed, true);
  assert.equal(v.file.pricedAt, next.pricedAt);
});

test("an unchanged price inside the heartbeat writes nothing", () => {
  const prev = fileAt(T0);
  const next = fileAt(hoursLater(T0, HEARTBEAT_H - 1));
  const v = decide(prev, next);
  assert.equal(v.write, false);
  assert.equal(v.changed, false);
});

test("an unchanged price carries the OLD pricedAt forward", () => {
  const prev = fileAt(T0);
  const next = fileAt(hoursLater(T0, 1));
  const v = decide(prev, next);
  assert.equal(v.file.pricedAt, T0, "pricedAt must not move when the price did not");
  assert.equal(v.file.checkedAt, next.checkedAt, "checkedAt must move on every read");
});

test("past the heartbeat, an unchanged price still writes", () => {
  const prev = fileAt(T0);
  const next = fileAt(hoursLater(T0, HEARTBEAT_H + 0.5));
  const v = decide(prev, next);
  assert.equal(v.write, true);
  assert.equal(v.changed, false, "a heartbeat is not a price change");
  assert.equal(v.file.pricedAt, T0);
});

test("THE MONDAY MORNING CASE: a quiet weekend is not a dead reader", () => {
  /* Friday 1pm CT their board stops moving. Nothing changes until Monday.
     With one clock, Monday's file would be 63 hours old and both Emmert sites
     would withdraw a perfectly good price. With two, `pricedAt` is 63 hours
     old -- true, and fine -- while `checkedAt` never gets more than the
     heartbeat behind. */
  let committed = fileAt(T0);
  const priced = committed.pricedAt;
  let t = T0;
  let writes = 0;
  for (let i = 0; i < 63; i++) {          // 63 hourly polls, no price change
    t = hoursLater(t, 1);
    const v = decide(committed, fileAt(t, 4.075));
    if (v.write) { committed = v.file; writes++; }
  }
  const priceAge = (Date.parse(t) - Date.parse(committed.pricedAt)) / 36e5;
  const checkAge = (Date.parse(t) - Date.parse(committed.checkedAt)) / 36e5;

  assert.equal(committed.pricedAt, priced, "the price never moved, so pricedAt must not");
  assert.ok(priceAge >= 62, `price should read as ~63h old, got ${priceAge}h`);
  assert.ok(checkAge <= HEARTBEAT_H,
    `checkedAt must never fall more than the heartbeat behind, got ${checkAge}h`);
  assert.ok(checkAge < 14,
    "and must stay inside the Emmert Worker's FEED_MAX_AGE_H of 14 hours");
  assert.ok(writes >= 9 && writes <= 12,
    `63 quiet hours should cost about 63/${HEARTBEAT_H} commits, got ${writes}`);
});

test("a heartbeat costs far fewer commits than writing every poll", () => {
  /* Ten-minute polls for a full quiet trading day: 54 reads. Writing each
     would be 54 commits. */
  let committed = fileAt(T0);
  let t = T0, writes = 0, reads = 0;
  for (let i = 0; i < 54; i++) {
    t = hoursLater(t, 1 / 6);
    reads++;
    const v = decide(committed, fileAt(t, 4.075));
    if (v.write) { committed = v.file; writes++; }
  }
  assert.equal(reads, 54);
  assert.ok(writes <= 2, `54 quiet reads should write at most twice, got ${writes}`);
});

test("a schema/1 file's `observed` upgrades instead of resetting the price age", () => {
  const legacy = { ...fileAt(T0), pricedAt: undefined, observed: T0 };
  delete legacy.pricedAt;
  const v = decide(legacy, fileAt(hoursLater(T0, 1)));
  assert.equal(v.file.pricedAt, T0,
    "must not silently claim the price changed the moment we upgraded the schema");
});

test("an unreadable previous checkedAt writes rather than skipping forever", () => {
  const broken = { ...fileAt(T0), checkedAt: "not a date" };
  const v = decide(broken, fileAt(hoursLater(T0, 0.1)));
  assert.equal(v.write, true, "a broken clock must not wedge the reader shut");
});

test("a change in row count is a change even at identical prices", () => {
  const prev = fileAt(T0);
  const next = { ...fileAt(hoursLater(T0, 0.1)), count: 2 };
  assert.equal(decide(prev, next).changed, true);
});

test("a heartbeat and a price change do not read the same in git log", () => {
  const changed = commitMessage({ changed: true, file: fileAt(T0, 4.075) });
  const beat = commitMessage({ changed: false, file: fileAt(T0, 4.075) });
  assert.notEqual(changed, beat);
  assert.match(changed, /August 4\.075 basis -0\.52/);
  assert.match(beat, /heartbeat/);
});

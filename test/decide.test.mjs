/* The write-or-skip decision, and the two clocks.
 *
 * These are the tests for the bug that was shipped and caught: one timestamp
 * that only moved on a price change made a quiet weekend look identical to a
 * dead reader. Every case below is a state that actually occurs on a real
 * calendar, not a synthetic edge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, commitMessage, HEARTBEAT_H, movedSources } from "../lib/decide.mjs";

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

/* ---- guards added after the 2026-08-17 panel ---------------------------- */

import { checkMove, MAX_MOVE, priceChanged } from "../lib/board.mjs";

test("THE MAX-MOVE RAIL: a bad futures quote that satisfies the identity is refused", () => {
  /* Their Dec futures prints 584 instead of 484 and their board recomputes
     cash from it. Every existing guard passes: the identity balances exactly,
     the value is inside the sanity band, the columns are right. Only the size
     of the move gives it away. */
  const prev = { bids: [{ delivery: "December", cash: 4.34, basisDollars: -0.50 }] };
  const bad = { bids: [{ delivery: "December", cash: 5.34, basisDollars: -0.50 }] };
  const hits = checkMove(prev, bad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].delivery, "December");
  assert.ok(Math.abs(hits[0].move - 1.0) < 1e-9);

  // and the identity really does balance on it, which is the whole point
  const derived = Math.round((5.34 - -0.50) * 10000) / 10000;
  assert.equal(derived, 5.84, "the wrong number is internally consistent");
});

test("the rail passes an ordinary day's movement", () => {
  const prev = { bids: [{ delivery: "August", cash: 4.075, basisDollars: -0.52 }] };
  for (const cash of [4.075, 4.125, 3.95, 4.40, 3.70]) {
    const next = { bids: [{ delivery: "August", cash, basisDollars: -0.52 }] };
    assert.equal(checkMove(prev, next).length, 0, `${cash} should pass`);
  }
  assert.ok(MAX_MOVE > 0.35 * 2,
    "must clear two consecutive limit moves, or it will refuse a real market");
});

test("the rail never blocks a first run or a newly-appearing delivery month", () => {
  const next = { bids: [{ delivery: "March", cash: 4.9, basisDollars: -0.6 }] };
  assert.equal(checkMove(null, next).length, 0, "first run has nothing to compare");
  assert.equal(checkMove({ bids: [] }, next).length, 0, "a new month has no previous reading");
});

test("A FROZEN SOURCE BOARD EVENTUALLY SAYS SO", () => {
  /* The carry-forward had no ceiling. A board that stops updating polls fine
     forever: checkedAt current, Emmert's 14h gate never trips, and both sites
     publish a weeks-old bid as today's price. */
  let committed = fileAt(T0);
  let t = T0;
  for (let i = 0; i < 120; i++) {
    t = hoursLater(t, 6);
    const v = decide(committed, fileAt(t, 4.075));
    if (v.write) committed = v.file;
  }
  assert.equal(committed.pricedAt, T0, "the price never moved, so pricedAt must not");
  assert.equal(committed.status, "stale");
  assert.match(committed.staleReason, /shown the same numbers for \d+ days/);
  assert.match(committed.staleReason, /The reader is healthy; the source is not moving/);
});

test("...and marking it stale does not itself look like a price change", () => {
  /* The bug this replaces: priceChanged() compared `status`, which decide()
     now writes. So the poll after the file went stale saw our own annotation
     differ from buildFile's fresh "ok", called it a price change, and stamped
     pricedAt as now -- erasing the very evidence it had just recorded. */
  const stale = { ...fileAt(T0), status: "stale", staleReason: "x" };
  const fresh = fileAt(hoursLater(T0, 6), 4.075);
  assert.equal(priceChanged(stale, fresh), false,
    "our own status annotation must not read as news");
  const v = decide(stale, fresh);
  assert.equal(v.changed, false);
  assert.equal(v.file.pricedAt, T0, "pricedAt must survive the stale flag");
});

test("a real move after a frozen spell is still seen, and clears the flag", () => {
  const stale = { ...fileAt(T0), status: "stale", staleReason: "x" };
  const moved = fileAt(hoursLater(T0, 6), 4.30);
  const v = decide(stale, moved);
  assert.equal(v.changed, true);
  assert.equal(v.file.status, "ok");
  assert.equal(v.file.pricedAt, moved.pricedAt);
});

test("A FUTURE-DATED checkedAt WRITES rather than suppressing forever", () => {
  /* A negative sinceCheck is finite and less than the heartbeat, so it used to
     suppress every write until the wall clock caught up -- tested at 30 days.
     And since nothing was written, the future stamp persisted, so consumers
     computing now - checkedAt saw a negative number and read the feed as
     perpetually fresh. The exact state the two clocks exist to expose. */
  const future = fileAt(hoursLater(T0, 24 * 30));
  const v = decide(future, fileAt(T0));
  assert.equal(v.write, true);
  assert.match(v.reason, /FUTURE/);
});

test("a previous file with no checkedAt does not invent a 26-year-old reading", () => {
  /* `Date.parse(previous.checkedAt ?? 0)` is Date.parse("0") = 2000-01-01, not
     NaN, so the log printed "heartbeat (last checked 233428.0h ago)" -- a
     fabricated observation in a project whose first rule is not to invent
     numbers. */
  const noClock = { ...fileAt(T0) };
  delete noClock.checkedAt;
  const v = decide(noClock, fileAt(hoursLater(T0, 1)));
  assert.equal(v.write, true);
  assert.match(v.reason, /no readable checkedAt/);
  assert.doesNotMatch(v.reason, /\d{4,}\.\dh/, "must not print an invented age");
});

/* ---- which sources moved, for the step that tells the two sites ---------- */

test("a move is reported and a heartbeat is not", () => {
  /* This repository commits on EVERY run, because data/index.json carries
     `generated: now`. So "did we commit" cannot mean "the price moved", and
     the price moving is the only thing the Emmert sites need to hear about.
     decide() already tells a move from a heartbeat; this is that answer per
     source, in a form a shell step can read. */
  assert.deepEqual(movedSources([
    { id: "boyceville", wrote: true, changed: true },
    { id: "albertlea", wrote: true, changed: false },   // heartbeat
    { id: "flashgrain-thorp", wrote: false, changed: false },
  ]), ["boyceville"]);
});

test("a source that refused is never reported as having moved", () => {
  /* A refusal writes nothing and holds the last good file. Telling the sites
     to rebuild off a file that did not change would be a rebuild for nothing,
     and worse, would read in their log as a price move that never happened. */
  assert.deepEqual(movedSources([
    { id: "boyceville", health: "refused", wrote: false, changed: false },
    { id: "babgrain-auburn", health: "broken", wrote: false },
  ]), []);
});

test("it is total: no results, junk results, missing fields", () => {
  assert.deepEqual(movedSources([]), []);
  assert.deepEqual(movedSources(null), []);
  assert.deepEqual(movedSources(undefined), []);
  assert.deepEqual(movedSources([null, {}, { wrote: true }, { changed: true }]), []);
  /* Truthy-but-not-true must not count: `wrote` and `changed` are booleans and
     anything else is a bug upstream, not a licence to guess. */
  assert.deepEqual(movedSources([{ id: "x", wrote: 1, changed: "yes" }]), []);
});

test("A DRY RUN NEVER TELLS THE SITES ANYTHING", () => {
  /* This is the case `wrote` is carrying, and it is the whole reason the check
     is on both fields. decide() never returns changed-without-write, so from
     decide's side the two look redundant — but poll.mjs sets `wrote` only when
     `verdict.write && !dryRun`, so on a dry run or a --fixture read a source is
     `changed: true, wrote: false`.
     Same doctrine as "a fixture can never write": test data must never be one
     forgotten flag away from firing a rebuild of two live sites. */
  assert.deepEqual(movedSources([{ id: "boyceville", wrote: false, changed: true }]), []);
  assert.deepEqual(movedSources([
    { id: "boyceville", wrote: false, changed: true },
    { id: "albertlea", wrote: false, changed: true },
  ]), []);
});

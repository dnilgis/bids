/* ONE PLATFORM'S OUTAGE MUST NOT TAKE DOWN THE READER.
 *
 * These use the REAL message text from run 33580292481, copied out of the log
 * rather than paraphrased — the whole guard turns on matching one phrase, and a
 * guard tested against my memory of a log tests my memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Breaker, loadedNothing, Skipped, isSkip } from "../lib/breaker.mjs";

/* Verbatim from the run that started this. */
const EMPTY = "no readable response matching https://api.bushelpowered.com/api/markets/"
  + "aggregator/bids/v1/GetBidsList within 45000ms. The page did make 0 request(s): "
  + "[browser said: [3332:3356:0902/014056.401504:ERROR:google_apis/gcm/engine/"
  + "registration_request.cc:291] Registration response error message: PHONE_REGISTRATION_ERROR]";

/* Also verbatim, from the 19:59 index — the SAME timeout, but the page worked
   and made 29 requests. This is the case that must NOT trip the breaker. */
const BUSY = "no readable response matching https://api.bushelpowered.com/api/markets/"
  + "aggregator/bids/v1/GetBidsList within 45000ms. The page did make 29 request(s): "
  + "www.chsunitedplains.com/, cdn.cookielaw.org/scripttemplates/otSDKStub.js";

test("an empty page is recognised from the real message", () => {
  assert.equal(loadedNothing(EMPTY), true);
});

/* THE DISTINCTION THE WHOLE GUARD RESTS ON. A page that made 29 requests is a
   site that WORKS and whose one call we missed — a selector or endpoint problem
   on one source, saying nothing about the platform. Treating it as an outage
   would let a single bad source switch off a working platform. */
test("a page that loaded but missed our call is NOT an outage", () => {
  assert.equal(loadedNothing(BUSY), false);
});

test("rubbish input does not throw or trip anything", () => {
  for (const v of [null, undefined, "", 0, {}, "some other failure"]) {
    assert.equal(loadedNothing(v), false);
  }
});

test("three consecutive empty loads trip it; two do not", () => {
  const b = new Breaker({ strikes: 3 });
  assert.equal(b.allows("bushel"), true);
  assert.equal(b.fail("bushel", EMPTY), false);
  assert.equal(b.fail("bushel", EMPTY), false);
  assert.equal(b.allows("bushel"), true, "two failures must not switch a platform off");
  assert.equal(b.fail("bushel", EMPTY), true, "the third is the one that trips it");
  assert.equal(b.allows("bushel"), false);
  assert.deepEqual(b.down, ["bushel"]);
});

/* CONSECUTIVE, NOT CUMULATIVE. A platform with three scattered failures across a
   healthy hour is a platform that is up. Without the reset, a busy day of
   ordinary flakiness would switch off a working reader. */
test("a page that loads resets the count", () => {
  const b = new Breaker({ strikes: 3 });
  b.fail("bushel", EMPTY);
  b.fail("bushel", EMPTY);
  b.ok("bushel");
  assert.equal(b.fail("bushel", EMPTY), false, "the count did not reset on a good load");
  assert.equal(b.allows("bushel"), true);
});

test("one platform going down does not touch another", () => {
  const b = new Breaker({ strikes: 3 });
  for (let i = 0; i < 3; i++) b.fail("bushel", EMPTY);
  assert.equal(b.allows("bushel"), false);
  assert.equal(b.allows("dtn-cs"), true,
    "the whole point is that the other platforms still get read");
  assert.deepEqual(b.down, ["bushel"]);
});

test("a working site that times out never trips it, however often", () => {
  const b = new Breaker({ strikes: 3 });
  for (let i = 0; i < 20; i++) assert.equal(b.fail("bushel", BUSY), false);
  assert.equal(b.allows("bushel"), true);
});

/* The arithmetic that made this necessary, kept as a test so the reason cannot
   drift away from the code. */
test("the numbers that forced this are written down", () => {
  const pages = 25, timeoutS = 45, budgetS = 8 * 60;
  assert.ok(pages * timeoutS > budgetS,
    "if this ever stops being true the breaker's justification has changed");
  assert.equal(Math.floor(budgetS / timeoutS), 10,
    "a pass can reach about ten dead pages before the outer timeout kills it");
});

/* ── THE STARVATION, AND THE LABEL ──────────────────────────────────────────
 *
 * Run 91003295176, 02:11Z. The breaker did its job: it tripped after three
 * empty page loads (2.3 min) and saved twenty-two more (16.5 min) against a
 * six-minute pass budget. Both of the things it got wrong were downstream of
 * that correct decision.
 *
 *   1. It reported "bushel is not answering" in a pass where 193 Bushel
 *      sources had just been read successfully. All 23 failures were CHS.
 *   2. Sources are read in id order, so the trip took down everything
 *      alphabetically after chs* on the same platform -- `coopelev` and seven
 *      `michag` sources, every one of them `ok` at 19:59. And it would have
 *      taken them down again on every following pass, for as long as CHS was
 *      out. Nothing in the design would have let them back.
 */
const EMPTY_LOAD = "no readable response within 45000ms. The page did make 0 request(s): []";
const tripped = (strikes = 3) => {
  const b = new Breaker({ strikes });
  for (let i = 0; i < strikes; i++) b.fail("bushel", EMPTY_LOAD, `chsoperator${i}`);
  return b;
};

test("the trip names who actually failed, not where they are hosted", () => {
  const b = tripped();
  assert.deepEqual(b.culprits("bushel"), ["chsoperator0", "chsoperator1", "chsoperator2"]);
  assert.deepEqual(b.culprits("dtn-cs"), [], "a platform nobody blamed blames nobody");
});

test("a source that read cleanly last pass is still attempted after a trip", () => {
  const b = tripped();
  assert.equal(b.allows("bushel", false), false, "no evidence: skipped, as before");
  assert.equal(b.allows("bushel", true), true, "read cleanly last pass: still worth one load");
});

test("a single operator's outage cannot starve the platform, pass after pass", () => {
  /* The real shape: CHS is down, michag is fine. michag must be read every
     pass, indefinitely — its successful load resets the reprieve. */
  const b = tripped();
  for (let pass = 0; pass < 50; pass++) {
    assert.equal(b.allows("bushel", true), true, `starved on pass ${pass}`);
    b.ok("bushel");                       // michag loaded
  }
});

test("a genuine platform outage stops after `strikes` more loads, not forever", () => {
  /* The other shape: Bushel really is down. The reprieve must be bounded or a
     platform-wide outage costs one page load per previously-ok source — which
     on this manifest is 190 of them, or two and a half hours. */
  const b = tripped();
  let extra = 0;
  while (b.allows("bushel", true) && extra < 500) { b.fail("bushel", EMPTY_LOAD, "anyone"); extra++; }
  assert.equal(extra, 3, "bounded by the same strike limit, and no larger");
});

test("a reprieved load that fails does not re-announce the trip", () => {
  const b = tripped();
  assert.equal(b.fail("bushel", EMPTY_LOAD, "x"), false,
    "returning true again would print a second ::error for one outage");
});

test("not attempted is its own class, and it is not an Error we sniff for", () => {
  /* poll.mjs used to classify by "is it a Refused? no -> broken", so a source
     it had chosen not to touch was recorded as broken. 127 of them, in a run
     the board reported as 153 failures out of 23. A type, so the test is a
     type test and not a regex over prose somebody will reword. */
  assert.equal(isSkip(new Skipped("not attempted")), true);
  assert.equal(isSkip(new Error("not attempted")), false);
  assert.equal(isSkip(null), false);
  assert.ok(new Skipped("x") instanceof Error, "it still behaves as an Error at the throw site");
});

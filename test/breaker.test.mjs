/* ONE PLATFORM'S OUTAGE MUST NOT TAKE DOWN THE READER.
 *
 * These use the REAL message text from run 33580292481, copied out of the log
 * rather than paraphrased — the whole guard turns on matching one phrase, and a
 * guard tested against my memory of a log tests my memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Breaker, loadedNothing } from "../lib/breaker.mjs";

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

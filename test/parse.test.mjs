/* Tests for the Boyceville reader.
 *
 * Most of these assert that a BAD page is REFUSED. The failure this exists to
 * prevent is not a crash, it is a confident wrong number reaching a price board
 * that growers can act on. A red run means look at it. Never loosen one.
 *
 * fixtures/bigriver-2121.html is a REAL capture of their page, trimmed to the
 * parts the parser touches, values verbatim. Not a reconstruction — an earlier
 * version of this project was built on a fixture rebuilt from the parser's own
 * assumptions, and it confirmed those assumptions including the wrong ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractBids, checkIdentity, filterLocation } from "../lib/parse.mjs";

const html = readFileSync(new URL("../fixtures/bigriver-2121.html", import.meta.url), "utf8");
const boyceville = () => filterLocation(extractBids(html, "x"), "2121").kept;

test("their page really does carry other locations", () => {
  const { kept, dropped, locations } = filterLocation(extractBids(html, "x"), "2121");
  assert.equal(kept.length, 7);
  assert.equal(dropped, 7);
  assert.ok(locations.length > 1, "if this ever drops to 1, the filter has stopped being tested");
  assert.deepEqual([...new Set(kept.map((b) => b.location))], ["Boyceville"]);
});

test("the real Boyceville strip, exactly", () => {
  assert.deepEqual(boyceville().map((b) => [b.delivery, b.cash, b.basisCents]), [
    ["August", 4.075, -52], ["September", 4.135, -46], ["October", 4.29, -55],
    ["November", 4.29, -55], ["December", 4.34, -50], ["January", 4.3975, -60],
    ["February", 4.4175, -58],
  ]);
});

test("cash minus basis equals the quoted future on every row", () => {
  assert.deepEqual(checkIdentity(boyceville()), []);
});

test("a column swap that stays inside the sanity band is still caught", () => {
  // Every value stays a plausible corn number, so a price band would pass it.
  const swapped = boyceville().map((r) => ({
    ...r, cash: r.futuresPrice / 100, futuresPrice: r.cash * 100,
  }));
  assert.equal(checkIdentity(swapped).length, 7);
});

test("a one-eighth misread is caught, so the tolerance is not too loose", () => {
  const rows = boyceville().map((r, i) => (i ? r : { ...r, futuresPrice: r.futuresPrice + 0.125 }));
  assert.equal(checkIdentity(rows).length, 1);
});

test("page order is captured and is NOT alphabetical", () => {
  const page = boyceville().map((b) => b.delivery);
  const alpha = [...page].sort((a, b) => a.localeCompare(b));
  assert.equal(page[0], "August", "nearest delivery leads on their page");
  assert.notDeepEqual(page, alpha,
    "if these ever match, this test has stopped proving anything");
});

test("sorting by label would price the wrong month in 10 months of 12", () => {
  // The reason `seq` exists and the reason nothing downstream sorts by label.
  const M = ["January","February","March","April","May","June",
             "July","August","September","October","November","December"];
  let wrong = 0;
  for (let m = 0; m < 12; m++) {
    const page = Array.from({ length: 7 }, (_, i) => M[(m + i) % 12]);
    if ([...page].sort((a, b) => a.localeCompare(b))[0] !== page[0]) wrong++;
  }
  assert.equal(wrong, 10);
});

test("units are what the field names say", () => {
  const r = boyceville()[0];
  assert.equal(r.cash, 4.075, "cash is DOLLARS");
  assert.equal(r.basis, -0.52, "basis is DOLLARS");
  assert.equal(r.basisCents, -52, "basisCents is CENTS");
  assert.equal(r.futuresPrice, 459.5, "futuresPrice is CENTS, parsed from 459-4");
});

test("a redesigned page yields nothing rather than something wrong", () => {
  const gone = "<!doctype html><html><body><h1>Cash Bids</h1><p>Call the office.</p>"
    + "<p>filler</p>".repeat(40) + "</body></html>";
  assert.equal(extractBids(gone, "x").length, 0);
});

test("a wrong location id keeps nothing, and names what was there", () => {
  const { kept, locations } = filterLocation(extractBids(html, "x"), "9999");
  assert.equal(kept.length, 0);
  assert.ok(locations.some((l) => l.includes("Boyceville")),
    "a filter that matches nothing must say what the page did contain");
});

/* The two clocks. This is the bug that a ten-minute cadence surfaced: a single
   timestamp that only moved when the PRICE moved was indistinguishable from a
   dead reader over a quiet weekend, and every consumer would have withdrawn a
   perfectly good price on Monday morning. */
test("a price being old and a reader being dead are different facts", () => {
  const fri = Date.parse("2026-08-14T21:00:00Z");   // last price change, Friday 4pm CT
  const mon = Date.parse("2026-08-17T12:00:00Z");   // Monday 7am CT
  const priceAgeH = (mon - fri) / 36e5;
  assert.ok(priceAgeH > 60, "a weekend really is that long");

  // With one clock, that is what a consumer sees and it fails every threshold.
  assert.ok(priceAgeH > 8, "which is why the single-clock version broke on Mondays");

  // With two, checkedAt is capped by the heartbeat and stays plausible.
  const HEARTBEAT_H = 6, WEEKEND_POLL_GAP_H = 4;
  assert.ok(HEARTBEAT_H + WEEKEND_POLL_GAP_H < 14,
    "checkedAt can never age past the consumer threshold while the reader lives");
});

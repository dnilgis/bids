/* THE CEILING THAT LOOKED LIKE AN ABSENCE.
 *
 * getGrainBids defaults to 30 locations per query, and the fetcher this replaces
 * logged BIDS rather than locations — so a query that hit the ceiling was
 * indistinguishable from one that did not, and "this elevator is absent from
 * Barchart" was never a safe claim. These pin the two things that made that
 * possible: how saturation is counted, and how an empty env var is read.
 *
 * The live call cannot be exercised here — ondemand.websol.barchart.com is not
 * reachable from this sandbox and the key is a repository secret. What CAN be
 * tested is everything that decides what to do with an answer, so that is
 * exported and tested rather than left to the first live run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { locationsIn, isSaturated, envInt } from "../scripts/fetch_barchart.mjs";

const bid = (facility, branch, city, state) => ({ facility, branch, city, state });

test("saturation is counted in LOCATIONS, not bids", () => {
  /* One facility quoting thirty contracts is one location. Counting bids here is
     the exact mistake that hid a thirty-location ceiling for months. */
  const many = Array.from({ length: 30 }, () => bid("Acme", "Thorp", "Thorp", "WI"));
  assert.equal(locationsIn(many), 1, "thirty bids from one elevator is one location");
  assert.equal(isSaturated(many, 30), false, "thirty BIDS was read as thirty locations");
});

test("distinct facilities count separately", () => {
  const rows = [bid("A", "x", "Thorp", "WI"), bid("B", "y", "Granton", "WI"), bid("A", "x", "Thorp", "WI")];
  assert.equal(locationsIn(rows), 2);
});

test("a query at the cap is flagged as truncated", () => {
  const rows = Array.from({ length: 200 }, (_, i) => bid(`F${i}`, "b", "c", "IA"));
  assert.equal(isSaturated(rows, 200), true, "a full answer must be reported as truncated");
  assert.equal(isSaturated(rows.slice(0, 199), 200), false);
});

test("with no cap set, nothing is called saturated", () => {
  assert.equal(isSaturated([bid("A", "b", "c", "IA")], 0), false);
  assert.equal(isSaturated([bid("A", "b", "c", "IA")], undefined), false);
});

test("an empty or absent row set is zero locations, not a crash", () => {
  for (const v of [null, undefined, []]) assert.equal(locationsIn(v), 0);
});

/* GitHub Actions passes an unfilled workflow_dispatch input as the empty string,
   and it passes it on SCHEDULED runs too — so a blank box in the Run-workflow
   dialog would take down every scheduled fetch, not just the manual one. */
test("a set-but-empty env var means UNSET, not zero and not a crash", () => {
  const k = "BARCHART_TEST_ONLY_VAR";
  for (const v of ["", "   ", undefined]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    assert.equal(envInt(k, 200), 200, `"${v}" should have fallen back to the default`);
  }
  process.env[k] = "50";
  assert.equal(envInt(k, 200), 50);
  process.env[k] = "0";
  assert.equal(envInt(k, 200), 200, "zero locations is not a request, it is a mistake");
  process.env[k] = "banana";
  assert.equal(envInt(k, 200), 200);
  delete process.env[k];
});

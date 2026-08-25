/* The Bushel probe, against the one real board captured from a customer page.
 *
 * It is a printer, so what is worth testing is the arithmetic it prints: the
 * rounding verdict decides whether a manifest gets "floor-cent" and an EXACT
 * identity check, or a tolerance that quietly widens the torn-read guard.
 *
 * The first version of roundingEvidence read `r.futures`, which is the futures
 * SYMBOL -- "ZCU26" -- and not the price. Every row came out NaN and every
 * location was reported as "no rule explains it", which is the most expensive
 * wrong answer this probe can give: it is the one that sends somebody to widen
 * a tolerance on a board that floors cleanly. The fixture says floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { roundingEvidence } from "../scripts/bushel-probe.mjs";
import { extract } from "../lib/adapters/bushel.mjs";

const rows = extract(readFileSync("fixtures/bushel-chsfarmersalliance.json", "utf8"), "fixture");

test("the captured CHS board floors its cash, and every row says so", () => {
  const e = roundingEvidence(rows);
  assert.equal(e.testable, rows.length, "some rows carried no cash, basis or futures price");
  assert.equal(e.floor, e.testable, `floor explains ${e.floor} of ${e.testable}`);
  assert.ok(e.exact < e.testable, "if the identity were exact there would be nothing to decide");
});

test("the residuals are quarter cents and nothing else", () => {
  /* Corn trades in quarter cents. A residual that is not a multiple of 0.25
     is not display rounding -- it is a misparse, and it must not be waved
     through as one. */
  const e = roundingEvidence(rows);
  for (const r of e.residuals)
    assert.equal(Math.round(r * 4) / 4, r, `${r}c is not a quarter-cent multiple`);
  assert.ok(Math.max(...e.residuals.map(Math.abs)) <= 0.75,
    "a residual larger than three ticks is not display rounding");
});

test("futuresPrice is read, not the futures symbol", () => {
  /* Guards the actual defect rather than its symptom. */
  const one = rows[0];
  assert.equal(typeof one.futures, "string", "the fixture shape has changed");
  assert.equal(typeof one.futuresPrice, "number", "the fixture shape has changed");
  const only = roundingEvidence([one]);
  assert.equal(only.testable, 1, "a row with a price was treated as untestable");
  assert.ok(Number.isFinite(only.residuals[0]), "the residual came out NaN — the symbol is being read as a price");
});

test("every location comes back with an id and a name", () => {
  const seen = new Map();
  for (const r of rows) seen.set(r.locationId, r.location);
  assert.equal(seen.size, 4, "the captured board carries four locations");
  for (const [id, name] of seen) {
    assert.match(id, /^[0-9a-f-]{36}$/, `${name} has no UUID`);
    assert.ok(name && name.trim().length, `${id} has no name`);
  }
});

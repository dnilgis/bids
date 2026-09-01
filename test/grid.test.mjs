/* WHERE WE ASK IS THE WHOLE BALL GAME.
 *
 * AGSIST asked Barchart about fifty hand-picked city ZIPs and reached 405
 * facilities — 22% of the 1,806 this repository had already geocoded. The feed
 * was never the ceiling; the question was. scripts/build_grid.mjs chooses the
 * centres by covering the elevators instead.
 *
 * A cover is easy to get wrong in ways that look fine: a distance function off
 * by a few percent, a centre that will silently truncate, an answer that shifts
 * every run. These test those.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { miles, cover } from "../scripts/build_grid.mjs";

/* THE DISTANCE FUNCTION IS VALIDATED BEFORE THE COVER BUILT ON IT IS TRUSTED.
   Only the 30-80 mile scale matters — that is the radius a query uses. */
test("great-circle distance is right at the scale a radius uses", () => {
  const cases = [
    ["Madison -> Milwaukee", 43.0731, -89.4012, 43.0389, -87.9065, 77],
    ["Omaha -> Lincoln",     41.2565, -95.9345, 40.8136, -96.7026, 50],
    ["Thorp -> Granton",     44.9600, -90.7990, 44.5580, -90.4630, 32],
    ["Ames -> Des Moines",   42.0347, -93.6200, 41.5868, -93.6250, 31],
  ];
  for (const [name, a, b, c, d, want] of cases) {
    const got = miles(a, b, c, d);
    assert.ok(Math.abs(got - want) < 3, `${name}: ${got.toFixed(1)} mi, expected about ${want}`);
  }
  assert.equal(miles(43, -89, 43, -89), 0, "a point is not distant from itself");
});

const T = (lat, lon, key) => ({ lat, lon, key });
const C = (lat, lon, zip) => ({ lat, lon, zip, label: zip });

test("a cover reaches everything a chosen centre can reach", () => {
  const targets = [T(43.0, -89.0, "a"), T(43.1, -89.1, "b"), T(46.0, -96.0, "c")];
  const cands = [C(43.05, -89.05, "11111"), C(46.0, -96.0, "22222")];
  const { chosen, uncovered } = cover(targets, cands, 45);
  assert.equal(uncovered.length, 0, "something reachable was left uncovered");
  assert.equal(chosen.length, 2, "two clusters 200 miles apart need two centres");
});

test("the greedy step takes the biggest gain first", () => {
  const targets = [T(43.0, -89.0), T(43.01, -89.01), T(43.02, -89.02), T(47.0, -97.0)];
  const cands = [C(47.0, -97.0, "lonely"), C(43.01, -89.01, "cluster")];
  const { chosen } = cover(targets, cands, 45);
  assert.equal(chosen[0].zip, "cluster", "it did not take the densest centre first");
  assert.equal(chosen[0].added, 3);
});

/* A CENTRE THAT WOULD SATURATE IS NOT A CENTRE.
   getGrainBids caps at totalLocations and a truncated answer is indistinguishable
   from a complete one. At 60 miles the busiest real centre already holds 199
   known facilities against a cap of 200 — before counting anything Barchart has
   there that we have not seen. The build refuses such a centre and names it. */
test("a centre that would hit the location cap is refused, and named", () => {
  const targets = Array.from({ length: 30 }, (_, i) => T(43 + i * 0.001, -89 + i * 0.001, `t${i}`));
  const cands = [C(43.015, -89.015, "dense"), C(43.0, -89.0, "edge")];
  const { chosen, refused } = cover(targets, cands, 45, Infinity, 10);   // cap 10 -> refuse at 8
  assert.ok(refused.some((r) => r.zip === "dense"), "a saturating centre was used anyway");
  assert.ok(refused[0].holds >= 8, "the refusal must say how many it holds");
  assert.ok(!chosen.some((c) => c.zip === "dense"));
});

test("without a cap, nothing is refused for saturation", () => {
  const targets = Array.from({ length: 30 }, (_, i) => T(43 + i * 0.001, -89 + i * 0.001));
  const { refused } = cover(targets, [C(43.015, -89.015, "dense")], 45);
  assert.equal(refused.length, 0);
});

test("a query budget is respected, and what it could not reach is returned", () => {
  const targets = [T(43.0, -89.0), T(46.0, -96.0), T(35.0, -97.0)];
  const cands = [C(43.0, -89.0, "a"), C(46.0, -96.0, "b"), C(35.0, -97.0, "c")];
  const { chosen, uncovered } = cover(targets, cands, 45, 2);
  assert.equal(chosen.length, 2, "the budget was exceeded");
  assert.equal(uncovered.length, 1, "what the budget could not reach must be reported");
});

test("a target no candidate can reach is reported, not silently lost", () => {
  const { chosen, uncovered } = cover([T(43.0, -89.0, "near"), T(25.0, -80.0, "miami")],
                                      [C(43.0, -89.0, "a")], 45);
  assert.equal(chosen.length, 1);
  assert.deepEqual(uncovered.map((u) => u.key), ["miami"], "an unreachable target vanished");
});

test("the same input gives the same grid — a cover that jitters cannot be compared", () => {
  const targets = Array.from({ length: 40 }, (_, i) => T(41 + (i % 7) * 0.3, -93 - (i % 5) * 0.4, `t${i}`));
  const cands = Array.from({ length: 12 }, (_, i) => C(41 + (i % 4) * 0.5, -93 - (i % 3) * 0.6, `z${i}`));
  const a = cover(targets, cands, 45).chosen.map((c) => c.zip);
  const b = cover(targets, cands, 45).chosen.map((c) => c.zip);
  assert.deepEqual(a, b);
});

test("no targets means no queries, not one wasted call", () => {
  const { chosen } = cover([], [C(43, -89, "a")], 45);
  assert.equal(chosen.length, 0);
});

/* ── THE COMMITTED GRID ─────────────────────────────────────────────────────
   Skipped where the file is not in the checkout, per this repo's rule that a
   test must not fail because a data file has not been generated yet. */
const gridUrl = new URL("../data/barchart-grid.json", import.meta.url);
const skip = !existsSync(gridUrl);

test("the committed grid beats the fifty city ZIPs it replaces", { skip }, () => {
  const g = JSON.parse(readFileSync(gridUrl, "utf8"));
  assert.ok(g.covers.pct >= 95, `the grid covers only ${g.covers.pct}% of known facilities`);
  assert.ok(g.covers.facilities > 405 * 3,
    `${g.covers.facilities} facilities — barely better than the 405 the city grid reached`);
  assert.equal(g.radiusMiles, 45, "the radius moved; 60 puts the busiest query on the cap");
  for (const z of g.zips) {
    assert.match(z.zip, /^\d{5}$/, `"${z.zip}" is not a ZIP`);
    assert.ok(z.knownFacilitiesInRange < g.totalLocationsCap * 0.8,
      `${z.zip} holds ${z.knownFacilitiesInRange}, too near the ${g.totalLocationsCap} cap`);
  }
  assert.equal(new Set(g.zips.map((z) => z.zip)).size, g.zips.length, "the grid queries a ZIP twice");
});

test("what the grid could not cover is written down", { skip }, () => {
  const g = JSON.parse(readFileSync(gridUrl, "utf8"));
  assert.equal(g.uncoveredFacilities.length, g.covers.uncovered,
    "the uncovered count and the uncovered list disagree");
});

/* The Barchart switch-off is meant to happen region by region on a measured
   figure. These pin the measurement, because a coverage number that drifts
   upward for the wrong reason is worse than not having one. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { milesBetween, servesAPrice, coverage, RADII } from "../scripts/coverage.mjs";

test("distance is great-circle, not flat arithmetic on degrees", () => {
  /* ANCHORED ON A FIGURE I DID NOT INVENT. The first version of this asserted
     Madison->Ames was "~215 mi", which was a guess, and it failed: the answer
     is 226.5. The code was right and the test was wrong — road distance is
     ~285, straight line is 226.5, and I had split the difference from memory.
     New York to Los Angeles is 2,445 statute miles great-circle, a published
     and checkable number, and this returns it to the mile. */
  assert.equal(Math.round(milesBetween(40.71, -74.01, 34.05, -118.24)), 2445,
    "New York to Los Angeles is 2,445 miles great-circle");
  const d = milesBetween(43.07, -89.40, 42.03, -93.62);
  assert.ok(d > 220 && d < 233, `Madison->Ames came out ${d.toFixed(1)} mi`);
  /* A degree of longitude is 54 mi in Texas and 44 at the Canadian border.
     Flat arithmetic gets the same answer for both, and this must not. */
  const south = milesBetween(31, -101, 31, -100);
  const north = milesBetween(48, -101, 48, -100);
  assert.ok(south - north > 8, `one degree of longitude: ${south.toFixed(1)} vs ${north.toFixed(1)}`);
  assert.equal(Math.round(milesBetween(41, -93, 41, -93)), 0, "a point is zero from itself");
});

test("only an elevator with a publishable price counts", () => {
  assert.equal(servesAPrice({ status: "read" }), true);
  assert.equal(servesAPrice({ status: "stale" }), true, "a held price inside the window is a price");
  assert.equal(servesAPrice({ status: "known" }), false, "naming an elevator serves nobody");
  assert.equal(servesAPrice({ status: "down" }), false, "past withdrawal there is nothing to publish");
});

test("an unplaced elevator cannot cover anything, however healthy", () => {
  const pts = [{ zip: "1", label: "P", lat: 42, lon: -93 }];
  const near = { status: "read", placed: true, lat: 42.01, lon: -93.01 };
  assert.equal(coverage(pts, [near]).covered[25], 1);
  assert.equal(coverage(pts, [{ ...near, placed: false }]).covered[25], 0);
  assert.equal(coverage(pts, [{ ...near, lat: null }]).covered[25], 0);
});

test("the radii nest — anything inside 25 is inside 100", () => {
  const grid = JSON.parse(readFileSync(new URL("../data/grid-50.json", import.meta.url), "utf8"));
  const dir = JSON.parse(readFileSync(new URL("../data/directory.json", import.meta.url), "utf8"));
  const c = coverage(grid.points, dir.elevators);
  assert.ok(c.covered[25] <= c.covered[50], `25mi ${c.covered[25]} > 50mi ${c.covered[50]}`);
  assert.ok(c.covered[50] <= c.covered[100], `50mi ${c.covered[50]} > 100mi ${c.covered[100]}`);
  for (const r of c.rows) {
    assert.ok(r.within[25] <= r.within[50] && r.within[50] <= r.within[100], r.label);
    if (r.within[100] > 0) assert.ok(r.nearest <= 100, `${r.label} counts inside 100 but nearest is ${r.nearest}`);
  }
});

test("the grid is the 50 points agsist actually queries", () => {
  const grid = JSON.parse(readFileSync(new URL("../data/grid-50.json", import.meta.url), "utf8"));
  assert.equal(grid.count, 50);
  assert.equal(grid.points.length, 50, "count and contents must agree — it is a copy and copies drift");
  assert.equal(new Set(grid.points.map((p) => p.zip)).size, 50, "no duplicate ZIPs");
  for (const p of grid.points) {
    assert.ok(p.lat > 24 && p.lat < 50, `${p.label} latitude ${p.lat} is not in the lower 48`);
    assert.ok(p.lon > -125 && p.lon < -66, `${p.label} longitude ${p.lon} is not in the lower 48`);
  }
  assert.match(grid.note, /fetch_bids\.py/, "it must say where it was copied from");
});

test("the figure has not silently jumped", () => {
  /* 16 / 30 / 38 was recorded in STANDING-DECISIONS before this script was
     rebuilt; this reproduces 16 / 30 / 37 from the same inputs. The point is
     not the exact number — it moves as sources are added — but that it moves
     for a reason. A jump past this band means the definition changed, not the
     coverage. */
  const grid = JSON.parse(readFileSync(new URL("../data/grid-50.json", import.meta.url), "utf8"));
  const dir = JSON.parse(readFileSync(new URL("../data/directory.json", import.meta.url), "utf8"));
  const c = coverage(grid.points, dir.elevators);
  for (const r of RADII) {
    assert.ok(c.covered[r] >= 0 && c.covered[r] <= 50, `${r}mi out of range`);
  }
  assert.ok(c.covered[100] >= c.covered[25], "the widest radius cannot cover less than the tightest");
  assert.ok(c.elevatorsWithAPrice > 100,
    `only ${c.elevatorsWithAPrice} elevators carry a price — that is a collapse, not a coverage figure`);
});

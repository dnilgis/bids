/* HOW THE MAP BEHAVES UNDER THE HAND, guarded as a file.
 *
 * map.html has no build step and no import graph, so nothing in this repo has
 * ever looked at it. Two of its settings were wrong in ways only a person
 * could find, and a person did -- Sig, 2026-09-02: "map on bids scroll on mouse
 * doesnt work to zoom which is annoying, also the clustering is too
 * aggressive". Both were deliberate choices, defended in comments, and both
 * were answering a question nobody had asked about THIS page.
 *
 * A comment saying why is not a guard. These are the two decisions, written
 * down where a later tidy-up has to argue with them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = readFileSync(join(ROOT, "map.html"), "utf8");

/* ── the wheel ───────────────────────────────────────────────────────────── */

test("the scroll wheel zooms the map", () => {
  // It was `scrollWheelZoom: false`, on the general rule about maps embedded in
  // articles. This page IS the map. If it ever goes back to false it should be
  // because somebody decided to, not because a default came back.
  assert.match(CODE, /scrollWheelZoom:\s*true/,
    "scrollWheelZoom must be on -- Sig asked for it by name on 2026-09-02");
  assert.doesNotMatch(CODE, /scrollWheelZoom:\s*false/);
});

test("one notch of a mouse wheel is about one zoom level", () => {
  // Leaflet's default of 60px/level is tuned for trackpads; a mouse notch is
  // 100-120px in Chrome, so on the default one notch jumped two levels and
  // overshot the county you were aiming at. Measured in Chromium at 110:
  // a 100px notch and a 120px notch each move exactly one level.
  const m = CODE.match(/wheelPxPerZoomLevel:\s*(\d+)/);
  assert.ok(m, "wheelPxPerZoomLevel is not set, so Leaflet's 60 applies");
  const px = Number(m[1]);
  assert.ok(px >= 90 && px <= 140, `wheelPxPerZoomLevel is ${px}; a mouse notch is 100-120px`);
});

/* ── the clustering ──────────────────────────────────────────────────────── */

/* COMMENTS ARE NOT CODE, and this file is nine tenths comment.
 * The first cut of the "clustering is never switched off" test below matched
 * the word disableClusteringAtZoom anywhere in map.html -- and map.html now
 * contains a paragraph explaining why disableClusteringAtZoom is the wrong
 * answer. The guard failed on its own reasoning. Strip the comments first. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/<!--[\s\S]*?-->/g, " ");

/* The schedule is read out of the file rather than imported, because map.html
   is a page and not a module. Reading it as text is also the only form that
   fails when somebody deletes the function and puts a constant back. */
function radiusSchedule(src) {
  const body = src.match(/maxClusterRadius:\s*function\s*\(z\)\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(body, "maxClusterRadius is not a function of zoom");
  const steps = [...body[1].matchAll(/if\s*\(z\s*(<=|===)\s*(\d+)\)\s*return\s*(\d+)/g)]
    .map((m) => ({ op: m[1], z: Number(m[2]), r: Number(m[3]) }));
  const tail = body[1].match(/\n\s*return\s+(\d+)\s*;/);
  assert.ok(steps.length >= 3, "the schedule has collapsed to almost nothing");
  assert.ok(tail, "the schedule has no fall-through return");
  return { steps, tail: Number(tail[1]) };
}

test("the cluster radius never grows as you zoom in", () => {
  const { steps, tail } = radiusSchedule(CODE);
  const zs = steps.map((s) => s.z);
  assert.deepEqual(zs, [...zs].sort((a, b) => a - b), "the zoom steps are out of order");
  const radii = [...steps.map((s) => s.r), tail];
  for (let i = 1; i < radii.length; i++) {
    assert.ok(radii[i] <= radii[i - 1],
      `radius grows on the way in: ${radii.join(" -> ")}`);
  }
});

test("the national view still clusters hard, because 3,873 flat pins is not a map", () => {
  const { steps } = radiusSchedule(CODE);
  assert.ok(steps[0].r >= 40, `the widest radius is ${steps[0].r}px; the country needs bubbles`);
});

test("by town level the radius is small enough to separate anything genuinely apart", () => {
  // Measured over central Iowa at 1440x900: a flat 55px radius left a
  // 43-elevator bubble at zoom 8 and a 19 at zoom 10. With the schedule it is
  // 19 and 15, and both of those are exact-coordinate stacks rather than
  // clustering. The fall-through is what does that work.
  const { tail } = radiusSchedule(CODE);
  assert.ok(tail <= 3, `the innermost radius is ${tail}px; two neighbouring yards will merge`);
});

test("clustering is never switched off, because 2,098 elevators share a coordinate", () => {
  /* THE OBVIOUS FIX IS THE WRONG ONE, and this is the test that says so.
   *
   * disableClusteringAtZoom looks like the answer to "too aggressive" and it
   * was written that way first. Counted from data/directory.json on
   * 2026-09-02: 3,873 placed elevators sit on 2,565 distinct coordinates,
   * 2,098 of them share a coordinate with at least one other, and the biggest
   * single stack is FIFTEEN -- most of the directory is geocoded to a town or
   * ZIP centroid, so those fifteen are on the same point exactly.
   *
   * Switching clustering off draws one pin there and hides fourteen elevators
   * underneath it. A bubble saying 15 is the truth; one pin is not. */
  assert.doesNotMatch(CODE, /disableClusteringAtZoom/,
    "clustering must stay on at every zoom -- coincident elevators would be hidden, not separated");
  const { tail } = radiusSchedule(CODE);
  assert.ok(tail >= 1, "a radius of 0 clusters nothing, which is the same hiding by another route");
  assert.match(CODE, /spiderfyOnMaxZoom:\s*true/,
    "the last bubble has to be openable, or those fifteen are unreachable");
});

/* ── the page can actually load ──────────────────────────────────────────── */

/* A vendored file at a path that does not exist is a blank white box, and the
   page reports nothing: Leaflet simply never defines L. This is cheap and it
   is the failure that would waste the most time. */
test("every local file the page loads is in the repository", () => {
  const refs = [...SRC.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith("#") && !u.startsWith("data:")
                   && !u.startsWith("mailto:"));
  assert.ok(refs.length >= 3, `only ${refs.length} local references found -- is the path right?`);
  for (const r of refs) {
    assert.ok(existsSync(join(ROOT, r.split("?")[0])), `map.html loads ${r}, which is not here`);
  }
});

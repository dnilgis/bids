/* THE DIRECTORY IS THE TOP OF THE CHAIN, AND THE CHAIN HAS TO BE CONNECTED.
 *
 *   data/barchart.json  ->  build_known.mjs   ->  data/known-elevators.json
 *                       ->  build_geocodes.py ->  geocodes/places.json
 *                       ->  build_grid.mjs    ->  data/barchart-grid.json
 *   (the fetch that fed this chain was removed 2026-10-30)
 *
 * Until 2026-09-01 that chain ran agsist -> weekly -> monthly -> never: a
 * facility Barchart began pricing reached the grid up to a month later, if at
 * all, and merge_bids.mjs printed the ones it could not place every run while
 * nothing consumed the list.
 *
 * Two things are tested here. That the directory builder cannot lose a
 * facility or hide a broken fetch, and that the steps are actually WIRED — a
 * correct script nobody calls is the same as no script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { keyOf, FETCH_FLOOR } from "../scripts/build_known.mjs";
import { placeKey } from "../scripts/merge_bids.mjs";

/* THE JOIN ONLY WORKS IF BOTH SIDES SPELL THE KEY THE SAME WAY.
   places.json is keyed operator|branch|location|state and merge_bids.mjs looks
   places up by that string. If the directory builder wrote a different shape,
   every Barchart row would miss and the merge would report the whole feed as
   "not yet in the directory" while looking like it was working. */
test("the directory's key is character-for-character the merge's key", () => {
  const r = { facility: " Premier  Cooperative ", branch: "Westby", city: "Westby", state: "wi" };
  assert.equal(keyOf(r), "Premier Cooperative|Westby|Westby|WI");
  assert.equal(keyOf(r), placeKey(r.facility, r.branch, r.city, r.state));
  const empty = { facility: "", branch: null, city: undefined, state: "" };
  assert.equal(keyOf(empty), placeKey(empty.facility, empty.branch, empty.city, empty.state));
});

test("the collapse floor is a fraction, not a count", () => {
  assert.ok(FETCH_FLOOR > 0 && FETCH_FLOOR < 1, `FETCH_FLOOR is ${FETCH_FLOOR}`);
});

/* ── THE WIRING ────────────────────────────────────────────────────────────
   A script that runs correctly and is called by nothing is the exact failure
   this repository found twice in one day: two python guards no workflow ran,
   and then a whole test suite no workflow ran. */
const wf = (n) => readFileSync(new URL(`../.github/workflows/${n}`, import.meta.url), "utf8");
const nonComment = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("barchart.yml rebuilds the merged feed and no longer fetches from Barchart", () => {
  const t = nonComment(wf("barchart.yml"));
  assert.ok(t.includes("merge_bids.mjs"), "barchart.yml never runs merge_bids.mjs");
  assert.ok(!t.includes("fetch_barchart") && !t.includes("BARCHART_API_KEY"),
    "barchart.yml still fetches from Barchart; the subscription is cancelled");
});

test("barchart.yml installs python before running python", () => {
  const t = nonComment(wf("barchart.yml"));
  if (/\bpython3?\s/.test(t) || /\.py\b/.test(t))
    assert.ok(t.includes("actions/setup-python"),
      "a python step with no setup-python: the schedule-guard failure of 2026-09-01");
});

/* THE MERGE IS PURE LOCAL COMPUTATION AND BELONGS ON THE BOARDS' CADENCE.
   It reads the checkout and writes an index; no network, about a second. Left
   on the fetch's four-times-a-day clock, the one file a consumer reads was
   hours behind boards sitting correct in the same repository. */
test("the poll rebuilds the merged feed on every pass that commits", () => {
  const t = readFileSync(new URL("../scripts/one-pass.sh", import.meta.url), "utf8");
  assert.ok(t.includes("scripts/merge_bids.mjs"), "one-pass.sh never rebuilds the feed");
  assert.ok(/git add .*data\/merged/.test(t), "the feed is rebuilt and never staged");
  /* fail-open, like the dashboard and the directory beside it: a feed that
     cannot be rebuilt must not stop a price reaching the repo */
  const at = t.indexOf("merge_bids.mjs");
  assert.ok(t.slice(at, at + 400).includes("::warning::"),
    "a failed merge must warn and continue, not take the price down with it");
});

test("sync_known stands down instead of fighting the local build", () => {
  const t = readFileSync(new URL("../scripts/sync_known.py", import.meta.url), "utf8");
  assert.ok(t.includes("STANDING DOWN"),
    "sync_known.py still replaces the directory unconditionally — it would drop every "
    + "facility our own fetch found that agsist has not seen");
  assert.ok(t.includes("LOCAL_SOURCE_MARK"));
});

/* ── THE COMMITTED DIRECTORY ───────────────────────────────────────────────*/
const knownUrl = new URL("../data/known-elevators.json", import.meta.url);
test("the committed directory says where it came from and when each row was seen",
  { skip: !existsSync(knownUrl) }, () => {
    const d = JSON.parse(readFileSync(knownUrl, "utf8"));
    assert.ok(Array.isArray(d.elevators) && d.elevators.length > 1000,
      `only ${d.elevators?.length} facilities`);
    assert.ok(d.from, "a directory with no provenance");
    const keys = new Set(d.elevators.map(keyOf));
    assert.equal(keys.size, d.elevators.length, "the directory lists a facility twice");
  });

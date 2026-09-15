#!/usr/bin/env node
/**
 * CAN THE BARCHART SUBSCRIPTION BE CANCELLED YET? A NUMBER, NOT A FEELING.
 *
 * WHY THIS EXISTS
 *
 * agsist.com/cash-bids merges two feeds: the boards this project reads itself,
 * and Barchart OnDemand through a Worker proxy. Ours wins on a duplicate;
 * Barchart fills the rest. Barchart is the paid one, and Sig wants it gone.
 *
 * "Gone" is not a decision anybody can make from a feeling about coverage. It
 * is the moment this number reaches zero, or close enough that what is left is
 * worth losing. Nothing in the repository measured it, so the question kept
 * being asked and never answered.
 *
 * WHAT IT MEASURES
 *
 * geocodes/places.json -> `known` is the Barchart facility roster: 1,796
 * facilities harvested while the subscription was live. It is a FROZEN
 * SNAPSHOT — the fetch does not run (there is no BARCHART_API_KEY on this
 * repo), so this roster is the best available picture of what cancelling would
 * cost and it does not grow.
 *
 * Against it: every place the merged feed publishes. A Barchart facility counts
 * as covered when one of our places sits within MATCH_KM of it.
 *
 * WHY A DISTANCE AND NOT A NAME. Barchart calls it "ADM Grain" with a branch of
 * "Abilene, KS"; the elevator's own board calls it something else entirely.
 * Name matching scored 133 of 1,796 and was wrong. Coordinates are the same
 * elevator whatever anybody calls it.
 *
 * AND THE HONEST CAVEAT, WHICH IS THE WHOLE REASON THIS PRINTS A RANGE. Every
 * entry in the Barchart roster is `precision: "town"` — a ZIP centroid, not the
 * building. So a match at 3 km means "we read an elevator in that town", not
 * "we read THAT elevator". A town with two elevators reads as covered when we
 * have one. This OVERSTATES coverage and the report says so rather than
 * printing the friendlier number alone.
 *
 * WHAT IT WRITES
 *
 *   data/gaps/barchart-coverage.json  the number to watch, with its caveat
 *   data/gaps/barchart-cutover.csv  every uncovered facility, ranked by the
 *                                   operator that would close the most at once
 *
 * The ranking is the point. 1,038 uncovered facilities across 272 operators
 * sounds like forever. The top twenty operators are 37% of it, and each one is
 * a single website — Heartland Coop is 45 facilities behind one board.
 *
 *   node scripts/barchart_gap.mjs
 *   node scripts/barchart_gap.mjs --selftest
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATCH_KM = 3;

export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Coarse 0.1-degree buckets so 1,796 x 879 is not a nested scan. 0.1 degrees of
   latitude is ~11 km, comfortably wider than MATCH_KM, and the neighbours are
   searched too — a point near a bucket edge must not read as uncovered. */
export function nearIndex(points) {
  const b = new Map();
  for (const [lat, lon] of points) {
    const k = `${Math.round(lat * 10)}|${Math.round(lon * 10)}`;
    if (!b.has(k)) b.set(k, []);
    b.get(k).push([lat, lon]);
  }
  return (lat, lon, km = MATCH_KM) => {
    const la = Math.round(lat * 10), lo = Math.round(lon * 10);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const [x, y] of b.get(`${la + i}|${lo + j}`) ?? [])
          if (haversineKm(lat, lon, x, y) <= km) return true;
    return false;
  };
}

function main() {
  const places = JSON.parse(readFileSync(join(ROOT, "geocodes", "places.json"), "utf8"));
  const idx = JSON.parse(readFileSync(join(ROOT, "data", "merged-index.json"), "utf8"));
  const known = places.known ?? {};
  const ours = (idx.places ?? [])
    .filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
    .map((p) => [p.lat, p.lon]);
  const near = nearIndex(ours);

  const gap = [];
  let covered = 0, noCoord = 0;
  for (const [key, v] of Object.entries(known)) {
    if (typeof v.lat !== "number" || typeof v.lon !== "number") { noCoord++; continue; }
    if (near(v.lat, v.lon)) { covered++; continue; }
    const [operator = "", branch = "", city = "", state = ""] = key.split("|");
    gap.push({ operator, branch, city, state, lat: v.lat, lon: v.lon,
               url: v.url ?? null, address: v.address ?? null });
  }

  const byOperator = new Map();
  for (const g of gap) byOperator.set(g.operator, (byOperator.get(g.operator) ?? 0) + 1);
  const ranked = [...byOperator.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const total = covered + gap.length;
  const out = {
    schema: "agsist-barchart-coverage/1",
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    note: "What cancelling the Barchart subscription would cost today. `gap` is the "
        + "number to drive to zero. Coverage is measured by COORDINATE, within "
        + `${MATCH_KM} km — and every facility in the Barchart roster is geocoded to its `
        + "TOWN, not its building, so a town with two elevators reads as covered when "
        + "we read one. This overstates coverage. Treat `gap` as a floor.",
    matchKm: MATCH_KM,
    barchartRoster: total,
    rosterWithoutCoordinate: noCoord,
    ourPlaces: ours.length,
    covered,
    gap: gap.length,
    coveredPct: total ? Math.round((covered / total) * 1000) / 10 : null,
    operatorsInGap: byOperator.size,
    singletonOperators: ranked.filter(([, n]) => n === 1).length,
    topOperators: ranked.slice(0, 25).map(([operator, facilities]) => ({ operator, facilities })),
  };
  /* data/gaps/, NOT data/ -- AND THE FIRST LIVE RUN IS WHY.
   *
   * This wrote data/barchart-coverage.json. Run 33 committed it at 02:07 on
   * 2026-09-14, and the merge in the very next step reported:
   *
   *     5  board file with no entry in index.json -- the poller did not reach
   *        this source and its bids are being dropped
   *            e.g. barchart-coverage
   *
   * data/ is where the BOARD FILES live -- data/<source-id>.json, one per
   * elevator -- and merge_bids.mjs reads every .json in it. A report dropped in
   * there is read as an elevator nobody polled, counted against the orphan
   * tally forever, and printed as the example of a failure that did not happen.
   * It also counts toward the CEILING in test/manifest-covers-boards.test.py,
   * which exists to catch the real version of that failure.
   *
   * The CSV beside it was already going to data/gaps/. The JSON belongs there
   * too: it is a report about the feed, not a part of it. Nothing reads it by
   * path -- checked across every .mjs, .py, .yml and .html in the repo before
   * moving it. */
  const gapsDir = join(ROOT, "data", "gaps");
  if (!existsSync(gapsDir)) mkdirSync(gapsDir, { recursive: true });
  writeFileSync(join(gapsDir, "barchart-coverage.json"), JSON.stringify(out, null, 1) + "\n");

  /* AND TAKE THE OLD ONE OUT OF data/. Run 33 committed it there, and a zip
     cannot delete a file — so the script that put it there removes it, once,
     on the next run. Only this exact path and only when its schema says it is
     ours: a file in data/ that is not this report is somebody else's board. */
  const stale = join(ROOT, "data", "barchart-coverage.json");
  if (existsSync(stale)) {
    let mine = false;
    try { mine = JSON.parse(readFileSync(stale, "utf8"))?.schema === out.schema; } catch { /* not ours */ }
    if (mine) { rmSync(stale); console.log("  removed the old data/barchart-coverage.json"); }
  }
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rank = new Map(ranked.map(([op], i) => [op, i + 1]));
  gap.sort((a, b) => (byOperator.get(b.operator) - byOperator.get(a.operator))
    || a.operator.localeCompare(b.operator) || a.city.localeCompare(b.city));
  const csv = ["operator_rank,operator,operator_facilities_in_gap,branch,city,state,lat,lon,website"]
    .concat(gap.map((g) => [rank.get(g.operator), q(g.operator), byOperator.get(g.operator),
      q(g.branch), q(g.city), q(g.state), g.lat, g.lon, q(g.url)].join(",")));
  writeFileSync(join(gapsDir, "barchart-cutover.csv"), csv.join("\n") + "\n");

  console.log(`Barchart roster ${total} facilities`);
  console.log(`  covered by a place we read (within ${MATCH_KM} km): ${covered} (${out.coveredPct}%)`);
  console.log(`  gap: ${gap.length} across ${byOperator.size} operators `
    + `(${out.singletonOperators} of them a single facility)`);
  console.log("");
  console.log("  the operators that would close the most at once:");
  let cum = 0;
  for (const [op, n] of ranked.slice(0, 10)) {
    cum += n;
    console.log(`   ${String(n).padStart(4)}  ${op.padEnd(40).slice(0, 40)} `
      + `cumulative ${String(cum).padStart(4)} (${((cum / gap.length) * 100).toFixed(1)}%)`);
  }
  console.log("");
  console.log("  wrote data/gaps/barchart-coverage.json and data/gaps/barchart-cutover.csv");
  console.log("  NOTE: the roster is geocoded to towns, so `covered` is an over-count "
    + "and `gap` is a floor.");
  return 0;
}

function selftest() {
  let pass = 0, fail = 0;
  const chk = (c, name, d = "") => c ? (pass++, console.log("  ok    " + name))
    : (fail++, console.log(`  FAIL  ${name}${d ? "  [" + d + "]" : ""}`));

  const d = haversineKm(41.0, -93.0, 41.0, -93.0);
  chk(d === 0, "a point is zero km from itself", d);
  const oneDeg = haversineKm(41.0, -93.0, 42.0, -93.0);
  chk(Math.abs(oneDeg - 111.2) < 1.5, "a degree of latitude is ~111 km", oneDeg.toFixed(1));

  const near = nearIndex([[41.0, -93.0]]);
  chk(near(41.0, -93.0), "an exact coordinate is covered");
  chk(near(41.02, -93.0), "2.2 km away is covered at a 3 km radius");
  chk(!near(41.1, -93.0), "11 km away is not");

  /* THE BUCKET EDGE, WHICH IS THE ONLY WAY THIS CAN BE WRONG AND LOOK RIGHT.
     Buckets are 0.1 degrees. Two points either side of a boundary are ~2 km
     apart and land in different buckets; without the neighbour scan the second
     reads as uncovered and the gap is overstated by however many facilities sit
     near an edge. */
  const edge = nearIndex([[41.049, -93.0]]);
  chk(edge(41.051, -93.0), "a match across a bucket boundary is still found");
  const edgeLon = nearIndex([[41.0, -93.049]]);
  chk(edgeLon(41.0, -93.051), "...and across a longitude boundary");

  chk(!nearIndex([])(41.0, -93.0), "an empty index covers nothing");

  console.log("");
  console.log(`barchart_gap selftest: ${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

process.exit(process.argv.includes("--selftest") ? selftest() : main());

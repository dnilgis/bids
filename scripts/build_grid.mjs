#!/usr/bin/env node
/* WHERE TO ASK BARCHART — CHOSEN FROM WHERE THE ELEVATORS ARE.
 *
 * WHAT THIS REPLACES. AGSIST asked Barchart about fifty hand-picked city ZIPs:
 * Madison, Eau Claire, Ames, Dubuque. Fifty calls at a 60-mile radius returned
 * 405 facilities across 29 states — 22% of the 1,806 facilities THIS REPOSITORY
 * HAD ALREADY GEOCODED. The feed was never the ceiling. The question was.
 *
 * Measured 2026-09-01, greedy set cover over those 1,806 coordinates at 60 miles:
 *
 *      25 queries -> 1,613 facilities (89%)
 *      50 queries -> 1,781 facilities (99%)
 *      70 queries -> 1,806 facilities (100%)
 *
 * The same fifty calls, aimed at the elevators instead of at cities, reach 1,781
 * instead of 405.
 *
 * ── WHY 45 MILES AND NOT 60 ──────────────────────────────────────────────────
 *
 * getGrainBids takes totalLocations, and a truncated answer looks exactly like a
 * complete one. At a 60-mile radius the busiest centre already holds 199 known
 * facilities against a cap of 200 — before counting anything Barchart carries
 * there that we have never seen. That is not a margin, it is a coin toss.
 *
 *      radius   queries for 100%   busiest query returns
 *        60           70                 199   at the cap
 *        45          113                 140   safe
 *        35          150                  94   safe
 *
 * 45 miles is the first honest option: full coverage with the busiest query at
 * 70% of the cap. It costs more calls than 60 miles and that is the point.
 *
 * ── WHY THE CENTRES ARE ZIPS AND NOT COORDINATES ─────────────────────────────
 *
 * getGrainBids takes a zipCode, not a latitude. So the cover is run over ZIPs we
 * can actually send — AGSIST's 590-entry ZIP table plus the ZIPs on this repo's
 * own sources — rather than over ideal points that would then have to be snapped
 * to a ZIP afterwards, which is an optimisation followed by a fudge.
 *
 * ── WHY IT IS COMMITTED AND NOT COMPUTED EVERY RUN ───────────────────────────
 *
 * A grid recomputed on every poll jitters as the directory grows, and then a
 * fall in coverage cannot be told from a reshuffle. It is built here, committed,
 * and rebuilt when somebody asks — and the file records what it covered on the
 * day it was made, so the next build can be compared against it.
 *
 * USAGE
 *     node scripts/build_grid.mjs                        # 45 miles, full cover
 *     node scripts/build_grid.mjs --radius 60 --max 50   # what fits in 50 calls
 *     node scripts/build_grid.mjs --candidates path.json --out data/barchart-grid.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

const RADIUS = Number(arg("--radius", 45));
const MAXQ = Number(arg("--max", 0)) || Infinity;
/* Barchart's cap. A centre whose circle already holds this many facilities WE
 * know about cannot be trusted to return them all, so the build refuses to
 * place one there and says so. */
const CAP = Number(arg("--cap", 200));
const CAP_HEADROOM = 0.8;

/* Great-circle. Validated against known distances before the cover was trusted:
 * Madison->Milwaukee 75.5mi, Omaha->Lincoln 50.4mi, Thorp->Granton 32.3mi. */
export function miles(a, b, c, d) {
  const p = Math.PI / 180;
  return 3958.8 * 2 * Math.asin(Math.sqrt(
    Math.sin((c - a) * p / 2) ** 2 +
    Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2));
}

/** Greedy set cover: repeatedly take the candidate covering the most targets
 *  still uncovered. Returns the chosen centres in the order they were chosen,
 *  each with what it added and what it holds in total. */
export function cover(targets, candidates, radius, maxQueries = Infinity, cap = Infinity) {
  /* Pre-index by a generous lat/lon box so the inner loop is not 1806 x 649
     haversines on every pass. 45 miles is 0.65 degrees of latitude and at most
     0.9 of longitude at 49N; the box is wider than either. */
  const near = candidates.map((c) =>
    new Set(targets.map((t, i) =>
      (Math.abs(c.lat - t.lat) < 1.3 && Math.abs(c.lon - t.lon) < 2.0 &&
       miles(c.lat, c.lon, t.lat, t.lon) <= radius) ? i : -1).filter((i) => i >= 0)));

  const left = new Set(targets.map((_, i) => i));
  const chosen = [], refused = [];
  while (left.size && chosen.length < maxQueries) {
    let best = -1, bestGain = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (chosen.some((c) => c._i === i)) continue;
      /* A CENTRE THAT WOULD SATURATE IS NOT A CENTRE. If we already know of `cap`
         facilities inside this circle, Barchart will truncate and we will not be
         able to tell. Refused, named, and the cover finds another way in. */
      if (near[i].size >= cap * CAP_HEADROOM) {
        if (!refused.some((r) => r._i === i)) refused.push({ _i: i, ...candidates[i], holds: near[i].size });
        continue;
      }
      let gain = 0;
      for (const t of near[i]) if (left.has(t)) gain++;
      if (gain > bestGain) { bestGain = gain; best = i; }
    }
    if (best === -1) break;
    for (const t of near[best]) left.delete(t);
    chosen.push({ _i: best, ...candidates[best], added: bestGain, holds: near[best].size });
  }
  return { chosen, uncovered: [...left].map((i) => targets[i]), refused };
}

function main() {
  const plPath = join(ROOT, "geocodes", "places.json");
  if (!existsSync(plPath)) { console.error("missing geocodes/places.json — this reads it, it does not build it"); return 1; }
  const places = JSON.parse(readFileSync(plPath, "utf8"));

  /* THE TARGETS ARE THE FACILITIES WE ALREADY KNOW BARCHART PRICES. Every entry
     in known{} arrived from Barchart and carries a geocode this repo made. */
  const targets = Object.entries(places.known || {})
    .filter(([, v]) => typeof v.lat === "number" && typeof v.lon === "number")
    .map(([key, v]) => ({ key, lat: v.lat, lon: v.lon, state: v.state }));

  const candPath = arg("--candidates", join(ROOT, "geocodes", "zip-candidates.json"));
  if (!existsSync(candPath)) {
    console.error(`missing ${candPath}`);
    console.error("  It is the pool of ZIPs a query may be centred on. Build it once from");
    console.error("  AGSIST's data/zip-grid.json plus this repo's own source ZIPs.");
    return 1;
  }
  const candidates = JSON.parse(readFileSync(candPath, "utf8")).zips;

  console.log(`covering ${targets.length} known Barchart facilities`);
  console.log(`from ${candidates.length} candidate ZIPs, radius ${RADIUS} mi, cap ${CAP}\n`);

  const { chosen, uncovered, refused } = cover(targets, candidates, RADIUS, MAXQ, CAP);
  let cum = 0;
  for (const [n, c] of chosen.entries()) {
    cum += c.added;
    if (n < 12 || n % 25 === 0) {
      console.log(`  ${String(n + 1).padStart(3)}. ${c.zip}  ${(c.label || "").padEnd(22)} +${String(c.added).padStart(3)}  (${cum} covered)`);
    }
  }
  const pct = (100 * cum / targets.length).toFixed(1);
  console.log(`\n  ${chosen.length} queries cover ${cum} of ${targets.length} facilities (${pct}%)`);
  if (refused.length) {
    console.log(`  ${refused.length} candidate ZIPs refused for sitting on ${Math.round(CAP * CAP_HEADROOM)}+ known facilities:`);
    for (const r of refused.slice(0, 5)) console.log(`     ${r.zip} ${r.label} holds ${r.holds}`);
  }
  if (uncovered.length) {
    console.log(`  ${uncovered.length} facilities are not within ${RADIUS} mi of ANY candidate ZIP:`);
    for (const u of uncovered.slice(0, 8)) console.log(`     ${u.key}`);
    console.log("  (they need a candidate ZIP added near them, not a wider radius)");
  }

  const out = {
    schema: "barchart-grid/1",
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    note: `Query centres chosen by greedy set cover over the ${targets.length} Barchart `
        + `facilities in geocodes/places.json, at a ${RADIUS}-mile radius. Chosen from ZIPs `
        + `we can actually send, not from ideal points snapped to a ZIP afterwards. `
        + `Committed rather than recomputed per run so a change in coverage cannot be `
        + `confused with a reshuffle.`,
    radiusMiles: RADIUS, totalLocationsCap: CAP,
    covers: { facilities: cum, of: targets.length, pct: Number(pct), uncovered: uncovered.length },
    refusedForSaturation: refused.map((r) => ({ zip: r.zip, label: r.label, knownFacilities: r.holds })),
    uncoveredFacilities: uncovered.map((u) => u.key),
    zips: chosen.map((c) => ({ zip: c.zip, lat: c.lat, lon: c.lon, label: c.label,
                               adds: c.added, knownFacilitiesInRange: c.holds })),
  };
  /* ── A NEW GRID MAY NOT COVER LESS THAN THE ONE IT REPLACES ─────────────
     The same failure as the candidate pool, one step downstream: a rebuild with
     a thinner pool, or a smaller --max, writes a worse grid and says nothing —
     it just reaches fewer elevators, quietly, for as long as nobody compares.
     A drop of more than half a point is refused. */
  const outPath = arg("--out", join(ROOT, "data", "barchart-grid.json"));
  if (existsSync(outPath) && !process.argv.includes("--allow-worse")) {
    let prev = null;
    try { prev = JSON.parse(readFileSync(outPath, "utf8")); } catch { /* unreadable: nothing to compare */ }
    if (prev && prev.covers && Number(pct) < prev.covers.pct - 0.5) {
      console.error(`\nREFUSED: this grid covers ${pct}% where the one on disk covers ${prev.covers.pct}%.`);
      console.error(`  ${prev.covers.facilities} facilities -> ${cum}.`);
      if (prev.radiusMiles !== RADIUS) console.error(`  The radius changed: ${prev.radiusMiles} -> ${RADIUS} mi.`);
      console.error("  Check geocodes/zip-candidates.json first — a thinner candidate pool is");
      console.error("  the usual cause. Pass --allow-worse if the drop is intended.");
      return 1;
    }
  }
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${outPath}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

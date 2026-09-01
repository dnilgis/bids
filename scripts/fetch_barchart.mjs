#!/usr/bin/env node
/* BARCHART, ASKED WHERE THE ELEVATORS ARE.
 *
 * This is AGSIST's scripts/fetch_bids.py, moved here and pointed at
 * data/barchart-grid.json instead of at fifty hand-picked city ZIPs. It writes
 * the WHOLE response. AGSIST committed a slim selection and threw ~17,200 bids
 * away every half hour because a public repo could not hold the rest; Sig pays
 * for the feed and has said to publish it, so the reason for slimming is gone
 * and with it the "keep this in lockstep with cash-bids.html" coupling that made
 * two copies of one parsing rule.
 *
 * ── THE CEILING THAT LOOKED LIKE AN ABSENCE ──────────────────────────────────
 *
 * getGrainBids defaults to 30 locations per query and the old per-ZIP log printed
 * BIDS, not locations — so a query that hit the ceiling looked exactly like one
 * that did not, and "this elevator is absent from Barchart" was never a safe
 * claim. It sends totalLocations now, and it REPORTS SATURATION PER QUERY. A
 * saturated query is a warning in the output and a field in the file, because a
 * truncated answer that is not labelled is a wrong answer.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
 *
 *   - It will not write a file when every query failed. An empty run overwriting
 *     a good file is how a feed goes dark without anybody noticing.
 *   - It will not silently keep a partial run. Below --min-ok it refuses.
 *   - It will not classify, convert or filter. Those belong to lib/crop.mjs and
 *     scripts/merge_bids.mjs, which is the whole point of the move: one place.
 *
 * ENVIRONMENT
 *     BARCHART_API_KEY   repo secret. Never a file — see STANDING-DECISIONS.
 *
 * USAGE
 *     node scripts/fetch_barchart.mjs
 *     node scripts/fetch_barchart.mjs --limit 3 --out /tmp/probe.json   # a probe
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://ondemand.websol.barchart.com/getGrainBids.json";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

/* AN ENV VAR THAT IS SET-BUT-EMPTY MEANS UNSET, NOT ZERO AND NOT A CRASH.
 * GitHub Actions passes an unfilled workflow_dispatch input as "" — and it
 * passes it on SCHEDULED runs too, so a blank box in the Run-workflow dialog
 * would otherwise take down every scheduled fetch as well as the manual one. */
export const envInt = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/* SATURATION IS COUNTED IN LOCATIONS, NOT BIDS. One facility can return thirty
 * bids, so counting bids against a location cap is what hid the old
 * thirty-location ceiling for months: a query returning 400 bids from 30
 * facilities looked healthy and was truncated. */
export const locationsIn = (rows) =>
  new Set((rows || []).map((r) => `${r.facility}|${r.branch}|${r.city}|${r.state}`)).size;

export const isSaturated = (rows, cap) => !!cap && locationsIn(rows) >= cap;

const TOTAL_LOCATIONS = envInt("BARCHART_TOTAL_LOCATIONS", 200);
const MIN_OK_PCT = Number(arg("--min-ok", 70));
const PAUSE_MS = envInt("BARCHART_PAUSE_MS", 250);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(zip, radius, totalLocations, key) {
  const q = new URLSearchParams({ apikey: key, zipCode: zip, maxDistance: String(radius), getAllBids: "1" });
  if (totalLocations) q.set("totalLocations", String(totalLocations));
  const res = await fetch(`${BASE}?${q}`, { headers: { "User-Agent": "AGSIST/1.0 (dnilgis/bids)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  /* Barchart reports its own status in the body, not only in the HTTP code. */
  if (j.status && j.status.code && j.status.code !== 200) {
    throw new Error(`barchart status ${j.status.code}: ${j.status.message || ""}`);
  }
  return j.results || [];
}

async function main() {
  const key = process.env.BARCHART_API_KEY;
  if (!key) {
    console.error("BARCHART_API_KEY is not set.");
    console.error("  It is a repository secret on dnilgis/bids. Secrets never live in files.");
    return 1;
  }
  const gridPath = arg("--grid", join(ROOT, "data", "barchart-grid.json"));
  if (!existsSync(gridPath)) {
    console.error(`missing ${gridPath} — build it with scripts/build_grid.mjs`);
    return 1;
  }
  const grid = JSON.parse(readFileSync(gridPath, "utf8"));
  const limit = Number(arg("--limit", 0)) || grid.zips.length;
  const zips = grid.zips.slice(0, limit);

  console.log(`asking Barchart about ${zips.length} ZIPs at ${grid.radiusMiles} mi, `
            + `up to ${TOTAL_LOCATIONS} locations each`);
  console.log(`the grid covers ${grid.covers.facilities} of ${grid.covers.of} known facilities `
            + `(${grid.covers.pct}%)\n`);

  const all = [], perZip = [], saturated = [], failed = [];
  for (const [i, z] of zips.entries()) {
    let rows;
    try {
      rows = await ask(z.zip, grid.radiusMiles, TOTAL_LOCATIONS, key);
    } catch (e) {
      failed.push({ zip: z.zip, label: z.label, why: String(e.message || e) });
      console.log(`  ${String(i + 1).padStart(3)}. ${z.zip} ${(z.label || "").padEnd(22)} FAILED ${e.message}`);
      continue;
    }
    /* SATURATION IS COUNTED IN LOCATIONS, NOT BIDS. One facility can return
       thirty bids; counting bids against a location cap is what hid the old
       thirty-location ceiling for months. */
    const locations = locationsIn(rows);
    const hit = isSaturated(rows, TOTAL_LOCATIONS);
    if (hit) saturated.push({ zip: z.zip, label: z.label, locations });
    perZip.push({ zip: z.zip, label: z.label, lat: z.lat, lon: z.lon,
                  bids: rows.length, locations, saturated: hit });
    for (const r of rows) all.push({ ...r, sourceZip: z.zip });
    console.log(`  ${String(i + 1).padStart(3)}. ${z.zip} ${(z.label || "").padEnd(22)} `
              + `${String(locations).padStart(3)} loc  ${String(rows.length).padStart(5)} bids`
              + `${hit ? "   *** SATURATED — this answer is truncated ***" : ""}`);
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  const okPct = 100 * perZip.length / zips.length;
  console.log(`\n${perZip.length} of ${zips.length} queries answered (${okPct.toFixed(0)}%)`);
  if (perZip.length === 0) {
    console.error("REFUSED TO WRITE: every query failed. An empty file over a good one is how");
    console.error("  a feed goes dark without anybody noticing.");
    return 1;
  }
  if (okPct < MIN_OK_PCT) {
    console.error(`REFUSED TO WRITE: only ${okPct.toFixed(0)}% of queries answered, `
                + `below the ${MIN_OK_PCT}% floor.`);
    console.error("  A partial run published as a whole one understates coverage everywhere.");
    for (const f of failed.slice(0, 8)) console.error(`    ${f.zip} ${f.label}: ${f.why}`);
    return 1;
  }
  if (saturated.length) {
    console.log(`\n${saturated.length} queries SATURATED at ${TOTAL_LOCATIONS} locations. `
              + `Those answers are truncated:`);
    for (const s of saturated) console.log(`   ${s.zip} ${s.label} (${s.locations})`);
    console.log("  Raise BARCHART_TOTAL_LOCATIONS, or rebuild the grid at a smaller radius.");
  }

  const facilities = new Set(all.map((r) => `${r.facility}|${r.branch}|${r.city}|${r.state}`));
  const out = {
    schema: "barchart-raw/1",
    fetched: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source: "Barchart OnDemand getGrainBids",
    /* THE FLAG merge_bids.mjs CHECKS. AGSIST's committed copy carries full:false
       and merging it would publish a fraction of the feed while reporting a
       whole one. This file is the whole run, and says so. */
    full: true,
    grid: { radiusMiles: grid.radiusMiles, totalLocations: TOTAL_LOCATIONS,
            zipsAsked: zips.length, zipsAnswered: perZip.length,
            generated: grid.generated },
    counts: { bids: all.length, facilities: facilities.size,
              states: new Set(all.map((r) => r.state).filter(Boolean)).size,
              saturatedQueries: saturated.length, failedQueries: failed.length },
    saturated, failed, perZip,
    bids: all,
  };
  const outPath = arg("--out", join(ROOT, "data", "barchart.json"));
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${outPath}`);
  console.log(`  ${all.length} bids, ${facilities.size} facilities, ${out.counts.states} states`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}

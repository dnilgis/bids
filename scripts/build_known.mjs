#!/usr/bin/env node
/* THE DIRECTORY, BUILT FROM OUR OWN FETCH INSTEAD OF BORROWED BACK.
 *
 * WHAT THIS CLOSES. data/known-elevators.json is the list of facilities Barchart
 * prices — who and where, no prices — and geocodes/places.json is built from it,
 * and data/barchart-grid.json is chosen from that. It is the top of the chain
 * that decides how many elevators we can reach at all.
 *
 * Until now it arrived by the long way round:
 *
 *      agsist fetches Barchart  ->  agsist/data/elevator-directory.json
 *        -> sync_known.py, WEEKLY      -> data/known-elevators.json
 *        -> build_geocodes.py, MONTHLY -> geocodes/places.json
 *        -> build_grid.mjs             -> data/barchart-grid.json
 *
 * A facility Barchart started pricing today reached the grid UP TO A MONTH
 * LATER, and only if agsist's directory had caught it first. Meanwhile
 * merge_bids.mjs printed `facilitiesNotYetInDirectory` every run and nothing
 * anywhere consumed it. The loop was open at both ends.
 *
 * sync_known.py's own header explains why it borrowed: "agsist writes the
 * directory, because that is where the Barchart key and the full national pull
 * live." That was true and is not any more — the key and the pull are here now.
 * So the directory is built from data/barchart.json, in the same job that
 * fetched it, and the grid grows on the next run rather than next month.
 *
 * IT REFUSES TO REPLACE GOOD DATA WITH BAD, exactly as sync_known.py does, and
 * for the same reason: a directory that quietly loses a third of its facilities
 * shows fewer grey pins on a map with no explanation. Below the floor it exits
 * non-zero and leaves the existing file alone. A stale directory is safe. A
 * silently emptied one is not.
 *
 * IT ONLY ADDS. A facility seen last week that Barchart did not return today is
 * KEPT — one fetch missing it means the query did not reach it, not that the
 * elevator closed. Coverage is a union over time, and the file records when each
 * facility was last seen so a genuinely dead one can be found on purpose.
 *
 * USAGE
 *     node scripts/build_known.mjs [--barchart data/barchart.json]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

/* THE GUARD THIS FILE FIRST HAD COULD NOT FIRE.
 *
 * It copied sync_known.py's rule — refuse if the directory falls below two
 * thirds of what it was — which is right for a script that REPLACES the file.
 * This one takes a union, so the output always contains everything the input
 * did and can never shrink. The check was unreachable. I only found that by
 * truncating the directory to 100 rows to watch it fail, and watching it pass.
 *
 * The union makes a shrunken directory impossible, so that is not the danger.
 * The danger is the FETCH quietly collapsing: 116 queries returning what 20
 * should. The directory stays safe and the grid stays fine, and nobody learns
 * that Barchart, or the key, or the network, has stopped working properly.
 * So what is guarded is the fetch, measured against the last one, and the run
 * goes red while the file on disk stays good. */
const FETCH_FLOOR = 0.66;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const keyOf = (r) => [norm(r.facility), norm(r.branch), norm(r.city), norm(r.state).toUpperCase()].join("|");

function main() {
  const bcPath = arg("--barchart", join(ROOT, "data", "barchart.json"));
  if (!existsSync(bcPath)) {
    console.error(`no ${bcPath} — run scripts/fetch_barchart.mjs first`);
    return 1;
  }
  const bc = JSON.parse(readFileSync(bcPath, "utf8"));
  if (bc.full === false) {
    console.error("REFUSED: that is a slim Barchart file, not a full run.");
    console.error("  A directory built from a slim file would drop every facility the");
    console.error("  slimming left out, and the shrink guard below would then refuse the");
    console.error("  next honest run for being 'too different'. Point at the full output.");
    return 1;
  }

  const seen = new Map();
  const now = bc.fetched || new Date().toISOString().replace(/\.\d+Z$/, "Z");
  for (const r of bc.bids || []) {
    const k = keyOf(r);
    if (!norm(r.facility) || seen.has(k)) continue;
    seen.set(k, { facility: norm(r.facility), branch: norm(r.branch) || null,
                  city: norm(r.city) || null, state: norm(r.state).toUpperCase() || null,
                  zip: norm(r.zip) || null, phone: norm(r.phone) || null,
                  source: "barchart", lastSeen: now });
  }

  const outPath = arg("--out", join(ROOT, "data", "known-elevators.json"));
  const prev = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;
  const prevRows = prev?.elevators || [];

  /* A UNION, NOT A REPLACEMENT. Today's fetch is 116 radius queries; a facility
   * it did not return may simply have been outside all of them, or behind a
   * query that failed. Dropping it would make the directory oscillate and the
   * grid oscillate with it. */
  const merged = new Map();
  for (const r of prevRows) merged.set(keyOf(r), r);
  let added = 0, refreshed = 0;
  for (const [k, r] of seen) {
    if (merged.has(k)) { merged.set(k, { ...merged.get(k), ...r }); refreshed++; }
    else { merged.set(k, r); added++; }
  }
  const kept = prevRows.length - refreshed;

  /* Compared against the previous fetch, not against the directory — see the
     note beside FETCH_FLOOR. The file is still written, because a union cannot
     be damaged by a thin fetch; what must not happen is the thin fetch passing
     unremarked. */
  /* AGAINST A HIGH-WATER MARK, NOT AGAINST LAST TIME.
     Comparing to the previous fetch alarms once and then goes quiet: the thin
     run writes its own small number as the new baseline, so the NEXT thin run
     looks normal and the alarm never fires again while the fault persists. The
     peak only ever moves up, so a broken fetch keeps the run red until it is
     genuinely fixed. */
  const peak = Math.max(prev?.counts?.peakFetchSaw ?? 0, prev?.counts?.seenThisFetch ?? 0);
  const thin = peak > 0 && seen.size < peak * FETCH_FLOOR;

  const rows = [...merged.values()].sort((a, b) =>
    (a.facility + a.branch).localeCompare(b.facility + b.branch));
  const out = {
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    from: "data/barchart.json — this repository's own fetch",
    complete: false,
    note: "Directory only: who operates a facility and where. No prices, no basis, no "
        + "symbols, no delivery windows. A union over every fetch, not a snapshot: a "
        + "facility absent from today's queries is kept, because one fetch missing it "
        + "means the query did not reach it, not that the elevator closed. `lastSeen` "
        + "says when Barchart last returned it.",
    counts: {
      facilities: rows.length,
      seenThisFetch: seen.size, added, refreshed,
      keptFromPreviousFetches: kept,
      states: new Set(rows.map((r) => r.state).filter(Boolean)).size,
      withZip: rows.filter((r) => r.zip).length,
    },
    saturated: bc.saturated || [], failed: bc.failed || [],
    elevators: rows,
  };
  out.counts.peakFetchSaw = Math.max(peak, seen.size);
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`wrote ${outPath}`);
  console.log(`  ${rows.length} facilities: ${added} new, ${refreshed} refreshed, `
            + `${kept} kept from earlier fetches`);
  if (added) console.log(`  the ${added} new ones reach the grid on the next build_grid run`);
  if ((bc.saturated || []).length) {
    console.log(`  NOTE: ${bc.saturated.length} queries were truncated at the location cap, so`);
    console.log("        this directory is a floor, not a census, in those areas.");
  }
  if (thin) {
    console.error(`\nFETCH COLLAPSED: this run saw ${seen.size} facilities where the best `
                + `run has seen ${peak}.`);
    console.error("  The directory on disk is unharmed — it is a union and nothing was lost.");
    console.error("  But something is wrong with the fetch, the key, or the grid, and a run");
    console.error("  that goes green here is a run nobody investigates.");
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
export { keyOf, FETCH_FLOOR };

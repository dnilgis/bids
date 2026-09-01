#!/usr/bin/env node
/* THE ZIPS A BARCHART QUERY MAY BE CENTRED ON.
 *
 * getGrainBids takes a zipCode, not a coordinate, so scripts/build_grid.mjs can
 * only choose query centres from ZIPs that actually exist and whose position we
 * know. This assembles that pool. Nothing here is invented: every ZIP arrives
 * with its coordinate already attached, from one of three places.
 *
 *   1. AGSIST's data/zip-grid.json — 590 ZIP centroids across 47 states.
 *   2. This repository's own sources — each carries the elevator's ZIP and the
 *      geocode we made for it.
 *   3. A Barchart response, which carries a ZIP on every facility row. This is
 *      the one that closes gaps: the first cover left 21 facilities with no
 *      candidate ZIP within 45 miles, in Oklahoma, Alabama and Missouri, where
 *      AGSIST's city grid was thin. A facility's own ZIP is by definition within
 *      nought miles of it.
 *
 * A ZIP is taken from the FIRST source that offers it, in that order, and the
 * file records which — so a coordinate that turns out to be wrong can be traced
 * to the table it came from rather than argued about.
 *
 * USAGE
 *     node scripts/build_zip_candidates.mjs --agsist-grid ../agsist/data/zip-grid.json \
 *                                           --barchart data/barchart.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const zip5 = (z) => { const s = String(z ?? "").trim().slice(0, 5); return /^\d{5}$/.test(s) ? s : null; };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const outPathOf = () => arg("--out", join(ROOT, "geocodes", "zip-candidates.json"));

function main() {
  const pool = new Map();
  const add = (zip, lat, lon, label, from) => {
    const z = zip5(zip);
    if (!z || num(lat) == null || num(lon) == null) return false;
    /* A COORDINATE OUTSIDE THE LOWER 48 IS NOT A GRAIN ZIP. Cheap, and it stops
       a transposed or defaulted pair from becoming a query centre nobody checks. */
    if (lat < 24 || lat > 50 || lon < -125 || lon > -66) return false;
    if (pool.has(z)) return false;
    pool.set(z, { zip: z, lat, lon, label: label || z, from });
    return true;
  };

  const counts = {};
  const gridPath = arg("--agsist-grid", "");
  if (gridPath && existsSync(gridPath)) {
    let n = 0;
    for (const e of JSON.parse(readFileSync(gridPath, "utf8"))) {
      if (add(e.zip, e.lat, e.lng ?? e.lon, e.label, "agsist zip-grid.json")) n++;
    }
    counts.agsistGrid = n;
  }

  const index = JSON.parse(readFileSync(join(ROOT, "data", "index.json"), "utf8"));
  let n2 = 0;
  for (const s of index.sources) {
    if (add(s.zip, s.lat, s.lon, `${s.location ?? "?"}, ${s.usState ?? "?"}`, `bids source ${s.id}`)) n2++;
  }
  counts.bidsSources = n2;

  const bcPath = arg("--barchart", "");
  if (bcPath && existsSync(bcPath)) {
    const bc = JSON.parse(readFileSync(bcPath, "utf8"));
    const places = JSON.parse(readFileSync(join(ROOT, "geocodes", "places.json"), "utf8"));
    const known = places.known || {};
    const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    let n3 = 0;
    for (const r of bc.bids || []) {
      /* The ZIP comes from Barchart; the COORDINATE comes from our own geocode of
         that facility. Barchart does not send one, and a ZIP centroid guessed
         here would be a second geocoder running in a helper script. */
      const k = [norm(r.facility), norm(r.branch), norm(r.city), norm(r.state).toUpperCase()].join("|");
      const p = known[k];
      if (p && add(r.zip, p.lat, p.lon, `${r.city ?? "?"}, ${r.state ?? "?"}`, "barchart facility")) n3++;
    }
    counts.barchartFacilities = n3;
  }

  /* ── A REBUILD MAY NOT QUIETLY LOSE GROUND ──────────────────────────────
     Run without --barchart, this rebuilds from the city grid and our own
     sources alone: 745 candidate ZIPs become 649, and the next build_grid run
     drops from 116 queries covering 99.8% to 114 covering 98.8%. Nothing said
     a word. That is how a feed degrades — not with an error, with a smaller
     number nobody compared.

     So it compares. A pool smaller than the one already on disk is refused
     unless --shrink says that is intended, and the message names what would
     have been lost. */
  const existing = existsSync(outPathOf()) ? JSON.parse(readFileSync(outPathOf(), "utf8")) : null;
  if (existing && pool.size < (existing.counts?.total ?? 0) && !process.argv.includes("--shrink")) {
    console.error(`REFUSED: this would cut the candidate pool from ${existing.counts.total} `
                + `ZIPs to ${pool.size}.`);
    const lost = (existing.zips || []).filter((z) => !pool.has(z.zip));
    const byOrigin = {};
    for (const z of lost) byOrigin[z.from?.startsWith("bids source") ? "bids sources" : z.from] =
      (byOrigin[z.from?.startsWith("bids source") ? "bids sources" : z.from] || 0) + 1;
    console.error(`  ${lost.length} would be dropped:`, byOrigin);
    console.error("  A smaller pool means a worse grid, and build_grid.mjs will not tell you");
    console.error("  either — it will just cover fewer elevators. Most likely you left off");
    console.error("  --barchart, which is where the facility ZIPs come from.");
    console.error("  Pass --shrink if the loss is intended.");
    return 1;
  }

  const out = {
    schema: "zip-candidates/1",
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    note: "Every ZIP a getGrainBids query may be centred on, each with the coordinate used "
        + "to reason about what a radius around it reaches. Nothing invented — every ZIP "
        + "arrived with its coordinate attached, and `from` says which table it came from. "
        + "A facility's own ZIP is the only thing that can cover a facility no city grid "
        + "reaches.",
    counts: { total: pool.size, ...counts },
    zips: [...pool.values()].sort((a, b) => a.zip.localeCompare(b.zip)),
  };
  const outPath = outPathOf();
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`${pool.size} candidate ZIPs ->`, counts);
  console.log(`wrote ${outPath}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

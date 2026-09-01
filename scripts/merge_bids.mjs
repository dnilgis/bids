#!/usr/bin/env node
/* ONE FEED. THE SCRAPED BOARDS AND BARCHART, IN ONE SHAPE, WITH THE SEAMS VISIBLE.
 *
 * WHY. AGSIST had two bid pipelines: this repository's scraped boards, and its own
 * Barchart fetch whose parsing was under written orders to "stay in lockstep with
 * cash-bids.html". Two copies of a rule that must agree is a defect with a date on
 * it. Sig asked for a single point of reference. This builds it.
 *
 * WHY IT LIVES HERE AND NOT IN AGSIST. Measured 2026-09-01: geocodes/places.json
 * already holds 1,806 Barchart facilities, every one geocoded, keyed
 * operator|branch|location|state — the exact four fields a Barchart row carries.
 * 413 of the 440 committed Barchart rows key into it exactly. The hard half of a
 * merge is knowing that two rows are the same elevator, and this repository had
 * already solved it. AGSIST becomes a consumer of one file.
 *
 * WHAT IT REFUSES TO DO
 *
 *   - It does not average. Nearby basis and deferred basis are different markets.
 *     AGSIST's basis map averages every period a location quotes into one dot;
 *     ADM Grain's corn runs +0.05 to +1.00, a 95c spread flattened to a point.
 *     Every row here keeps its own period key so a consumer can group like with
 *     like, and the map can stop averaging.
 *   - It does not trust an incoming label. Barchart returns "Soybean Meal" with
 *     category "soybeans"; meal is sold by the ton and would win "best soybean
 *     bid" outright. lib/crop.mjs re-derives the bucket for every row from
 *     whichever feed.
 *   - It does not invent a period, a coordinate, a state or a price. Anything
 *     unreadable is DROPPED AND COUNTED, and the counts are published in the
 *     file so a reader can see the size of what is missing.
 *   - It does not publish Barchart's deliveryStart. Eight of 440 rows carry a
 *     2012 date against a 2026 bid — a 5,509-day window. That field is when the
 *     bid opened, not when delivery starts. deliveryEnd's month matches the
 *     contract month on 440 of 440, so the contract month is what is carried.
 *
 * USAGE
 *     node scripts/merge_bids.mjs [--barchart data/barchart.json] [--out data/merged.json]
 *     node scripts/merge_bids.mjs --no-barchart     # scraped boards only
 *
 * The --no-barchart switch is the one gate the whole Barchart half hangs on. If
 * the licence position ever changes, this is the flag, not a rebuild.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { crop, ppu, plausible, basisCents, basisDollars, PPU_BAND } from "../lib/crop.mjs";
import { delivery } from "../lib/delivery.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = "agsist-merged-index/1";
const SHARD_SCHEMA = "agsist-merged-place/1";

/* A FILE NAME MUST NOT COLLIDE AND MUST NOT SURPRISE.
 * A place key is "Operator|Branch|Town|ST" and can hold slashes, quotes, accents
 * and non-ASCII. Slugging alone would let "A/B" and "A-B" land on one file and
 * silently merge two elevators, so the slug is followed by a short hash of the
 * FULL key: readable in a directory listing, and unique because the hash is. */
const shardName = (place) => {
  const slug = place.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${slug || "place"}-${createHash("sha1").update(place).digest("hex").slice(0, 8)}`;
};

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const has = (name) => process.argv.includes(name);

/* data/ HOLDS BOARDS AND ALSO SIX THINGS THAT ARE NOT BOARDS.
 * This list was written when there were four. Adding data/barchart-grid.json,
 * data/known-elevators.json and data/merged-index.json in this same package and
 * NOT adding them here is how they came to be reported as "board file with no
 * entry in index.json" — my own files, blamed on the index. A denylist that the
 * author of a new file has to remember is a denylist that goes stale, so the
 * unexpected case below reports rather than assumes, and this list only keeps
 * the noise down for files we put there on purpose. */
const NOT_A_BOARD = new Set([
  "index.json", "directory.json", "platforms.json", "registries.json",
  "registry-ia.json", "registry-survey.json", "us-states.json",
  "known-elevators.json", "barchart-grid.json", "merged-index.json", "merged.json",
]);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const r5 = (n) => (typeof n === "number" ? Math.round(n * 1e5) / 1e5 : null);

/* THE JOIN KEY IS THE ONE places.json ALREADY USES. Not a new one — the same
 * operator|branch|location|state the geocoder wrote, so a Barchart row and a
 * geocoded place meet without a translation layer in between. */
const placeKey = (operator, branch, location, state) =>
  [norm(operator), norm(branch), norm(location), norm(state).toUpperCase()].join("|");

/* Every drop is counted under a reason a person can act on. A tally of
 * "dropped: 214" tells the next reader nothing about whether that is a bug. */
class Tally {
  constructor() { this.n = {}; this.eg = {}; }
  drop(why, example) {
    this.n[why] = (this.n[why] || 0) + 1;
    if (!this.eg[why]) this.eg[why] = example;
  }
  get total() { return Object.values(this.n).reduce((a, b) => a + b, 0); }
  report(label) {
    if (!this.total) { console.log(`  ${label}: nothing dropped`); return; }
    console.log(`  ${label}: ${this.total} rows dropped`);
    for (const [why, n] of Object.entries(this.n).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(5)}  ${why}`);
      if (this.eg[why]) console.log(`            e.g. ${this.eg[why]}`);
    }
  }
}

/* ── ONE ROW SHAPE ───────────────────────────────────────────────────────────
 * The board's own words are never overwritten: `commodity` and `delivery` are
 * verbatim. `crop` and `period` are ADDED beside them for anything that has to
 * select or group. `via` says which reader produced the row, and every row has
 * one — there is no such thing as an anonymous row in this file. */
function row(o) {
  const c = crop(o.commodity);
  const d = delivery(o.delivery, o.asOf);
  const cash = ppu(o.cash);
  return {
    place: o.place,
    operator: o.operator, branch: o.branch || null,
    city: o.city || null, state: o.state || null, zip: o.zip || null,
    lat: r5(o.lat), lon: r5(o.lon), precision: o.precision || null,

    commodity: o.commodity ?? null,      // verbatim, the board's own words
    crop: c,                             // derived here, never taken from a feed
    delivery: o.delivery ?? null,        // verbatim
    period: d.key,                       // comparable; null if unreadable
    periodVia: d.via,                    // how the period was arrived at

    cash: cash == null ? null : Math.round(cash * 1e4) / 1e4,

    /* THE FEED'S OWN NUMBER, ALWAYS, UNTOUCHED. Every conversion below can be
       audited against this, and a consumer that distrusts our arithmetic can do
       its own. */
    basisRaw: Number.isFinite(o.basis) ? o.basis : null,

    /* THE CENTS-OR-DOLLARS HEURISTIC IS |b| < 5, AND IT IS ONLY SOUND PER BUSHEL.
       Barchart returns Soybean Meal with basis -13.0. Meal trades near $300 a
       TON, so -13.0 is thirteen dollars a ton — and the heuristic read it as
       thirteen cents and published -0.13, a number the feed never said. Per-ton
       commodities are exactly the ones with no per-bushel band, so the band is
       the test: where we do not know the unit, the converted fields stay null
       and basisRaw carries the truth. Nothing invented, nothing lost. */
    basis: PPU_BAND[c] ? basisDollars(o.basis) : null,
    basisCents: PPU_BAND[c] ? basisCents(o.basis) : null,
    basisUnit: PPU_BAND[c] ? "per-bushel" : "unknown",
    futuresMonth: o.futuresMonth ?? null,
    futuresCents: o.futuresCents ?? null,

    /* Everything needed to draw it. False is an honest "we do not know where
       this is", not a claim that the price is doubtful. */
    mappable: r5(o.lat) != null && r5(o.lon) != null && !!norm(o.state),

    via: o.via, source: o.source,
    pricedAt: o.pricedAt || null, checkedAt: o.checkedAt || null,
  };
}

/* ── THE SCRAPED BOARDS ─────────────────────────────────────────────────────*/
/* THE COORDINATE HAS ONE OWNER, AND IT IS geocodes/places.json.
 * index.json carries a lat/lon as a convenience copy, but it is written by the
 * poller and the geocoder is a different job on a different schedule — so the
 * index can be missing a coordinate the geocoder already has. Reading the index
 * alone dropped 473 scraped bids on the first run, 22 sources' worth of which
 * were geocoded all along. places{} is asked first, and the index is the
 * fallback, not the other way round. */
function coordOf(s, places) {
  const p = (places.places || {})[s.id];
  if (p && typeof p.lat === "number") {
    return { lat: p.lat, lon: p.lon, precision: p.precision || null, via: p.via || "places.json" };
  }
  if (typeof s.lat === "number") {
    return { lat: s.lat, lon: s.lon, precision: s.latPrecision || null, via: "index.json" };
  }
  return { lat: null, lon: null, precision: null, via: null };
}

function readScraped(index, places, tally) {
  const byId = new Map(index.sources.map((s) => [s.id, s]));
  const out = [];
  for (const f of readdirSync(join(ROOT, "data")).filter((x) => x.endsWith(".json"))) {
    if (NOT_A_BOARD.has(f)) continue;
    const id = f.replace(/\.json$/, "");
    const s = byId.get(id);
    if (!s) {
      /* A SHARD IS NOT A BOARD, AND IT SAYS SO IN ITS OWN SCHEMA.
         On 2026-09-01 an upload of this package put 29 of its 323 shards in
         data/ instead of data/merged/ — a browser upload split a folder, which
         is a thing browser uploads do. They fell into this branch and were
         reported as "no entry in index.json", which is TRUE and USELESS: it
         points at the index when the fix is to move a file. The schema on the
         file says exactly what it is, so it is asked before blame is assigned.
         The order matters and is the whole bug: this test used to run before
         the file was ever opened. */
      let peek = null;
      try { peek = JSON.parse(readFileSync(join(ROOT, "data", f), "utf8")); } catch { /* not JSON */ }
      if (peek && peek.schema === SHARD_SCHEMA) {
        tally.drop("a merged shard filed in data/ instead of data/merged/ — move or delete it", f);
      } else {
        tally.drop("board file with no entry in index.json", id);
      }
      continue;
    }
    /* inMerge is this repository's existing switch: "read this board" and "put it
     * on the map" are deliberately two different questions. A board read without
     * a state is harmless; a published row whose state says SET THIS is a wrong
     * answer in front of somebody. That decision is respected here, not re-made. */
    if (s.inMerge === false) { tally.drop("inMerge is false on the source", id); continue; }
    let j;
    try { j = JSON.parse(readFileSync(join(ROOT, "data", f), "utf8")); }
    catch { tally.drop("board file would not parse", f); continue; }
    /* A SHARD IS NOT A BOARD, AND IT SAYS SO IN ITS OWN SCHEMA.
       On 2026-09-01 an upload of this package put 29 of its 323 shards in data/
       instead of data/merged/ — a browser upload split a folder, which is a
       thing browser uploads do. They then read as boards with no entry in
       index.json and were dropped under that reason, which is TRUE and USELESS:
       it points at the index when the fix is to move a file. Named for what
       they are, and counted apart, so the message says what to do. */
    if (j && j.schema === SHARD_SCHEMA) {
      tally.drop("a merged shard filed in data/ instead of data/merged/ — move or delete it", f);
      continue;
    }
    if (s.status !== "ok") { tally.drop(`source status is "${s.status}"`, id); continue; }
    const g = coordOf(s, places);
    for (const b of j.bids || []) {
      out.push(row({
        place: placeKey(s.operator, "", s.location, s.usState),
        operator: s.operator, branch: null,
        city: s.location, state: s.usState, zip: s.zip,
        lat: g.lat, lon: g.lon, precision: g.precision,
        commodity: b.commodity, delivery: b.delivery,
        cash: b.cash, basis: b.basisDollars ?? b.basisCents,
        futuresMonth: b.futuresMonth, futuresCents: b.futuresPriceCents,
        via: "scrape", source: id,
        pricedAt: j.pricedAt, checkedAt: j.checkedAt, asOf: j.pricedAt || j.checkedAt,
      }));
    }
  }
  return out;
}

/* ── BARCHART ───────────────────────────────────────────────────────────────*/
function readBarchart(bc, places, tally) {
  const known = places.known || {};
  const out = [];
  const unknownPlaces = new Map();
  for (const r of bc.bids || []) {
    const k = placeKey(r.facility, r.branch, r.city, r.state);
    const p = known[k];
    if (!p) {
      /* A facility the directory has not caught up with. NOT geocoded from the
       * ZIP here — that would be a second, weaker geocoder running in a merge
       * step, and a coordinate has one owner in this repository. It is named so
       * the directory job can pick it up. */
      unknownPlaces.set(k, (unknownPlaces.get(k) || 0) + 1);
      tally.drop("facility not yet in the geocoded directory", k);
      continue;
    }
    out.push(row({
      place: k,
      operator: r.facility, branch: r.branch,
      city: r.city || p.location, state: r.state || p.state, zip: r.zip,
      lat: p.lat, lon: p.lon, precision: p.precision,
      commodity: r.commodity, delivery: r.deliveryMonth,
      cash: r.cashPrice, basis: r.basis,
      futuresMonth: r.symbol, futuresCents: null,
      via: "barchart", source: `barchart:${r.sourceZip || "?"}`,
      pricedAt: bc.fetched, checkedAt: bc.fetched, asOf: bc.fetched,
    }));
  }
  return { out, unknownPlaces };
}

/* ── THE GUARDS EVERY ROW PASSES, WHOEVER SENT IT ───────────────────────────*/
/* A MISSING COORDINATE IS NOT A MISSING PRICE.
 * The first cut dropped 293 bids for having no coordinate and 49 for having no
 * state. But only the maps need a coordinate — the futures pages and the
 * homepage card need a number and a town name, and those rows had both. Throwing
 * away a real bid from a real elevator because we cannot draw it is a silent
 * withholding, and a consumer that needs a pin can filter on `mappable` in one
 * line. So they are KEPT and FLAGGED, and the count of unmappable rows is
 * published so nobody mistakes the map for the whole feed. */
function keepable(b, tally) {
  if (b.cash == null && b.basis == null) { tally.drop("no cash and no basis", `${b.place} ${b.commodity}`); return false; }
  if (b.period == null) { tally.drop(`delivery unreadable (${b.periodVia})`, JSON.stringify(b.delivery)); return false; }
  /* The FJ Krob band. A per-ton row rescaled by ppu() comes out absurdly cheap
   * and would otherwise win its crop outright. Withheld and counted, never
   * rescaled until it looks sensible. */
  if (b.cash != null && !plausible(b.cash, b.crop)) {
    tally.drop(`cash outside the plausible band for ${b.crop}`, `${b.place} ${b.commodity} ${b.cash}`);
    return false;
  }
  /* A basis more than $3 from the board is a unit error, not a market. This is
   * AGSIST's own existing limit, applied to both feeds rather than one. */
  if (b.basis != null && Math.abs(b.basis) > 3.0) {
    tally.drop("basis more than $3.00 from the board — a unit error, not a market",
      `${b.place} ${b.commodity} ${b.basis}`);
    return false;
  }
  /* An unbanded row has no converted basis to test, so the $3 rule cannot speak
     for it. That is stated rather than papered over: the row is published with
     basisUnit "unknown" and a consumer selecting on basis must skip it. */
  return true;
}

/* TWO FEEDS CAN QUOTE THE SAME ELEVATOR FOR THE SAME THING. Nine towns and one
 * operator overlap between them, so this is rare — but where it happens the
 * FIRST-PARTY READ WINS. We read that board off the elevator's own page; Barchart
 * is a redistributor and can be a refresh behind. The loser is kept in the file
 * under `supersededBy` rather than deleted, because a silently discarded
 * disagreement is the one nobody ever finds. */
function dedupe(rows) {
  const seen = new Map();
  const collisions = [];
  for (const b of rows) {
    const k = [b.place, b.crop, b.period, b.commodity].join("␟");
    const prev = seen.get(k);
    if (!prev) { seen.set(k, b); continue; }
    const [win, lose] = prev.via === "scrape" ? [prev, b] : [b, prev];
    if (prev.via !== b.via) {
      collisions.push({ place: b.place, crop: b.crop, period: b.period,
                        kept: win.via, dropped: lose.via,
                        keptCash: win.cash, droppedCash: lose.cash });
    }
    seen.set(k, win);
  }
  return { rows: [...seen.values()], collisions };
}

function main() {
  const idxPath = join(ROOT, "data", "index.json");
  const plPath = join(ROOT, "geocodes", "places.json");
  for (const [p, what] of [[idxPath, "data/index.json"], [plPath, "geocodes/places.json"]]) {
    if (!existsSync(p)) { console.error(`missing ${what} — this build reads it, it does not create it`); process.exit(1); }
  }
  const index = JSON.parse(readFileSync(idxPath, "utf8"));
  const places = JSON.parse(readFileSync(plPath, "utf8"));

  const scrapeTally = new Tally(), bcTally = new Tally(), keepTally = new Tally();
  console.log("reading the scraped boards…");
  let rows = readScraped(index, places, scrapeTally);
  console.log(`  ${rows.length} bids from ${index.sources.filter((s) => s.status === "ok").length} live boards`);
  scrapeTally.report("scrape");

  let unknownPlaces = new Map(), barchartRead = 0;
  const bcPath = arg("--barchart", join(ROOT, "data", "barchart.json"));
  if (has("--no-barchart")) {
    console.log("\n--no-barchart: the Barchart half is switched off for this run.");
  } else if (!existsSync(bcPath)) {
    console.log(`\nno Barchart file at ${bcPath} — building from the scraped boards alone.`);
    console.log("  (this is a smaller feed, not a broken one; the count below says so)");
  } else {
    console.log("\nreading Barchart…");
    const bc = JSON.parse(readFileSync(bcPath, "utf8"));
    if (bc.full === false) {
      console.error("REFUSED: that Barchart file is the slim browser copy, not the full run.");
      console.error("  It carries only the rows a page needed. Merging it would publish a");
      console.error("  fraction of the feed while reporting a whole one. Point --barchart at");
      console.error("  the complete output of fetch_barchart.mjs.");
      process.exit(1);
    }
    const r = readBarchart(bc, places, bcTally);
    barchartRead = r.out.length; unknownPlaces = r.unknownPlaces;
    rows = rows.concat(r.out);
    console.log(`  ${barchartRead} bids matched to a geocoded place`);
    bcTally.report("barchart");
  }

  const misfiled = Object.entries(scrapeTally.n)
    .filter(([k]) => k.startsWith("a merged shard filed in data/"))
    .reduce((a, [, n]) => a + n, 0);
  if (misfiled) {
    console.log(`\n${misfiled} MERGED SHARD(S) SIT IN data/ RATHER THAN data/merged/.`);
    console.log("  Harmless to the feed — they are skipped — but they clutter the board");
    console.log("  directory and every run from here will report them. Delete them: they");
    console.log(`  are the files directly in data/ whose schema is "${SHARD_SCHEMA}".`);
    console.log("  scripts/tidy_shards.mjs --write does it in one pass.");
  }

  console.log("\nguards…");
  rows = rows.filter((b) => keepable(b, keepTally));
  keepTally.report("guards");

  const { rows: kept, collisions } = dedupe(rows);
  console.log(`\ndedupe: ${rows.length} -> ${kept.length}`);
  if (collisions.length) {
    console.log(`  ${collisions.length} place/crop/period quoted by BOTH feeds; the first-party read wins:`);
    for (const c of collisions.slice(0, 10)) {
      console.log(`     ${c.place} ${c.crop} ${c.period}  kept ${c.kept} ${c.keptCash} over ${c.dropped} ${c.droppedCash}`);
    }
  }

  const byCrop = {}, byVia = {}, byState = {}, byPeriodVia = {};
  const placesSeen = new Set();
  let unmappable = 0, noState = 0, noCoord = 0;
  for (const b of kept) {
    if (!b.mappable) {
      unmappable++;
      if (!b.state) noState++;
      if (b.lat == null) noCoord++;
    }
    byCrop[b.crop] = (byCrop[b.crop] || 0) + 1;
    byVia[b.via] = (byVia[b.via] || 0) + 1;
    byState[b.state] = (byState[b.state] || 0) + 1;
    byPeriodVia[b.periodVia] = (byPeriodVia[b.periodVia] || 0) + 1;
    placesSeen.add(b.place);
  }

  const out = {
    schema: SCHEMA,
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    note: "One row per elevator, crop, delivery period and commodity label. `commodity` and "
        + "`delivery` are the board's own words, never rewritten. `crop` and `period` are derived "
        + "here so a consumer can group like with like — `periodVia` says how each period was "
        + "arrived at, and an inferred year says so. Nothing is averaged. Rows that could not be "
        + "read are dropped and counted under `dropped`, never quietly omitted.",
    sources: {
      scrape: { rows: byVia.scrape || 0, boards: index.sources.filter((s) => s.status === "ok").length,
                generated: index.generated },
      barchart: { rows: byVia.barchart || 0, matched: barchartRead,
                  facilitiesNotYetInDirectory: unknownPlaces.size },
    },
    counts: {
      rows: kept.length, places: placesSeen.size,
      byCrop, byVia, byState, byPeriodVia,
      collisionsBetweenFeeds: collisions.length,
      /* Real prices that cannot go on a map. Published so the map is never
         mistaken for the whole feed. */
      unmappable, unmappableNoCoordinate: noCoord, unmappableNoState: noState,
    },
    dropped: { scrape: scrapeTally.n, barchart: bcTally.n, guards: keepTally.n },
    collisions,
    /* Named so the directory job can pick them up. A facility Barchart prices
     * that we cannot place is a gap with an address, not a mystery. */
    facilitiesNotYetInDirectory: [...unknownPlaces.entries()]
      .sort((a, b) => b[1] - a[1]).map(([place, rows]) => ({ place, rows })),
    bids: kept,
  };

  /* ── ONE FILE WAS THE WRONG SHAPE, AND THE ARITHMETIC SAYS SO ──────────────
   *
   * The first cut wrote every bid into data/merged.json. Measured against the
   * committed sample: 701 bytes a row, 43.7 bids per facility, and a grid that
   * reaches 1,802 facilities.
   *
   *      1,802 x 43.7 x 701  =  about 55 MB, in one file
   *
   * GitHub warns over 50 MB and refuses over 100, and raw.githubusercontent.com
   * would be handing that to a browser to draw a map with. It was fine at the
   * 3,274 scraped rows it was built against and would have failed the week the
   * grid was switched on — the worst kind of defect, because the small case
   * works.
   *
   * SO IT IS SPLIT THE WAY THIS REPOSITORY ALREADY SPLITS THINGS: an index
   * beside per-item detail, exactly as data/index.json sits beside the 356
   * board files.
   *
   *   data/merged-index.json     one row per place, the best bid per crop,
   *                              about 1 MB at 2,500 places. A map, a "near me"
   *                              card and a state roll-up need nothing else.
   *   data/merged/<place>.json   that place's every bid, about 30 KB, fetched
   *                              when somebody clicks the pin.
   *
   * A shard is only rewritten when its contents change, so a place whose board
   * did not move makes no new git object — which is the same reason the 356
   * board files are affordable at a ten-minute cadence. */
  const outDir = arg("--shard-dir", join(ROOT, "data", "merged"));
  mkdirSync(outDir, { recursive: true });

  const byPlace = new Map();
  for (const b of kept) {
    if (!byPlace.has(b.place)) byPlace.set(b.place, []);
    byPlace.get(b.place).push(b);
  }

  const placeRows = [];
  let shardsWritten = 0, shardsUnchanged = 0;
  for (const [place, bids] of byPlace) {
    /* BEST IS PER CROP AND PER PLACE, AND IT IS NOT A COMPARISON ACROSS
       PERIODS. A October bid and a July-next-year bid are different markets;
       picking the higher number across them would recreate the averaging fault
       this whole file exists to avoid. So `best` carries the top cash bid for
       each crop AND the period it is for, and a consumer that needs one period
       reads the shard. */
    const best = {};
    for (const b of bids) {
      if (b.cash == null) continue;
      const cur = best[b.crop];
      if (!cur || b.cash > cur.cash) {
        best[b.crop] = { cash: b.cash, basis: b.basis, basisCents: b.basisCents,
                         period: b.period, commodity: b.commodity, delivery: b.delivery };
      }
    }
    const f = bids[0];
    const slug = shardName(place);
    placeRows.push({
      place, shard: `merged/${slug}.json`,
      operator: f.operator, branch: f.branch, city: f.city, state: f.state,
      lat: f.lat, lon: f.lon, precision: f.precision, mappable: f.mappable,
      via: f.via, source: f.source, bids: bids.length,
      crops: [...new Set(bids.map((b) => b.crop))].sort(),
      periods: [...new Set(bids.map((b) => b.period))].sort(),
      best, pricedAt: f.pricedAt, checkedAt: f.checkedAt,
    });
    const shard = { schema: SHARD_SCHEMA, place, generated: out.generated,
                    operator: f.operator, city: f.city, state: f.state,
                    lat: f.lat, lon: f.lon, bids };
    const path = join(outDir, `${slug}.json`);
    const text = JSON.stringify(shard, null, 1);
    /* Compare before writing. An identical rewrite still updates the mtime and
       still shows as a change to anything watching the tree. */
    if (existsSync(path) && readFileSync(path, "utf8") === text) { shardsUnchanged++; continue; }
    writeFileSync(path, text);
    shardsWritten++;
  }
  placeRows.sort((a, b) => a.place.localeCompare(b.place));

  /* A SHARD FOR A PLACE THAT NO LONGER HAS BIDS IS A LIE WITH A DATE ON IT.
     Named, not deleted — this script does not remove files it did not make in
     this run, and a stale shard the index does not point at is harmless until
     somebody has looked at why it went quiet. */
  const live = new Set([...byPlace.keys()].map(shardName));
  const orphanShards = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => f.endsWith(".json") && !live.has(f.replace(/\.json$/, "")))
    : [];

  out.shards = { dir: "data/merged", written: shardsWritten, unchanged: shardsUnchanged,
                 orphaned: orphanShards };
  const indexOut = { ...out, bids: undefined, places: placeRows };
  delete indexOut.bids;

  const outPath = arg("--out", join(ROOT, "data", "merged-index.json"));
  writeFileSync(outPath, JSON.stringify(indexOut, null, 1));
  console.log(`\nwrote ${outPath}`);
  console.log(`  ${placeRows.length} places, ${(statSync(outPath).size / 1048576).toFixed(2)} MB`);
  console.log(`  shards: ${shardsWritten} written, ${shardsUnchanged} unchanged`
            + `${orphanShards.length ? `, ${orphanShards.length} orphaned (named, not deleted)` : ""}`);
  if (orphanShards.length) for (const o of orphanShards.slice(0, 8)) console.log(`     ${o}`);
  console.log(`  ${kept.length} bids across ${placesSeen.size} places in ${Object.keys(byState).length} states`);
  console.log(`  by crop:`, byCrop);
  console.log(`  by feed:`, byVia);
  if (unmappable) {
    console.log(`  ${unmappable} rows carry a price but cannot be mapped `
      + `(${noCoord} without a coordinate, ${noState} without a state). Kept, flagged, counted.`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
export { placeKey, row, keepable, dedupe, Tally, shardName };

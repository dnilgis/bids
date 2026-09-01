/* ONE FEED, AND THE SEAMS STAY VISIBLE.
 *
 * scripts/merge_bids.mjs puts the scraped boards and Barchart into one shape for
 * AGSIST to read. These tests are about the things a merge quietly gets wrong:
 * a label rewritten, a period averaged away, a disagreement resolved in silence,
 * a unit converted where the unit was not known.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeKey, row, keepable, dedupe, Tally, shardName } from "../scripts/merge_bids.mjs";

const ASOF = "2026-09-01T12:00:00Z";
const base = {
  place: "Acme Coop||Thorp|WI", operator: "Acme Coop", branch: null,
  city: "Thorp", state: "WI", zip: "54771", lat: 44.96, lon: -90.799,
  precision: "town", via: "scrape", source: "acme-thorp", asOf: ASOF,
};
const mk = (o) => row({ ...base, ...o });

/* ── THE JOIN KEY IS THE ONE places.json ALREADY WROTE ─────────────────────*/
test("the place key matches the geocoder's, character for character", () => {
  assert.equal(placeKey("21st Century Coop", "All Locations", "Cumberland", "IA"),
    "21st Century Coop|All Locations|Cumberland|IA");
  assert.equal(placeKey(" Acme  Coop ", "", "Thorp", "wi"), "Acme Coop||Thorp|WI");
  assert.equal(placeKey(null, undefined, "", ""), "|||");
});

/* ── THE BOARD'S OWN WORDS ─────────────────────────────────────────────────
   This repo keys its rows on the elevator's own strings and renders them to
   growers. "Wheat, HRS 14%" is a protein spec and the spec is money. The merge
   ADDS a bucket; it never edits the label. */
test("the label and the delivery string survive verbatim", () => {
  const b = mk({ commodity: "Wheat, HRS 14%", delivery: "New Crop 26", cash: 6.1, basis: -0.4 });
  assert.equal(b.commodity, "Wheat, HRS 14%");
  assert.equal(b.delivery, "New Crop 26");
  assert.equal(b.crop, "wheat", "the bucket is added beside the label");
  assert.equal(b.period, "newcrop-2026");
});

/* ── NOTHING IS AVERAGED ───────────────────────────────────────────────────
   AGSIST's basis map averages every period one location quotes into a single
   dot. ADM Grain's corn runs +0.05 to +1.00 — a 95c spread flattened to a
   point that matches no bid anyone can hit. Two periods stay two rows. */
test("two delivery periods at one place stay two rows", () => {
  const rows = [
    mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.30 }),
    mk({ commodity: "Corn", delivery: "MAR 2027", cash: 4.6, basis: -0.10 }),
  ];
  const { rows: kept } = dedupe(rows);
  assert.equal(kept.length, 2, "the periods were collapsed");
  assert.notEqual(kept[0].period, kept[1].period);
});

test("the same period quoted twice at one place collapses to one row", () => {
  const rows = [mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 }),
                mk({ commodity: "Corn", delivery: "Oct 26",   cash: 4.2, basis: -0.3 })];
  assert.equal(dedupe(rows).rows.length, 1, "two spellings of October are one period");
});

/* ── A DISAGREEMENT IS RESOLVED IN THE OPEN ────────────────────────────────
   The two feeds overlap on nine towns and one operator, so in the committed data
   this fires zero times — which is exactly why it is tested here rather than
   trusted to real rows. First-party wins: we read that board off the elevator's
   own page and Barchart is a redistributor that can be a refresh behind. The
   loser is REPORTED, because a silently discarded disagreement is the one
   nobody ever finds. */
test("where both feeds quote the same thing, the first-party read wins and the clash is reported", () => {
  const scraped = mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.25, basis: -0.30 });
  const barchart = row({ ...base, via: "barchart", source: "barchart:54701",
                         commodity: "Corn", delivery: "Oct26", cash: 4.11, basis: -0.44 });
  for (const order of [[scraped, barchart], [barchart, scraped]]) {
    const { rows: kept, collisions } = dedupe(order);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].via, "scrape", "Barchart beat the first-party read");
    assert.equal(kept[0].cash, 4.25);
    assert.equal(collisions.length, 1, "the disagreement was not reported");
    assert.equal(collisions[0].kept, "scrape");
    assert.equal(collisions[0].dropped, "barchart");
    assert.equal(collisions[0].droppedCash, 4.11, "the losing number must be recoverable");
  }
});

test("two rows from the same feed are not counted as a cross-feed collision", () => {
  const { collisions } = dedupe([
    mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 }),
    mk({ commodity: "Corn", delivery: "Oct 26", cash: 4.2, basis: -0.3 }),
  ]);
  assert.equal(collisions.length, 0);
});

/* ── UNITS ─────────────────────────────────────────────────────────────────
   Barchart returns Soybean Meal with basis -13.0. Meal trades near $300 a TON,
   so that is thirteen dollars a ton — and the |b|<5 cents heuristic read it as
   thirteen cents and published -0.13, a number no feed ever sent. The heuristic
   is sound per bushel and only per bushel, and the per-bushel band is the test. */
test("a basis is only converted where the unit is known", () => {
  const meal = row({ ...base, via: "barchart", source: "barchart:56001",
                     commodity: "Soybean Meal", delivery: "Oct26", cash: 3.256, basis: -13.0 });
  assert.equal(meal.crop, "other");
  assert.equal(meal.basisUnit, "unknown");
  assert.equal(meal.basis, null, "an unknown unit must not be converted");
  assert.equal(meal.basisCents, null);
  assert.equal(meal.basisRaw, -13.0, "the feed's own number must survive untouched");
});

test("a per-bushel basis converts, both ways, and keeps its raw value", () => {
  const b = mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.60 });
  assert.equal(b.basisUnit, "per-bushel");
  assert.equal(b.basis, -0.60);
  assert.equal(b.basisCents, -60);
  assert.equal(b.basisRaw, -0.60);
  const c = mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -60 });
  assert.equal(c.basis, -0.60, "cents and dollars must reach the same answer");
  assert.equal(c.basisRaw, -60, "and each must still say what it was sent");
});

test("every row carries the feed that produced it", () => {
  for (const v of ["scrape", "barchart"]) {
    const b = row({ ...base, via: v, commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 });
    assert.equal(b.via, v);
    assert.ok(b.source, "a row with no source is an anonymous row");
  }
});

/* ── WHAT IS DROPPED, AND WHAT IS ONLY FLAGGED ─────────────────────────────
   The first cut dropped 293 bids for having no coordinate and 49 for having no
   state. Only the maps need a coordinate; the futures pages need a number and a
   town, and those rows had both. Dropping them was a silent withholding. */
test("a real price with no coordinate is kept and flagged, not dropped", () => {
  const t = new Tally();
  const b = mk({ lat: null, lon: null, commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 });
  assert.equal(b.mappable, false);
  assert.equal(keepable(b, t), true, "a bid was thrown away for not being drawable");
  assert.equal(t.total, 0);
});

test("a row with no state is kept and flagged too", () => {
  const b = mk({ state: "", commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 });
  assert.equal(b.mappable, false);
  assert.equal(keepable(b, new Tally()), true);
});

test("a row with a coordinate and a state is mappable", () => {
  assert.equal(mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 }).mappable, true);
});

test("a row with no price at all is dropped, with a reason", () => {
  const t = new Tally();
  assert.equal(keepable(mk({ commodity: "Corn", delivery: "OCT 2026", cash: null, basis: null }), t), false);
  assert.equal(t.total, 1);
  assert.ok(Object.keys(t.n)[0].includes("no cash and no basis"));
});

test("an unreadable delivery is dropped, and the reason names the shape", () => {
  const t = new Tally();
  assert.equal(keepable(mk({ commodity: "Corn", delivery: "J/J27", cash: 4.2, basis: -0.3 }), t), false);
  assert.ok(Object.keys(t.n)[0].startsWith("delivery unreadable"), Object.keys(t.n)[0]);
});

/* FJ Krob of Walker, Iowa posted SOYBEANS at 120.083 — a per-ton row. ppu()
   rescales it to $1.20, which is below any soybean price there has ever been. */
test("a per-ton row is withheld and counted, never rescaled into looking sensible", () => {
  const t = new Tally();
  const b = mk({ commodity: "Soybeans", delivery: "OCT 2026", cash: 120.083, basis: -0.3 });
  assert.equal(keepable(b, t), false);
  assert.ok(Object.keys(t.n)[0].includes("plausible band"));
});

test("a basis more than $3 from the board is a unit error and is refused", () => {
  const t = new Tally();
  assert.equal(keepable(mk({ commodity: "Soybeans", delivery: "OCT 2026", cash: 11, basis: 4 }), t), false);
});

test("every drop lands under a reason, with an example", () => {
  const t = new Tally();
  keepable(mk({ commodity: "Corn", delivery: "OCT 2026", cash: null, basis: null }), t);
  keepable(mk({ commodity: "Corn", delivery: "J/J27", cash: 4.2, basis: -0.3 }), t);
  assert.equal(Object.keys(t.n).length, 2, "two different faults must not share one bucket");
  for (const why of Object.keys(t.n)) assert.ok(t.eg[why], `"${why}" has no example a person could act on`);
});

/* ── THE SPLIT ─────────────────────────────────────────────────────────────
 *
 * The first cut wrote every bid into one data/merged.json. Measured: 701 bytes
 * a row, 43.7 bids per facility, a grid reaching 1,802 facilities — about 55 MB
 * in one file. GitHub warns over 50 and refuses over 100, and
 * raw.githubusercontent.com would hand it to a browser to draw a map with.
 *
 * It worked perfectly at the 3,274 scraped rows it was built against. That is
 * the whole danger: the small case passes and the defect arrives with success.
 *
 * So it is an index beside per-place shards, the way data/index.json already
 * sits beside 356 board files. These tests are about the two things a split can
 * silently get wrong: losing rows in the gap, and colliding two places onto one
 * file name.
 */
test("a shard name is unique even when the slug is not", () => {
  /* "A/B" and "A-B" slug identically. Without the hash they would land on one
     file and one elevator's bids would silently become another's. */
  const collide = ["Acme A/B|x|Thorp|WI", "Acme A-B|x|Thorp|WI", "Acme A B|x|Thorp|WI"];
  const names = collide.map(shardName);
  assert.equal(new Set(names).size, 3, `three different places share a file name: ${names}`);
});

test("a shard name is stable, readable, and safe as a file name", () => {
  const a = shardName("Premier Cooperative|Westby|Westby|WI");
  assert.equal(a, shardName("Premier Cooperative|Westby|Westby|WI"), "the same place must always name the same file");
  assert.match(a, /^[a-z0-9-]+$/, `"${a}" is not a safe file name`);
  assert.ok(a.includes("premier"), "the name should be findable in a directory listing");
  assert.ok(a.length <= 70, `"${a}" is ${a.length} characters`);
});

test("a shard name survives punctuation, accents and non-latin text", () => {
  for (const p of ["|||", "Ünïcode Grain|Ø|Åby|MN", "..|..|..|..", "'\"\\\\/|x|y|IA",
                   "A".repeat(300) + "|b|c|IA", "中文 Grain|x|y|IL"]) {
    const n = shardName(p);
    assert.match(n, /^[a-z0-9-]+$/, `"${p}" -> "${n}" is not a safe file name`);
    assert.ok(n.length > 8 && n.length <= 70, `"${p}" -> "${n}"`);
  }
  const weird = ["|||", "..|..|..|..", "中文 Grain|x|y|IL"];
  assert.equal(new Set(weird.map(shardName)).size, 3, "unslugabble names collapsed onto one file");
});

/* BEST IS PER CROP, AND NEVER A COMPARISON ACROSS PERIODS.
   An October bid and a July-next-year bid are different markets. Picking the
   higher number across them recreates exactly the averaging fault this file
   exists to prevent — so `best` carries the period it belongs to, and any
   consumer wanting one period reads the shard. */
test("the index's best-per-crop carries the period it is for", () => {
  const rows = [
    mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.20, basis: -0.30 }),
    mk({ commodity: "Corn", delivery: "JUL 2027", cash: 4.90, basis: -0.05 }),
  ];
  const { rows: kept } = dedupe(rows);
  const best = {};
  for (const b of kept) {
    if (b.cash == null) continue;
    if (!best[b.crop] || b.cash > best[b.crop].cash) best[b.crop] = { cash: b.cash, period: b.period };
  }
  assert.equal(best.corn.cash, 4.90);
  assert.equal(best.corn.period, "2027-07",
    "the best bid must say which period it is for, or it reads as a spot price");
});

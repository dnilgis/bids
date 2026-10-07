/* ONE FEED, AND THE SEAMS STAY VISIBLE.
 *
 * scripts/merge_bids.mjs puts the scraped boards and Barchart into one shape for
 * AGSIST to read. These tests are about the things a merge quietly gets wrong:
 * a label rewritten, a period averaged away, a disagreement resolved in silence,
 * a unit converted where the unit was not known.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeKey, row, keepable, dedupe, Tally, shardName, shardOf,
         isBoardFile, nearestOpen, deliveryMonth } from "../scripts/merge_bids.mjs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ASOF = "2026-09-01T12:00:00Z";
const base = {
  place: "Acme Coop||Thorp|WI", operator: "Acme Coop", branch: null,
  city: "Thorp", state: "WI", zip: "54771", lat: 44.96, lon: -90.799,
  precision: "town", via: "scrape", source: "acme-thorp", asOf: ASOF,
  /* Added 2026-09-06 with the currency guard. Thorp is in Wisconsin, so this
     is what the merge would resolve for it anyway -- the fixture is being told
     something true, not being given a pass. The guard itself is tested below. */
  currency: "USD", currencyVia: "province",
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

/* ── WHICH MONEY ────────────────────────────────────────────────────────────
   Wanstead Farmers Cooperative published Ontario corn at 6.92 into this feed
   for eight days beside a US median of 4.99. Every guard passed: 6.92 is inside
   corn's band, and cash - basis = futures holds on a board that quotes a
   Canadian basis over a US futures price. Nothing in the schema said which
   money it was, so nothing could. */
test("a row whose board could not establish a currency does not publish", () => {
  const t = new Tally();
  const b = row({ ...base, currency: null, currencyVia: null,
                  commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 });
  assert.equal(keepable(b, t), false, "a price with no currency reached the merge");
  assert.equal(t.total, 1);
  assert.match(JSON.stringify(t), /currency/, "the drop does not say why");
});

test("a Canadian row publishes, in Canadian dollars, and says so", () => {
  const b = row({ ...base, place: "Wanstead Farmers Cooperative||Wanstead|ON",
                  city: "Wanstead", state: "ON", zip: null,
                  currency: "CAD", currencyVia: "payload",
                  commodity: "Corn", delivery: "Sept 26", cash: 6.92, basis: 1.55 });
  assert.equal(keepable(b, new Tally()), true, "a real Canadian bid was thrown away");
  assert.equal(b.currency, "CAD");
  assert.equal(b.country, "CA");
  assert.equal(b.currencyVia, "payload");
  assert.equal(b.cash, 6.92, "the cash was converted — it must be published as posted");
});

test("the country is derived from the currency, never from the state alone", () => {
  assert.equal(row({ ...base, currency: "USD" }).country, "US");
  assert.equal(row({ ...base, currency: "CAD" }).country, "CA");
  assert.equal(row({ ...base, currency: null }).country, null);
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

/* ── A SHARD MUST NOT CARRY THE CLOCK OF THE RUN THAT WROTE IT ──────────────
 *
 * The whole reason 300-odd shard files are affordable at a ten-minute cadence
 * is that a quiet board makes no new git object. The first version put the
 * RUN's `generated` inside every shard, so all 310 changed on every pass
 * whatever the market did — and the run's own output said "0 unchanged" every
 * time, which I read past twice before md5summing two runs a second apart.
 *
 * A shard carries the board's own clocks. When the FEED was built is one fact
 * about the run, and it belongs in the index, once.
 */
test("two runs over unchanged bids produce byte-identical shards", () => {
  const bids = [mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 })];
  const a = JSON.stringify(shardOf("Acme Coop||Thorp|WI", bids));
  const b = JSON.stringify(shardOf("Acme Coop||Thorp|WI", bids));
  assert.equal(a, b);
  /* and the same content built a second later must still match — the real
     failure was a timestamp, so a second call is not enough on its own */
  assert.equal(a, JSON.stringify(shardOf("Acme Coop||Thorp|WI",
    [mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 })])));
});

test("a shard carries the board's clocks and never the run's", () => {
  const sh = shardOf("Acme Coop||Thorp|WI",
    [mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 })]);
  assert.ok(!("generated" in sh),
    "a shard carrying the run's `generated` changes on every pass and every quiet "
    + "board costs a git object — which is the whole cost sharding was meant to avoid");
  assert.ok("checkedAt" in sh && "pricedAt" in sh,
    "a shard must still say when its board was read and when it last moved");
});

test("a shard changes when its bids change, and only then", () => {
  const base = () => mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.2, basis: -0.3 });
  const same = JSON.stringify(shardOf("p", [base()]));
  const moved = JSON.stringify(shardOf("p", [mk({ commodity: "Corn", delivery: "OCT 2026", cash: 4.25, basis: -0.25 })]));
  assert.notEqual(same, moved, "a price moved and the shard did not");
});

/* ── WHAT IN data/ IS AN ELEVATOR ───────────────────────────────────────────
 *
 * data/ holds the board files AND every other .json this repository writes. The
 * rule used to be a hand-kept list of names to skip, and anything missing from
 * it was reported as "the poller did not reach this source and its bids are
 * being dropped" — the one tally that means bids were thrown away.
 *
 * On 2026-09-14 that tally had five entries and zero bids behind it, one of
 * them a coverage report written by the step above the merge in the same job.
 */

test("a board file is a bids array and a checkedAt, and that is the whole rule", () => {
  assert.equal(isBoardFile({ bids: [], checkedAt: "2026-09-14T01:00:00Z" }), true);
  /* An empty board is still a board: a co-op that posts nothing today has not
     stopped being an elevator, and its file must stay in the tally. */
  assert.equal(isBoardFile({ schema: "heartland/1", status: "ok", count: 0,
                             bids: [], checkedAt: "2026-09-14T01:00:00Z" }), true);
  for (const not of [
    null, undefined, 42, "a string", [], [{ bids: [], checkedAt: "x" }],
    { bids: [] },                                   // no clock
    { checkedAt: "2026-09-14T01:00:00Z" },          // no bids
    { bids: {}, checkedAt: "2026-09-14T01:00:00Z" },// bids is not a list
    { bids: [], checkedAt: "" },                    // empty clock is not a clock
    { schema: "agsist-barchart-coverage/1", generated: "2026-09-14T02:07:00Z", gap: 983 },
    { schema: "agsist-merged-index/1", places: [] },
  ]) assert.equal(isBoardFile(not), false, JSON.stringify(not));
});

test("EVERY BOARD FILE ON DISK PASSES THE RULE — including refused and broken ones", () => {
  /* The rule is only safe if no real board fails it. The poller does not write
     a board file for a source it refused; it leaves the last good one and
     records the status in data/index.json. So a file that exists is a file that
     was read. Asserted against the tree rather than against that sentence. */
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const idxPath = join(ROOT, "data", "index.json");
  if (!existsSync(idxPath)) return;                 // a tree the fetch never ran in
  const ids = new Set((JSON.parse(readFileSync(idxPath, "utf8")).sources ?? [])
    .map((s) => s.id).filter(Boolean));
  let checked = 0;
  for (const f of readdirSync(join(ROOT, "data")).filter((x) => x.endsWith(".json"))) {
    const id = f.replace(/\.json$/, "");
    if (!ids.has(id)) continue;
    let j = null;
    try { j = JSON.parse(readFileSync(join(ROOT, "data", f), "utf8")); } catch { continue; }
    assert.equal(isBoardFile(j), true, `${f} is a board the index names and the rule rejects it`);
    checked++;
  }
  assert.ok(checked > 500, `only ${checked} board file(s) checked — the tree looks empty`);
});

test("AND NOTHING ELSE IN data/ DOES — the reports, indexes and registries", () => {
  /* The other half. If one of these ever passed, the merge would report it as
     an elevator whose bids were dropped, which is what this change fixes. */
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const idxPath = join(ROOT, "data", "index.json");
  if (!existsSync(idxPath)) return;
  const ids = new Set((JSON.parse(readFileSync(idxPath, "utf8")).sources ?? [])
    .map((s) => s.id).filter(Boolean));
  const strays = [];
  for (const f of readdirSync(join(ROOT, "data")).filter((x) => x.endsWith(".json"))) {
    const id = f.replace(/\.json$/, "");
    if (ids.has(id)) continue;
    let j = null;
    try { j = JSON.parse(readFileSync(join(ROOT, "data", f), "utf8")); } catch { continue; }
    /* A leftover board from a retired or disabled source IS board-shaped, and
       it is meant to be — merge_bids reports those separately and correctly. */
    if (isBoardFile(j)) strays.push(f);
  }
  /* Whatever is left must be a board somebody retired, never a report. */
  for (const f of strays)
    assert.ok(!/coverage|grid|index|registr|directory|residual|urlfinder|states/i.test(f),
      `${f} is not an elevator and the rule says it is`);
});

test("data/gaps/ IS WHERE A REPORT GOES, and barchart_gap.mjs writes it there", () => {
  /* The one-line version of the whole bug: the coverage report was landing in
     data/, next to the boards. Pinned on the source rather than on the output
     so it holds in a tree where the report has not been generated. */
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const src = readFileSync(join(ROOT, "scripts", "barchart_gap.mjs"), "utf8");
  assert.match(src, /writeFileSync\(join\(gapsDir, "barchart-coverage\.json"\)/,
    "the coverage report must be written into data/gaps/");
  /* THE WRITE, NOT THE MENTION. The first version of this line forbade the
     string anywhere in the file and went red on the cleanup that deletes the
     old copy — which has to name that path to remove it. A test that cannot
     tell a write from a delete would have blocked the fix for the bug it was
     written to catch. */
  assert.ok(!/writeFileSync\(join\(ROOT, "data", "barchart-coverage\.json"\)/.test(src),
    "the coverage report is being written into data/, where the board files live");
});


/* ── the number a cash card prints ──────────────────────────────────────── */

/* THESE CASES WERE WRITTEN AGAINST SEPTEMBER 2026 FILES, AND NOW SAY SO.
   nearestOpen() reckons spot, new crop and expiry from a clock; without one
   pinned here these tests would start failing on their own as the months
   named in them went by. */
const SEPT = "2026-09-15";

const B = (crop, period, cash, past = false, delivery = "") =>
  ({ crop, period, cash, periodPast: past, basis: null, basisCents: null,
     commodity: crop, delivery });

test("nearestOpen takes the soonest window, not the biggest number", () => {
  /* ABBYVILLE, FROM THE LIVE FILE. `best` returns the June-July 2027 wheat at
     $7.185 because carry pays. A grower reading a cash board wants the window
     he can deliver into, which is thirteen cents lower and nine months
     sooner. 1,590 of 2,239 place/crop rows in that file disagree this way. */
  const got = nearestOpen([
    B("wheat", "2027-06/2027-07", 7.185),
    B("wheat", "2026-09/2026-11", 7.05),
  ], SEPT);
  assert.equal(got.wheat.cash, 7.05);
  assert.equal(got.wheat.period, "2026-09/2026-11");
});

test("inside one window the better price wins", () => {
  const got = nearestOpen([
    B("corn", "2026-10/2026-11", 4.90),
    B("corn", "2026-10/2026-11", 5.10),
  ], SEPT);
  assert.equal(got.corn.cash, 5.10);
});

test("a window that has closed is never the nearest one", () => {
  /* periodPast is lib/delivery.mjs's answer, not ours. Its own comment says
     this is how 37 rows reached three AGSIST surfaces as prices a grower
     could take. */
  const got = nearestOpen([
    B("corn", "2026-08", 9.99, true),
    B("corn", "2026-12", 5.00, false),
  ], SEPT);
  assert.equal(got.corn.cash, 5.00, "the expired row must not win on price");
});

test("a row with no readable period cannot be the nearest anything", () => {
  const got = nearestOpen([{ crop: "corn", period: null, cash: 9.99, periodPast: false }], SEPT);
  assert.equal(got.corn, undefined);
});

test("a row with no price is not a bid", () => {
  const got = nearestOpen([B("corn", "2026-12", null)], SEPT);
  assert.equal(got.corn, undefined);
});

test("each crop is answered on its own, and nothing else is invented", () => {
  const got = nearestOpen([
    B("corn", "2026-12", 5.00), B("soybeans", "2026-11", 13.00),
  ], SEPT);
  assert.deepEqual(Object.keys(got).sort(), ["corn", "soybeans"]);
});

test("a bare month sorts against a range on the end of the range", () => {
  /* "2026-09" and "2026-08/2026-11" both appear in the live file. Comparing
     whole strings would put the range first because "2026-0" < "2026-9". */
  const got = nearestOpen([
    B("corn", "2026-08/2026-11", 5.50),
    B("corn", "2026-09", 5.00),
  ], SEPT);
  assert.equal(got.corn.period, "2026-09", "the bare September closes first");
});

test("a price the board could not confirm this pass is not today's cash", () => {
  /* agsist's merge already drops these and says why: "merging that would show
     an unconfirmed price as today's cash." 268 rows in the live file carry
     stale:true and 268 a sourceStatus that is not ok. */
  const stale = nearestOpen([
    { ...B("corn", "2026-10", 9.99), stale: true },
    B("corn", "2026-12", 5.00),
  ], SEPT);
  assert.equal(stale.corn.cash, 5.00, "a stale row must not win on nearness");

  for (const st of ["broken", "refused"]) {
    const got = nearestOpen([
      { ...B("corn", "2026-10", 9.99), sourceStatus: st },
      B("corn", "2026-12", 5.00),
    ], SEPT);
    assert.equal(got.corn.cash, 5.00, `a ${st} source must not win on nearness`);
  }
});

/* ── NEW CROP, OLD CROP AND SPOT ARE MONTHS, NOT STRINGS ──────────────────
   Allied Cooperative (Tomah, Mauston and ten-odd more WI boards) quotes
   "newcrop-2026" and "2027-01". As strings "2027-01" sorts first, so on
   2026-10-06 its January forward ($4.46) was published as today's cash with
   the harvest bid beside it. */

test("October: the harvest bid beats a later forward (Allied, 2026-10-06)", () => {
  const got = nearestOpen([
    B("corn", "2027-01", 4.46),
    B("corn", "newcrop-2026", 4.40),
    B("soybeans", "2027-01", 12.05),
    B("soybeans", "newcrop-2026", 11.88),
  ], "2026-10-06");
  assert.equal(got.corn.period, "newcrop-2026");
  assert.equal(got.corn.cash, 4.40);
  assert.equal(got.soybeans.period, "newcrop-2026");
});

test("October: spot is this month, and a range ending later loses to it", () => {
  const got = nearestOpen([
    B("corn", "2026-10/2026-11", 4.50),
    B("corn", "spot", 4.20),
  ], "2026-10-06");
  assert.equal(got.corn.period, "spot");
});

test("October: wheat's new crop window (Jun-Sep) has closed, so it is not a candidate", () => {
  const got = nearestOpen([
    B("wheat", "newcrop-2026", 6.00),
    B("wheat", "2026-12", 5.50),
  ], "2026-10-06");
  assert.equal(got.wheat.period, "2026-12");
  const only = nearestOpen([B("wheat", "newcrop-2026", 6.00)], "2026-10-06");
  assert.equal(only.wheat, undefined, "an expired harvest window is not today's cash");
});

test("October: last year's corn is expired once its crop year has ended", () => {
  /* oldcrop-YYYY is the harvest year. 2025 corn's crop year ran Sep 2025 to
     Aug 2026. */
  const got = nearestOpen([
    B("corn", "oldcrop-2025", 4.80),
    B("corn", "2026-12", 4.50),
  ], "2026-10-06");
  assert.equal(got.corn.period, "2026-12");
});

test("May: old crop is today, new crop opens at its window start", () => {
  const got = nearestOpen([
    B("corn", "newcrop-2026", 4.40),   // Sep 2026
    B("corn", "2026-07", 4.60),
    B("corn", "oldcrop-2025", 4.70),   // May 2026, inside 2025's crop year
  ], "2026-05-12");
  assert.equal(got.corn.period, "oldcrop-2025");

  const noOld = nearestOpen([
    B("corn", "newcrop-2026", 4.40),   // Sep 2026
    B("corn", "2026-12", 4.30),
  ], "2026-05-12");
  assert.equal(noOld.corn.period, "newcrop-2026", "Sep beats Dec");

  const fwd = nearestOpen([
    B("corn", "newcrop-2026", 4.40),   // Sep 2026
    B("corn", "2026-07", 4.60),
  ], "2026-05-12");
  assert.equal(fwd.corn.period, "2026-07", "July comes before the September window");

  const wheat = nearestOpen([
    B("wheat", "newcrop-2026", 6.10),  // Jun 2026
    B("wheat", "2026-07", 6.30),
  ], "2026-05-12");
  assert.equal(wheat.wheat.period, "newcrop-2026", "wheat harvest opens in June");
});

test("December: still inside the row-crop window; next year's new crop is a forward", () => {
  const got = nearestOpen([
    B("soybeans", "2027-01", 12.10),
    B("soybeans", "newcrop-2026", 11.90),  // Dec 2026, inside Sep-Dec
    B("soybeans", "newcrop-2027", 11.50),  // Sep 2027
  ], "2026-12-03");
  assert.equal(got.soybeans.period, "newcrop-2026");

  const later = nearestOpen([
    B("soybeans", "2027-01", 12.10),
    B("soybeans", "newcrop-2027", 11.50),
  ], "2026-12-03");
  assert.equal(later.soybeans.period, "2027-01");

  const tie = nearestOpen([
    B("corn", "spot", 4.10),
    B("corn", "newcrop-2026", 4.25),
  ], "2026-12-03");
  assert.equal(tie.corn.cash, 4.25, "same month: the better price wins, as before");
});

test("a month already gone is not a candidate even if periodPast was not set", () => {
  const got = nearestOpen([
    B("corn", "2026-09", 9.99),
    B("corn", "2026-11", 4.50),
  ], "2026-10-06");
  assert.equal(got.corn.period, "2026-11");
});

test("deliveryMonth maps each key the way the comment says", () => {
  const oct = "2026-10-06";
  assert.equal(deliveryMonth("spot", "corn", oct), "2026-10");
  assert.equal(deliveryMonth("newcrop-2026", "corn", oct), "2026-10");
  assert.equal(deliveryMonth("newcrop-2026", "sorghum", oct), "2026-10");
  assert.equal(deliveryMonth("newcrop-2026", "wheat", oct), null);
  assert.equal(deliveryMonth("newcrop-2027", "wheat", oct), "2027-06");
  assert.equal(deliveryMonth("oldcrop-2025", "corn", oct), null);
  assert.equal(deliveryMonth("oldcrop-2026", "corn", oct), "2026-10");
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", oct), "2026-10");
  assert.equal(deliveryMonth("2026-10/2026-11", "corn", oct), "2026-11");
  assert.equal(deliveryMonth("2027-01", "corn", oct), "2027-01");
  assert.equal(deliveryMonth("whenever", "corn", oct), null);
});

/* ── OLD CROP IS THE HARVEST YEAR, INSIDE ITS CROP YEAR ────────────────────
   2026-10-06: ADM Plains KS posted "Old Crop Wheat (2026-12)" at $6.75 and
   the old rule ("current until YYYY-09") dropped it as expired. Wheat's crop
   year starts June 1, corn's September 1; YYYY is the year it was harvested
   (see the comment on deliveryMonth for the boards that show it). */

test("old-crop wheat: October and May are inside the crop year, July is not", () => {
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2026-10-06"), "2026-10");
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2027-05-12"), "2027-05");
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2027-07-01"), null);
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2027-06-01"), null, "June 1 starts the next crop year");
  assert.equal(deliveryMonth("oldcrop-2026", "oats", "2027-05-12"), "2027-05");
  assert.equal(deliveryMonth("oldcrop-2026", "barley", "2027-07-01"), null);
});

test("old-crop corn: October and May are inside the crop year, July too; September is not", () => {
  assert.equal(deliveryMonth("oldcrop-2026", "corn", "2026-10-06"), "2026-10");
  assert.equal(deliveryMonth("oldcrop-2026", "corn", "2027-05-12"), "2027-05");
  assert.equal(deliveryMonth("oldcrop-2026", "corn", "2027-07-01"), "2027-07");
  assert.equal(deliveryMonth("oldcrop-2026", "corn", "2027-08-31"), "2027-08");
  assert.equal(deliveryMonth("oldcrop-2026", "corn", "2027-09-01"), null);
  assert.equal(deliveryMonth("oldcrop-2025", "corn", "2026-07-01"), "2026-07");
  assert.equal(deliveryMonth("oldcrop-2025", "soybeans", "2026-10-06"), null);
  assert.equal(deliveryMonth("oldcrop-2025", "sorghum", "2026-05-12"), "2026-05");
});

test("an old crop not yet harvested is placed at its crop year's first month", () => {
  assert.equal(deliveryMonth("oldcrop-2027", "wheat", "2026-10-06"), "2027-06");
  assert.equal(deliveryMonth("oldcrop-2027", "corn", "2026-10-06"), "2027-09");
});

test("ADM Plains KS, 2026-10-06: old-crop wheat is today's wheat again", () => {
  const got = nearestOpen([
    B("wheat", "oldcrop-2026", 6.7475, false, "Old Crop Wheat (2026-12)"),
    B("wheat", "2027-07", 6.9325, false, "2027 HRW Wheat (2027-07)"),
  ], "2026-10-06");
  assert.equal(got.wheat.period, "oldcrop-2026");
  assert.equal(got.wheat.cash, 6.7475);
});

test("a real start/end on the row beats the season key", () => {
  const r = { start: "2026-12-01", end: "2026-12-31" };
  assert.equal(deliveryMonth("oldcrop-2025", "corn", "2026-10-06", r), "2026-12");
  assert.equal(deliveryMonth("newcrop-2026", "wheat", "2026-10-06", r), "2026-12");
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2027-07-01", { end: "2027-07-31" }), "2027-07");
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2026-10-06", { end: "2026-09-30" }), null, "a window that has closed");
});

test("the gradable \"(YYYY-MM)\" suffix is the futures contract and is NOT read as delivery", () => {
  /* "Old Crop Wheat (2026-12)" is priced off KEZ6. If the suffix were a
     delivery month, July 2027 would see December 2026 and still drop it,
     and October would see a later month than the bid means. The label is
     not consulted; only a start/end is. */
  const row = { delivery: "Old Crop Wheat (2026-12)" };
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2026-10-06", row), "2026-10");
  assert.equal(deliveryMonth("oldcrop-2026", "wheat", "2027-05-12", row), "2027-05");
});

test("a Canadian board is not stale and is not dropped here", () => {
  /* Whether a page can draw CAD is that page's question. The place row carries
     `currency` so it can ask without fetching the shard. */
  const got = nearestOpen([{ ...B("corn", "2026-12", 5.00), currency: "CAD" }], SEPT);
  assert.equal(got.corn.cash, 5.00);
});

test("nearestOpen copes with nothing at all", () => {
  assert.deepEqual(nearestOpen([]), {});
  assert.deepEqual(nearestOpen(null), {});
});

/* ── DIFFERENT FACILITIES, ONE TOWN, NO LABEL ──────────────────────────────
   2026-10-07. ADM's three Fremont NE boards keyed to one place and dedupe()
   dropped two of them a crop and period at a time, with nothing in the run to
   say so: Lincoln Premium Poultry's Dec corn ($4.87) behind the elevator's
   $4.67, the soy plant's Dec beans ($13.145) gone. */
import { facilityName, facilityBranches, summariseSameFeed } from "../scripts/merge_bids.mjs";

test("a facility's name is read from its own market page address", () => {
  const n = (u, loc) => facilityName({ id: "x", browserPage: u }, loc);
  assert.equal(n("https://adm.gradable.com/market/Fremont--NE-Lincoln-Premium-Poultry", "Fremont"), "Lincoln Premium Poultry");
  assert.equal(n("https://adm.gradable.com/market/Mt-Vernon--IN-Wheat-Milling", "Mount Vernon"), "Wheat Milling");
  assert.equal(n("https://adm.gradable.com/market/Mendota-Wheat-Milling", "Mendota"), "Wheat Milling");
  assert.equal(n("https://adm.gradable.com/market/Country-Store--KS", "Copeland"), "Country Store");
  assert.equal(n("https://adm.gradable.com/market/Copeland--KS", "Copeland"), "", "nothing beyond the town");
  assert.equal(facilityName({ id: "x" }, "Fremont"), "");
});

test("different locationIds in one key each get a branch; the same one twice does not", () => {
  const idx = [
    { id: "a-el", operator: "ADM", location: "Fremont", usState: "NE", labelInFeed: null },
    { id: "a-soy", operator: "ADM", location: "Fremont", usState: "NE", labelInFeed: null },
    { id: "a-cs", operator: "ADM", location: "Copeland", usState: "KS" },
    { id: "a-cs2", operator: "ADM", location: "Copeland", usState: "KS" },
    { id: "m-1", operator: "AgMark", location: "Agra", usState: "KS" },
    { id: "m-2", operator: "AgMark", location: "Agra", usState: "KS" },
    { id: "lone", operator: "Acme", location: "Thorp", usState: "WI" },
  ];
  const files = new Map([
    ["a-el", { id: "a-el", locationId: "1", browserPage: "https://x/market/Fremont--NE-Elevator" }],
    ["a-soy", { id: "a-soy", locationId: "2", browserPage: "https://x/market/Fremont--NE-Soy-Processing" }],
    ["a-cs", { id: "a-cs", locationId: "3", browserPage: "https://x/market/Copeland--KS" }],
    ["a-cs2", { id: "a-cs2", locationId: "4", browserPage: "https://x/market/Country-Store--KS" }],
    ["m-1", { id: "m-1", locationId: "9" }], ["m-2", { id: "m-2", locationId: "9" }],
    ["lone", { id: "lone", locationId: "5" }],
  ]);
  const b = facilityBranches(idx, files);
  assert.equal(b.get("a-el"), "Elevator");
  assert.equal(b.get("a-soy"), "Soy Processing");
  assert.equal(b.get("a-cs"), "", "the one that says only the town keeps the plain key");
  assert.equal(b.get("a-cs2"), "Country Store");
  assert.equal(b.has("m-1"), false, "one elevator filed twice is left to dedupe");
  assert.equal(b.has("lone"), false);
  assert.notEqual(placeKey("ADM", b.get("a-el"), "Fremont", "NE"), placeKey("ADM", b.get("a-soy"), "Fremont", "NE"));
});

test("two facilities whose pages name nothing new fall back to their ids, not one key", () => {
  const idx = [{ id: "p", operator: "X", location: "T", usState: "IA" }, { id: "q", operator: "X", location: "T", usState: "IA" }];
  const files = new Map([["p", { id: "p", locationId: "1" }], ["q", { id: "q", locationId: "2" }]]);
  const b = facilityBranches(idx, files);
  assert.equal(b.get("p"), "p");
  assert.equal(b.get("q"), "q");
});

test("a drop inside one feed is recorded, not silent", () => {
  const rows = [
    mk({ commodity: "Corn", delivery: "DEC 2026", cash: 4.67, basis: -0.3, source: "a-el" }),
    mk({ commodity: "Corn", delivery: "DEC 2026", cash: 4.87, basis: -0.1, source: "a-lpp" }),
  ];
  const { rows: kept, collisions, sameFeed } = dedupe(rows);
  assert.equal(kept.length, 1);
  assert.equal(collisions.length, 0);
  assert.equal(sameFeed.length, 1);
  assert.deepEqual([sameFeed[0].kept, sameFeed[0].dropped, sameFeed[0].droppedCash], ["a-el", "a-lpp", 4.87]);
  const s = summariseSameFeed(sameFeed);
  assert.deepEqual(s, [{ place: base.place, kept: "a-el", dropped: "a-lpp", rows: 1, priceDiffers: 1 }]);
});

test("the shard header carries the branch and the phone", () => {
  const b = mk({ commodity: "Corn", delivery: "DEC 2026", cash: 4.67, basis: -0.3, branch: "Elevator" });
  const s = shardOf(b.place, [b], null, "(402) 555-0100");
  assert.equal(s.phone, "(402) 555-0100");
  assert.equal(s.branch, "Elevator");
  assert.equal(shardOf(b.place, [b]).phone, null);
});

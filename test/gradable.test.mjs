/* THE GRADABLE ADAPTER, AGAINST THE BYTES POET ACTUALLY SERVED.
 *
 * fixtures/gradable-poet-bigstonecity.json is the 6,281-byte body of
 *   poet.gradable.com/api/commodities/v2/merchandising/instruments/market/331845223
 * captured in discover run 92448519432 on 2026-09-07, and
 * fixtures/gradable-poet-bootstrap.json is the 202,283-byte body of their
 * bootstrap from run 92448826700. Neither is edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract, marketsFrom, boardUrl, describe, roundingFor, parseBody,
         COMMODITY_NAMES, GradableRefused } from "../lib/adapters/gradable.mjs";
import { buildFile } from "../lib/board.mjs";
import { toConfig, validateSource, PLATFORMS, transportOf } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { checkIdentity } from "../lib/parse.mjs";

const BOARD = readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8");
const BOOT  = readFileSync(new URL("../fixtures/gradable-poet-bootstrap.json", import.meta.url), "utf8");
const URL_ = "https://poet.gradable.com/api/commodities/v2/merchandising/instruments/market/331845223?offer_type=public";

/* --- the board --------------------------------------------------------- */

test("the captured board reads, and every row carries all three numbers", () => {
  const rows = extract(BOARD, URL_);
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.ok(r.cash != null && r.basis != null && r.futuresPrice != null, JSON.stringify(r));
    assert.equal(r.locationId, "331845223");
    assert.equal(r.commodity, "Corn");
  }
});

test("futures_bid is DOLLARS and futuresPrice is CENTS", () => {
  /* Their 5.3675 is 536.75c. Getting this backwards is a hundredfold error
     that still looks like a price, which is the worst kind. */
  const r = extract(BOARD, URL_)[0];
  assert.equal(r.futuresPrice, 536.75);
  assert.equal(r.cash, 4.66, "cash stays in dollars");
  assert.equal(r.basisCents, -70);
});

test("the identity holds on every row, and the residual is floor", () => {
  /* 5.3675 + (-0.7) + their own -0.0075 offset = 4.66 exactly. checkIdentity
     does not know about the offset, so what it sees is +0.75c and +0.25c —
     the eighths remainder, always in the buyer's favour, never negative. */
  const rows = extract(BOARD, URL_);
  const off = checkIdentity(rows);
  assert.equal(off.length, 5, "all five are off by the rounding, and none by more");
  const signed = [...new Set(off.map((r) => r.signedCents))].sort((a, b) => a - b);
  assert.deepEqual(signed, [0.25, 0.75]);
  for (const s of signed) assert.ok(s >= 0 && s < 1, `${s} is outside floor-cent`);
});

test("their board declares its own rounding, and we translate only what was seen", () => {
  /* No other platform in this repository states its mode. `always_down` is
     floor-cent. A mode nobody has observed gets null rather than a guess,
     because roundingRule() throws Refused on a name board.mjs does not know. */
  const rows = extract(BOARD, URL_);
  for (const r of rows) assert.equal(r.cashRoundingDeclared, "always_down");
  assert.equal(roundingFor("always_down"), "floor-cent");
  assert.equal(roundingFor("always_up"), null, "never map a mode nobody has seen");
  assert.equal(roundingFor("nearest"), null);
  assert.equal(roundingFor(undefined), null);
});

test("their offset is the residual, and it is NOT applied", () => {
  /* cash = futures + basis + offset, to the last digit. The adapter publishes
     their three numbers as published; applying the offset would mean the guard
     checks our arithmetic instead of theirs. */
  const raw = parseBody(BOARD).instruments;
  for (const r of raw) {
    const exact = r.futures_bid + r.basis_bid + r.cash_bid_rounding_offset;
    assert.ok(Math.abs(exact - r.cash_bid) < 1e-9,
      `${r.display_name}: ${r.futures_bid} + ${r.basis_bid} + ${r.cash_bid_rounding_offset} != ${r.cash_bid}`);
  }
  const rows = extract(BOARD, URL_);
  assert.equal(rows[0].cash, raw[0].cash_bid, "cash is theirs, uncorrected");
});

test("two rows on the same contract at the same price do not collapse", () => {
  /* Big Stone City posts "Oct '26" and "Nov '26", both ZCZ6, both 4.79. Keyed
     on the contract month alone they are one row and a farmer loses a window. */
  const rows = extract(BOARD, URL_);
  const same = rows.filter((r) => r.cash === 4.79);
  assert.equal(same.length, 2);
  assert.notEqual(same[0].delivery, same[1].delivery);
  assert.equal(new Set(rows.map((r) => r.delivery)).size, rows.length);
});

test("the commodity name is theirs, and an unknown code passes through", () => {
  /* "CN" matches no band in board.mjs, so an unmapped code must reach the log
     as itself rather than become a wrong commodity on a map — the Scoular
     "Yc" rule. The four names are transcribed from their own bootstrap. */
  assert.equal(COMMODITY_NAMES.CN, "Corn");
  assert.equal(COMMODITY_NAMES.SB, "Soybeans");
  const body = JSON.stringify({ crops: [], instruments: [{
    ...parseBody(BOARD).instruments[0], ext_commodity_id: "BLY" }] });
  assert.equal(extract(body, URL_)[0].commodity, "BLY", "a code we have not seen is not renamed");
});

test("a deleted or private instrument never reaches the feed", () => {
  const one = parseBody(BOARD).instruments[0];
  assert.throws(() => extract(JSON.stringify({ instruments: [{ ...one, deleted: true }] }), URL_),
    GradableRefused);
  assert.throws(() => extract(JSON.stringify({ instruments: [{ ...one, offer_type: "private" }] }), URL_),
    GradableRefused, "a private offer is somebody's contract, not a posted bid");
});

test("a row missing a number is skipped, never defaulted to zero", () => {
  const ins = parseBody(BOARD).instruments;
  const rows = extract(JSON.stringify({ instruments: [{ ...ins[0], cash_bid: null }, ins[1]] }), URL_);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cash, 4.79);
});

test("an HTML error page is refused as not JSON, not reported as no bids", () => {
  assert.throws(() => extract("<html><body>502</body></html>", URL_),
    (e) => e instanceof GradableRefused && /not JSON/.test(e.message));
  assert.match(describe("<html>"), /not JSON/);
});

test("the while(1) prefix on their bootstrap is stripped", () => {
  /* Their bootstrap opens `while(1);` and the instruments call does not — same
     host, same page load, same minute. Not stripping it turns a good board into
     "the response is not JSON". */
  assert.ok(BOOT.startsWith("while(1);"), "the fixture has lost its prefix");
  assert.ok(!BOARD.startsWith("while(1);"), "the board body never had one");
  assert.equal(parseBody(BOOT).intent, "poet");
  assert.equal(parseBody(`)]}',\n{"instruments":[]}`).instruments.length, 0);
});

/* --- the whole way through the guards ----------------------------------- */

const SOURCE = {
  id: "poetgrain-bigstonecity", operator: "POET Grain", location: "Big Stone City", state: "SD",
  platform: "gradable", url: URL_,
  browserPage: "https://poet.gradable.com/market/Big-Stone-City--SD",
  locationId: "331845223", bands: { corn: [2.0, 12.0] },
  cadence: "grain-day", provenance: "scraped", enabled: true,
  cashRounding: "floor-cent", cashRoundingCents: 0,
  lat: 45.29914855957031, lon: -96.51194763183594, zip: "57216",
  website: "https://poet.gradable.com/market/Big-Stone-City--SD",
  note: "test", publicNote: "test", inMerge: true,
};

test("gradable is a platform the loader accepts, on the browser", () => {
  /* A manifest naming a platform not in PLATFORMS is DROPPED at load, so an
     adapter that exists and a platform that is not listed is a source that
     silently never runs. */
  assert.ok(PLATFORMS.includes("gradable"));
  assert.equal(transportOf("gradable"), "browser");
  assert.deepEqual(validateSource(SOURCE), []);
  assert.equal(typeof adapterFor("gradable"), "function");
});

test("the board publishes, and the identity guard actually ran", () => {
  const built = buildFile(BOARD, { now: new Date("2026-09-07T13:10:00Z"), sourceUrl: URL_,
                                   source: toConfig(SOURCE), extract: adapterFor("gradable") });
  assert.equal(built.file.status, "ok");
  assert.equal(built.file.count, 5);
  assert.equal(built.verified, 5, "zero failures and zero verified is a guard switched off");
  assert.equal(built.withheld.length, 0);
  assert.equal(built.file.schema, "gradable/1");
  assert.equal(built.file.bids[0].futuresMonth, "ZCZ6");
});

test("declare no rounding, or the wrong one, and it REFUSES", () => {
  /* The guard is the point. If the board published either way, cashRounding
     would be decoration. */
  const now = new Date("2026-09-07T13:10:00Z");
  const run = (o) => buildFile(BOARD, { now, sourceUrl: URL_,
    source: toConfig({ ...SOURCE, ...o }), extract: adapterFor("gradable") });
  assert.throws(() => run({ cashRounding: undefined }), /fail cash - basis = futures/);
  assert.throws(() => run({ cashRounding: "round-cent" }), /fail cash - basis = futures/);
});

/* --- the catalogue ------------------------------------------------------ */

test("their bootstrap names every plant, with a coordinate for each", () => {
  /* Every DTN manifest in this repository says "nobody has derived a
     coordinate for this location and none will be invented". This payload
     hands one over, per facility. */
  const m = marketsFrom(BOOT);
  assert.equal(m.length, 36);
  const live = m.filter((x) => !x.demo && x.publicSite);
  assert.equal(live.length, 35);
  for (const x of live) {
    assert.ok(Number.isFinite(x.lat) && Number.isFinite(x.lon), `${x.displayName} has no coordinate`);
    assert.match(String(x.state), /^[A-Z]{2}$/, `${x.displayName} has no state`);
    assert.ok(x.marketId != null && x.city && x.zip, JSON.stringify(x));
  }
  assert.equal(live.reduce((a, x) => a + (x.publicInstruments ?? 0), 0), 2449);
});

test("a demo market is not an elevator", () => {
  /* POET's bootstrap carries one, flagged in the payload. Publishing a demo
     board as a real bid is exactly the wrong number this project refuses. */
  const demos = marketsFrom(BOOT).filter((x) => x.demo);
  assert.deepEqual(demos.map((x) => x.displayName), ["Glenville, MN"]);
});

test("the town comes from their normalised address, not the display name", () => {
  /* Their display_name for market 331848608 is "Obion, TN" and the address
     their own geocoder normalised says Rives. Reading the display name would
     put a pin in the wrong town with no way to notice. */
  const m = marketsFrom(BOOT).find((x) => x.marketId === 331848608);
  assert.equal(m.displayName, "Obion, TN");
  assert.equal(m.city, "Rives");
  assert.equal(m.state, "TN");
});

test("the board URL is built from the market id, not typed", () => {
  assert.equal(boardUrl(331845223), URL_);
  assert.match(boardUrl(1, "adm"), /^https:\/\/adm\.gradable\.com\//);
  assert.throws(() => boardUrl(null), GradableRefused);
});

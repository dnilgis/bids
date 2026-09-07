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
import { readdirSync } from "node:fs";
import { extract, marketsFrom, boardUrl, describe, roundingFor, parseBody,
         COMMODITY_NAMES, DECLARED_ROUNDING, GradableRefused } from "../lib/adapters/gradable.mjs";
import { CASH_ROUNDING } from "../lib/board.mjs";
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

test("their board declares its own rounding, and only the seen one is measured", () => {
  /* No other platform in this repository states its mode. `always_down` is
     floor-cent and that is MEASURED — these five rows. A mode outside the
     table gets null rather than a guess, because roundingRule() throws Refused
     on a name board.mjs does not know. */
  const rows = extract(BOARD, URL_);
  for (const r of rows) assert.equal(r.cashRoundingDeclared, "always_down");
  assert.equal(roundingFor("always_down"), "floor-cent");
  assert.equal(roundingFor("always_up"), null, "never map a mode nobody has stated");
  assert.equal(roundingFor("nearest"), null);
  assert.equal(roundingFor(undefined), null);
});

test("every mode the table names is one a manifest can declare", () => {
  /* roundingRule() throws Refused on a cashRounding lib/board.mjs does not
     know, so a name here that is not there is a manifest that refuses at its
     first poll — which is exactly how a good board gets written off. */
  for (const v of Object.values(DECLARED_ROUNDING))
    assert.ok(v in CASH_ROUNDING, `${v} is not a mode board.mjs knows`);
});

test("half_up and half_down are DERIVED, and the derivation is the test", () => {
  /* Their cash cell is basis + futures rounded to the cent, and a futures quote
     lives on an eighth-cent grid, so the residual can only be a quarter, a half
     or three quarters of a cent away from whole. Round each frac the way the
     mode says and see which window the results fall in. This is arithmetic
     about a rule they state — not a measurement — and the manifests written on
     these two are held disabled until a board proves each one. */
  const FRACS = [0, 0.25, 0.5, 0.75];
  const residuals = (round) => FRACS.map((f) => Number((f - round(f)).toFixed(4)));
  const fits = (rs, mode) => rs.every((r) => CASH_ROUNDING[mode](r));

  const down = residuals(Math.floor);                       // always_down
  assert.deepEqual(down, [0, 0.25, 0.5, 0.75]);
  assert.ok(fits(down, "floor-cent"));
  assert.equal(DECLARED_ROUNDING.always_down, "floor-cent");

  const halfUp = residuals((f) => (f >= 0.5 ? 1 : 0));       // .5 goes UP
  assert.deepEqual(halfUp, [0, 0.25, -0.5, -0.25]);
  assert.ok(fits(halfUp, "round-cent"), "half_up never produces +0.5, so the open top is right");
  assert.equal(DECLARED_ROUNDING.half_up, "round-cent");

  const halfDown = residuals((f) => (f > 0.5 ? 1 : 0));      // .5 goes DOWN
  assert.deepEqual(halfDown, [0, 0.25, 0.5, -0.25]);
  assert.ok(!fits(halfDown, "round-cent"), "+0.5 is exactly what round-cent refuses");
  assert.ok(fits(halfDown, "round-cent-either"));
  assert.equal(DECLARED_ROUNDING.half_down, "round-cent-either");
});

test("the mode is per market, and POET states three of them", () => {
  /* A mode read off one board is a fact about that board. 17 of POET's 35 live
     markets say always_down, 10 say half_down, 6 say half_up and 2 say nothing
     at all — so inheriting Big Stone City's answer across the platform would
     have been wrong on eighteen of them. */
  const live = marketsFrom(BOOT).filter((m) => !m.demo && m.publicSite);
  const tally = {};
  for (const m of live) tally[String(m.declaredRounding)] = (tally[String(m.declaredRounding)] ?? 0) + 1;
  assert.deepEqual(tally, { always_down: 17, half_down: 10, half_up: 6, null: 2 });
  const bsc = live.find((m) => m.marketId === 331845223);
  assert.equal(bsc.declaredRounding, "always_down");
  assert.equal(bsc.cashRounding, "floor-cent");
  const none = live.filter((m) => m.declaredRounding == null);
  for (const m of none) assert.equal(m.cashRounding, null, `${m.displayName} must get no mode`);
});

test("only a mode that has been SEEN on a board is enabled", () => {
  /* The rule this repository already has: a board is not enabled on a rounding
     we cannot state. always_down was measured at Big Stone City. The other two
     are arithmetic, so exactly ONE market on each is enabled as the test that
     settles it and the rest are held. */
  const dir = new URL("../sources/", import.meta.url);
  const poet = readdirSync(dir).filter((f) => f.startsWith("poetgrain-"))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  assert.equal(poet.length, 35);
  const enabledBy = {};
  for (const s of poet.filter((x) => x.enabled))
    enabledBy[String(s.cashRounding)] = (enabledBy[String(s.cashRounding)] ?? 0) + 1;
  assert.equal(enabledBy["floor-cent"], 17,
    "the measured mode: every always_down market, Big Stone City among them");
  assert.equal(enabledBy["round-cent"], 1, "one probe, not six");
  assert.equal(enabledBy["round-cent-either"], 1, "one probe, not ten");
  for (const s of poet.filter((x) => !x.enabled))
    assert.ok(s._pending, `${s.id} is held with no reason written down`);
  for (const s of poet.filter((x) => x.enabled))
    assert.ok(!s._pending, `${s.id} is enabled and still carries a _pending`);
});

test("every POET manifest carries a coordinate and a corn band, and no guess", () => {
  const dir = new URL("../sources/", import.meta.url);
  const poet = readdirSync(dir).filter((f) => f.startsWith("poetgrain-"))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  const byId = new Map(marketsFrom(BOOT).map((m) => [String(m.marketId), m]));
  for (const s of poet) {
    assert.deepEqual(validateSource(s), [], s.id);
    /* bands is corn alone because commodity_settings names crop_id 1 and no
       other, and their own table maps crop 1 to CN. Not a guess about what an
       ethanol plant buys. */
    assert.deepEqual(Object.keys(s.bands), ["corn"], s.id);
    const m = byId.get(s.locationId);
    assert.ok(m, `${s.id} names a market id not in their bootstrap`);
    /* THEIRS, TO THE LAST DIGIT. A coordinate that has been rounded, nudged or
       re-geocoded is no longer the measurement it claims to be. */
    assert.equal(s.lat, m.lat, s.id);
    assert.equal(s.lon, m.lon, s.id);
    assert.equal(s.location, m.city, `${s.id} town must be their normalised city`);
    assert.equal(s.state, m.state, s.id);
    assert.equal(s.cashRounding ?? null, m.cashRounding, `${s.id} mode must be their declaration`);
  }
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

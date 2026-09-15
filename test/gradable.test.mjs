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
         COMMODITY_NAMES, DECLARED_ROUNDING, GradableRefused,
         commoditiesFrom, partnerFromUrl, namesFor, forgetNames,
         currencyOf, isBushels, BUSHELS } from "../lib/adapters/gradable.mjs";
import { resolveCurrency } from "../lib/currency.mjs";
import { bandFor } from "../lib/board.mjs";
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

/* --- ADM: a second partner, and what it does NOT declare ---------------- */
/*
 * fixtures/gradable-adm-bootstrap.json is the 783,632-byte body of
 *   adm.gradable.com/api/commodities/merchandising/bootstrap
 * captured whole on 2026-09-15 by the `gradable bootstrap` workflow and
 * committed as d84e3de. It is not edited.
 *
 * It is here because POET alone could not have caught either of the two bugs
 * below. Both are the same shape: a field POET happens to carry on every one
 * of its 36 markets, read as if it were guaranteed.
 */
const ADM = readFileSync(new URL("../fixtures/gradable-adm-bootstrap.json", import.meta.url), "utf8");

test("ADM: THE ADDRESS IS NOT ONLY IN fbn_normalized, and 129 markets proved it", () => {
  const ms = marketsFrom(ADM);
  assert.equal(ms.length, 152);
  /* Before the fallbacks landed, measured on these exact bytes:
       state null on 129, zip null on 129, address null on 130.
     fbn_normalized is present on 23 of 152 here and on 36 of 36 in POET's. */
  const raw = parseBody(ADM).markets;
  assert.equal(raw.filter((m) => m?.address?.fbn_normalized).length, 23,
    "the fixture changed; this test's whole premise is that most markets lack that block");
  for (const f of ["state", "zip", "address", "city", "lat", "lon"])
    assert.equal(ms.filter((m) => m[f] == null).length, 0,
      `${f} is null on ${ms.filter((m) => m[f] == null).length} of 152 ADM markets`);
});

test("ADM: the state list is 26 codes, and nine of them are only reachable by fallback", () => {
  const states = [...new Set(marketsFrom(ADM).map((m) => m.state))].sort();
  assert.equal(states.length, 26);
  /* Reading fbn_normalized alone printed seventeen. These nine were invisible,
     and two of them are Iowa and Ohio. */
  for (const s of ["AB", "AR", "GA", "IA", "LA", "OH", "PA", "SK", "WA"])
    assert.ok(states.includes(s), `${s} is missing — the fallback is not being consulted`);
});

test("THE STATE IS THE TWO-LETTER CODE, never the spelled-out name", () => {
  /* a.input_administrative_area_level_1 says "Kansas" on the very market whose
     manifest needs "KS". It is in the same object as the code and is not a
     state source. */
  const m = marketsFrom(ADM).find((x) => x.marketId === 371713182);
  assert.equal(m.state, "KS");
  const raw = parseBody(ADM).markets.find((x) => x.id === 371713182);
  assert.equal(raw.address.input_administrative_area_level_1, "Kansas");
  for (const x of marketsFrom(ADM))
    assert.match(x.state, /^[A-Z]{2}$/, `${x.displayName} has state ${JSON.stringify(x.state)}`);
});

test("POET'S VALUES DO NOT MOVE. The fallbacks are additive or they are a rewrite", () => {
  /* 35 POET manifests are committed with these bytes in them. A fallback that
     changed the order would silently rewrite files a person has already read. */
  const m = marketsFrom(BOOT).find((x) => x.marketId === 331845223);
  assert.equal(m.city, "Big Stone City");
  assert.equal(m.state, "SD");
  assert.equal(m.zip, "57216");
  assert.equal(m.address, "48416 144th Street");
  assert.equal(m.lat, 45.29914855957031);
  assert.equal(m.lon, -96.51194763183594);
});

test("ADM DECLARES NO ROUNDING AT ALL, and nothing may assume one", () => {
  /* POET states a mode per market and states three different ones. ADM's
     commodity_settings is {} on every one of its 152. A manifest that said
     "floor-cent" here would carry a number nobody measured. */
  const raw = parseBody(ADM).markets;
  assert.equal(raw.filter((m) => Object.keys(m?.commodity_settings ?? {}).length === 0).length, 152);
  const ms = marketsFrom(ADM);
  assert.equal(ms.filter((m) => m.declaredRounding == null).length, 152);
  assert.equal(ms.filter((m) => m.cashRounding == null).length, 152);
  /* And POET still declares its three, so this is a fact about ADM and not a
     reader that stopped reading. */
  assert.ok(new Set(marketsFrom(BOOT).map((m) => m.declaredRounding)).size >= 3);
});

test("ADM: 0 demo markets, 136 of 152 post a board", () => {
  const ms = marketsFrom(ADM);
  assert.equal(ms.filter((m) => m.demo).length, 0);
  assert.equal(ms.filter((m) => (m.publicInstruments ?? 0) > 0).length, 136);
  /* Six companies run markets on ADM's own site. `operator` is theirs, not
     "ADM" stamped on everything. */
  const cos = [...new Set(ms.map((m) => m.company))].sort();
  assert.deepEqual(cos, ["ADM", "Bacres Grain", "MFA", "MFA Agri Services",
                         "Maplehurst Farms", "Prairie Grain Partners"]);
});

test("WHERE THE TWO SOURCES DISAGREE, THEIRS WINS — and on ZIP they do disagree", () => {
  /* Measured across ADM's 23 markets that carry both blocks: state never
     disagrees, ZIP disagrees on three, and the street line on fifteen. So the
     order of the ?? chain is not cosmetic. These three are the proof:

       Beech Grove, IN   fbn 46107   input 46107-0610   (ZIP+4 for a PO box)
       Novelty, MO       fbn 63451   input 63460        (a different ZIP)
       Silver Grove, KY  fbn 41059   input 41085        (a different ZIP)

     fbn_normalized is the block their geocoder produced for the coordinate
     this manifest also carries. input_postal_code is whatever was typed into
     their system. Reading the typed one first would put two facilities in the
     wrong postcode while the pin stayed right. */
  const ms = marketsFrom(ADM);
  for (const [id, zip] of [[331846037, "46107"], [331847519, "63451"], [331847520, "41059"]])
    assert.equal(ms.find((m) => m.marketId === id).zip, zip,
      `market ${id} took the typed ZIP over their geocoder's`);
});

/* ---------------------------------------------------------------------------
 * THE DICTIONARY THAT WAS FOUR ENTRIES LONG — 2026-09-15.
 *
 * The first ADM board run read 122 boards and every row came back as a code:
 * "01", "02", "11", "16", "37", "73", "MW", "31", "12", "28", "49", "U9",
 * "59", "R5", "1B", "PB". None was in COMMODITY_NAMES, so bandFor returned
 * null for all of them and NOT ONE ADM ROW COULD EVER HAVE PUBLISHED.
 *
 * The forty-two entry dictionary was in the bootstrap the whole time.
 * --------------------------------------------------------------------------- */

const ADM_CODES_SEEN = ["01", "02", "11", "16", "37", "73", "MW", "31",
                        "12", "28", "49", "U9", "59", "R5", "1B", "PB"];

test("EVERY CODE THE ADM RUN SAW IS NAMED BY ADM'S OWN BOOTSTRAP", () => {
  const names = commoditiesFrom(readFileSync(new URL("../fixtures/gradable-adm-bootstrap.json", import.meta.url), "utf8"));
  assert.ok(Object.keys(names).length >= 42, `${Object.keys(names).length} entries`);
  for (const c of ADM_CODES_SEEN)
    assert.ok(names[c], `code ${c} — seen on a real board — is not in their dictionary`);
  /* The two that carry the most markets, by name, so a dictionary that shifted
     under us is caught rather than merely counted. */
  assert.equal(names["01"], "Soybeans");
  assert.equal(names["02"], "Corn");
});

test("AND FIFTEEN OF THE SIXTEEN BAND. Before this, zero did.", () => {
  const names = namesFor("adm");
  const unbanded = [];
  for (const c of ADM_CODES_SEEN) {
    let b = null;
    try { b = bandFor({ bands: {} }, names[c]); } catch { b = null; }
    if (!b) unbanded.push(`${c} ${names[c]}`);
  }
  /* Soybean Meal is priced per ton and lib/board.mjs lists it in
     KNOWN_UNBANDED on purpose — a null there is the right answer, not a gap. */
  assert.deepEqual(unbanded, ["MW Soybean Meal"], unbanded.join(" | "));
});

test("the board's rows resolve through the PARTNER IN THEIR OWN URL", () => {
  const proto = parseBody(readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8")).instruments[0];
  const body = JSON.stringify({
    instruments: ADM_CODES_SEEN.map((c) => ({ ...proto, ext_commodity_id: c, market_id: 331844986 })),
  });
  const rows = extract(body, boardUrl(331844986, "adm"));
  assert.equal(rows.length, 16);
  assert.equal(rows.find((r) => r.commodityCode === "02").commodity, "Corn");
  assert.equal(rows.find((r) => r.commodityCode === "37").commodity, "Sorghum");
  /* Not one of them may come out as its own code. */
  assert.deepEqual(rows.filter((r) => r.commodity === r.commodityCode), []);
});

test("A LOOK-ALIKE HOST PICKS NOBODY'S DICTIONARY", () => {
  /* Choosing a dictionary by a host somebody else controls would name one
     operator's crops with another operator's words. */
  assert.equal(partnerFromUrl("https://adm.gradable.com/api/x"), "adm");
  assert.equal(partnerFromUrl("https://poet.gradable.com/api/x"), "poet");
  assert.equal(partnerFromUrl("https://adm.gradable.com.evil.example/api/x"), null);
  assert.equal(partnerFromUrl("https://evil.example/api/x?h=adm.gradable.com"), null);
  assert.equal(partnerFromUrl("https://sub.adm.gradable.com/api/x"), null);
  assert.equal(partnerFromUrl("http://adm.gradable.com/api/x"), null, "http is not their board");
  assert.equal(partnerFromUrl("not a url"), null);
});

test("POET'S PUBLISHED WORDS DO NOT MOVE", () => {
  /* The live POET files carry "Corn" and "Soybeans" and nothing else. Their own
     dictionary says exactly those two strings for CN and SB, so switching from
     the hand-copied table to their payload changes no published value. If this
     ever fails, 35 committed boards just had their commodity column rewritten. */
  const poet = namesFor("poet");
  assert.equal(poet.CN, "Corn");
  assert.equal(poet.SB, "Soybeans");
  const rows = extract(
    readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8"),
    boardUrl(331845223, "poet"));
  assert.deepEqual([...new Set(rows.map((r) => r.commodity))], ["Corn"]);
});

test("a partner with no committed bootstrap falls back rather than throwing", () => {
  /* A pass must not die for every other platform because one bootstrap has not
     been captured. It falls back to the table and refuses row by row. */
  forgetNames();
  const table = namesFor("nosuchpartner");
  assert.deepEqual(table, COMMODITY_NAMES);
  forgetNames();
  assert.deepEqual(namesFor("alsomissing", () => { throw new Error("no such file"); }), COMMODITY_NAMES);
  /* And an empty dictionary is not an answer that shadows the fallback. */
  forgetNames();
  assert.deepEqual(namesFor("empty", () => JSON.stringify({ bids_offers_ext_commodities: {} })), COMMODITY_NAMES);
  forgetNames();
});

test("THE TWO DICTIONARIES ARE NEVER MERGED", () => {
  /* They share no key today — measured — but a merge is one collision away
     from naming one operator's crop with another's word for it. */
  const adm = namesFor("adm"), poet = namesFor("poet");
  assert.equal(Object.keys(poet).length, 4, "poet's dictionary grew; re-check the collision claim");
  assert.deepEqual(Object.keys(poet).filter((k) => k in adm), [],
    "the two dictionaries now share a key, so per-partner lookup is load-bearing");
  /* An ADM code must mean nothing on a POET board. */
  const proto = parseBody(readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8")).instruments[0];
  const body = JSON.stringify({ instruments: [{ ...proto, ext_commodity_id: "02", market_id: 331845223 }] });
  assert.equal(extract(body, boardUrl(331845223, "poet"))[0].commodity, "02",
    "POET's board named an ADM code, so the dictionaries are being merged");
});

test("the caller may hand in its own dictionary", () => {
  /* The boards reader already has the bootstrap open; making the adapter
     re-read the same 783 KB file would be a second copy of one fact. */
  const proto = parseBody(readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8")).instruments[0];
  const body = JSON.stringify({ instruments: [{ ...proto, ext_commodity_id: "ZZ", market_id: 1 }] });
  assert.equal(extract(body, boardUrl(1, "adm"), { names: { ZZ: "Turnips" } })[0].commodity, "Turnips");
});

test("the code is kept on the row and NEVER reaches the published file", () => {
  const rows = extract(
    readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8"),
    boardUrl(331845223, "poet"));
  assert.equal(rows[0].commodityCode, "CN");
  const src = readFileSync(new URL("../data/poetgrain-bigstonecity.json", import.meta.url), "utf8");
  assert.doesNotMatch(src, /commodityCode/,
    "the raw code leaked into a published board file");
});

/* ---------------------------------------------------------------------------
 * WHICH MONEY, AND HOW MUCH GRAIN — 2026-09-15.
 *
 * lib/currency.mjs was written on 2026-09-06 about an Ontario board publishing
 * CAD into a USD feed, and its conclusion was that the payload states the
 * currency and "we were discarding it". Gradable was the last adapter still
 * discarding it, with ADM running thirteen Canadian markets.
 * --------------------------------------------------------------------------- */

const boardOf = (rows) => JSON.stringify({ instruments: rows });
const PROTO = parseBody(readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8")).instruments[0];

test("THE ROW'S OWN CURRENCY IS READ, and it reaches resolveCurrency as payload", () => {
  const rows = extract(readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8"),
                       boardUrl(331845223, "poet"));
  assert.equal(rows[0].currency, "USD");
  /* The tier that matters: "the feed said so, per row, and every row agreed". */
  assert.deepEqual(resolveCurrency({ id: "x", state: "SD" }, rows),
                   { currency: "USD", currencyVia: "payload" });
});

test("A CANADIAN BOARD COMES OUT CAD, from its own rows and nothing else", () => {
  const rows = extract(boardOf([{ ...PROTO, currency: "cad", futures: { ...PROTO.futures, currency: "cad" } }]),
                       boardUrl(347074487, "adm"));
  assert.equal(rows[0].currency, "CAD");
  /* Note the state says nothing here — no province inference is involved. */
  assert.deepEqual(resolveCurrency({ id: "x" }, rows), { currency: "CAD", currencyVia: "payload" });
});

test("a cash cell and a futures quote in DIFFERENT money names neither", () => {
  /* Exactly the Ontario shape lib/currency.mjs describes: a CAD basis over a
     USD futures price. Naming either would publish the other as if it were
     that one. */
  const rows = extract(boardOf([{ ...PROTO, currency: "cad", futures: { ...PROTO.futures, currency: "usd" } }]),
                       boardUrl(1, "adm"));
  assert.equal(rows[0].currency, null, "one of two currencies was picked as the board's");
  assert.equal(resolveCurrency({ id: "x", state: "ON" }, rows).currencyVia, "province",
    "it should fall through to the weaker tier and SAY so");
});

test("a currency this repository does not know is not a currency", () => {
  assert.equal(currencyOf("usd"), "USD");
  assert.equal(currencyOf("CAD"), "CAD");
  assert.equal(currencyOf("eur"), null, "a code with no place in CURRENCIES was accepted");
  assert.equal(currencyOf(""), null);
  assert.equal(currencyOf(null), null);
  const rows = extract(boardOf([{ ...PROTO, currency: "eur", futures: { ...PROTO.futures, currency: "eur" } }]),
                       boardUrl(1, "adm"));
  assert.equal(rows[0].currency, null);
});

test("PER TONNE IS NOT PER BUSHEL, and the row says so instead of being checked", () => {
  /* Vanscoy SK posts Desi Chickpeas and North Battleford posts Yellow Peas.
     Those trade per tonne. A per-tonne cash price checked against a per-bushel
     futures quote is the Border Ag "Price X2 for CWT" failure, which reported a
     board out by 82,486 cents. */
  const rows = extract(boardOf([
    { ...PROTO, quantity_unit: "tonnes" },
    { ...PROTO, quantity_unit: "bushels", futures: { ...PROTO.futures, quantity_unit: "tonnes" } },
    { ...PROTO, quantity_unit: "bushels" },
  ]), boardUrl(1, "adm"));
  assert.deepEqual(rows.map((r) => r.identityCheckable), [false, false, true]);
  assert.equal(rows[0].quantityUnit, "tonnes", "their word for the unit was not carried");
  assert.equal(rows[1].futuresUnit, "tonnes");
  /* Both halves matter: the cash unit AND the futures unit. */
  assert.equal(isBushels("bushels"), true);
  assert.equal(isBushels("BUSHELS"), true);
  assert.equal(isBushels("tonnes"), false);
  assert.equal(isBushels(null), false);
  assert.equal(BUSHELS, "bushels");
});

test("a row set aside for its unit is still CARRIED, never dropped", () => {
  const rows = extract(boardOf([{ ...PROTO, quantity_unit: "tonnes" }]), boardUrl(1, "adm"));
  assert.equal(rows.length, 1, "a per-tonne row vanished instead of being marked");
  assert.equal(rows[0].identityCheckable, false);
});

test("THEIR OWN country_code, on all 152, agreeing with every state code", () => {
  const ms = marketsFrom(ADM);
  const counts = {};
  for (const m of ms) counts[String(m.countryCode)] = (counts[String(m.countryCode)] ?? 0) + 1;
  assert.deepEqual(counts, { US: 139, CA: 13 });
  /* Their word and this repository's state table must not disagree. If they
     ever do, the payload is the elevator's own and the table is ours. */
  const CA = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
  for (const m of ms)
    assert.equal(m.countryCode, CA.has(m.state) ? "CA" : "US",
      `${m.marketId} ${m.displayName}: they say ${m.countryCode}, the state ${m.state} says otherwise`);
});

test("POET'S PUBLISHED NUMBERS DO NOT MOVE — only the provenance sharpens", () => {
  /* The committed POET files say currencyVia "province". Reading the payload
     makes the same USD a fact instead of an inference. If any PRICE moved, 35
     live boards just changed. */
  const rows = extract(readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8"),
                       boardUrl(331845223, "poet"));
  assert.equal(rows.length, 5);
  /* THESE FIVE ARE MEASURED off fixtures/gradable-poet-bigstonecity.json, not
     remembered. The first version of this line carried five numbers I had
     written down from nothing, and this assertion is what caught them — which
     is the whole reason a pin like this exists. */
  assert.deepEqual(rows.map((r) => r.cash), [4.66, 4.79, 4.79, 4.83, 4.96],
    "a cash figure moved — 35 live POET boards just changed");
  assert.equal(rows.every((r) => r.identityCheckable), true);
  assert.equal(rows.every((r) => r.currency === "USD"), true);
});

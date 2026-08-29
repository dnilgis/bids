/* BUSHEL — ten operators behind one shape, seven of them CHS regions.
 *
 * Every number in this file comes from a REAL board: CHS Farmers Alliance,
 * captured live 2026-08-21 and saved as fixtures/bushel-chsfarmersalliance.json.
 * Four locations, three commodities, 24 rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract } from "../lib/adapters/bushel.mjs";
import { BushelRefused } from "../lib/adapters/bushel-refused.mjs";
import { isRefusal } from "../lib/board.mjs";
import { PLATFORMS, transportOf, wireOf } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const BODY = readFileSync(new URL("../fixtures/bushel-chsfarmersalliance.json", import.meta.url), "utf8");
const URL_ = "https://api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList";
const rows = extract(BODY, URL_);

/* The SECOND generation, captured whole 2026-08-29 by run 90133552278. */
const GEN2_BODY = readFileSync(new URL("../fixtures/bushel-incograin-gen2.json", import.meta.url), "utf8");
const GEN2 = extract(GEN2_BODY, "https://futures.bushelops.com/api/v1/cash-bids");

test("the real board reads, every row of it", () => {
  assert.equal(rows.length, 24);
  assert.deepEqual([...new Set(rows.map((r) => r.location))].sort(),
    ["Chamberlain", "Corsica", "Mitchell", "Wagner"]);
  assert.deepEqual([...new Set(rows.map((r) => r.commodity))].sort(),
    ["Corn", "Soybeans", "Wheat HRW"]);
});

test("THE IDENTITY HOLDS ON EVERY ROW, and it floors", () => {
  /* Measured across all 24: exact 12, round 16, floor 24. Residuals
     {0, 0.25, 0.5, 0.75} — the eighths remainder and nothing else, the same
     signature Ag Partners shows. This is what lets a source declare
     cashRounding floor-cent instead of being handed a blunt tolerance. */
  let exact = 0, round = 0, floor = 0;
  const residuals = new Set();
  for (const r of rows) {
    const cash = Math.round(r.cash * 100);
    const derived = r.basisCents + r.futuresPrice;
    if (Math.abs(derived - cash) < 1e-6) exact++;
    if (Math.round(derived) === cash) round++;
    if (Math.floor(derived + 1e-9) === cash) floor++;
    residuals.add(Math.round((derived - cash) * 1000) / 1000);
  }
  assert.equal(floor, 24, "floor must explain every row");
  assert.equal(exact, 12);
  /* SIXTEEN, NOT EIGHTEEN, AND THE DIFFERENCE IS THE LANGUAGE.
     Counting this in Python first gave 18, because Python's round() is
     banker's rounding -- half goes to even -- while JavaScript's Math.round is
     half-up. These residuals include exactly 0.5, so the two disagree on those
     rows. roundingEvidence uses Math.round, so 16 is what this project
     measures. The board did not change; the arithmetic convention did, and a
     rounding mode read in the wrong language is a wrong answer that looks
     right. */
  assert.equal(round, 16);
  assert.deepEqual([...residuals].sort((a, b) => a - b), [0, 0.25, 0.5, 0.75]);
});

test("FUTURES ARE CARRIED IN CENTS, because that is what the guard checks", () => {
  const r = rows[0];
  assert.equal(r.futuresPrice, 476.25, "4.7625 dollars is 476.25 cents");
  assert.equal(r.cash, 4.31, "cash stays in dollars");
  assert.equal(r.basisCents, -45);
});

test("a price is a string on this board, and is parsed exactly once", () => {
  for (const r of rows) {
    assert.equal(typeof r.cash, "number");
    assert.equal(typeof r.basis, "number");
    assert.equal(typeof r.futuresPrice, "number");
    assert.ok(Number.isFinite(r.cash) && Number.isFinite(r.futuresPrice));
  }
});

test("their board timestamp is carried, and their symbol is theirs", () => {
  assert.equal(rows[0].futuresAt, "2026-08-21T01:02:13Z");
  assert.match(rows[0].futures, /^[A-Z]{2}[A-Z]\d{2}$/);
});

test("A ROW THAT IS NOT PER-BUSHEL CANNOT MATCH A PER-BUSHEL BAND", () => {
  // The unit lives on the GROUP, not the bid. Fold it into the name so
  // DEFAULT_BANDS cannot match it and board.mjs withholds it by name.
  const doc = JSON.parse(BODY);
  doc.locations[0].groups[0].bidPriceUoM = "cwt";
  const out = extract(JSON.stringify(doc), URL_);
  const odd = out.filter((r) => r.commodity.includes("cwt"));
  assert.ok(odd.length > 0, "the unit was not folded into the commodity name");
  assert.match(odd[0].commodity, /^Corn \(cwt\)$/);
});

test("and a missing unit says so rather than being assumed", () => {
  const doc = JSON.parse(BODY);
  delete doc.locations[0].groups[0].bidPriceUoM;
  assert.match(extract(JSON.stringify(doc), URL_)[0].commodity, /unit unstated/);
});

test("A ROW MISSING A PRICE IS SKIPPED, NOT GUESSED", () => {
  const doc = JSON.parse(BODY);
  doc.locations[0].groups[0].bids[0].basisPrice = "";
  assert.equal(extract(JSON.stringify(doc), URL_).length, rows.length - 1);
});

test("an empty string is not zero", () => {
  const doc = JSON.parse(BODY);
  doc.locations[0].groups[0].bids[0].bidPrice = "";
  const out = extract(JSON.stringify(doc), URL_);
  assert.ok(!out.some((r) => r.cash === 0), "an empty price became a zero bid");
});

test("REFUSALS SAY WHAT CAME BACK", () => {
  /* CORRECTED 2026-08-29 evening, and the old assertion is worth recording.
     This test used to require that `{"data":[]}` refuse with "older bushelops"
     -- the right answer for as long as that shape was unhandled. It is handled
     now, so an empty `data` array is an empty BOARD, not an unknown shape, and
     it must say so. The check that a body matching NEITHER shape is named
     rather than silently mis-parsed has moved down to its own case below. */
  assert.throws(() => extract("not json", URL_),
    (e) => isRefusal(e) && /not JSON/.test(e.message) && /Body was/.test(e.message));
  assert.throws(() => extract('{"locations":[]}', URL_),
    (e) => isRefusal(e) && /no board at all/.test(e.message));
  assert.throws(() => extract('{"data":[]}', URL_),
    (e) => isRefusal(e) && /no board at all/.test(e.message),
    "an empty second-generation board is an empty board, not an unknown shape");
  assert.throws(() => extract('{"locations":[{"name":"X","groups":[]}]}', URL_),
    (e) => e instanceof BushelRefused && /no row carried/.test(e.message));
  assert.throws(() => extract('{"data":[{"location_name":"X","crops":[]}]}', URL_),
    (e) => e instanceof BushelRefused && /no row carried/.test(e.message));
});

test("A BODY THAT IS NEITHER SHAPE IS NAMED, NOT MIS-PARSED", () => {
  assert.throws(() => extract('{"markets":[]}', URL_),
    (e) => isRefusal(e) && /neither Bushel shape/.test(e.message) && /Body was/.test(e.message));
});

/* ---- the second generation, read whole before a line of this was written -- */

test("THE BUSHELOPS SHAPE READS, and its UUID is the one a manifest carries", () => {
  /* fixtures/bushel-incograin-gen2.json is Inco Grain's WHOLE board, captured
     by run 90133552278 at 2951 characters -- the complete document, closing
     brace and all, not an excerpt. Until it existed this adapter said in its
     own header that no code would be written for this shape. */
  assert.equal(GEN2.length, 4);
  assert.deepEqual([...new Set(GEN2.map((r) => r.location))], ["Inco Grain"]);
  assert.deepEqual([...new Set(GEN2.map((r) => r.commodity))].sort(), ["Corn", "Soybeans"]);
  /* location_id is 590558 and bushel_location_id is the UUID. The UUID is what
     the first generation emits and what filterLocation compares against. */
  assert.deepEqual([...new Set(GEN2.map((r) => r.locationId))],
    ["755bf688-2cbd-4824-954b-1f078bd23e35"]);
  assert.equal(GEN2[0].futuresAt, "2026-08-29T14:50:40Z", "meta.last_updated is snake_case here");
});

test("FUTURES ARE IN CENTS IN BOTH GENERATIONS, because that is what the guard checks", () => {
  /* "5.3650" dollars is 536.5 cents -- identical treatment to GetBidsList, so
     board.mjs cannot tell the two shapes apart and does not have to. */
  assert.equal(GEN2[0].futuresPrice, 536.5);
  assert.equal(GEN2[0].cash, 4.91);
  assert.equal(GEN2[0].basisCents, -45);
  assert.equal(GEN2[0].futures, "ZCZ26");
});

test("Inco Grain floors its cash, measured on all four rows", () => {
  /* -0.5c, -0.5c, 0c, 0c. Stated here so the day it stops being true, this is
     what says so. */
  const residuals = GEN2.map((r) => Math.round((r.cash * 100 - (r.basisCents + r.futuresPrice)) * 100) / 100);
  assert.deepEqual(residuals, [-0.5, -0.5, 0, 0]);
  for (const r of GEN2)
    assert.equal(Math.floor(r.basisCents + r.futuresPrice + 1e-9), Math.round(r.cash * 100));
});

test("THE CHANGE SIGN IS A FIELD IN THIS SHAPE AND IT IS APPLIED", () => {
  assert.equal(GEN2[0].change, 3, "0.0300 dollars up is +3 cents");
  const doc = JSON.parse(GEN2_BODY);
  doc.data[0].crops[0].bids[0].futures_change_sign = -1;
  assert.equal(extract(JSON.stringify(doc), URL_)[0].change, -3, "a down day must come out negative");
});

test("A CROP WITH NO BIDS IS NOT A FAULT", () => {
  /* Riceland carries fifteen empty crops per location, back to 2022. */
  const doc = JSON.parse(GEN2_BODY);
  doc.data[0].crops.push({ id: "x", name: "2022 Rice", market_tick_size: "0.01", bids: [] });
  assert.equal(extract(JSON.stringify(doc), URL_).length, GEN2.length);
});

test("A ROW WHOSE FUTURES ARE IN ANOTHER UNIT IS MARKED UNCHECKABLE, NOT CONVERTED", () => {
  /* Riceland's rice: bid per bushel against a futures contract quoted per CWT,
     unit_conversion_factor 0.450000. 15.5450 x 0.45 = 6.995 and
     5.98 - (-1.02) = 7.00, so the identity is fine -- it is just not an
     identity between the two PRINTED numbers. One example is not a rule, so no
     conversion is applied; the row is marked and withheld instead. */
  const doc = JSON.parse(GEN2_BODY);
  doc.data[0].crops[0].bids[0].futures_unit_of_measure = "cwt";
  const out = extract(JSON.stringify(doc), URL_);
  assert.equal(out[0].perBushel, true, "the CASH cell is still per bushel");
  assert.equal(out[0].identityCheckable, false, "the identity cannot be checked across units");
  assert.equal(out[1].identityCheckable, true, "only the row that changed is affected");
});

test("AND A CASH CELL THAT IS NOT PER BUSHEL FOLDS ITS UNIT INTO THE NAME", () => {
  const doc = JSON.parse(GEN2_BODY);
  doc.data[0].crops[0].bids[0].unit_of_measure = "cwt";
  const out = extract(JSON.stringify(doc), URL_);
  assert.match(out[0].commodity, /^Corn \(cwt\)$/);
  assert.equal(out[0].perBushel, false);
  assert.equal(out[0].identityCheckable, false);
});

test("the platform is registered end to end", () => {
  assert.ok(PLATFORMS.includes("bushel"));
  assert.equal(wireOf("bushel"), "json");
  assert.equal(transportOf("bushel"), "browser", "the board is fetched by their own page");
  assert.equal(typeof adapterFor("bushel"), "function");
  assert.equal(adapterFor("bushel")(BODY, URL_).length, 24);
});

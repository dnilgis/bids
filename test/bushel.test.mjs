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
  assert.throws(() => extract("not json", URL_),
    (e) => isRefusal(e) && /not JSON/.test(e.message) && /Body was/.test(e.message));
  assert.throws(() => extract('{"data":[]}', URL_),
    (e) => isRefusal(e) && /older bushelops/.test(e.message),
    "the other generation must be named, not silently mis-parsed");
  assert.throws(() => extract('{"locations":[]}', URL_),
    (e) => isRefusal(e) && /no board at all/.test(e.message));
  assert.throws(() => extract('{"locations":[{"name":"X","groups":[]}]}', URL_),
    (e) => e instanceof BushelRefused && /no row carried/.test(e.message));
});

test("the platform is registered end to end", () => {
  assert.ok(PLATFORMS.includes("bushel"));
  assert.equal(wireOf("bushel"), "json");
  assert.equal(transportOf("bushel"), "browser", "the board is fetched by their own page");
  assert.equal(typeof adapterFor("bushel"), "function");
  assert.equal(adapterFor("bushel")(BODY, URL_).length, 24);
});

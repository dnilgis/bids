/* The DTN Content Services adapter, against a real capture.
 *
 * fixtures/dtn-cs-agpartners-e0172401.json is 25 records copied verbatim out of
 * the live response Sig pulled from his browser on 2026-08-20, from
 *
 *     https://api.dtn.com/markets/sites/e0172401/cash-bids?apikey=…&units=us
 *
 * The full response carried 176 records across THIRTEEN locations; the excerpt
 * keeps four of them (Red Wing Grain LLC, Goodhue, Eyota, Traverse) and every
 * field of every record it keeps, unedited. That is a subset, not a
 * reconstruction, and the distinction matters: rule 57 in this project — never
 * test a parser against a page you rebuilt — was earned on WHITESPACE, and this
 * payload is read with JSON.parse, which has no whitespace to get wrong. What a
 * JSON fixture must be faithful about is field names, types and value formats,
 * and every one of those is verbatim here.
 *
 * The sandbox cannot fetch this endpoint: api.dtn.com answers 403 to a
 * non-browser client on every path under /markets/, existing or not. So this
 * fixture is the only copy, and it is why it lives in the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused, roundingRule, explainedByRounding, CASH_ROUNDING } from "../lib/board.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { extract, DtnCsRefused } from "../lib/adapters/dtn-cs.mjs";
import { parseTicks } from "../lib/parse.mjs";

const body = readFileSync(new URL("../fixtures/dtn-cs-agpartners-e0172401.json", import.meta.url), "utf8");
const URL_ = "https://api.dtn.com/markets/sites/e0172401/cash-bids?units=us";
const NOW = "2026-08-20T14:05:00.000Z";
const src = (o) => ({ operator: "Ag Partners Cooperative", cashRounding: "floor-cent", ...o });
const build = (o) => buildFile(body, { now: NOW, sourceUrl: URL_, source: src(o), extract });

test("the adapter is registered under its own platform name", () => {
  assert.equal(adapterFor("dtn-cs"), extract);
});

test("every record in the capture becomes a row, with the location id kept as the key", () => {
  const rows = extract(body, URL_);
  assert.equal(rows.length, 25);
  const seen = [...new Set(rows.map((r) => `${r.location} (${r.locationId})`))];
  assert.deepEqual(seen, [
    "Red Wing Grain LLC (7239)", "Goodhue (7240)", "Eyota (25078)", "Traverse (25686)",
  ]);
  /* The id, not the name. "Red Wing Grain LLC" is a joint venture's company
     name rather than a town, and a name is the thing a vendor re-cases. */
  assert.equal(typeof rows[0].locationId, "string");
});

test("the futures quote is read as eighths of a cent, not as its leading integer", () => {
  /* This is the whole reason parseTicks learned the apostrophe. Before that,
     478'6 came back as 478 and every row was three quarters of a cent wrong in
     a direction nothing downstream could detect. */
  const rows = extract(body, URL_);
  assert.equal(rows[0].futures, "@C6U");
  assert.equal(rows[0].futuresPrice, 478.75);
  assert.equal(parseTicks("478'6"), 478.75);
  const beans = rows.find((r) => r.commodity === "Soybeans");
  assert.equal(beans.futuresPrice, 1238.25);
});

test("cash and basis arrive in dollars and the change column in eighths", () => {
  const r = extract(body, URL_)[0];
  assert.equal(r.cash, 4.35);
  assert.equal(r.basis, -0.43);
  assert.equal(r.basisCents, -43);
  assert.equal(r.change, 5.75);          // "5'6"
});

test("their cash cell is the arithmetic FLOORED to the cent, on all 25 records", () => {
  /* Measured before any code was written to accommodate it:
       cash == basis + futures exactly      4 of 25
       cash == ROUND(basis + futures)      11 of 25
       cash == FLOOR(basis + futures)      25 of 25
     and the residuals present are only 0, 0.25 and 0.75 cents. If this test
     ever fails, the platform changed how it computes its own board and the
     `floor-cent` declaration on every source is no longer true. */
  const rows = extract(body, URL_);
  const resid = new Set();
  for (const r of rows) {
    const derived = Math.round(r.basis * 100) + r.futuresPrice;
    assert.equal(Math.floor(derived + 1e-9), Math.round(r.cash * 100),
      `${r.location} ${r.commodity} ${r.delivery}`);
    resid.add(Math.round((derived - Math.round(r.cash * 100)) * 1000) / 1000);
  }
  assert.deepEqual([...resid].sort((a, b) => a - b), [0, 0.25, 0.75]);
  const exact = rows.filter((r) => Math.round(r.basis * 100) + r.futuresPrice === Math.round(r.cash * 100));
  assert.equal(exact.length, 4, "if every row were exact this platform would not need the mode at all");
});

test("one site id carries a whole co-operative, and each location publishes only its own rows", () => {
  const rw = build({ locationId: "7239", location: "Red Wing" });
  assert.equal(rw.file.count, 16);
  assert.equal(rw.dropped, 9);
  const gh = build({ locationId: "7240", location: "Goodhue" });
  assert.equal(gh.file.count, 5);
  assert.ok(gh.file.otherLocationsOnPage.includes("Red Wing Grain LLC (7239)"));
  for (const b of gh.file.bids) assert.ok(b.cash > 4 && b.cash < 12);
});

test("without the rounding declared the whole board refuses, and says why in cents", () => {
  /* The floor residual is up to three quarters of a cent — bigger than the two
     ticks a torn read can account for — so an undeclared board does not sneak
     through as "lagging". It refuses, loudly. */
  assert.throws(() => build({ locationId: "7240", location: "Goodhue", cashRounding: undefined }),
    (e) => e instanceof Refused &&
      /5 of 5 testable row\(s\) fail/.test(e.message) &&
      /\+0\.75c/.test(e.message));
});

test("floor-cent is stronger than the blunt tolerance that would also pass", () => {
  /* cashRoundingCents: 0.75 accepts a residual of ANY sign up to 0.75c.
     floor-cent accepts only [0, 1) — a cash cell reading HIGH by a quarter cent
     is a real defect and the tolerance would swallow it. */
  const rule = roundingRule({ cashRounding: "floor-cent" });
  assert.equal(rule(0), true);
  assert.equal(rule(0.75), true);
  assert.equal(rule(0.999), true);
  assert.equal(rule(-0.25), false, "cash a quarter cent HIGH is not their rounding");
  assert.equal(rule(1), false);
  assert.equal(rule(12), false);
  /* And the blunt tolerance really would have let the first of those through. */
  const off = [{ offCents: 0.25, signedCents: -0.25 }];
  assert.equal(explainedByRounding({ cashRoundingCents: 0.75 }, off, 0.75).length, 0);
  assert.equal(explainedByRounding({ cashRounding: "floor-cent" }, off, 0).length, 1);
});

test("an unrecognised cashRounding refuses rather than falling back to exact", () => {
  assert.throws(() => roundingRule({ cashRounding: "nearest-cent" }),
    (e) => e instanceof Refused && /is not one of/.test(e.message));
  assert.equal(roundingRule({}), null);
  assert.equal(roundingRule({ cashRounding: "exact" }), null);
  assert.ok("floor-cent" in CASH_ROUNDING);
});

test("a location id that is not in the feed refuses and lists what was there", () => {
  assert.throws(() => build({ locationId: "9999", location: "Nowhere" }),
    (e) => e instanceof Refused &&
      /none for location 9999/.test(e.message) &&
      /Goodhue \(7240\)/.test(e.message));
});

test("a non-bushel or converted row cannot borrow a per-bushel band", () => {
  /* It is not dropped — absent is not empty. The unit is folded into the
     commodity name so no default band can match it, and board.mjs then
     withholds it under its own name where somebody can see it. */
  const one = JSON.parse(body)[0];
  const cwt = { ...one, unitOfMeasure: "Hundredweight", primaryPrice: { ...one.primaryPrice, unitOfMeasure: "Hundredweight" } };
  const rows = extract(JSON.stringify([one, cwt]), URL_);
  assert.equal(rows[0].commodity, "Corn");
  assert.equal(rows[1].commodity, "Corn (Hundredweight)");

  const conv = { ...one, conversionUsed: "0.3937", convertedPrice: 171.25 };
  assert.equal(extract(JSON.stringify([conv]), URL_)[0].commodity, "Corn (Bushels, converted)");
});

test("the two copies of the price in the payload have to agree", () => {
  /* primaryPrice is the elevator's own figure; the top-level pair is what the
     widget renders after any unit conversion the `units` parameter asked for.
     If a conversion is ever applied to one and not the other, the identity
     check cannot see it, because both halves move together. */
  const one = JSON.parse(body)[0];
  const skew = { ...one, primaryPrice: { ...one.primaryPrice, cashPrice: 17.12 } };
  assert.throws(() => extract(JSON.stringify([skew]), URL_),
    (e) => e instanceof DtnCsRefused && /do not match primaryPrice/.test(e.message));
});

test("an error page, an empty list and a wrapped list are each told apart", () => {
  assert.throws(() => extract("<html><body>Forbidden</body></html>", URL_),
    (e) => e instanceof DtnCsRefused && /not JSON/.test(e.message));
  assert.throws(() => extract("[]", URL_),
    (e) => e instanceof DtnCsRefused && /no cash bids at all/.test(e.message));
  assert.throws(() => extract('{"message":"unauthorized"}', URL_),
    (e) => e instanceof DtnCsRefused && /expected an array/.test(e.message));
  /* Some DTN endpoints wrap the list; both shapes are accepted. */
  assert.equal(extract(JSON.stringify({ cashBids: JSON.parse(body) }), URL_).length, 25);
});

test("a record with no bid on it is skipped, and a board of nothing but those refuses", () => {
  const one = JSON.parse(body)[0];
  const noBid = { ...one, cashPrice: null, basisPrice: null, futuresQuote: null, primaryPrice: null };
  assert.equal(extract(JSON.stringify([one, noBid]), URL_).length, 1);
  assert.throws(() => extract(JSON.stringify([noBid]), URL_),
    (e) => e instanceof DtnCsRefused && /1 record\(s\) came back but none carried/.test(e.message));
});

test("the delayed flag is carried as a diagnostic and never published", () => {
  const rows = extract(body, URL_);
  assert.equal(rows[0].futuresFlag, "delayed");
  const b = build({ locationId: "7239", location: "Red Wing" }).file.bids[0];
  assert.ok(!("futuresFlag" in b));
  assert.ok(!("change" in b), "their change column is theirs, and it moves every minute");
});

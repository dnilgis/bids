/* DTN Grain Desk — public JSON keyed by the company's own slug.
 *
 * ON THE FIXTURE: `fixtures/graindesk-albertlea-SAMPLE.json` is a SAMPLE, not a
 * capture. Its shape and its numbers came back through a summarising reader
 * rather than as raw bytes off the wire, and this repo has already been bitten
 * twice by a parser that agreed with a hand-rebuilt copy of a page and not the
 * page. So these tests pin the SHAPE and the ARITHMETIC, the first live poll is
 * the verification, and the fixture gets replaced by a real capture as soon as
 * one is in hand. It is named SAMPLE so nobody forgets which it is. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract, describe as describeBody, cashBidsUrl, num, GrainDeskRefused } from "../lib/adapters/graindesk.mjs";

const SAMPLE = readFileSync(new URL("../fixtures/graindesk-albertlea-SAMPLE.json", import.meta.url), "utf8");
/* THE REAL BYTES, captured off the wire by the probe on 2026-08-20 (run
   87617854954). The SAMPLE above stays only for the case it covers that this
   one does not -- an offer carrying a `comments` label. It is also the evidence
   for why captures matter: the transcribed sample said 11.63 and −0.75 against
   1238.00, and the wire says 11.6375 against 1238.75. Both balance, but only
   one of them is what Albert Lea was bidding. */
const LIVE = readFileSync(new URL("../fixtures/graindesk-albertlea-2026-08-20.json", import.meta.url), "utf8");
const URL_ = "https://marketplace.graindiscovery.com/api/public-sites/albertleaelevator/cash-bids";

test("the sample yields four rows and the identity is EXACT, not approximate", () => {
  const rows = extract(SAMPLE, URL_);
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map((r) => r.location))], ["Albert Lea"]);
  assert.deepEqual([...new Set(rows.map((r) => r.commodity))], ["Soybeans", "Corn"]);
  for (const r of rows) {
    /* This platform quotes cash to four decimals, so cash − basis lands on the
       futures quote to the cent with nothing left over. A source on it declares
       cashRoundingCents 0 and the guard stays strict. */
    assert.equal(Math.round((r.cash - r.basis) * 10000) / 100, r.futuresPrice,
      `${r.commodity} ${r.delivery}: ${r.cash} − ${r.basis} ≠ ${r.futuresPrice}`);
  }
});

test("their own label is kept, with the dates beside it", () => {
  const rows = extract(SAMPLE, URL_);
  const newCrop = rows.find((r) => r.delivery.startsWith("New Crop 2026"));
  assert.ok(newCrop, "the commented offer lost its label");
  assert.match(newCrop.delivery, /New Crop 2026 \(.*2026.*\)/);
  /* Two offers on one commodity must never collapse into one row. */
  const corn = rows.filter((r) => r.commodity === "Corn").map((r) => r.delivery);
  assert.equal(new Set(corn).size, corn.length);
});

test("the captured board reads, and its identity is exact to the cent", () => {
  const rows = extract(LIVE, URL_);
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map((r) => r.location))], ["Albert Lea"]);
  const corn = rows.filter((r) => r.commodity === "Corn");
  assert.equal(corn.length, 2);
  assert.equal(corn[0].cash, 4.2925);
  assert.equal(corn[0].basis, -0.45);
  assert.equal(corn[0].futuresPrice, 474.25);
  for (const r of rows) {
    assert.equal(Math.round((r.cash - r.basis) * 10000) / 100, r.futuresPrice,
      `${r.commodity} ${r.delivery}`);
  }
});

test("an empty comments string does not become part of the delivery label", () => {
  /* The wire sends `"comments": ""`, not an absent key. Concatenating it would
     produce " (03 Aug 2026 to 31 Aug 2026)" with a leading space and an empty
     label -- ugly, and worse, it would differ from the same row on a day when
     they do set a comment, so the row would look like a new one. */
  for (const r of extract(LIVE, URL_)) {
    assert.ok(!r.delivery.startsWith(" "), JSON.stringify(r.delivery));
    assert.ok(!/^\(/.test(r.delivery), JSON.stringify(r.delivery));
  }
});

test("a body that is not JSON is refused, and says so", () => {
  assert.throws(() => extract("<html><body>502 Bad Gateway</body></html>", URL_), (e) => {
    assert.ok(e instanceof GrainDeskRefused);
    assert.match(e.message, /not JSON/);
    return true;
  });
});

test("an empty array is a refusal, not an empty board", () => {
  /* Returning [] here would read downstream as "they are not bidding today",
     which is a claim about their business we have no evidence for. */
  assert.throws(() => extract("[]", URL_), /empty/);
});

test("an object instead of an array is refused by shape", () => {
  assert.throws(() => extract('{"message":"Not found"}', URL_), (e) => {
    assert.match(e.message, /expected an array/);
    return true;
  });
});

test("an incomplete offer is skipped; ALL incomplete is a refusal", () => {
  const oneBad = JSON.parse(SAMPLE);
  delete oneBad[0].offers[0].standardCashPrice;
  assert.equal(extract(JSON.stringify(oneBad), URL_).length, 3);

  const allBad = JSON.parse(SAMPLE);
  for (const g of allBad) for (const o of g.offers) delete o.basisPrice;
  assert.throws(() => extract(JSON.stringify(allBad), URL_), /every offer was incomplete/);
});

test("a commodity group with no name is refused rather than filed as blank", () => {
  const nameless = JSON.parse(SAMPLE);
  delete nameless[0].commodity.name;
  assert.throws(() => extract(JSON.stringify(nameless), URL_), /no name/);
});

test('num() never turns "" or null into zero', () => {
  assert.equal(num(""), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num("n/a"), null);
  assert.equal(num("4.2750"), 4.275);
  assert.equal(num("-0.4500"), -0.45);
});

test("the board URL is built from the token, and a custom host is honoured", () => {
  assert.equal(cashBidsUrl("albertleaelevator"),
    "https://marketplace.graindiscovery.com/api/public-sites/albertleaelevator/cash-bids");
  /* Their bundle carries a per-customer host map — lockiefarms has its own. */
  assert.equal(cashBidsUrl("lockiefarms", "https://lockiefarms.graindiscovery.com/api/"),
    "https://lockiefarms.graindiscovery.com/api/public-sites/lockiefarms/cash-bids");
  assert.match(cashBidsUrl("a b/c"), /public-sites\/a%20b%2Fc\/cash-bids/);
  assert.throws(() => cashBidsUrl(""), GrainDeskRefused);
});

test("describe() names what came back when it is not what we wanted", () => {
  assert.match(describeBody("not json at all"), /not JSON/);
  assert.match(describeBody('{"a":1}'), /not the expected array/);
  assert.match(describeBody(SAMPLE), /Soybeans×2, Corn×2/);
  assert.match(describeBody(SAMPLE), /"Albert Lea"/);
});

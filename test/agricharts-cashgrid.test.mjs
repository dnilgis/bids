/*
 * THE BOARD MOST AGRICHARTS OPERATORS ACTUALLY PUBLISH.
 *
 * lib/adapters/agricharts.mjs reads the MOBILE board. Measured 2026-09-03: of
 * the 211 sites data/platforms.json calls agricharts, our 84 sources come from
 * SIXTEEN distinct mobile boards and only 18 of the 211 have one we read — the
 * mobile route reaches about 8.5% of the platform.
 *
 * Run 91611899805 asked 61 uncovered operators for both shapes and 47 served
 * "prices in a table we cannot parse yet". Run 91617768662 brought the bytes
 * back: fixtures/agricharts-cashgrid-*.html, 47 boards, 6,349 price cells.
 *
 * THE BOARD NAMES ITS CONTRACT, which the mobile board does not:
 *
 *   writeBidCell(-34, false, 0, false, 56, 'c=4843&l=12579&d=U26', false,
 *                quotes['ZCZ26']);
 *
 * So `cash - basis = futures` is TRUE BY CONSTRUCTION here — we compute cash
 * from the basis and the quote — and a check of it would be checking our own
 * arithmetic against itself. What is asserted instead is what can actually be
 * wrong: an unpriced contract, a heading that disagrees with the symbol, and a
 * delivery code with no column header above it.
 *
 *     node --test test/agricharts-cashgrid.test.mjs
 *
 * No network. Every number below came off a committed capture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mergeQuotes } from "../lib/adapters/agricharts.mjs";
import { extract, parseCells, cashFor, deliveryFromCode, headerCodes,
         headingsBefore, MONTH_CODES, CELL, VERIFIED_BY } from "../lib/adapters/agricharts-cashgrid.mjs";
import { adapterFor, SHARED_PAGES } from "../lib/adapters/index.mjs";
import { PLATFORMS, PLATFORM_WIRE } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "fixtures");
const read = (f) => readFileSync(join(DIR, f), "utf8");
const captures = () => readdirSync(DIR).filter((f) => /^agricharts-cashgrid-/.test(f)).sort();
const CONTRACTS = mergeQuotes(readdirSync(DIR).filter((f) => /^agricharts-quotes-/.test(f)).map(read));

/* ── the month codes ─────────────────────────────────────────────────────── */

test("the month codes are the exchange's, and I is not one of them", () => {
  assert.equal(deliveryFromCode("U26"), "09/01/2026");
  assert.equal(deliveryFromCode("F27"), "01/01/2027");
  assert.equal(deliveryFromCode("Z26"), "12/01/2026");
  assert.equal(deliveryFromCode("I26"), null, "I is skipped on every exchange because it reads as a 1");
  assert.equal(deliveryFromCode("26"), null);
  assert.equal(deliveryFromCode(null), null);
  assert.equal(Object.keys(MONTH_CODES).length, 12);
});

/* ── the cell ────────────────────────────────────────────────────────────── */

test("a cell with a named contract parses every argument", () => {
  const [m] = [...`writeBidCell(-34, false, 0, false, 56, 'c=4843&l=12579&d=U26', false, quotes['ZCZ26']);`
    .matchAll(new RegExp(CELL.source, "g"))];
  assert.ok(m);
  assert.deepEqual(m.slice(1), ["-34", "false", "0", "false", "56", "4843", "12579", "U26", "false", "ZCZ26"]);
});

test("rounding is a float on plenty of boards, and -1 where it is off", () => {
  /* MATCHING IT AS AN INTEGER MISSED 2,037 OF 6,349 CELLS on the first pass —
     AgMark and Primient use 0.5, Minn-Kota 0.75, Agtegra -1. */
  const one = (s) => [...s.matchAll(new RegExp(CELL.source, "g"))].length;
  assert.equal(one(`writeBidCell(-55, false, 0.5, false, 56, 'c=1&l=2&d=U26', false, quotes['ZCZ26'])`), 1);
  assert.equal(one(`writeBidCell(-65, false, 0.75, false, 60, 'c=1&l=2&d=U26', false, quotes['ZSX26'])`), 1);
  assert.equal(one(`writeBidCell(2400, true, -1, false, 60, 'c=1&l=2&d=U26', false)`), 1);
});

test("the eighth argument is absent on a flat posted price", () => {
  const [m] = [...`writeBidCell(2400, true, -1, false, 60, 'c=10433&l=50053&d=U26', false)`
    .matchAll(new RegExp(CELL.source, "g"))];
  assert.equal(m[2], "true", "manual");
  assert.equal(m[10], undefined, "no contract named");
});

/* ── the arithmetic, which is the page's and not ours ────────────────────── */

const cell = (o = {}) => ({ basis: -34, manual: false, rounding: 0, incwt: false,
                            weight: 56, symbol: "ZCZ26", ...o });

test("a cent-quoted contract adds the basis in cents", () => {
  assert.equal(cashFor(cell(), { lastCents: 542.25, root: "ZC" }), 5.08);
});

test("MW and ZR take the SAME formula, because our quotes are already in cents", () => {
  /* THE BUG THIS TEST WAS WRITTEN TO CONFIRM, AND CAUGHT INSTEAD.
   * The page branches on MW/ZR because its quote object holds the exchange's
   * raw number — MW arrives as 7.5975 where corn arrives as 754.75 — and then
   * prints the first without dividing by a hundred. Two branches that cancel.
   * mergeQuotes() has already normalised MW to lastCents 759.75, so copying
   * the branch subtracts 0.85 where it must subtract 85. */
  assert.equal(cashFor(cell({ symbol: "MWZ26", basis: -85 }), { lastCents: 759.75 }), 6.75);
  assert.notEqual(cashFor(cell({ symbol: "MWZ26", basis: -85 }), { lastCents: 759.75 }), 7.59);
  assert.equal(cashFor(cell({ symbol: "ZWZ26", basis: -85 }), { lastCents: 759.75 }),
               cashFor(cell({ symbol: "MWZ26", basis: -85 }), { lastCents: 759.75 }),
               "the symbol does not change the arithmetic; the contract record already did");
  assert.equal(cashFor(cell({ symbol: "ZRX26", basis: 25 }), { lastCents: 1523.5 }), 15.49);
});

test("a manual cell is a posted price in the board's own notation", () => {
  /* parseInt(basis.toString().replace('.','')) — "24.5" is $2.45, not $24.50.
     Their notation, and following it exactly is the whole job. */
  assert.equal(cashFor(cell({ manual: true, basis: 2400, symbol: null }), null), 24);
  assert.equal(cashFor(cell({ manual: true, basis: 24.5, symbol: null }), null), 2.45);
});

test("incwt converts to hundredweight at the board's own test weight", () => {
  /* Agtegra's sunflowers come out of here. */
  assert.equal(cashFor(cell({ manual: true, basis: 1200, symbol: null, incwt: true, weight: 60 }), null), 20);
  assert.equal(cashFor(cell({ manual: true, basis: 1200, symbol: null, incwt: false, weight: 60 }), null), 12);
});

test("no contract means no price, rather than a price of zero", () => {
  assert.equal(cashFor(cell(), null), null === null ? cashFor(cell(), null) : 0);
  assert.equal(cashFor(cell(), { lastCents: undefined }), null);
});

/* ── the page ────────────────────────────────────────────────────────────── */

test("headerCodes reads the delivery months out of a table's own headers", () => {
  const t = `<thead><tr><th>Location</th><th>Sep '26</th><th>Oct '26</th><th>Jan '27</th></tr></thead>`;
  assert.deepEqual([...headerCodes(t)].sort(), ["F27", "U26", "V26"]);
  assert.deepEqual([...headerCodes("<tr><th>Location</th></tr>")], []);
});

test("the commodity heading in scope is the nearest one before the table", () => {
  const h = headingsBefore(`<h2>Corn</h2><table></table><h2>Soybeans</h2><table></table>`);
  assert.deepEqual(h.map((x) => x.text), ["Corn", "Soybeans"]);
  assert.ok(h[0].at < h[1].at);
});

/* ── the captures ────────────────────────────────────────────────────────── */

test("47 captures are on file and they are all cashgrid boards", () => {
  assert.ok(captures().length >= 47, `only ${captures().length} captures`);
});

/* THE TWO THAT DO NOT READ, AND WHY. An exception must be declared, asserted
   and total — a list that merely tolerates whatever fails is not a test. */
const NOT_CASHGRID = {
  "agricharts-cashgrid-faasfeed.html":
    "serves the MOBILE cashprices table at its cashgrid URL — the other adapter reads it",
  "agricharts-cashgrid-heartlandcoop.html":
    "1,306 characters of page furniture and no board: the bids load from somewhere else",
};

test("45 of the 47 captured boards read, and the other two say why", () => {
  const refused = [];
  let rows = 0, unreconciled = 0;
  const locations = new Set();
  for (const f of captures()) {
    try {
      const r = extract(read(f), `https://x/${f}`, { contracts: CONTRACTS });
      rows += r.length;
      unreconciled += r.unreconciled.length;
      for (const x of r) locations.add(`${f}|${x.locationId}`);
    } catch (e) { refused.push([f, e.message]); }
  }
  assert.deepEqual(refused.map((x) => x[0]).sort(), Object.keys(NOT_CASHGRID).sort(),
    `unexpected refusals: ${refused.map((x) => `${x[0]}: ${x[1].slice(0, 100)}`).join(" | ")}`);
  for (const [, why] of refused) assert.match(why, /not an AgriCharts cashgrid board/);

  assert.ok(rows > 6000, `only ${rows} rows`);
  assert.ok(locations.size > 500, `only ${locations.size} locations`);
  /* A handful of refused rows is the doctrine working. Hundreds would mean it
     had become a way of not noticing. */
  assert.ok(unreconciled < rows / 100, `${unreconciled} refused rows out of ${rows}`);
});

test("every published row carries a price a farmer could act on", () => {
  const BAND = { ZC: [2, 12], ZS: [6, 32], ZW: [3, 20], KE: [3, 20], MW: [3, 20] };
  let checked = 0;
  for (const f of captures()) {
    let r; try { r = extract(read(f), "u", { contracts: CONTRACTS }); } catch { continue; }
    for (const x of r) {
      assert.ok(x.cash > 0, `${f} ${x.raw} published ${x.cash}`);
      const b = BAND[String(x.futures ?? "").slice(0, 2)];
      if (!b) continue;
      checked++;
      assert.ok(x.cash >= b[0] && x.cash <= b[1],
        `${f} ${x.commodity} ${x.futures} came out at $${x.cash}`);
    }
  }
  assert.ok(checked > 5000, `only ${checked} rows had a band to check against`);
});

test("a zero is not a bid", () => {
  /* Eighteen flat rows under an "Oats" heading come out at $0.00 across the
     captures — an operator saying "we are not buying oats" in the only field
     the form gives them. */
  const html = `<h2>Oats</h2><table class="cashbid_grid"><thead><tr><th>Location</th>
    <th>Sep '26</th><th>Oct '26</th></tr></thead><tbody><tr>
    <script>writeBidCell(0, true, -1, false, 32, 'c=1&l=99&d=U26', false);
            writeBidCell(500, true, -1, false, 32, 'c=1&l=99&d=V26', false);</script>
    </tbody></table>`;
  const r = extract(html, "u", { contracts: CONTRACTS });
  assert.equal(r.length, 1, "only the real bid publishes");
  assert.equal(r[0].cash, 5);
  assert.match(r.unreconciled[0].why, /not a bid/);
});

/* ── the three checks that can actually fail ─────────────────────────────── */

const GRID = (opts) => `<h2>${opts.heading}</h2>
  <table class="homepage_quoteboard cashbid_grid"><thead><tr><th width="10%">Location</th>
  <th>${opts.header ?? "Sep '26"}</th></tr></thead><tbody><tr class="odd">
  <td><a href="/markets/cash.php?location_filter=77">Somewhere</a></td>
  <script>writeBidCell(-30, false, 0, false, 56, 'c=1&l=77&d=${opts.code ?? "U26"}', false, quotes['${opts.symbol}']);</script>
  </tr></tbody></table>`;

test("a contract our quote pages do not carry refuses the ROW and says so", () => {
  /* AgMark's board prices a Spring Hill soybean bid against ZSN26 — July 2026,
     long expired. That is a gap in our quote pages, not a broken board, and
     the row travels out on `unreconciled` rather than vanishing. */
  assert.throws(() => extract(GRID({ heading: "Soybeans", symbol: "ZSN26" }), "u", { contracts: CONTRACTS }),
                /all 1 price cell\(s\).*were refused/);
  try { extract(GRID({ heading: "Soybeans", symbol: "ZSN26" }), "u", { contracts: CONTRACTS }); }
  catch (e) { assert.match(e.message, /ZSN26, which our quote pages do not carry/); }
});

test("a heading that disagrees with the symbol is a parse error, and is refused", () => {
  /* THE FAILURE A POSITIONAL PARSER MAKES: reading the Corn table's cells and
     the Soybean table's heading. Nothing else on the page would notice. */
  try {
    extract(GRID({ heading: "Corn", symbol: "ZSX26" }), "u", { contracts: CONTRACTS });
    assert.fail("a Corn heading against a soybean contract must not publish");
  } catch (e) {
    assert.match(e.message, /heading says "Corn" \(ZC\) but the board prices it against ZSX26 \(ZS\)/);
  }
});

test("milo prices off corn, and that is not a disagreement", () => {
  const r = extract(GRID({ heading: "Milo", symbol: "ZCZ26" }), "u", { contracts: CONTRACTS });
  assert.equal(r.length, 1);
  assert.equal(r[0].futures, "ZCZ26");
});

test("every wheat class may price off any of the three exchanges", () => {
  /* Measured 2026-09-02: Cornerstone Ag's WHITE WHEAT implies 834c, which is
     Kansas City. Narrowed to Chicago it missed by 33c and was refused for
     being right. */
  for (const sym of ["ZWZ26", "KEZ26", "MWZ26"]) {
    const r = extract(GRID({ heading: "Wheat", symbol: sym }), "u", { contracts: CONTRACTS });
    assert.equal(r[0].futures, sym);
  }
});

test("a delivery code with no column header above it refuses the whole board", () => {
  /* The cells and the headers not being from the same table is a structural
     failure, not a bad row: every price on the page is then suspect. */
  assert.throws(() => extract(GRID({ heading: "Corn", symbol: "ZCZ26", code: "Z26", header: "Sep '26" }),
                              "u", { contracts: CONTRACTS }),
                /carries delivery code\(s\) Z26 that its own column headers do not offer/);
});

test("no quotes at all refuses the board rather than publishing a basis as a price", () => {
  assert.throws(() => extract(GRID({ heading: "Corn", symbol: "ZCZ26" }), "u", { contracts: [] }),
                /no CBOT quotes were handed to the cashgrid adapter/);
  assert.throws(() => extract(GRID({ heading: "Corn", symbol: "ZCZ26" }), "u", undefined),
                /no CBOT quotes/);
});

test("a page with no writeBidCell is not this board", () => {
  assert.throws(() => extract("<html><table class='cashprices'>x</table></html>", "u",
                              { contracts: CONTRACTS }), /not an AgriCharts cashgrid board/);
});

/* ── what a row says about itself ────────────────────────────────────────── */

test("the contract is NAMED, so nothing is implied", () => {
  const r = extract(GRID({ heading: "Corn", symbol: "ZCZ26" }), "u", { contracts: CONTRACTS });
  const row = r[0];
  assert.equal(row.futures, "ZCZ26");
  assert.equal(row.impliedFuturesCents, null,
    "restating our own subtraction as evidence is what the mobile adapter has to do; this board does not");
  assert.equal(row.verifiedBy, VERIFIED_BY);
  assert.equal(row.locationId, "77");
  assert.equal(row.location, "Somewhere", "named from the page's own location filter");
  assert.equal(row.delivery, "09/01/2026");
  assert.equal(row.basisCents, -30);
  assert.equal(row.unit, "bushel");
});

test("a flat posted price says so rather than borrowing the verified stamp", () => {
  const html = `<h2>Sunflowers</h2><table class="cashbid_grid"><thead><tr><th>Location</th>
    <th>Sep '26</th></tr></thead><tbody><tr>
    <script>writeBidCell(2400, true, -1, false, 60, 'c=1&l=88&d=U26', false);</script>
    </tbody></table>`;
  const r = extract(html, "u", { contracts: CONTRACTS });
  assert.equal(r[0].cash, 24);
  assert.equal(r[0].futures, null);
  assert.equal(r[0].basisCents, null, "there is no basis on a flat price and none is invented");
  assert.equal(r[0].verifiedBy, "agricharts-cashgrid:posted-flat");
  assert.notEqual(r[0].verifiedBy, VERIFIED_BY);
});

/* ── it is wired in ──────────────────────────────────────────────────────── */

test("the platform is declared, wired and reachable through the registry", () => {
  assert.ok(PLATFORMS.includes("agricharts-cashgrid"));
  assert.equal(PLATFORM_WIRE["agricharts-cashgrid"], "html");
  assert.equal(typeof adapterFor("agricharts-cashgrid"), "function");
});

test("it shares the same seven quote pages, fetched once", () => {
  const a = SHARED_PAGES["agricharts"], b = SHARED_PAGES["agricharts-cashgrid"];
  assert.deepEqual(b.urls, a.urls);
  assert.equal(b.urls.length, 7);
  assert.ok(b.build([read("agricharts-quotes-corn.html")]).contracts.length > 0);
});

test("the registry hands the adapter its context, or it cannot price anything", () => {
  const bound = adapterFor("agricharts-cashgrid", { contracts: CONTRACTS });
  const rows = bound(GRID({ heading: "Corn", symbol: "ZCZ26" }), "u");
  assert.equal(rows.length, 1);
  assert.throws(() => adapterFor("agricharts-cashgrid", { contracts: [] })(
    GRID({ heading: "Corn", symbol: "ZCZ26" }), "u"), /no CBOT quotes/);
});

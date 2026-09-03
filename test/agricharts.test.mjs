/* The AgriCharts adapter, against the bytes it was written from.
 *
 * fixtures/agricharts-*.html are seven cash boards and eight futures quote
 * pages, captured from the runner on 2026-09-02 and committed verbatim. They
 * are frozen on purpose — the probe keeps a fixture it already holds and only
 * --refresh replaces it — so the counts asserted below are stable, and a
 * change in one of them means either the parser moved or the platform did.
 *
 * IF YOU JUST RAN THE PROBE WITH --refresh AND THIS FILE WENT RED: that is the
 * guard working. Read the fixture diff, decide which of the two happened, and
 * update these numbers deliberately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  parseBoard, parseQuotes, quoteToCents, parseCash, parseBasisCents, sectionIsCommodity,
  impliedSpread, fitToContracts, boardStamp, describe, AgriChartsRefused,
  COLUMNS, GRAIN_ROOTS, MAX_FIT_CENTS,
  extract, mergeQuotes, quoteUrls, VERIFIED_BY, rootsFor, locationNames,
} from "../lib/adapters/agricharts.mjs";

const DIR = join(fileURLToPath(new URL("..", import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(DIR, f), "utf8");
const boards = () => readdirSync(DIR).filter((f) => /^agricharts-(?!quotes)/.test(f)).sort();
const quotePages = () => readdirSync(DIR).filter((f) => /^agricharts-quotes-/.test(f)).sort();

/* ── the boards ──────────────────────────────────────────────────────────── */

/* rows, and distinct location ids. The second number is the one that decides
   how many sources a board is worth, so it is asserted and not counted by eye. */
const BOARDS = {
  "agricharts-auroraelevator.html":     { rows: 11,  locs: 1, grouped: "commodity" },
  "agricharts-kellergrain.html":        { rows: 8,   locs: 1, grouped: "commodity" },
  "agricharts-kokomograin.html":        { rows: 74,  locs: 8, grouped: "location" },
  "agricharts-legacyfarmers.html":      { rows: 83,  locs: 10, grouped: "location" },
  "agricharts-offerle.html":            { rows: 7,   locs: 1, grouped: "commodity" },
  "agricharts-thefarmerselevator.html": { rows: 6,   locs: 1, grouped: "location" },
  "agricharts-wheatfieldgrain.html":    { rows: 120, locs: 7, grouped: "location" },
};

test("the seven boards these counts were written from are all still here", () => {
  /* There are more captures than these now -- the national sweep of 2026-09-03
     brought back sixteen more -- so this asserts the seven are present rather
     than that they are all there is. */
  for (const f of Object.keys(BOARDS)) assert.ok(boards().includes(f), `${f} is gone`);
  assert.ok(boards().length >= 7);
});

for (const [f, want] of Object.entries(BOARDS)) {
  test(`${f} parses to ${want.rows} rows across ${want.locs} location(s)`, () => {
    const rows = parseBoard(read(f), `https://x/${f}`);
    assert.equal(rows.length, want.rows);
    assert.equal(new Set(rows.map((r) => r.locationId)).size, want.locs);
  });

  test(`${f} is grouped by ${want.grouped}, and every row carries a location id`, () => {
    const rows = parseBoard(read(f), "x");
    // The chart link is on all 309 rows of all seven captures. That is what a
    // source keys on, and it is present whichever way the board is grouped.
    for (const r of rows) assert.match(String(r.locationId), /^\d+$/, JSON.stringify(r));
    const labelled = rows.filter((r) => r.location != null).length;
    if (want.grouped === "commodity") assert.equal(labelled, 0,
      "a commodity heading must not be filed as a location name");
    else assert.equal(labelled, rows.length);
  });

  test(`${f} publishes no futures price, which is the whole point`, () => {
    /* lib/board.mjs refuses a source where no row carries a quoted future, and
       that refusal is CORRECT here until a real quote is joined on. If this
       ever passes with a number in it, check where the number came from: cash
       minus basis would satisfy cash - basis = futures by construction and turn
       the one structural guard in this system into a tautology. */
    for (const r of parseBoard(read(f), "x")) {
      assert.equal(r.futuresPrice, null);
      assert.equal(r.futures, null);
      assert.notEqual(r.futuresPrice, r.impliedFuturesCents);
    }
  });

  test(`${f} agrees with itself across its locations`, () => {
    assert.equal(impliedSpread(parseBoard(read(f), "x")), null);
  });

  test(`${f} carries their own Last Update stamp`, () => {
    assert.match(boardStamp(read(f)) ?? "", /^\d\d:\d\d:\d\d [A-Z]{2,4}$/);
  });
}

test("309 rows over those seven boards, 29 location ids", () => {
  /* 29, not 24. I wrote 24 in a summary once by adding up the per-board counts
     wrong, and this test is what said so. A tally you computed is checked
     against the thing it is a tally of. */
  const all = Object.keys(BOARDS).flatMap((f) => parseBoard(read(f), f));
  assert.equal(all.length, 309);
  assert.equal(new Set(all.map((r) => `${r.source}␟${r.locationId}`)).size, 29);
  assert.equal(Object.values(BOARDS).reduce((a, b) => a + b.locs, 0), 29);
});

/* One row, read off the page by hand, asserted end to end. Everything else in
   this file counts things; this checks that the things being counted are right. */
test("Legacy Farmers, Apex Grain Marketing, Corn 09/01/2026", () => {
  const r = parseBoard(read("agricharts-legacyfarmers.html"), "u")[0];
  assert.equal(r.location, "Apex Grain Marketing");
  assert.equal(r.locationId, "85036");
  assert.equal(r.commodity, "Corn");
  assert.equal(r.delivery, "09/01/2026");
  assert.equal(r.cash, 5.28);
  assert.equal(r.basisCents, -15);
  assert.equal(r.basis, -0.15);
  assert.equal(r.impliedFuturesCents, 543);
  assert.equal(r.deliveryCode, "U26");     // the DELIVERY month, not the contract
  assert.equal(r.futuresChange, "-0-6");
});

/* ── the boards refuse rather than misread ───────────────────────────────── */

const ONE = read("agricharts-kellergrain.html");

test("a page with no cash board is refused, and says what it was", () => {
  assert.throws(() => parseBoard("<html><body>hello</body></html>"), AgriChartsRefused);
  assert.throws(() => parseBoard(read("agricharts-quotes-corn.html")),
    (e) => e instanceof AgriChartsRefused && /no cash board/.test(e.message)
           && /quote table/.test(e.message));
});

test("a renamed column refuses instead of reading the wrong cell", () => {
  const moved = ONE.replace("<td align=\"center\" width=\"20%\">Basis</td>",
                            "<td align=\"center\" width=\"20%\">Basis (cents)</td>");
  assert.notEqual(moved, ONE, "the mutation did not apply");
  assert.throws(() => parseBoard(moved),
    (e) => e instanceof AgriChartsRefused && /does not carry the columns/.test(e.message)
           && /Basis \(cents\)/.test(e.message));
});

test("a row with the wrong number of cells is a shape change, not a missing price", () => {
  const short = ONE.replace(/<td align="center" valign="top">[^<]*<\/td>\s*(?=<td align="right" valign="top" >)/, "");
  assert.notEqual(short, ONE, "the mutation did not apply");
  assert.throws(() => parseBoard(short),
    (e) => e instanceof AgriChartsRefused && /cell\(s\), not 5/.test(e.message));
});

/* A CENT OF ROUNDING IS NOT A DISAGREEMENT, and this is why the threshold is
 * not zero. Legacy Farmers' corn spanned 543 AND 544 in the 2026-09-02 23:11
 * capture, because Dec had settled at 543-4 and ten locations rounded the
 * half-cent both ways. The 00:37 capture in fixtures/ was taken during the
 * overnight session against a live 542-2 and spans nothing, so the case is
 * built rather than fished out of a file that has moved on. */
test("one cent of rounding across locations is allowed; nine is not", () => {
  const rows = parseBoard(read("agricharts-legacyfarmers.html"), "x");
  assert.equal(impliedSpread(rows), null, "the captured board must be clean to start with");

  const corn = rows.filter((r) => r.commodity === "Corn" && r.deliveryCode === "U26");
  assert.ok(corn.length >= 8, "this board should carry corn at many locations");

  const rounded = rows.map((r) => (r === corn[0]
    ? { ...r, impliedFuturesCents: r.impliedFuturesCents + 1 } : r));
  assert.equal(impliedSpread(rounded), null, "one cent is somebody's rounding");

  const broken = rows.map((r) => (r === corn[0]
    ? { ...r, impliedFuturesCents: r.impliedFuturesCents + 9 } : r));
  const s = impliedSpread(broken);
  assert.ok(s && s.spread >= 9, "nine cents is not");
  assert.equal(s.commodity, "Corn");
});

/* AND parseBoard HAS TO ACT ON IT. Testing impliedSpread() directly proves the
 * rule works; it does not prove the parser applies it. Deleting the call from
 * parseBoard left every other test in this file green, which is how a guard
 * ends up sitting in a file being run by nobody. */
const twoLocationBoard = (cashB) => `<html><body>
<table class="cashprices"><thead>
<tr class="section"><td colspan="5">Alpha</td></tr>
<tr><td>Commodity</td><td align="center">Delivery</td><td align="center">Basis</td>
<td align="right">Cash Price</td><td align="right">Futures Chg</td></tr>
</thead><tbody>
<tr class="odd"><td><a href="prices.php?commodity_filter=1">Corn</a></td>
<td align="center">09/01/2026</td><td align="center">-15</td>
<td align="right"><a href="/cash/chart.php?c=1&amp;l=11&amp;d=U26">$5.28</a></td>
<td align="right"><span class="chg_down">-0-6</span></td></tr>
</tbody></table>
<table class="cashprices"><thead>
<tr class="section"><td colspan="5">Beta</td></tr>
<tr><td>Commodity</td><td align="center">Delivery</td><td align="center">Basis</td>
<td align="right">Cash Price</td><td align="right">Futures Chg</td></tr>
</thead><tbody>
<tr class="odd"><td><a href="prices.php?commodity_filter=1">Corn</a></td>
<td align="center">09/01/2026</td><td align="center">-15</td>
<td align="right"><a href="/cash/chart.php?c=1&amp;l=22&amp;d=U26">${cashB}</a></td>
<td align="right"><span class="chg_down">-0-6</span></td></tr>
</tbody></table></body></html>`;

test("the synthetic board is read the same way as a real one", () => {
  const rows = parseBoard(twoLocationBoard("$5.28"), "x");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.locationId), ["11", "22"]);
  assert.deepEqual(rows.map((r) => r.impliedFuturesCents), [543, 543]);
  assert.deepEqual(rows.map((r) => r.location), ["Alpha", "Beta"]);
});

/* THE JUDGE MOVED OUT OF THE PARSER. parseBoard reads; extract() decides. That
 * separation cost two whole boards on the national sweep before it existed --
 * Balk Grain has one soybean group 6c wide out of dozens and Lang Farms carries
 * stale target rows dated 2023, and both were refused entirely by a rule
 * enforced one level too early and with no notion of a minority. */
test("parseBoard reads a disagreeing board; it does not judge it", () => {
  const rows = parseBoard(twoLocationBoard("$5.37"), "x");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.impliedFuturesCents), [543, 552]);
});

test("extract refuses when MOST groups disagree — that is a moved column", () => {
  assert.throws(() => extract(twoLocationBoard("$5.37"), "x", { contracts: CONTRACTS }),
    (e) => e instanceof AgriChartsRefused && /disagrees with itself on 1 of 1/.test(e.message));
});

test("and lets a cent of rounding through", () => {
  const rows = parseBoard(twoLocationBoard("$5.29"), "x");
  assert.deepEqual(rows.map((r) => r.impliedFuturesCents), [543, 544]);
});

/* ── the cells ───────────────────────────────────────────────────────────── */

test("cash", () => {
  assert.equal(parseCash("$5.29"), 5.29);
  assert.equal(parseCash(" $12.95 "), 12.95);
  assert.equal(parseCash("$1,102.50"), 1102.5);
  assert.equal(parseCash("--"), null);
  assert.equal(parseCash(""), null);
  assert.equal(parseCash("-15"), null);        // a basis cell in the cash column
});

test("basis is whole cents, signed", () => {
  assert.equal(parseBasisCents("-67"), -67);
  assert.equal(parseBasisCents("9"), 9);
  assert.equal(parseBasisCents("0"), 0);
  assert.equal(parseBasisCents("-67.5"), -67.5);
  assert.equal(parseBasisCents("-2-4"), null); // a futures-change cell in the basis column
  assert.equal(parseBasisCents("$5.29"), null);
  assert.equal(parseBasisCents(""), null);
});

test("a section heading is a commodity only when every row repeats it", () => {
  assert.equal(sectionIsCommodity("Corn", ["Corn", "Corn"]), true);
  assert.equal(sectionIsCommodity("Farmers Elevator", ["Corn", "Soybeans"]), false);
  assert.equal(sectionIsCommodity("Custar", ["Corn"]), false);
  assert.equal(sectionIsCommodity("Corn", []), false);
  assert.equal(sectionIsCommodity("", ["Corn"]), false);
});

/* ── the quotes ──────────────────────────────────────────────────────────── */

const QUOTES = {
  "agricharts-quotes-corn.html": 14,
  "agricharts-quotes-grains-overview.html": 18,
  "agricharts-quotes-oats.html": 11,
  "agricharts-quotes-rice.html": 7,
  "agricharts-quotes-soybeans.html": 18,
  "agricharts-quotes-wheat-chicago.html": 15,
  "agricharts-quotes-wheat-kc.html": 15,
  "agricharts-quotes-wheat-mpls.html": 7,
};

test("the eight captured quote pages are all still here", () => {
  assert.deepEqual(quotePages(), Object.keys(QUOTES).sort());
});

for (const [f, n] of Object.entries(QUOTES)) {
  test(`${f} carries ${n} contracts, each named by the page`, () => {
    const cs = parseQuotes(read(f));
    assert.equal(cs.length, n);
    for (const c of cs) {
      assert.match(c.symbol, /^[A-Z]{1,3}[FGHJKMNQUVXZ]\d{2}$/);
      assert.ok(c.year >= 2026 && c.year <= 2040, JSON.stringify(c));
    }
  });
}

test("eighths, the settle flag, and the bug that cost eleven hours", () => {
  assert.deepEqual(quoteToCents("542-2"), { cents: 542.25, flag: null, notation: "eighths" });
  // "513-6s" parsed as 513 on 2026-08-19 and froze the feed for eleven hours.
  assert.deepEqual(quoteToCents("513-6s"), { cents: 513.75, flag: "s", notation: "eighths" });
  assert.equal(quoteToCents("518-0").cents, 518);
  assert.equal(quoteToCents("-1-2").cents, -1.25);
});

test("a fraction that is not eighths refuses rather than guesses", () => {
  assert.equal(quoteToCents("542-9"), null);
  assert.equal(quoteToCents("542-"), null);
  assert.equal(quoteToCents("what"), null);
});

test("dollars convert to cents", () => {
  assert.equal(quoteToCents("7.8000").cents, 780);
  assert.equal(quoteToCents("15.235s").cents, 1523.5);
  assert.equal(quoteToCents("15.235s").flag, "s");
});

/* SOY MEAL IS DOLLARS PER SHORT TON AND SOY OIL IS CENTS PER POUND, and both
 * sit on the overview page beside the grains. Read as bushel prices they become
 * 33,950c and 7,050c: right shape, right sign, no correct use. The unit belongs
 * to the contract, not to the text of the cell, so the root decides. */
test("contracts this system does not price carry no price", () => {
  const cs = parseQuotes(read("agricharts-quotes-grains-overview.html"));
  const meal = cs.filter((c) => c.root === "ZM");
  const oil = cs.filter((c) => c.root === "ZL");
  assert.ok(meal.length && oil.length, "the overview should carry meal and oil");
  for (const c of [...meal, ...oil]) {
    assert.equal(c.priced, false);
    assert.equal(c.lastCents, null);
    assert.equal(c.unit, null);
    assert.ok(c.lastRaw, "the raw cell is kept, so nothing is lost");
  }
});

test("rice is per hundredweight and says so", () => {
  const cs = parseQuotes(read("agricharts-quotes-rice.html"));
  assert.ok(cs.every((c) => c.priced && c.unit === "hundredweight"));
  assert.equal(GRAIN_ROOTS.ZR.unit, "hundredweight");
  assert.ok(Object.values(GRAIN_ROOTS).filter((g) => g.unit === "bushel").length >= 6);
});

test("the settled flag survives the parse", () => {
  const cs = parseQuotes(read("agricharts-quotes-wheat-chicago.html"));
  assert.ok(cs.some((c) => c.settled), "the front month had settled when this was captured");
  assert.ok(cs.some((c) => !c.settled), "and the deferred ones had not");
});

test("a page with no quote table is refused", () => {
  assert.throws(() => parseQuotes(read("agricharts-kellergrain.html")),
    (e) => e instanceof AgriChartsRefused && /no futures quote table/.test(e.message));
});

test("a quote table with no column we read is refused", () => {
  const src = read("agricharts-quotes-corn.html");
  const bent = src.replace('<th class="quotefield_last">Last</th>', "<th>Last</th>");
  assert.notEqual(bent, src, "the mutation did not apply");
  assert.throws(() => parseQuotes(bent),
    (e) => e instanceof AgriChartsRefused && /no "last" column/.test(e.message));
});

/* ── the two pages, checked against each other ───────────────────────────── */

const CONTRACTS = mergeQuotes(quotePages().map(read));

test("87 distinct priced contracts across the eight pages", () => {
  assert.equal(CONTRACTS.filter((c) => c.priced).length, 87);
});

test("every row of the seven original boards sits on a real quoted contract", () => {
  for (const f of Object.keys(BOARDS)) {
    const rows = parseBoard(read(f), f);
    const fit = fitToContracts(rows, CONTRACTS);
    assert.ok(fit.ok, `${f}: ${fit.why}`);
    assert.equal(fit.checked, rows.length, `${f} left rows unchecked: ${JSON.stringify(fit.unquoted)}`);
  }
});

/* AND EVERY BOARD THE NATIONAL SWEEP BROUGHT BACK EITHER READS OR SAYS WHY.
 * These are 23 real boards from 23 different co-ops, and they are the only
 * defence against a parser tuned to seven. Two of them refuse, both for the
 * same honest reason, and that is asserted rather than tolerated. */
const CASH_ONLY = ["agricharts-butterfieldgrain.html", "agricharts-westco.html"];
test("every captured board reads, except the two that publish no basis at all", () => {
  const refused = [];
  let rows = 0, locations = 0, unreconciled = 0;
  for (const f of boards()) {
    try {
      const r = extract(read(f), f, { contracts: CONTRACTS });
      rows += r.length;
      locations += new Set(r.map((x) => x.locationId)).size;
      unreconciled += r.unreconciled.length;
    } catch (e) { refused.push([f, e.message]); }
  }
  assert.deepEqual(refused.map((x) => x[0]).sort(), CASH_ONLY.sort(),
    `unexpected refusals: ${refused.map((x) => `${x[0]}: ${x[1].slice(0, 120)}`).join(" | ")}`);
  for (const [, why] of refused) assert.match(why, /cash-only board/);
  assert.ok(rows > 1900, `only ${rows} rows across the captures`);
  assert.ok(locations > 100, `only ${locations} locations across the captures`);
  /* A handful of refused rows is the doctrine working. Hundreds would mean it
     had become a way of not noticing. */
  assert.ok(unreconciled < rows / 100, `${unreconciled} refused rows out of ${rows}`);
});

/* THE BOARD THAT MADE THE LOCATION SELECTOR NECESSARY. Farmers Cooperative
 * Dorchester: 1,096 rows over 49 locations, every table headed "CORN", and not
 * one location named anywhere in the tables. */
test("Dorchester's 49 locations are all named, from the page's own filter", () => {
  const html = read("agricharts-farmersco-operative.html");
  const rows = extract(html, "u", { contracts: CONTRACTS });
  assert.equal(rows.length, 1096);
  const ids = new Set(rows.map((r) => r.locationId));
  assert.equal(ids.size, 49);
  assert.equal(rows.filter((r) => r.location).length, 1096, "every row must carry a place name");
  const names = locationNames(html);
  assert.equal(names.get("28468"), "BEATRICE");
  assert.equal(names.get("4573"), "DORCHESTER");
  for (const id of ids) assert.ok(names.has(id), `no name for location ${id}`);
});

/* "ALL LOCATIONS" IS NOT A LOCATION. Some boards give it an empty value and
   some give it 0; the second would file every unmatched row under a town called
   "All Locations" and nobody would ever look at it twice. */
test("an All Locations option numbered zero is still not a place", () => {
  const n = locationNames(`<select name="location_filter">
    <option value="0">All Locations</option><option value="12">BEATRICE</option></select>`);
  assert.equal(n.size, 1);
  assert.equal(n.get("12"), "BEATRICE");
  assert.equal(n.get("0"), undefined);
});

/* AND IF THE TWO SOURCES OF A NAME DISAGREE, NEITHER IS TRUSTED. They agreed at
   all 47 places both existed across the captures. The day one stops, guessing
   which is right puts one town's name on another town's price. */
test("a heading that contradicts the selector refuses the board", () => {
  const board = twoLocationBoard("$5.28").replace("<body>",
    `<body><select name="location_filter"><option value="11">Alpha</option>`
    + `<option value="22">SOMEWHERE ELSE</option></select>`);
  assert.throws(() => parseBoard(board, "x"),
    (e) => e instanceof AgriChartsRefused && /disagree about location 22/.test(e.message)
           && /Beta/.test(e.message) && /SOMEWHERE ELSE/.test(e.message));
});

/* A ZERO IS NOT A BID. Westco posts $0.00 against Pinto Beans and Great
   Northern Beans — they are not buying those today, and a farmer reading a
   published 0.00 reads "we pay nothing". */
test("a $0.00 row is refused and the rest of the board publishes", () => {
  const board = twoLocationBoard("$0.00");
  const rows = extract(board, "u", { contracts: CONTRACTS });
  assert.equal(rows.length, 1, "the priced row survives");
  assert.equal(rows[0].cash, 5.28);
  assert.equal(rows.unreconciled.length, 1);
  assert.match(rows.unreconciled[0].why, /\$0\.00, which is not a bid/);
});

test("the selector is read past the All Locations option and the images around it", () => {
  assert.equal(locationNames("<html></html>").size, 0);
  const sel = `<select name="location_filter"><option value=''>All Locations</option>
    <option  value="12">BEATRICE</option><option value="13">Blue &amp; Rapids</option></select>`;
  const n = locationNames(sel);
  assert.equal(n.size, 2);
  assert.equal(n.get("12"), "BEATRICE");
  assert.equal(n.get("13"), "Blue & Rapids");
});

/* THE NEGATIVE CONTROL, which is the only reason the check above means
 * anything. Read the basis in dollars instead of cents — a units error, the
 * exact failure this guard exists for — and every row moves about ten cents. */
test("a basis read in the wrong units is caught", () => {
  const rows = parseBoard(read("agricharts-legacyfarmers.html"), "x")
    .map((r) => ({ ...r, impliedFuturesCents: Number((r.cash * 100 - r.basis).toFixed(4)) }));
  const fit = fitToContracts(rows, CONTRACTS);
  assert.equal(fit.ok, false);
  assert.match(fit.why, /wrong units/);
});

test("a sign flip on the basis is caught", () => {
  const rows = parseBoard(read("agricharts-wheatfieldgrain.html"), "x")
    .map((r) => ({ ...r, impliedFuturesCents: r.cash * 100 + r.basisCents }));
  assert.equal(fitToContracts(rows, CONTRACTS).ok, false);
});

test("the threshold is tight enough to matter and loose enough to hold", () => {
  // Measured max on a healthy board is 1.5c; a units error lands about 10c out.
  assert.ok(MAX_FIT_CENTS > 1.5 && MAX_FIT_CENTS < 10,
    `MAX_FIT_CENTS is ${MAX_FIT_CENTS}; healthy is <=1.5c and a units error is ~10c`);
});

test("with no contracts to check against, the check reports that rather than passing", () => {
  const rows = parseBoard(ONE, "x");
  const fit = fitToContracts(rows, []);
  assert.equal(fit.ok, false);
  assert.match(fit.why, /no priced contract/);
});

/* ── extract(), which is the only thing that stamps a row ────────────────── */

/* THE STAMP IS THE WHOLE PERMISSION SLIP. lib/board.mjs lets an AgriCharts
 * source publish because every row carries `verifiedBy`, and extract() is the
 * one place that applies it — after BOTH checks have passed on the whole board.
 * Testing the checks as functions does not test that extract runs them: taking
 * fitToContracts out of extract left every other test in this file green. */
test("extract stamps every row once the two checks have passed", () => {
  const rows = extract(read("agricharts-kokomograin.html"), "u", { contracts: CONTRACTS });
  assert.equal(rows.length, 74);
  assert.ok(rows.every((r) => r.verifiedBy === VERIFIED_BY));
});

test("extract refuses, and stamps nothing, when the rows do not fit the quotes", () => {
  // Every contract fifty cents from where it really is: the same shape a
  // misread column produces, and nothing may carry a stamp through it.
  const wrong = CONTRACTS.map((c) => (c.priced ? { ...c, lastCents: c.lastCents + 50 } : c));
  assert.throws(() => extract(read("agricharts-kokomograin.html"), "u", { contracts: wrong }),
    (e) => e instanceof AgriChartsRefused && /nearest quoted/.test(e.message));
});

test("extract refuses without quotes rather than publishing unchecked", () => {
  assert.throws(() => extract(read("agricharts-kokomograin.html"), "u", null),
    (e) => e instanceof AgriChartsRefused && /no futures quotes were supplied/.test(e.message));
  assert.throws(() => extract(read("agricharts-kokomograin.html"), "u", { contracts: [] }),
    (e) => e instanceof AgriChartsRefused && /no futures quotes were supplied/.test(e.message));
});

/* A COMMODITY WITH NO QUOTED BOARD IS NOT A ROW TO DROP QUIETLY. It is a row
 * whose columns nothing proved, sitting in a file beside rows that were
 * checked — which is the exact hole the whole design closes. */
test("a board of nothing but uncheckable commodities publishes nothing", () => {
  const board = twoLocationBoard("$5.28").replace(/>Corn</g, ">Sunflowers<");
  assert.throws(() => extract(board, "u", { contracts: CONTRACTS }),
    (e) => e instanceof AgriChartsRefused && /not one of 2 row\(s\) survived/.test(e.message)
           && /no futures contract is quoted/.test(e.message));
});

/* A CO-OP THAT NEVER WRITES THE WORD "WHEAT". Horse Heaven Grain's board says
 * DNS and HRW and nothing else, and that refused all ten of its rows. */
test("wheat classes are found even when the word wheat is absent", () => {
  for (const n of ["DNS", "HRW", "HRS 14%", "SRW", "SWW"]) {
    const got = rootsFor(n);
    assert.ok(got, `${n} found no contract`);
    assert.ok(got.includes("ZW") && got.includes("KE") && got.includes("MW"),
      `${n} was narrowed to ${JSON.stringify(got)} — a co-op hedges where it likes`);
  }
});

/* AND WHY THEY ARE NOT NARROWED. Cornerstone Ag posts WHITE WHEAT implying
 * 834c, and 834-0 is KEZ26 — they price white wheat off KANSAS CITY. Narrowed
 * to Chicago, that row missed by 33 cents and was refused for being right. */
test("a class is a hint about the grain, never a claim about the exchange", () => {
  const rows = extract(read("agricharts-cornerstone-ag.html"), "u", { contracts: CONTRACTS });
  assert.equal(rows.length, 10);
  assert.equal(rows.unreconciled.length, 0);
  assert.ok(rows.some((r) => /white wheat/i.test(r.commodity)));
});

/* ONE BAD LINE MUST NOT COST THE BOARD, and it must not vanish either.
 * dtn-cs learned this on 2026-08-20: "one bad Oats line cannot cost ten towns
 * of corn." The row is refused, not published, and travels out on
 * `unreconciled` where poll.mjs prints it every pass. */
test("an uncheckable row is refused; the rest of the board still publishes", () => {
  const mixed = twoLocationBoard("$5.28").replace(/>Corn</, ">Sunflowers<");
  const rows = extract(mixed, "u", { contracts: CONTRACTS });
  assert.equal(rows.length, 1, "the corn row survives");
  assert.equal(rows[0].commodity, "Corn");
  assert.equal(rows[0].verifiedBy, VERIFIED_BY);
  assert.equal(rows.unreconciled.length, 1);
  assert.match(rows.unreconciled[0].commodity, /Sunflowers/);
  assert.match(rows.unreconciled[0].why, /no futures contract is quoted/);
  assert.equal(Object.keys(rows).length, 1, "unreconciled must not enumerate as a bid");
});

/* THE STRINGS THAT COST THREE BOARDS ON THE NATIONAL SWEEP. Every one of these
 * is a co-op's own name for a grain whose futures we already fetch, and an
 * exact-match lookup on the whole cell called all of them unquoted. */
test("a co-op's own name for a grain still finds its contract", () => {
  for (const [name, root] of [
    ["CORN - CASH", "ZC"], ["Corn - Off Farm", "ZC"], ["BEANS - Elevator", "ZS"],
    ["Beans - Off Farm", "ZS"], ["Hard Red Winter Wheat", "ZW"], ["Spring Wheat", "ZW"],
    ["WHITE WHEAT", "ZW"], ["NGMO Waxy", "ZC"], ["Grain Sorghum", "ZC"],
  ]) {
    const got = rootsFor(name);
    assert.ok(got, `${name} found no contract`);
    assert.ok(got.includes(root), `${name} -> ${JSON.stringify(got)}, expected to include ${root}`);
  }
  assert.equal(rootsFor("Sunflowers"), null);
  assert.equal(rootsFor(""), null);
});

/* A TABLE WITH NO SECTION ROW IS NOT A TABLE WITH NO COLUMNS. Six boards on the
 * national sweep refused with `found []` because the header was located by
 * counting from a section row that was not there. */
test("a board with no section heading is read, not refused", () => {
  const flat = twoLocationBoard("$5.28").replace(/<tr class="section">[\s\S]*?<\/tr>/g, "");
  const rows = extract(flat, "u", { contracts: CONTRACTS });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.locationId), ["11", "22"]);
  assert.deepEqual(rows.map((r) => r.location), [null, null], "no heading means no location name");
});

test("a board whose columns really have moved still refuses, showing what it saw", () => {
  const moved = twoLocationBoard("$5.28").replace(/<td align="center">Basis<\/td>/g,
                                                  '<td align="center">Basis (cents)</td>');
  assert.throws(() => extract(moved, "u", { contracts: CONTRACTS }),
    (e) => e instanceof AgriChartsRefused && /does not carry the columns/.test(e.message)
           && /Basis \(cents\)/.test(e.message));
});

test("the quote pages are named once, beside the parser that reads them", () => {
  assert.equal(quoteUrls().length, 7);
  assert.equal(new Set(quoteUrls().map((u) => new URL(u).host)).size, 1);
  assert.equal(mergeQuotes([read("agricharts-quotes-corn.html"),
                            read("agricharts-quotes-corn.html")]).length, 14,
    "the same page twice is still fourteen contracts");
});

test("describe says enough to diagnose without a second run", () => {
  assert.match(describe(read("agricharts-kellergrain.html")), /cash table\(s\)/);
  assert.match(describe(read("agricharts-quotes-corn.html")), /quote table\(s\)/);
  assert.match(describe(""), /^0 bytes$/);
  assert.equal(COLUMNS.length, 5);
});

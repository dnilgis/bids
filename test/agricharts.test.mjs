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

test("the seven captured boards are all still here", () => {
  assert.deepEqual(boards(), Object.keys(BOARDS).sort());
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

test("309 rows over the seven boards, 29 location ids", () => {
  /* 29, not 24. I wrote 24 in a summary once by adding up the per-board counts
     wrong, and this test is what said so. A tally you computed is checked
     against the thing it is a tally of. */
  const all = boards().flatMap((f) => parseBoard(read(f), f));
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

test("parseBoard REFUSES a board whose locations disagree", () => {
  assert.throws(() => parseBoard(twoLocationBoard("$5.37"), "x"),
    (e) => e instanceof AgriChartsRefused && /disagrees with itself/.test(e.message)
           && /Corn U26/.test(e.message) && /9c/.test(e.message));
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

const CONTRACTS = quotePages().flatMap((f) => parseQuotes(read(f)))
  .filter((c, i, a) => a.findIndex((x) => x.symbol === c.symbol) === i);

test("87 distinct priced contracts across the eight pages", () => {
  assert.equal(CONTRACTS.filter((c) => c.priced).length, 87);
});

test("every row of every board sits on a real quoted contract", () => {
  for (const f of boards()) {
    const rows = parseBoard(read(f), f);
    const fit = fitToContracts(rows, CONTRACTS);
    assert.ok(fit.ok, `${f}: ${fit.why}`);
    assert.equal(fit.checked, rows.length, `${f} left rows unchecked: ${JSON.stringify(fit.unquoted)}`);
  }
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

test("describe says enough to diagnose without a second run", () => {
  assert.match(describe(read("agricharts-kellergrain.html")), /cash table\(s\)/);
  assert.match(describe(read("agricharts-quotes-corn.html")), /quote table\(s\)/);
  assert.match(describe(""), /^0 bytes$/);
  assert.equal(COLUMNS.length, 5);
});

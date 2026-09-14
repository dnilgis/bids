/*
 * HEARTLAND CO-OP'S CLOSING BOARD.
 *
 * One page, four tables, 129 body rows, five delivery columns each. The
 * delivery periods are COLUMN HEADINGS and the locations are rows, which is a
 * shape no other adapter in this repository reads.
 *
 * The fixture is the whole response body probe.mjs brought back on 2026-09-14
 * (run 94223494234): 50,890 bytes, 200, text/html, Apache. Nothing in it was
 * edited. The mutations below are applied to a copy of it, in the test, so
 * what is being asserted is always "this real board, broken this one way".
 *
 *     node --test test/heartland.test.mjs
 *
 * No network. Every number below came off that capture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extract, parseTables, parseCell, contractOf, deliveryLabel, boardDate,
         describe as describeBoard, BOARD_ROOTS, MAX_DRIFT_CENTS,
         VERIFIED_BY, HeartlandRefused } from "../lib/adapters/heartland.mjs";
import { ADAPTERS, SHARED_PAGES, adapterFor } from "../lib/adapters/index.mjs";
import { PLATFORMS, wireOf, transportOf, loadSources, toConfig } from "../lib/sources.mjs";
import { buildFile } from "../lib/board.mjs";
import { quoteUrls } from "../lib/adapters/agricharts.mjs";
import { readdirSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOARD = readFileSync(`${ROOT}test/fixtures/heartland-bids-2026-09-11.html`, "utf8");
const URL_ = "https://myaccount.heartlandcoop.com/bids.htm";

/* THE QUOTES THE BOARD ITSELF IMPLIES. Not invented: every one of these is the
   number every cell in that column works out to, printed by the capture. The
   fixture is a settlement board, so pinning the quotes at its own implied
   values is the only way to test the drift rule at a known distance. */
const IMPLIED = { ZCZ26: 530, ZCH27: 545, ZCZ27: 532,
                  ZSX26: 1296, ZSF27: 1312, ZSH27: 1318, ZSX27: 1255 };

const quotes = (over = {}) => ({
  contracts: Object.entries({ ...IMPLIED, ...over }).map(([symbol, lastCents]) => ({
    symbol, lastCents, priced: true, root: symbol.slice(0, 2), grain: symbol.slice(0, 2),
    at: "2026-09-11T18:20:00Z",
  })),
});

const refusal = (fn) => {
  try { fn(); } catch (e) { return e; }
  return null;
};

/* ── the page, as it came back ──────────────────────────────────────────── */

test("the capture is four tables, 129 body rows, five delivery columns each", () => {
  const t = parseTables(BOARD);
  assert.equal(t.length, 4);
  assert.deepEqual(t.map((x) => x.commodity),
    ["CORN", "PROCESSOR CORN", "SOYBEANS", "PROCESSOR SOYBEANS"]);
  assert.deepEqual(t.map((x) => x.rows.length), [54, 14, 53, 8]);
  assert.equal(t.reduce((n, x) => n + x.rows.length, 0), 129);
  for (const x of t) assert.equal(x.columns.length, 5);
});

test("the board carries its own settlement date", () => {
  assert.equal(boardDate(BOARD), "2026-09-11");
  assert.equal(boardDate('<div class="header">X <span>091126</span></div>'), "2026-09-11");
  assert.equal(boardDate("<p>no header</p>"), null);
  /* A month of 13 is not a date, and a date nobody checked is worse than none. */
  assert.equal(boardDate('<div class="header">X <span>131126</span></div>'), null);
});

test("twenty cells on this board are empty, and they are an operator not bidding", () => {
  const t = parseTables(BOARD);
  let empty = 0, priced = 0;
  for (const x of t) for (const r of x.rows) for (const c of r.cells) {
    const p = parseCell(c);
    if (p.empty) empty++; else if (p.cash != null) priced++; else assert.fail(p.bad);
  }
  assert.equal(empty, 20);
  assert.equal(priced, 625);
  assert.equal(empty + priced, 129 * 5);
});

test("a cell is two spans, cash then basis, and nothing else parses", () => {
  assert.deepEqual(parseCell("<td></td>".replace(/<\/?td>/g, "")), { empty: true });
  assert.deepEqual(parseCell("<span>4.81</span><span>-0.49</span>"), { cash: 4.81, basis: -0.49 });
  assert.ok(parseCell("<span>4.81</span>").bad);
  assert.ok(parseCell("<span>4.81</span><span>-0.49</span><span>1</span>").bad);
  assert.ok(parseCell("<span>call</span><span>-0.49</span>").bad);
});

/* ── what the headings mean ─────────────────────────────────────────────── */

test("a column heading names the contract, and only roots this board has printed map", () => {
  assert.deepEqual(contractOf("CZ26"),
    { boardRoot: "C", root: "ZC", month: 12, year: 2026, symbol: "ZCZ26" });
  assert.deepEqual(contractOf("SF27"),
    { boardRoot: "S", root: "ZS", month: 1, year: 2027, symbol: "ZSF27" });
  /* I is not a month letter anywhere on any exchange. */
  assert.equal(contractOf("CI26"), null);
  /* W is wheat and this board has never printed it. A guessed mapping feeding
     a check is the failure BOARD_ROOTS exists to refuse. */
  assert.equal(contractOf("WZ26"), null);
  assert.deepEqual(Object.keys(BOARD_ROOTS), ["C", "S"]);
});

test("the delivery label is the page's own, and lib/delivery.mjs reads all three shapes", () => {
  assert.equal(deliveryLabel("20260901", "20260930"), "Sep 26");
  assert.equal(deliveryLabel("20261001", "20261130"), "Oct-Nov 26");
  assert.equal(deliveryLabel("20270101", "20270131"), "Jan 27");
  /* The soybean spot column is a nine-day window inside one month. */
  assert.equal(deliveryLabel("20260910", "20260918"), "Sep 26");
  assert.equal(deliveryLabel("20261201", "20270131"), "Dec 26-Jan 27");
  assert.equal(deliveryLabel("", "20270131"), null);
});

test("TWO DELIVERY PERIODS PRICE OFF ONE CONTRACT, so the month code cannot be the delivery", () => {
  const rows = extract(BOARD, URL_, quotes());
  const corn = rows.filter((r) => r.commodity === "CORN" && r.futures === "ZCZ26");
  assert.deepEqual([...new Set(corn.map((r) => r.delivery))].sort(), ["Oct-Nov 26", "Sep 26"]);
});

/* ── the whole board ────────────────────────────────────────────────────── */

test("the real capture reads: 625 rows, 74 locations, every one stamped", () => {
  const rows = extract(BOARD, URL_, quotes());
  assert.equal(rows.length, 625);
  assert.equal(new Set(rows.map((r) => r.locationId)).size, 74);
  assert.ok(rows.every((r) => r.verifiedBy === VERIFIED_BY));
  /* NO FUTURES PRICE IS PUBLISHED FROM HERE. Filling it from our own
     subtraction would make cash - basis = futures a tautology and switch
     lib/board.mjs's structural guard off with every signal green. */
  assert.ok(rows.every((r) => r.futuresPrice === null));
  assert.ok(rows.every((r) => Number.isInteger(r.impliedFuturesCents)));
  assert.ok(rows.every((r) => r.boardDate === "2026-09-11"));
});

test("ALLEMAN's first corn row is the number on the page", () => {
  const rows = extract(BOARD, URL_, quotes());
  const r = rows.find((x) => x.locationId === "ALLEMAN" && x.commodity === "CORN"
                          && x.delivery === "Sep 26");
  assert.equal(r.cash, 4.81);
  assert.equal(r.basis, -0.49);
  assert.equal(r.basisCents, -49);
  assert.equal(r.futures, "ZCZ26");
  assert.equal(r.impliedFuturesCents, 530);
  assert.equal(r.unit, "bushel");
});

test("EVERY CELL IN A COLUMN IMPLIES THE SAME PRICE -- that is what proves the read", () => {
  const rows = extract(BOARD, URL_, quotes());
  const byCol = new Map();
  for (const r of rows) {
    const k = `${r.commodity}|${r.delivery}`;
    if (!byCol.has(k)) byCol.set(k, new Set());
    byCol.get(k).add(r.impliedFuturesCents);
  }
  for (const [k, v] of byCol) assert.equal(v.size, 1, `${k} implies ${[...v].join(", ")}`);
  const corn = [...byCol].filter(([k]) => k.startsWith("CORN|"));
  assert.deepEqual(new Map(corn.map(([k, v]) => [k, [...v][0]])), new Map([
    ["CORN|Sep 26", 530], ["CORN|Oct-Nov 26", 530], ["CORN|Jan 27", 545],
    ["CORN|Mar 27", 545], ["CORN|Oct-Nov 27", 532],
  ]));
});

/* ── the mutations: each one breaks the real board in one way ───────────── */

test("A ROW THAT LOSES A CELL REFUSES THE TABLE, because the rest would slide", () => {
  /* WEVER posts corn in columns 1, 2 and 5 and nothing in 3 and 4. Drop one of
     its empty cells and its fifth-column price becomes its fourth-column one:
     an Oct-Nov 27 bid published as Mar 27. Nothing about the numbers looks
     wrong afterwards, which is why this is checked on shape and not on value. */
  const broken = BOARD.replace(
    '<td class="dest-name">WEVER</td><td class="basis-num"><span>4.85</span><span>-0.45</span></td><td class="basis-num"><span>4.85</span><span>-0.45</span></td><td></td><td></td>',
    '<td class="dest-name">WEVER</td><td class="basis-num"><span>4.85</span><span>-0.45</span></td><td class="basis-num"><span>4.85</span><span>-0.45</span></td><td></td>');
  assert.notEqual(broken, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(broken, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /header has 6 column\(s\) and the row for "WEVER" has 5/);
});

test("ONE CELL OUT OF STEP REFUSES THE BOARD", () => {
  /* ALLEMAN's Sep 26 corn basis, moved one cent. The cash column is untouched,
     so the row still reads like a bid -- and its implied future is now 531
     against 530 for the other 106 cells in that column. */
  const broken = BOARD.replace(
    '<td class="dest-name">ALLEMAN</td><td class="basis-num"><span>4.81</span><span>-0.49</span></td>',
    '<td class="dest-name">ALLEMAN</td><td class="basis-num"><span>4.81</span><span>-0.50</span></td>');
  assert.notEqual(broken, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(broken, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /imply 2 different futures prices/);
  assert.match(e.message, /ALLEMAN 4\.81\/-0\.5 implies 531c/);
});

test("THE PAIR READ THE WRONG WAY ROUND REFUSES THE BOARD", () => {
  /* This is the mutation the column check cannot see: swap cash and basis
     everywhere and every cell in a column still agrees with every other. Only
     the quote says it is wrong -- -530 against 530 is 1,060 cents. */
  const swapped = BOARD.replace(
    /<td class="basis-num"><span>(-?[\d.]+)<\/span><span>(-?[\d.]+)<\/span><\/td>/g,
    '<td class="basis-num"><span>$2</span><span>$1</span></td>');
  assert.notEqual(swapped, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(swapped, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /past the 300c this board is allowed to drift/);
});

test("A CORN TABLE HEADED WITH A SOYBEAN CONTRACT REFUSES THE BOARD", () => {
  const broken = BOARD.replace("</span> / CZ26</th>", "</span> / SZ26</th>");
  assert.notEqual(broken, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(broken, URL_, quotes({ ZSZ26: 1290 })));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /"CORN" table \(ZC\) is headed "SZ26", which is ZS/);
});

test("A COLUMN WITH NO CONTRACT IN ITS HEADING REFUSES THE BOARD", () => {
  const broken = BOARD.replace("</span> / CZ26</th>", "</span></th>");
  assert.notEqual(broken, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(broken, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /names no contract/);
});

test("A COLUMN WITH NO DELIVERY WINDOW REFUSES THE BOARD", () => {
  const broken = BOARD.replace('data-start="20260901" data-end="20260930"', "");
  assert.notEqual(broken, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(broken, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /carries no readable delivery window/);
});

test("A CONTRACT OUR QUOTE PAGES DO NOT PRICE REFUSES THE BOARD", () => {
  const short = quotes();
  short.contracts = short.contracts.filter((c) => c.symbol !== "ZCZ27");
  const e = refusal(() => extract(BOARD, URL_, short));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /ZCZ27.*do not price it/s);
});

test("NO QUOTES AT ALL REFUSES THE BOARD RATHER THAN PUBLISHING UNCHECKED", () => {
  for (const shared of [null, undefined, {}, { contracts: [] }]) {
    const e = refusal(() => extract(BOARD, URL_, shared));
    assert.ok(e instanceof HeartlandRefused, `expected a refusal for ${JSON.stringify(shared)}`);
    assert.match(e.message, /no futures quotes were supplied/);
  }
});

test("A PAGE THAT IS NOT THIS BOARD REFUSES, and says what it saw", () => {
  const e = refusal(() => extract("<html><body><p>maintenance</p></body></html>", URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused);
  assert.match(e.message, /not the Heartland board/);
});

test("A BOARD SERVED WITH EVERY CELL EMPTY REFUSES", () => {
  const blank = BOARD.replace(
    /<td class="basis-num">.*?<\/td>/g, "<td></td>");
  const e = refusal(() => extract(blank, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /not one carried a price/);
});

test("A CELL THAT IS NOT TWO NUMBERS REFUSES THE BOARD, AND NAMES THE CELL", () => {
  /* Boards print "Call" and "--" when an operator wants a phone call instead
     of a posted bid. Coercing one of those to a number publishes a free
     bushel; letting it through as NaN refuses the board with a message about
     the column rather than about the cell. */
  const broken = BOARD.replace(
    '<td class="dest-name">TRAER</td><td class="basis-num"><span>4.81</span><span>-0.49</span></td>',
    '<td class="dest-name">TRAER</td><td class="basis-num"><span>Call</span><span>-0.49</span></td>');
  assert.notEqual(broken, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(broken, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /TRAER \/ "CORN" \/ Sep 26: \["Call","-0\.49"\] is not two numbers/);
});

test("A 0.00 CELL REFUSES ITS COLUMN -- this board says \"not buying\" with an empty <td>", () => {
  /* There is no "a zero is not a bid" rule in this adapter, because a zero
     cannot get past the column check to need one: 0.00 against a -0.49 basis
     implies 49c where the 106 cells beside it imply 530. Asserted here so that
     the missing rule stays a measured decision and not an oversight. */
  const broken = BOARD.replace(
    '<td class="dest-name">VICTOR</td><td class="basis-num"><span>4.81</span><span>-0.49</span></td>',
    '<td class="dest-name">VICTOR</td><td class="basis-num"><span>0.00</span><span>-0.49</span></td>');
  assert.notEqual(broken, BOARD, "the mutation did not apply; the fixture has changed");
  const e = refusal(() => extract(broken, URL_, quotes()));
  assert.ok(e instanceof HeartlandRefused, `expected a refusal, got ${e}`);
  assert.match(e.message, /VICTOR 0\/-0\.49 implies 49c/);
  /* And the twenty cells the board really does leave blank are still dropped
     silently, which is the difference this test exists to hold. */
  assert.equal(extract(BOARD, URL_, quotes()).length, 625);
});

test("THE DRIFT CEILING IS A CEILING: 300 passes, 301 refuses", () => {
  const at = (off) => refusal(() => extract(BOARD, URL_,
    quotes({ ZCZ26: 530 - off })));
  assert.equal(at(MAX_DRIFT_CENTS), null);
  const e = at(MAX_DRIFT_CENTS + 1);
  assert.ok(e instanceof HeartlandRefused, "301c away must refuse");
  assert.match(e.message, /301\.00c away/);
});

test("driftCents is carried on every row, so the ceiling gets measured", () => {
  const rows = extract(BOARD, URL_, quotes({ ZCZ26: 525 }));
  const corn = rows.filter((r) => r.futures === "ZCZ26");
  assert.ok(corn.length);
  assert.ok(corn.every((r) => r.driftCents === 5));
  assert.ok(rows.filter((r) => r.futures === "ZSX26").every((r) => r.driftCents === 0));
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

test("the platform is declared everywhere a platform has to be declared", () => {
  assert.ok(PLATFORMS.includes("heartland"), "a platform missing from PLATFORMS is DROPPED at load");
  assert.equal(wireOf("heartland"), "html");
  assert.equal(transportOf("heartland"), "fetch");
  assert.equal(typeof ADAPTERS.heartland, "function");
});

test("it shares the CBOT quote pages AgriCharts already fetches, not a second set", () => {
  assert.deepEqual(SHARED_PAGES.heartland.urls, quoteUrls());
  assert.deepEqual(SHARED_PAGES.heartland.urls, SHARED_PAGES.agricharts.urls);
  const bound = adapterFor("heartland", quotes());
  assert.equal(bound(BOARD, URL_).length, 625);
});

/* ── the manifests ──────────────────────────────────────────────────────── */

const HEARTLAND = readdirSync(`${ROOT}sources`)
  .filter((f) => f.startsWith("heartlandcoop-"))
  .map((f) => JSON.parse(readFileSync(`${ROOT}sources/${f}`, "utf8")));

test("54 manifests, one per location on the board's own two tables", () => {
  assert.equal(HEARTLAND.length, 54);
  const { sources, errors } = loadSources(HEARTLAND);
  assert.deepEqual(errors, []);
  assert.equal(sources.length, 54);
});

test("EVERY MANIFEST'S locationId IS A LABEL THE BOARD ACTUALLY CARRIES", () => {
  /* filterLocation compares by exact string equality with no trim and no case
     fold. A locationId that is one space or one capital off matches zero rows
     and the source refuses at six in the morning for a reason nobody can see
     from the manifest. */
  const onBoard = new Set(extract(BOARD, URL_, quotes()).map((r) => r.locationId));
  for (const s of HEARTLAND)
    assert.ok(onBoard.has(s.locationId), `${s.id}: "${s.locationId}" is not on the board`);
});

test("THE PROCESSOR TABLES ARE NOT CLAIMED AS HEARTLAND FACILITIES", () => {
  /* The board posts delivered-to-processor bids -- ADM, Cargill, POET, AGP.
     Those are somebody else's plants. Filing them under this operator would
     invent 20 Heartland elevators and collide with the real operators' own
     places in the merged feed. They are parsed, checked and then dropped by
     filterLocation, which is the honest place to drop them. */
  const claimed = new Set(HEARTLAND.map((s) => s.locationId));
  for (const name of ["ADM", "CARGILL - BLAIR", "POET - JEWELL", "AGP - MANNING",
                      "SHELL ROCK SOY PROCESSING", "VERBIO"])
    assert.ok(!claimed.has(name), `${name} is somebody else's plant`);
});

test("every manifest declares the alternative the adapter actually stamps", () => {
  for (const s of HEARTLAND) {
    assert.equal(s.identityAlternative, VERIFIED_BY, s.id);
    assert.equal(s.platform, "heartland", s.id);
    assert.equal(s.url, URL_, s.id);
    assert.equal(s.operator, "Heartland Co-op", s.id);
  }
});

test("48 of the 54 replace a row of the Barchart roster in this repository", () => {
  const roster = new Set(JSON.parse(readFileSync(`${ROOT}data/known-elevators.json`, "utf8"))
    .elevators.filter((e) => e.facility === "Heartland Coop").map((e) => e.branch));
  assert.equal(roster.size, 48);
  const ours = new Set(HEARTLAND.map((s) => s.locationId));
  const missed = [...roster].filter((b) => !ours.has(b));
  assert.deepEqual(missed, [], "every Barchart Heartland facility must be read from Heartland");
  assert.equal([...ours].filter((b) => !roster.has(b)).length, 6);
});

test("a coordinate is a ZIP centroid or an explicit null, never half of one", () => {
  for (const s of HEARTLAND) {
    assert.ok("lat" in s && "lon" in s, s.id);
    assert.equal(s.lat === null, s.lon === null, s.id);
    if (s.lat !== null) assert.equal(s.latPrecision, "town", s.id);
    else assert.ok(!("latPrecision" in s), `${s.id}: no pin, so no precision to claim`);
  }
  assert.equal(HEARTLAND.filter((s) => s.lat !== null).length, 48);
});

test("a board file builds for every one of the 54, and WEVER's gaps stay gaps", () => {
  const ex = adapterFor("heartland", quotes());
  const now = new Date("2026-09-14T12:00:00Z");
  let total = 0;
  for (const s of HEARTLAND) {
    const { file } = buildFile(BOARD, { now, sourceUrl: s.url, source: toConfig(s), extract: ex });
    assert.equal(file.status, "ok", s.id);
    assert.ok(file.count > 0, `${s.id} published nothing`);
    total += file.count;
  }
  assert.equal(total, 527);

  const wever = HEARTLAND.find((s) => s.locationId === "WEVER");
  const { file } = buildFile(BOARD, { now, sourceUrl: wever.url, source: toConfig(wever), extract: ex });
  /* Its two blank corn cells are Jan 27 and Mar 27, and the fifth column must
     not slide into them. */
  assert.deepEqual(file.bids.filter((b) => b.commodity === "CORN").map((b) => b.delivery),
    ["Sep 26", "Oct-Nov 26", "Oct-Nov 27"]);
});

test("describe() says what came back without pretending to read it", () => {
  const d = describeBoard(BOARD);
  assert.match(d, /51909 bytes/);
  assert.match(d, /4 table\(s\)/);
  assert.match(d, /dated 2026-09-11/);
  assert.match(d, /CORN: 54 row\(s\) x 5 column\(s\)/);
});

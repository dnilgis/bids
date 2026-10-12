/* READER REPAIRS FROM THE REPOSITORY'S OWN EVIDENCE -- 2026-10-12.
 *
 * 1. wheatongrain-chippewafalls was refused on 1,636 of the 1,882 polls that
 *    listed it from 2026-09-30 to 2026-10-12, always on rows a fraction of a
 *    cent off cash - basis = futures. The 267 distinct rows those refusals
 *    printed are pinned in test/fixtures/wheatongrain-refusals-2026-10.json.
 *    Every residual is +0.25c, +0.5c or +0.75c and none is negative: the board
 *    truncates cash to the cent. Declared floor-cent, which the repository's
 *    own roundingEvidence names from those rows with a wide margin.
 *
 * 2. An identity refusal now names each failing row's commodity. Border Ag's
 *    six towns refuse on one row, "01 Mar 2027 to 31 Mar 2027 March 2027 cash
 *    548.8 basis -290.3", that balances exactly in its own unit. foreignQuote
 *    would withhold it, but foreignQuote is declared by commodity, and the
 *    refusal never said which commodity it was. The next poll will.
 *
 * 3. A browser read that times out names requests to OTHER hosts first.
 *    Central United's sixteen locations print 300 characters of their own
 *    WordPress stylesheets, which cannot say where the DTN widget went.
 *
 * No guard moves. The identity check is as strict as it was; what changed is
 * one manifest declaration backed by measured rows, and two diagnostics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused } from "../lib/board.mjs";
import { roundingEvidence, residualCents } from "../lib/rounding.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { extract as graindesk } from "../lib/adapters/graindesk.mjs";
import { listRequests } from "../lib/cdp.mjs";

const ROOT = new URL("..", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
const refusal = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof Refused, e.message); return e.message; }
  assert.fail("expected a refusal");
};

/* --- 1. Wheaton Grain: the board floors cash to the cent ----------------- */

const WHEATON = () => json("sources/wheatongrain-chippewafalls.json");
const REFUSED = json("test/fixtures/wheatongrain-refusals-2026-10.json").rows;

test("wheaton: the pinned rows are the refusals, and none of them is negative", () => {
  assert.equal(REFUSED.length, 267);
  const counts = {};
  for (const r of REFUSED) {
    const s = residualCents(r);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  assert.deepEqual(counts, { 0.25: 85, 0.5: 90, 0.75: 92 },
    "the fixture no longer holds the rows the note in the manifest describes");
});

test("wheaton: the repository's own rounding evidence names floor-cent, by a wide margin", () => {
  /* The published rows of the same board were exact; they go in too, so the
     measurement is over everything this board has shown, not only its failures. */
  const published = json("data/wheatongrain-chippewafalls.json").bids.map((b) => ({
    cash: b.cash, basis: b.basisDollars, futuresPrice: b.futuresPriceCents,
  }));
  const ev = roundingEvidence([...REFUSED, ...published]);
  assert.equal(ev.confident, "floor-cent");
  assert.ok(ev.margin >= 90, `floor-cent won by only ${ev.margin} row(s)`);
  assert.equal(ev["round-cent-either"] < ev.testable, true, "round-cent-either is not ruled out");
  assert.equal(ev.residuals[0] >= 0, true, "a negative residual would refute floor-cent");
});

test("wheaton: the manifest declares what was measured, and validates", () => {
  const m = WHEATON();
  assert.equal(m.cashRounding, "floor-cent");
  assert.equal(m.futuresUnits, "dollars");
  assert.deepEqual(validateSource(m, new Set()), []);
  assert.match(m.note, /CASH ROUNDING MEASURED 2026-10-12: floor-cent/);
});

/* NOT A CAPTURE. Rows in the shape lib/adapters/index.mjs cashbidssingle
   returns (futures in dollars, as their board writes it). The corn rows are the
   board's own committed exact rows; the two bean rows are the last live
   refusal, 2026-10-12T22:56Z, to the digit. What is under test is the manifest
   against the guard, not the parser. */
const row = (seq, commodity, delivery, futures, cash, basis, futuresDollars) => ({
  seq, source: "https://wheatongrain.com/", locationId: "2644", location: "location 2644",
  section: null, commodity, delivery, cash, basis, basisCents: Math.round(basis * 100),
  futures, futuresPrice: futuresDollars, futuresAt: "10/12/26", futuresFlag: null, change: 0,
  raw: `${delivery} | ${cash} | ${basis} | ${futuresDollars} | ${futures}`,
});
const READ = [
  row(0, "Corn", "October", "Dec 26 Corn", 4.18, -0.65, 4.83),
  row(1, "Corn", "November", "Dec 26 Corn", 4.18, -0.65, 4.83),
  row(2, "Soybeans", "October", "Nov 26 Soybeans", 12.15, -0.72, 12.8775),
  row(3, "Soybeans", "November", "Nov 26 Soybeans", 12.19, -0.68, 12.8775),
];
const NOW = "2026-10-12T23:00:00.000Z";
const build = (m, rows = READ) => buildFile("(rows)", {
  now: NOW, sourceUrl: m.url, source: toConfig(m), extract: () => rows.map((r) => ({ ...r })),
});

test("wheaton: without the declaration the live read refuses, exactly as it did", () => {
  const bare = WHEATON(); delete bare.cashRounding;
  const msg = refusal(() => build(bare));
  assert.match(msg, /2 of 4 testable row\(s\) fail/);
  assert.match(msg, /cash 12\.15\s+basis -0\.72\s+->\s+1287c but quoted 1287\.75c\s+\(\+0\.75c\)/);
});

test("wheaton: declared, the same read publishes all four rows", () => {
  const r = build(WHEATON());
  assert.equal(r.file.count, 4);
  assert.deepEqual(r.file.bids.map((b) => b.cash), [4.18, 4.18, 12.15, 12.19]);
  assert.equal(r.verified, 4, "every published row must be explained by the declared mode");
  assert.deepEqual(r.file.bids.map((b) => b.futuresPriceCents), [483, 483, 1287.75, 1287.75]);
});

test("wheaton: floor-cent buys nothing for a row that ROUNDS, or for a moved column", () => {
  /* 1287.75 - 72 = 1215.75 and 1287.75 - 68 = 1219.75. Rounded, those are
     12.16 and 12.20: residual -0.25c, which a board that floors never
     produces. Two rows of four is not a minority, so the read refuses. (One
     such row alone is the existing "lagging" case: it publishes with that row
     marked unverified, before and after this declaration alike.) */
  const rounded = READ.map((r) => (r.seq === 2 ? { ...r, cash: 12.16 }
                                 : r.seq === 3 ? { ...r, cash: 12.2 } : r));
  assert.match(refusal(() => build(WHEATON(), rounded)), /cash 12\.16.*\(-0\.25c\)/s);
  /* Cash read from the futures column: out by the basis, 72 cents. */
  const moved = READ.map((r) => (r.seq === 2 ? { ...r, cash: 12.8775 } : r));
  assert.match(refusal(() => build(WHEATON(), moved)), /cash 12\.8775/);
});

/* --- 2. The identity refusal names the commodity ------------------------- */

test("an identity refusal names the commodity of each failing row", () => {
  /* NOT A CAPTURE. Border Ag's refused row to the digit, under a commodity
     name made up here, because which commodity it is is exactly what the live
     message never said. Its neighbours balance the way Grain Desk's four-decimal
     cash does (fixtures/graindesk-albertlea-2026-08-20.json). */
  const m = json("sources/borderag-kramer.json");
  const offer = (deliveryPeriod, futuresMonth, cash, basis, fut) => ({
    destination: "Kramer", deliveryPeriod, comments: "", futuresMonth,
    futuresPrice: fut.toFixed(4), futuresChange: "0", basisPrice: basis.toFixed(4),
    standardCashPrice: cash.toFixed(4), convertedCashPrice: null,
  });
  const body = JSON.stringify([
    { commodity: { name: "Wheat, HRS 14%", standardWeightUnit: "BU" }, offers: [
      offer("02 Oct 2026 to 31 Oct 2026", "December 2026", 6.2125, -0.75, 696.25),
      offer("01 Jan 2027 to 31 Jan 2027", "March 2027", 6.4375, -0.70, 713.75) ] },
    { commodity: { name: "Soybeans", standardWeightUnit: "BU" }, offers: [
      offer("02 Oct 2026 to 31 Oct 2026", "November 2026", 12.0275, -0.85, 1287.75) ] },
    { commodity: { name: "Some Other Crop", standardWeightUnit: "BU" }, offers: [
      offer("01 Mar 2027 to 31 Mar 2027", "March 2027", 548.8, -290.3, 839.1) ] },
  ]);
  const msg = refusal(() => buildFile(body, { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: graindesk }));
  assert.match(msg, /1 of 4 testable row\(s\) fail/);
  assert.match(msg, /Some Other Crop: 01 Mar 2027 to 31 Mar 2027/,
    "the failing row's commodity is not in the refusal, so nothing can be declared from it");
});

/* --- 3. A timed-out browser read names the other hosts first ------------- */

test("listRequests: requests to other hosts come first, each once, then the page's own", () => {
  const seen = [
    "centralunitedcoop.com/",
    ...Array.from({ length: 20 }, (_, i) => `centralunitedcoop.com/wp-content/a${i}.css`),
    "fonts.googleapis.com/css",
    "www.centralunitedcoop.com/x.js",
    "api.dtn.com/markets/sites/E0200799/cash-bids",
    "fonts.googleapis.com/css",
  ];
  const out = listRequests(seen, "https://centralunitedcoop.com");
  assert.ok(out.startsWith("fonts.googleapis.com/css, api.dtn.com/markets/sites/E0200799/cash-bids, centralunitedcoop.com/"), out);
  assert.equal(out.split(", ").length, 12);
  assert.ok(out.endsWith(" …"));
  /* What poll.mjs keeps of the message is 300 characters. The DTN request has
     to be inside it. */
  const msg = `no readable response matching https://api.dtn.com/markets/sites/E0200701/cash-bids?units=us within 45000ms. The page did make ${seen.length} request(s): ${out}`;
  assert.match(msg.slice(0, 300), /E0200799/);
});

test("listRequests: nothing seen still reads as nothing, which lib/breaker.mjs keys on", () => {
  assert.equal(listRequests([], "https://example.com/"), "");
  assert.equal(listRequests(["a.com/x"], "not a url"), "a.com/x");
  const src = readFileSync(new URL("lib/cdp.mjs", ROOT), "utf8");
  assert.match(src, /The page did make \$\{seen\.length\} request\(s\): \$\{listRequests\(seen, pageUrl\)\}/);
});

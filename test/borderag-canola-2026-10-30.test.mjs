/* BORDER AG'S CANOLA ROW IS IN ANOTHER UNIT -- 2026-10-30.
 *
 * test/reader-repairs-2026-10-12.test.mjs made the identity refusal name the
 * failing row's commodity, because Border Ag's six towns refused on one row
 * that balanced in its own unit and foreignQuote is declared by commodity.
 * The next polls named it. On all 40 passes from 2026-10-29 18:08Z, all six
 * towns printed the same row:
 *
 *   Canola: 01 Mar 2027 to 31 Mar 2027 March 2027 cash 532.5 basis -266.6
 *   -> 79910c but quoted 799.1c
 *
 * 532.5 + 266.6 = 799.1 exactly: a per-tonne price beside a per-tonne quote,
 * read as if it were dollars per bushel. Berthold Farmers, on the same Grain
 * Desk platform, already declares foreignQuote ["Canola"]. The six manifests
 * now do too: the canola rows are withheld, and every other row is checked
 * exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused } from "../lib/board.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { extract as graindesk } from "../lib/adapters/graindesk.mjs";

const ROOT = new URL("..", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
const NOW = new Date("2026-10-30T00:30:00Z");
const TOWNS = ["Bottineau", "Westhope", "Lansford", "Russell", "Kramer", "Souris"];

/* NOT A CAPTURE. Grain Desk's shape (fixtures/graindesk-albertlea-2026-08-20.json)
   holding the canola row to the digit as the live refusal printed it, beside
   Border Ag's own committed rows (data/borderag-bottineau.json, 2026-10-12). */
const offer = (destination, deliveryPeriod, futuresMonth, cash, basis, fut) => ({
  destination, deliveryPeriod, comments: "", futuresMonth,
  futuresPrice: fut.toFixed(4), futuresChange: "0", basisPrice: basis.toFixed(4),
  standardCashPrice: cash.toFixed(4), convertedCashPrice: null,
});
const board = (town) => JSON.stringify([
  { commodity: { name: "Wheat, HRS 14%", standardWeightUnit: "BU" }, offers: [
    offer(town, "02 Oct 2026 to 31 Oct 2026", "December 2026", 6.2125, -0.75, 696.25),
    offer(town, "01 Jan 2027 to 31 Jan 2027", "March 2027", 6.4375, -0.70, 713.75) ] },
  { commodity: { name: "Soybeans", standardWeightUnit: "BU" }, offers: [
    offer(town, "02 Oct 2026 to 31 Oct 2026", "November 2026", 12.0275, -0.85, 1287.75) ] },
  { commodity: { name: "Corn", standardWeightUnit: "BU" }, offers: [
    offer(town, "02 Oct 2026 to 31 Oct 2026", "December 2026", 3.83, -1.00, 483) ] },
  { commodity: { name: "Canola", standardWeightUnit: "BU" }, offers: [
    offer(town, "01 Mar 2027 to 31 Mar 2027", "March 2027", 532.5, -266.6, 799.1) ] },
]);

for (const town of TOWNS) {
  const id = `borderag-${town.toLowerCase()}`;
  test(`${id}: canola is declared foreign, and the board publishes the rest`, () => {
    const m = json(`sources/${id}.json`);
    assert.deepEqual(validateSource(m, new Set()), []);
    assert.deepEqual(m.foreignQuote, ["Price X2 for CWT", "Canola"]);
    assert.equal(m.locationId, town);
    const b = buildFile(board(town), { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: graindesk });
    assert.equal(b.file.count, 4);
    assert.equal(b.file.bids.some((r) => /canola/i.test(r.commodity)), false, "a canola row published");
  });
}

test("without the declaration the same board still refuses, naming canola", () => {
  const m = json("sources/borderag-kramer.json");
  const bare = toConfig({ ...m, foreignQuote: ["Price X2 for CWT"] });
  let msg = null;
  try { buildFile(board("Kramer"), { now: NOW, sourceUrl: m.url, source: bare, extract: graindesk }); }
  catch (e) { assert.ok(e instanceof Refused, e.message); msg = e.message; }
  assert.ok(msg, "expected a refusal");
  assert.match(msg, /Canola: 01 Mar 2027 to 31 Mar 2027 March 2027 cash 532\.5\s+basis -266\.6\s+->\s+79910c but quoted 799\.1c/);
});

test("the declaration does not hide a wrong bushel row: a moved column still refuses", () => {
  const m = json("sources/borderag-kramer.json");
  const body = JSON.parse(board("Kramer"));
  body[0].offers[0].standardCashPrice = "6.9625";   // cash read from the futures column
  body[0].offers[1].standardCashPrice = "7.1375";
  body[1].offers[0].standardCashPrice = "12.8775";
  body[2].offers[0].standardCashPrice = "4.83";
  assert.throws(() => buildFile(JSON.stringify(body), { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: graindesk }),
    (e) => e instanceof Refused);
});

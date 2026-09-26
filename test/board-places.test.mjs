/* geocodes/board-places.json: towns decided by hand, and what they must survive.
 *
 * Each entry is run the way a poll would run it: the captured board through its
 * adapter, planned into a manifest, and that manifest through the real
 * identity guard. A place that only looks right on paper fails here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { planSite, placeFromPlaces } from "../scripts/board-sweep.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { buildFile } from "../lib/board.mjs";
import { validateSource } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLACES = JSON.parse(readFileSync(join(ROOT, "geocodes/board-places.json"), "utf8")).places;
const KNOWN = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8")).elevators;

const BOARDS = [
  ["cashbidssingle-adellcoopcom", "cashbidssingle", "https://adellcoop.com/", "Adell Cooperative"],
  ["cashbidssingle-elkhartgraincom", "cashbidssingle", "https://elkhartgrain.com/cashbidssingle-3436", "Elkhart Grain Company"],
  ["cashbidssingle-fgcrosevillecom", "cashbidssingle", "https://fgcroseville.com/", "Farmers Grain Company of Roseville"],
  ["cashbidssingle-graymontcoopcom", "cashbidssingle", "https://graymontcoop.com/cashbidssingle-3404", "Graymont Co-op"],
  ["cashbidssingle-npacoopcom", "cashbidssingle", "https://npacoop.com/cashbidssingle-1595", "North Prairie Ag - NPA Coop"],
  ["cashbidssingle-oneearthenergycom", "cashbidssingle", "https://oneearthenergy.com/", "One Earth Energy"],
  ["aghost-dtncfscoopcom", "aghost", "https://dtn.cfscoop.com/index.cfm?show=11&mid=3", "Central Farm Service"],
  ["aghost-harmonyagricom", "aghost", "https://harmonyagri.com/index.cfm?show=11&mid=7", "Harmony Agri Services, Inc."],
  ["aghost-poetbiorefiningashtonaghostnet", "aghost", "http://poetbiorefining-ashton.aghost.net/index.cfm?show=11&mid=3", "POET Grain - Ashton"],
  ["aghost-poetbiorefiningbinghamlakeaghostnet", "aghost", "http://poetbiorefining-binghamlake.aghost.net/index.cfm?show=11&mid=3", "POET Grain - Bingham Lake"],
];

for (const [fixture, platform, url, operator] of BOARDS) {
  test(`${operator}: placed by hand, valid, and the captured board passes the guard`, () => {
    const html = readFileSync(join(ROOT, "fixtures/board-sweep", `${fixture}.html`), "utf8");
    const rows = adapterFor(platform)(html, url);
    const plan = planSite({ html, url, site: new URL(url).origin + "/", platform, rows, known: KNOWN,
                            byZip: new Map(), existingIds: new Set(), places: PLACES });
    assert.equal(plan.write.length, 1, JSON.stringify(plan.unmatched.concat(plan.skip)));
    const m = plan.write[0].json;
    assert.deepEqual(validateSource(m, new Set()), []);
    assert.equal(m.cashRounding, "round-cent-both");
    assert.match(m.url, /^https:\/\//, "a manifest must never be written on http");
    assert.match(m.note, /geocodes\/board-places\.json/);
    const out = buildFile(html, { now: new Date(), sourceUrl: url, source: m, extract: adapterFor(platform) });
    assert.ok(out.file, "the guard refused a board it should accept");
  });
}

test("a place with a locationId never matches another location of the same operator", () => {
  assert.equal(placeFromPlaces(PLACES, "Adell Cooperative", { locationId: "9999" }, { soleLocation: true }), null);
});

test("a place with no locationId matches only a single-location board", () => {
  assert.equal(placeFromPlaces(PLACES, "Harmony Agri Services, Inc.", { locationId: null }, { soleLocation: false }), null);
  assert.ok(placeFromPlaces(PLACES, "Harmony Agri Services, Inc.", { locationId: null }, { soleLocation: true }));
});

test("multi-plant price sheets and the guard-refused board are deliberately not placed", () => {
  for (const op of ["Glacial Lakes Energy LLC", "MICHAEL FOODS", "Pomeroy Grain", "Northwest Grain Growers",
                    "Scranton Equity Exchange"])
    assert.ok(!PLACES.some((p) => p.operator === op), `${op} must stay unplaced`);
});

test("every place names its evidence and a five-digit ZIP", () => {
  for (const p of PLACES) {
    assert.ok(p.evidence && p.evidence.length > 30, `${p.operator}: no evidence`);
    assert.match(p.zip, /^\d{5}$/, p.operator);
  }
});

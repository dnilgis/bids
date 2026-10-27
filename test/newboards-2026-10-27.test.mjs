/* THE OCT 27 CANDIDATE BOARDS. A research list named public cash-bid pages,
 * unverified. capture.yml runs 40594412672 and 40595637896 loaded each one; the boards an
 * existing adapter reads were written as manifests, and their bytes are the
 * fixtures here. Each manifest must name a location that is really on its
 * board, and publish from that capture through every guard with nothing
 * withheld. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFile } from "../lib/board.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { filterLocation } from "../lib/parse.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const NOW = new Date("2026-10-27T22:30:00Z");

/* id -> [fixture, rows the capture carried for that location] */
const BOARDS = {
  "yodergrain-yoder": ["fixtures/cashbidssingle-yodergrain-2026-10-27.html", 7],
  "yodergrain-bluffton": ["fixtures/cashbidssingle-yodergrain-2026-10-27.html", 9],
  "yodergrain-monroe": ["fixtures/cashbidssingle-yodergrain-2026-10-27.html", 9],
  "yodergrain-shideler": ["fixtures/cashbidssingle-yodergrain-2026-10-27.html", 9],
  "stewartgrain-williamsport": ["fixtures/cashbidssingle-stewartgrain-2026-10-27.html", 9],
  "smithfieldgrain-lapaz": ["fixtures/cashbidssingle-smithfieldgrain-2026-10-27.html", 1],
  "farcoop-halstead": ["fixtures/cashbidssingle-farcoop-2026-10-27.html", 8],
  "farcoop-mounthope": ["fixtures/cashbidssingle-farcoop-2026-10-27.html", 8],
  "farcoop-patterson": ["fixtures/cashbidssingle-farcoop-2026-10-27.html", 8],
  "farcoop-bentley": ["fixtures/cashbidssingle-farcoop-2026-10-27.html", 6],
  "ndmgrain-grandforks": ["fixtures/cashbidssingle-ndmgrain-2026-10-27.html", 4],
  "emeradofarmerselevator-emerado": ["fixtures/cashbidssingle-emeradofarmerselevator-2026-10-27.html", 6],
  "northwoodequity-northwood": ["fixtures/cashbidssingle-northwoodequity-2026-10-27.html", 12],
  "dellrapidscoopgrain-dellrapids": ["fixtures/cashbidssingle-dellrapidscoopgrain-2026-10-27.html", 10],
  "burgessgrain-clinton": ["fixtures/cashbidssingle-burgessgrain-2026-10-27.html", 12],
  "jorgensenfe-williamston": ["fixtures/cashbidssingle-jorgensenfe-2026-10-27.html", 9],
  "harvestonelcp-ibec": ["fixtures/cashbidssingle-harvestonelcp-ibec-2026-10-27.html", 7],
  "southbendethanol-southbend": ["fixtures/graindesk-verbio-2026-10-27.json", 6],
};

for (const [id, [fixture, rows]] of Object.entries(BOARDS)) {
  test(`${id}: on its captured board, and publishes from it with nothing withheld`, () => {
    const m = JSON.parse(rd(`sources/${id}.json`));
    assert.deepEqual(validateSource(m), [], id);
    assert.equal(m.enabled, true);
    assert.match(m.note, /capture\.yml run (40594412672|40595637896)/, "the note names the capture it was written from");
    assert.match(m.note, /PLACE: /, "the note says how the town was decided");
    const body = rd(fixture);
    const all = adapterFor(m.platform)(body, m.url);
    const { kept } = filterLocation(all, m.locationId);
    assert.equal(kept.length, rows, `${id}: rows for location ${m.locationId}`);
    const b = buildFile(body, { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: adapterFor(m.platform) });
    assert.equal(b.file.count, rows);
    assert.equal((b.file.withheld ?? []).length, 0, `${id} withheld rows`);
    /* No coordinate is invented here: geocode fill adds one and says how. */
    assert.equal(m.lat, null);
    assert.equal(m.lon, null);
  });
}

test("the Grain Discovery feed behind South Bend Ethanol's page also names VERBIO Nevada, and only South Bend is taken from it", () => {
  const body = rd("fixtures/graindesk-verbio-2026-10-27.json");
  const dests = new Set(adapterFor("graindesk")(body, "u").map((r) => r.locationId));
  assert.deepEqual([...dests].sort(), ["Nevada", "South Bend Ethanol"]);
});

test("a board that is not this location's refuses to stand in for it", () => {
  const m = JSON.parse(rd("sources/yodergrain-yoder.json"));
  const other = rd("fixtures/cashbidssingle-stewartgrain-2026-10-27.html");
  assert.equal(filterLocation(adapterFor(m.platform)(other, m.url), m.locationId).kept.length, 0);
});

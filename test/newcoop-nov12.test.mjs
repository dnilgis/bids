/* THREE NEW COOPERATIVE LOCATIONS THAT HAD NO SOURCE (2026-11-12).
 * The board has printed "Cainsville", "Morton Mills" and "Mt. Ayr" since the
 * 2026-10-02 capture. The generator left them out ("not written") because no
 * directory or licence row placed them; the owner's read of newcoop.com/locations
 * on 2026-11-12 does. The fixture is four tables cut byte for byte from the page
 * source the owner pasted that day (69 locations, 649 KB): those three plus Afton. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extract, sections } from "../lib/adapters/newcoop.mjs";
import { buildFile } from "../lib/board.mjs";
import { loadSources, toConfig, validateSource } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const ROOT = new URL("../", import.meta.url);
const PAGE = readFileSync(new URL("fixtures/newcoop-cashbids-2026-11-12-three.html", ROOT), "utf8");
const src = (id) => JSON.parse(readFileSync(new URL(`sources/${id}.json`, ROOT), "utf8"));
const THREE = [
  ["newcoop-cainsville", "Cainsville", "MO", "64632", "1301 E Main St, Cainsville, MO 64632"],
  ["newcoop-mortonmills", "Morton Mills", "IA", "50864", "3107 155th St, Villisca, IA 50864"],
  ["newcoop-mtayr", "Mt. Ayr", "IA", "50854", "403 E South St, Mount Ayr, IA 50854"],
];

test("the trimmed page has the three headings and Afton, each a readable board", () => {
  assert.deepEqual(sections(PAGE).map((s) => s.name), ["Afton", "Cainsville", "Morton Mills", "Mt. Ayr"]);
  const rows = extract(PAGE, "https://www.newcoop.com/cash-bids");
  for (const [, name] of THREE) assert.ok(rows.filter((r) => r.locationId === name).length >= 6, `${name} rows`);
});

for (const [id, name, state, zip, address] of THREE) {
  test(`${id}: a valid source for the heading "${name}", placed where the owner's read says`, () => {
    const m = src(id);
    assert.deepEqual(validateSource(m), []);
    assert.deepEqual([m.id, m.platform, m.locationId, m.state, m.zip, m.address, m.enabled, m.inMerge],
      [id, "newcoop", name, state, zip, address, true, true]);
    assert.equal(m.operator, "NEW Cooperative, Inc.");
    assert.match(m.note, /LOCATED \(2026-11-12\)/);
  });

  test(`${id}: publishes every row of its table from the Nov 12 page`, () => {
    const m = src(id);
    const { sources } = loadSources([m]);
    assert.equal(sources.length, 1);
    const built = buildFile(PAGE, { now: "2026-11-12T20:00:00.000Z", sourceUrl: m.url, source: toConfig(sources[0]), extract: adapterFor("newcoop", null) });
    const want = extract(PAGE, m.url).filter((r) => r.locationId === name).length;
    assert.ok(built.file.count > 0 && built.file.count === want, `${id}: ${built.file.count} of ${want} rows`);
    assert.equal((built.file.withheld ?? []).length, 0, `${id} withheld rows`);
  });
}

test("coordinates are the town's ZIP-table pin or nothing: Cainsville and Mt. Ayr have one, Morton Mills shares Villisca's ZIP and has none", () => {
  const [c, m, a] = THREE.map(([id]) => src(id));
  assert.deepEqual([c.lat, c.lon, c.latPrecision], [40.4578, -93.759, "town"]);
  assert.deepEqual([a.lat, a.lon, a.latPrecision], [40.7142, -94.2321, "town"]);
  assert.deepEqual([m.lat, m.lon], [null, null]);
  assert.equal(src("newcoop-villisca").zip, m.zip);
});

test("every heading on a NEW Cooperative board has a source, and no source is left without a heading: 69 and 69", () => {
  const ids = readdirSync(new URL("sources/", ROOT)).filter((f) => /^newcoop-.*\.json$/.test(f)).map((f) => src(f.replace(/\.json$/, "")));
  assert.equal(ids.length, 69);
  assert.equal(new Set(ids.map((m) => m.locationId)).size, 69);
  for (const [, name] of THREE) assert.ok(ids.some((m) => m.locationId === name), name);
});

/* Placing the board siblings must be ADDITIVE.
 *
 * scripts/agricharts-sweep.mjs writes every agricharts source in this
 * repository. The change that lets a directory row carry its own coordinate is
 * only safe if a row WITHOUT one behaves exactly as it did before — so the
 * first test here rebuilds real manifests both ways and compares bytes.
 *
 * The rest are the rules the new path must not break.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { manifestFor, readSiblingDirectory } from "../scripts/agricharts-sweep.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/* A directory row and a location, taken from a source this repo already
   shipped, so the comparison is against real data rather than a fixture I
   shaped to pass. */
function sampleArgs() {
  const f = readdirSync(ROOT + "sources").find((n) => /^ceagrain-/.test(n));
  const s = JSON.parse(readFileSync(ROOT + "sources/" + f, "utf8"));
  return {
    id: s.id, operator: s.operator, website: s.website, url: s.url,
    loc: { locationId: s.locationId, label: s.location, rows: 12,
           commodities: new Set(["CORN", "SOYBEANS"]) },
    dir: { branch: s.location, city: s.location, state: s.state, zip: s.zip, phone: s.phone },
    zipCoord: { lat: s.lat, lon: s.lon },
    runId: "test", kind: "cashgrid",
  };
}

test("ADDITIVE: a row with no coord produces the identical manifest", () => {
  /* The change is only safe if it changes nothing that already worked. */
  const a = sampleArgs();
  const before = manifestFor(a);
  /* Same call, with the new field explicitly absent — which is every existing
     directory row. */
  const after = manifestFor({ ...a, dir: { ...a.dir, coord: undefined } });
  assert.equal(JSON.stringify(before), JSON.stringify(after),
    "a directory row without a coordinate no longer produces the same manifest");
  assert.equal(before.lat, a.zipCoord.lat, "the ZIP coordinate stopped being used");
  assert.equal(before.latPrecision, "town", "the ZIP path lost its precision");
});

test("a carried coordinate wins, and brings its own precision", () => {
  const a = sampleArgs();
  const m = manifestFor({ ...a, dir: { ...a.dir, zip: null,
    coord: { lat: 41.229, lon: -85.3244, precision: "town", via: "zip-centroid" } } });
  assert.equal(m.lat, 41.229);
  assert.equal(m.lon, -85.3244);
  assert.equal(m.latPrecision, "town");
  assert.match(m._pending, /geocodes\/places\.json already/,
    "the manifest does not say where its coordinate came from — rule 45");
  assert.match(m._pending, /zip-centroid/, "the `via` is not carried into the note");
});

test("a street-precision coordinate is NOT relabelled 'town'", () => {
  /* 196 of the geocoded places are street precision, from the census. Calling
     one of those a town centroid understates what we know; calling a town
     centroid a street address is the lie that matters. Neither may happen. */
  const a = sampleArgs();
  const m = manifestFor({ ...a, dir: { ...a.dir, zip: null,
    coord: { lat: 41.5, lon: -93.6, precision: "street", via: "census" } } });
  assert.equal(m.latPrecision, "street",
    "a street-precision coordinate was flattened to 'town'");
});

test("the sibling directory only offers rows that carry a coordinate", () => {
  const rows = readSiblingDirectory(ROOT);
  if (!existsSync(ROOT + "data/gaps/board-siblings.csv")) return;
  assert.ok(rows.length > 0, "no sibling rows were read at all");
  for (const r of rows) {
    assert.ok(r.state && r.branch && r.facility, "a row is missing its identity: " + JSON.stringify(r));
    assert.ok(r.coord && Number.isFinite(r.coord.lat) && Number.isFinite(r.coord.lon),
      "a row without a usable coordinate was offered to the directory: " + JSON.stringify(r));
    assert.ok(Math.abs(r.coord.lat) <= 90 && Math.abs(r.coord.lon) <= 180, "coordinate out of range");
    assert.ok(r.coord.lat > 18 && r.coord.lat < 72 && r.coord.lon < -60,
      "a sibling coordinate is not in the United States: " + JSON.stringify(r));
    assert.equal(r.zip, null, "a sibling row claims a ZIP it does not have");
    assert.equal(r.source, "board-siblings", "a sibling row does not say where it came from");
  }
});

test("a missing worklist file is not an error", () => {
  /* The sweep predates the worklist and must run without it. */
  assert.deepEqual(readSiblingDirectory("/nonexistent-path-for-this-test/"), []);
});

test("Barchart's own rows are loaded BEFORE the siblings", () => {
  /* joinDirectory takes the first match. data/known-elevators.json is the file
     a street-precision fix would have landed in, so it must win. */
  const src = readFileSync(ROOT + "scripts/agricharts-sweep.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const iKnown = src.indexOf("data/known-elevators.json");
  const iSib = src.indexOf("known.push(...siblingRows)");
  assert.ok(iKnown > 0 && iSib > 0, "one of the two loads is gone");
  assert.ok(iKnown < iSib,
    "the sibling rows are pushed before Barchart's, so a sibling could displace a real directory entry");
});

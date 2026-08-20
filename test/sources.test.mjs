/* Every manifest in sources/, checked for the things that go wrong silently.
 *
 * These files are hand-written JSON and nothing validated them. Two of the
 * defects found on 2026-08-20 were configuration rather than code — a band
 * written as an object instead of a pair switched the level guard off, and a
 * missing locationId matched every row on the page. Both would have been caught
 * here in a second. A manifest is code; it just has no compiler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validBand, roundingRule, futuresScale, Refused } from "../lib/board.mjs";
import { ADAPTERS } from "../lib/adapters/index.mjs";
import { normLocationId } from "../lib/parse.mjs";

const dir = new URL("../sources/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));

test("there are sources to check at all", () => {
  assert.ok(files.length > 0, "an empty sources/ would make every test below vacuous");
});

for (const f of files) {
  test(`${f} is a manifest the guards can actually use`, () => {
    const s = load(f);

    assert.equal(typeof s.id, "string");
    assert.ok(s.id.length, "id is the filename contract and the data/<id>.json path");
    assert.equal(`${s.id}.json`, f, "the id and the filename must agree or data/ and sources/ drift");

    for (const k of ["operator", "location", "platform", "url"])
      assert.equal(typeof s[k], "string", `${k} must be a string`);
    assert.ok(s.platform in ADAPTERS, `no adapter for platform "${s.platform}"`);
    assert.match(s.url, /^https:\/\//, "http would put a cash board on an unauthenticated wire");

    /* THE ONE THAT BIT. `null` is allowed and means "this page carries one
       location and does not key its rows"; missing is not allowed, because a
       missing key used to match every row on the page. */
    assert.ok("locationId" in s, "locationId must be present, even if it is null");
    assert.doesNotThrow(() => normLocationId(s.locationId));

    /* A band that is not a pair of numbers disables the level check in silence. */
    assert.ok(s.bands && typeof s.bands === "object" && !Array.isArray(s.bands),
      "bands must be an object of commodity -> [floor, ceiling]");
    for (const [name, range] of Object.entries(s.bands))
      assert.doesNotThrow(() => validBand(range, `${f} ${name}`), `${f}: band ${name}`);

    /* Declared knobs have to be knobs this code knows. */
    assert.doesNotThrow(() => roundingRule(s), `${f}: cashRounding`);
    assert.doesNotThrow(() => futuresScale(s), `${f}: futuresUnits`);
    assert.ok(Number.isFinite(Number(s.cashRoundingCents ?? 0)), "cashRoundingCents must be a number");

    /* A coordinate is either a real pair or an honest pair of nulls. Half a
       coordinate puts a pin in the Gulf of Guinea. */
    const hasLat = s.lat !== null && s.lat !== undefined;
    const hasLon = s.lon !== null && s.lon !== undefined;
    assert.equal(hasLat, hasLon, "lat and lon must both be present or both be null");
    if (hasLat) {
      assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), "coordinates must be numbers");
      assert.ok(s.lat > 24 && s.lat < 50, `lat ${s.lat} is not in the continental US`);
      assert.ok(s.lon > -125 && s.lon < -66, `lon ${s.lon} is not in the continental US`);
      assert.ok(!(s.lat === 0 && s.lon === 0), "0,0 is the null island, not a grain elevator");
    }

    assert.equal(typeof s.enabled, "boolean", "enabled must be an explicit true or false");
    assert.equal(typeof s.note, "string");
    assert.ok(s.note.length > 40, "a note nobody can act on is not a note");
  });
}

test("no two sources claim the same platform, url and locationId", () => {
  /* Two manifests reading the same rows would publish the same board twice
     under two towns, and anything counting elevators would count it twice —
     the hazard the Thorp/Granton note in the multisource handoff describes. */
  const seen = new Map();
  for (const f of files) {
    const s = load(f);
    const key = `${s.platform}|${s.url}|${normLocationId(s.locationId)}`;
    assert.ok(!seen.has(key), `${f} and ${seen.get(key)} read exactly the same rows`);
    seen.set(key, f);
  }
});

test("a source with a key uses an env name, never the key itself", () => {
  /* Secrets live in repo secrets. A manifest may say WHICH secret, never what
     it is. This also catches a key pasted into the url by mistake. */
  for (const f of files) {
    const s = load(f);
    assert.ok(!("apiKey" in s), `${f} carries an apiKey; use apiKeyEnv and a repo secret`);
    assert.ok(!/apikey=/i.test(s.url), `${f} has a key in its url, where every log line will keep it`);
    if (s.apiKeyEnv) assert.match(s.apiKeyEnv, /^[A-Z][A-Z0-9_]*$/, `${f}: apiKeyEnv looks like a value, not a name`);
  }
});

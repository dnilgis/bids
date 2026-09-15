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
import { COORD_BOX, validateSource } from "../lib/sources.mjs";
import { countryOfState } from "../lib/currency.mjs";

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
      /* THE BOX IS lib/sources.mjs's, IMPORTED — it used to be four numbers
         typed out again here, which is a second copy of a fact that already
         had a home. The copy said "the continental US" on a feed that already
         publishes Ontario boards, and it would have refused every Canadian ADM
         manifest the moment one was committed, with the loader's own copy
         passing them. Two guards measuring the same thing differently is how
         one of them quietly stops being true. */
      const box = COORD_BOX[s.country ?? countryOfState(s.state) ?? "US"] ?? COORD_BOX.US;
      assert.ok(s.lat > box.lat[0] && s.lat < box.lat[1], `lat ${s.lat} is not in ${box.what}`);
      assert.ok(s.lon > box.lon[0] && s.lon < box.lon[1], `lon ${s.lon} is not in ${box.what}`);
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


/* ---------------------------------------------------------------------------
 * THE COORDINATE BOX, WHICH NOTHING TESTED.
 *
 * Deleting the check outright, and widening the US box to Canada's, both left
 * the whole suite green on 2026-09-15. The box is the only thing standing
 * between a transposed pair and a pin in the wrong hemisphere, and it was
 * asserted only against the manifests that already pass it.
 * --------------------------------------------------------------------------- */
const coordSrc = (over) => ({
  id: "t", operator: "O", location: "L", platform: "gradable",
  url: "https://adm.gradable.com/a", browserPage: "https://adm.gradable.com/b",
  locationId: "1", bands: { corn: [2, 12] }, cadence: "grain-day",
  provenance: "scraped", enabled: false, website: "https://adm.gradable.com/b",
  inMerge: true, zip: "1", address: "a", phone: null, email: null, ...over,
});
const coordErrs = (over) => validateSource(coordSrc(over)).filter((e) => /is not in/.test(e));

test("THE US BOX IS THE UNITED STATES AND NOTHING WIDER", () => {
  assert.deepEqual(COORD_BOX.US.lat, [24, 50]);
  assert.deepEqual(COORD_BOX.US.lon, [-125, -66]);
  assert.deepEqual(coordErrs({ state: "KS", lat: 38.917, lon: -97.212 }), []);
  /* Calgary's latitude on a Kansas source is a bad coordinate, not a border. */
  assert.equal(coordErrs({ state: "KS", lat: 51.02, lon: -114.02 }).length, 1,
    "a US source now accepts a Canadian latitude — the box has been widened");
  assert.equal(coordErrs({ state: "KS", lat: 38.917, lon: 97.212 }).length, 1, "eastern hemisphere");
});

test("and Canada gets Canada's, because this feed already publishes Ontario", () => {
  for (const [state, lat, lon] of [
    ["AB", 51.02041, -114.01999],      // Calgary
    ["SK", 58.33136, -107.06396],      // Vanscoy
    ["ON", 44.516708, -80.98444],      // Owen Sound, which passes the US box too
  ]) assert.deepEqual(coordErrs({ state, lat, lon }), [], `${state} ${lat},${lon}`);
});

test("A TRANSPOSED PAIR IS STILL CAUGHT, in both countries", () => {
  /* The whole point of the box. Swapping Calgary gives a latitude of -114,
     which is not a latitude at all. */
  assert.equal(coordErrs({ state: "AB", lat: -114.01999, lon: 51.02041 }).length, 1);
  assert.equal(coordErrs({ state: "KS", lat: -97.212, lon: 38.917 }).length, 1);
  assert.equal(coordErrs({ state: "KS", lat: 0, lon: 0 }).length, 1, "null island");
});

test("an explicit country wins over the state's, and an unknown one falls back to the US", () => {
  assert.equal(coordErrs({ state: "KS", country: "CA", lat: 51.02, lon: -114.02 }).length, 0,
    "the declared country is ignored");
  assert.equal(coordErrs({ state: "ZZ", lat: 51.02, lon: -114.02 }).length, 1,
    "an unrecognised state silently got the widest box");
});

/* THE MANIFEST LAYER — the one place a knob can be added to the guards and
 * silently never reach them.
 *
 * Two of the three defects this file was written for were exactly that shape:
 *
 *   - `cashRounding` and `futuresUnits` were live in board.mjs and neither was
 *     carried by toConfig(), so a source could declare either and get the old
 *     behaviour with nothing anywhere saying so.
 *   - `locationId: String(s.locationId ?? "")` turned a deliberate null into an
 *     empty string, which meant the key was ALWAYS present by the time
 *     buildFile saw it — so buildFile's own "the manifest must say which
 *     location" guard could never fire. A conversion that makes a guard
 *     downstream unreachable is not a conversion, it is a hole.
 *
 * The third was the opposite: a comment saying "warn rather than reject" above
 * code that rejected, which silently dropped every source with a deliberate
 * `lat: null` — sunriseag-buckman, agpartners-goodhue and agpartners-eyota.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PLATFORMS, PLATFORM_WIRE, wireOf, CASH_ROUNDING_MODES, FUTURES_UNITS,
  validateSource, warnSource, toConfig, loadSources,
} from "../lib/sources.mjs";
import { buildFile, Refused } from "../lib/board.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const ok = {
  id: "x-town", operator: "Op", location: "Town", platform: "graindesk",
  url: "https://example.test/api", locationId: "Town",
  bands: { corn: [2, 12] }, lat: 44.5, lon: -92.5,
};
const errs = (o) => validateSource({ ...ok, ...o });

/* ---- the knobs reach the guards ----------------------------------------- */

test("toConfig carries the knobs that board.mjs actually reads", () => {
  const c = toConfig({ ...ok, cashRounding: "floor-cent", futuresUnits: "dollars", cashRoundingCents: 0 });
  assert.equal(c.cashRounding, "floor-cent");
  assert.equal(c.futuresUnits, "dollars");
  assert.equal(c.cashRoundingCents, 0);
});

test("a null locationId survives toConfig as null, not as an empty string", () => {
  assert.equal(toConfig({ ...ok, locationId: null }).locationId, null);
  assert.equal(toConfig({ ...ok, locationId: 2121 }).locationId, "2121");
  assert.equal(toConfig({ ...ok, locationId: "Auburn" }).locationId, "Auburn");
  /* And the key is still there, so buildFile can tell "declared none" from
     "forgot to declare". */
  assert.ok("locationId" in toConfig({ ...ok, locationId: null }));
});

test("END TO END: a real manifest and a real capture publish through the real guards", () => {
  /* This is the test that would have caught the missing knob. Without
     cashRounding reaching buildFile, this board fails the identity check on
     every row, because their cash cell is floored to the cent. */
  const body = readFileSync(new URL("../fixtures/dtn-cs-agpartners-e0172401.json", import.meta.url), "utf8");
  const src = JSON.parse(readFileSync(new URL("../sources/agpartners-redwing.json", import.meta.url), "utf8"));
  assert.deepEqual(validateSource(src), []);
  const { file, verified } = buildFile(body, {
    now: "2026-08-20T15:00:00.000Z", sourceUrl: src.url,
    source: toConfig(src), extract: adapterFor(src.platform),
  });
  assert.equal(file.count, 16);
  assert.equal(verified, 16);
  assert.equal(file.bids[0].futuresPriceCents, 478.75);

  /* Strip the knob and the same board refuses. That is the regression. */
  const blind = toConfig({ ...src, cashRounding: undefined });
  assert.throws(() => buildFile(body, {
    now: "2026-08-20T15:00:00.000Z", sourceUrl: src.url, source: blind,
    extract: adapterFor(src.platform),
  }), Refused);
});

/* ---- what a manifest must say ------------------------------------------- */

test("dtn-cs is a platform the manifest layer knows about", () => {
  assert.ok(PLATFORMS.includes("dtn-cs"));
  assert.deepEqual(errs({ platform: "dtn-cs", url: "https://api.dtn.com/markets/sites/e0/cash-bids" }), []);
  assert.match(errs({ platform: "made-up" })[0], /unknown platform/);
});

test("a manifest with no locationId is rejected, and null is accepted", () => {
  const { locationId, ...noId } = ok;
  assert.match(validateSource(noId)[0], /no locationId/);
  assert.deepEqual(errs({ locationId: null }), []);
  assert.deepEqual(errs({ locationId: 0 }), []);
});

test("a coordinate is a pair of numbers or a pair of nulls, and nothing else", () => {
  assert.deepEqual(errs({ lat: null, lon: null }), []);
  assert.match(errs({ lat: 44.5, lon: null })[0], /both be numbers or both be null/);
  assert.match(errs({ lat: null, lon: -92.5 })[0], /both be numbers or both be null/);
  const { lat, ...noLat } = ok;
  assert.match(validateSource(noLat).join(" "), /no lat/);
  assert.match(errs({ lat: "44.5" })[0], /must be a number or null/);
  /* A transposed pair reads as a plausible number and lands in the wrong
     hemisphere — Auburn IL at -89.7,39.6 would sit in the Gulf of Guinea. */
  assert.match(errs({ lat: -89.71, lon: 39.59 })[0], /not in the continental US/);
});

test("a source with no coordinates is READ, and warned about, not dropped", () => {
  /* The comment said "warn rather than reject" and the code rejected. Three
     shipped sources carry a deliberate null. */
  const { sources, errors, warnings } = loadSources([{ ...ok, lat: null, lon: null }]);
  assert.equal(errors.length, 0);
  assert.equal(sources.length, 1, "a deliberate null must not cost an elevator its reading");
  assert.match(warnings.join(" "), /no coordinates/);
  assert.match(warnSource({ ...ok, inMerge: false }).join(" "), /kept off the map/);
});

test("the declared knobs have to be knobs this code knows", () => {
  for (const m of CASH_ROUNDING_MODES) assert.deepEqual(errs({ cashRounding: m }), []);
  for (const u of FUTURES_UNITS) assert.deepEqual(errs({ futuresUnits: u }), []);
  assert.match(errs({ cashRounding: "nearest-cent" })[0], /is not one of/);
  assert.match(errs({ futuresUnits: "eighths" })[0], /is not one of/);
});

/* ---- secrets ------------------------------------------------------------- */

test("a key may never be in a manifest or in a url", () => {
  assert.match(errs({ apiKey: "exwhqAFLCNJeAo9hG8gjGj8r1APimbja" })[0], /carries an apiKey/);
  assert.match(errs({ url: "https://api.dtn.com/x?apikey=abc123" })[0], /key in its url/);
  assert.match(errs({ apiKeyEnv: "exwhqAFLCNJeAo9hG8gjGj8r1APimbja" })[0], /NAME of an environment variable/);
  assert.deepEqual(errs({ apiKeyEnv: "DTN_CS_API_KEY" }), []);
});

test("every shipped manifest is free of a key, in the file and in the url", async () => {
  const dir = new URL("../sources/", import.meta.url);
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    assert.ok(!("apiKey" in s), `${f} carries an apiKey`);
    assert.ok(!/[?&]apikey=/i.test(s.url), `${f} has a key in its url`);
  }
});

/* ---- the wire ----------------------------------------------------------- */

test("every platform declares what comes back on the wire", () => {
  for (const p of PLATFORMS) assert.ok(p in PLATFORM_WIRE, `${p} has no wire type`);
  assert.equal(wireOf("dtn-cs"), "json");
  assert.equal(wireOf("graindesk"), "json");
  assert.equal(wireOf("cashbidssingle"), "html");
  assert.equal(wireOf("aghost"), "html");
  /* An unknown platform defaults to html rather than throwing: validation has
     already refused it by the time anything asks. */
  assert.equal(wireOf("who-knows"), "html");
});

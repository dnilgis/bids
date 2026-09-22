/* A MANIFEST MAY SAY WHICH BARCHART ROW IT IS, AND ONLY BY EXACT KEY.
 *
 * scripts/build_directory.mjs never joins on name and town, because a town can
 * hold three elevators. `sameAsKnown` is the one way a row is dropped without a
 * phone match: a person wrote the key into the manifest. What can go wrong
 * silently is a key that stopped matching (the grey pin comes back and nobody
 * notices) or a declaration that drifts into a guess. These hold both.
 *
 * Measured on 2026-09-21 data before shipping: the build dropped exactly the
 * two declared rows and changed no other row of 8,099.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const known = JSON.parse(readFileSync(join(ROOT, "geocodes/places.json"), "utf8")).known || {};
const sources = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")));
const declaring = sources.filter((s) => s.sameAsKnown !== undefined);

test("the two Emmert elevators declare their Barchart rows", () => {
  const by = Object.fromEntries(declaring.map((s) => [s.id, s.sameAsKnown]));
  assert.deepEqual(by["badgergrain-wheeler"], ["Badger Grain Supply|Badger Grain Supply|Wheeler|WI"]);
  assert.deepEqual(by["midwestcommodity-baldwin"], ["Midwest Commodity Services Inc.|Baldwin|Baldwin|WI"]);
});

test("EVERY DECLARED KEY STILL EXISTS, so no grey pin can come back unnoticed", () => {
  for (const s of declaring) {
    assert.ok(Array.isArray(s.sameAsKnown) && s.sameAsKnown.length, `${s.id}: sameAsKnown is not a list`);
    for (const k of s.sameAsKnown)
      assert.ok(k in known, `${s.id} declares "${k}", which is not a known elevator any more`);
  }
});

test("a declared row is in the manifest's own state and town", () => {
  /* The key is facility|branch|city|state. A declaration naming another town
     is a typo that would hide a real elevator somewhere else. */
  const t = (x) => String(x || "").toLowerCase().replace(/[^a-z]/g, "");
  for (const s of declaring)
    for (const k of s.sameAsKnown) {
      const parts = k.split("|");
      assert.equal(parts.at(-1), s.state, `${s.id}: "${k}" is in another state`);
      assert.equal(t(parts.at(-2)), t(s.location), `${s.id}: "${k}" is in another town`);
    }
});

test("no key is declared by two sources", () => {
  const seen = new Map();
  for (const s of declaring) for (const k of s.sameAsKnown) {
    assert.ok(!seen.has(k), `"${k}" is declared by both ${seen.get(k)} and ${s.id}`);
    seen.set(k, s.id);
  }
});

test("the build drops declared rows only, and only for sources it emits", () => {
  const src = readFileSync(join(ROOT, "scripts/build_directory.mjs"), "utf8");
  assert.match(src, /for \(const s of active\)\s*\n\s*for \(const kid of Array\.isArray\(s\.sameAsKnown\)/,
    "sameAsKnown is read from every source, not just the active ones");
  assert.match(src, /if \(!declaredSame\.has\(kid\)\) return true;/);
  assert.match(src, /no known elevator has that key any more/, "a stale declaration is no longer reported");
});

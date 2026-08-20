/* The token sweep. It makes real requests, so the only part worth testing is
 * the part that decides WHICH requests: a variant generator that drops the
 * shape a real token happens to take is a sweep that reports "nothing there". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugVariants } from "../scripts/gd-sweep.mjs";

test("the two tokens we KNOW exist are generated from their company names", () => {
  /* If either of these ever stops appearing, the sweep has gone blind. */
  assert.ok(slugVariants("Albert Lea Elevator").includes("albertleaelevator"));
  assert.ok(slugVariants("St Lawrence Grain").includes("stLawrenceGrain"),
    `camelCase variant missing: ${JSON.stringify(slugVariants("St Lawrence Grain"))}`);
});

test("Co-Op is one word", () => {
  /* Splitting on the hyphen leaves "co" and "op", and "co" is then dropped as a
     company suffix — which turned River Country Co-Op into "rivercountryop"
     and would have missed a real token by one letter. */
  const v = slugVariants("River Country Co-Op");
  assert.ok(v.includes("rivercountrycoop"), JSON.stringify(v));
  assert.ok(!v.some((s) => s.includes("countryop")), JSON.stringify(v));
});

test("company suffixes and punctuation are stripped, not squashed in", () => {
  const v = slugVariants("Agassiz Valley Grain, LLC");
  assert.ok(v.includes("agassizvalleygrain"), JSON.stringify(v));
  assert.ok(!v.some((s) => s.includes("llc")), JSON.stringify(v));
  assert.ok(slugVariants("Smith & Sons Grain").some((s) => s.includes("and")),
    "an ampersand should become 'and', not vanish");
});

test("nothing shorter than four characters is asked for", () => {
  /* Two-letter tokens are noise: they cost requests and any hit would be a
     coincidence rather than a company. */
  for (const v of slugVariants("A B")) assert.ok(v.length >= 4, v);
  assert.deepEqual(slugVariants(""), []);
  assert.deepEqual(slugVariants("   "), []);
});

test("variants are unique, so no name is asked twice", () => {
  const v = slugVariants("Grain");
  assert.equal(new Set(v).size, v.length, JSON.stringify(v));
});

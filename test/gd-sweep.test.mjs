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

/* THE ONLY CORPUS THIS GENERATOR HAS: the tokens known to exist.
 *
 * Four of these came out of a page or a bundle. `sunriseagcoop` came out of a
 * person typing the abbreviation the company uses on its own domain, and on
 * 2026-08-20 the generator still could not produce it — it offered
 * sunriseagcooperative, sunriseAgCooperative, sunrise-ag-cooperative and
 * sunriseag. A candidate generator that cannot produce the one hit a sweep has
 * ever had is not generating candidates, it is generating confidence.
 *
 * If a sixth token is ever found, add it here first and make the generator
 * reach it. That is the whole discipline available on a guessing game whose
 * negative answer carries no information.
 */
test("every token known to exist is reachable from its company name", () => {
  const known = [
    ["Sunrise Ag Cooperative", "sunriseagcoop"],
    ["Albert Lea Elevator", "albertleaelevator"],
    ["BAB Grain", "babgrain"],
    ["St Lawrence Grain", "stLawrenceGrain"],
    ["Lockie Farms", "lockiefarms"],
  ];
  for (const [name, token] of known)
    assert.ok(slugVariants(name).includes(token),
      `${name} -> ${slugVariants(name).join(", ")} does not contain ${token}`);
});

test("the abbreviation swap goes both ways and costs nothing on a name without it", () => {
  assert.ok(slugVariants("River Country Co-Op").includes("rivercountrycooperative"));
  assert.ok(slugVariants("River Country Co-Op").includes("rivercountrycoop"));
  /* A name with neither spelling gains no extra candidates. */
  assert.deepEqual(slugVariants("BAB Grain"), ["babgrain", "babGrain", "bab-grain"]);
});

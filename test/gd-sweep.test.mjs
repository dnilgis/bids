/* The token sweep. It makes real requests, so the only part worth testing is
 * the part that decides WHICH requests: a variant generator that drops the
 * shape a real token happens to take is a sweep that reports "nothing there". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugVariants, CONTROL_TOKENS, isLead, controlReport } from "../scripts/gd-sweep.mjs";
import { readFileSync } from "node:fs";

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

/* ---- the sweep has to be able to find what it already knows -------------- */

test("every control token is reachable from the shipped candidate list", () => {
  /* The 2026-08-20 sweep tried 1,252 tokens, reported five hits, and looked
     like a clean result — while missing `sunriseagcoop`, confirmed working the
     day before. The list said "Sunrise Cooperative"; the company is "Sunrise Ag
     Cooperative", so the token was never generated and never tried. Nothing in
     the output could have told you that.
     A 401 is returned for a private token AND for one that does not exist, so
     a negative carries no information. Without a control group, "no new hits"
     and "the sweep is broken" are the same log line. */
  const list = readFileSync(new URL("../probe-lists/gd-candidates.txt", import.meta.url), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const tokens = new Set(list.flatMap(slugVariants));
  for (const t of CONTROL_TOKENS)
    assert.ok(tokens.has(t), `no name in gd-candidates.txt generates the known token ${t}`);
});

test("the control group is exactly the tokens known to answer on the shared host", () => {
  /* lockiefarms is deliberately NOT here: that customer has its own API host —
     see the Rf override map quoted in lib/adapters/graindesk.mjs — so it is
     expected to fail against marketplace.graindiscovery.com and would be a
     false alarm on every run. */
  assert.ok(!CONTROL_TOKENS.includes("lockiefarms"));
  assert.ok(CONTROL_TOKENS.includes("sunriseagcoop"));
  assert.equal(new Set(CONTROL_TOKENS).size, CONTROL_TOKENS.length, "no duplicates");
});

test("a 401 is not a lead and anything else is", () => {
  /* 401 means private OR nonexistent, so it says nothing. A 500 carrying
     `{"error":"Error fetching bids"}` means the server got as far as looking
     the company up — five candidates did exactly that on 2026-08-20 and they
     are leads, not noise. */
  assert.equal(isLead({ status: 401, verdict: "no such token" }), false);
  assert.equal(isLead({ status: 200, verdict: "HIT" }), false);
  assert.equal(isLead({ status: 500, verdict: "HTTP 500" }), true);
  assert.equal(isLead({ status: 200, verdict: "200 but not JSON" }), true);
  assert.equal(isLead({ status: 0, verdict: "fetch failed: ETIMEDOUT" }), true);
});

test("a sweep that loses a control token is reported as inconclusive, not clean", () => {
  /* This check lived inside the script body first, where no test could reach
     it — so the guard against a silent sweep was itself silent. That is the
     same shape as the bug it exists to catch. */
  const hit = (token) => ({ token, verdict: "HIT" });
  const all = CONTROL_TOKENS.map(hit);
  assert.deepEqual(controlReport(all), { ok: true, lost: [], checked: CONTROL_TOKENS.length });

  const missing = all.filter((r) => r.token !== "sunriseagcoop");
  const r = controlReport(missing);
  assert.equal(r.ok, false);
  assert.deepEqual(r.lost, ["sunriseagcoop"]);

  /* A 401 on a control token is exactly the 2026-08-20 situation and must not
     read as a hit. */
  assert.equal(controlReport([{ token: "sunriseagcoop", verdict: "no such token", status: 401 }],
                             ["sunriseagcoop"]).ok, false);
  assert.equal(controlReport([], ["a"]).ok, false);
  assert.equal(controlReport(null, []).ok, true, "no control group, nothing to prove");
});

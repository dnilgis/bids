/* The DTN site probe — what one site id is hiding, and what its manifests
 * would have to say.
 *
 * The part worth testing hardest is `roundingEvidence`. `cashRounding` decides
 * whether a board's cash cell is the arithmetic exactly, rounded, or floored.
 * Declare it wrong one way and a perfectly good board is refused for ever;
 * declare it wrong the other way and the one guard that proves we read the
 * right columns is loosened by up to a cent on every row. So the probe must
 * MEASURE it and must refuse to name a rule that does not explain every row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { roundingEvidence, skeleton, ask } from "../scripts/dtn-probe.mjs";
import { extract } from "../lib/adapters/dtn-cs.mjs";
import { validateSource } from "../lib/sources.mjs";

const body = readFileSync(new URL("../fixtures/dtn-cs-agpartners-e0172401.json", import.meta.url), "utf8");
const URL_ = "https://api.dtn.com/markets/sites/e0172401/cash-bids?units=us";
const rows = extract(body, URL_);

test("the real capture is explained by FLOOR and by nothing else", () => {
  const ev = roundingEvidence(rows);
  assert.equal(ev.testable, 25);
  assert.equal(ev.exact, 4);
  assert.equal(ev.round, 11);
  assert.equal(ev.floor, 25);
  assert.equal(ev.mode, "floor-cent");
  /* The residuals are the eighths remainder of their own futures quote and
     nothing else. Anything outside this set would mean the rule is a
     coincidence rather than their arithmetic. */
  assert.deepEqual(ev.residuals, [0, 0.25, 0.75]);
});

test("a rule that explains most rows explains none of them", () => {
  /* The rows a rule misses are the ones that would have told us something.
     Naming a mode on a 24-of-25 fit is how a wrong number gets a green tick. */
  const r = (o) => ({ cash: 4.29, basis: -0.5, futuresPrice: 479, ...o });
  assert.equal(roundingEvidence([r(), r(), r()]).mode, "exact");
  assert.equal(roundingEvidence([r(), r(), r({ futuresPrice: 479.75 })]).mode, "floor-cent");
  /* One row a whole cent out: floor cannot explain it, exact cannot either. */
  assert.equal(roundingEvidence([r(), r(), r({ futuresPrice: 480.5 })]).mode, null);
  /* Cash a quarter cent HIGH is not anybody's rounding. */
  assert.equal(roundingEvidence([r({ futuresPrice: 478.75 })]).mode, null);
});

test("a row with no quote is not counted as evidence for anything", () => {
  const ev = roundingEvidence([{ cash: 4.29, basis: -0.5, futuresPrice: null }, { cash: null }]);
  assert.equal(ev.testable, 0);
  assert.equal(ev.mode, null, "no testable row means no rule has been established");
});

test("one skeleton per location, keyed on the id the feed uses", () => {
  const s = skeleton(rows, { siteId: "e0172401", url: URL_, page: "https://agpartners.net/cash-bids/", operator: "Ag Partners Cooperative" });
  assert.equal(s.length, 4);
  assert.deepEqual(s.map((x) => x.manifest.locationId).sort(), ["25078", "25686", "7239", "7240"]);
  const rw = s.find((x) => x.manifest.locationId === "7239");
  assert.equal(rw._rows, 16);
  assert.deepEqual(rw._commodities, ["Corn", "Soybeans"]);
  assert.equal(rw.manifest.location, "Red Wing Grain LLC");
  assert.equal(rw.manifest.cashRounding, "floor-cent");
  assert.deepEqual(rw.manifest.bands, { corn: [2.0, 12.0], soybeans: [6.0, 25.0] });
});

test("the skeleton refuses to invent the two things the feed does not know", () => {
  const s = skeleton(rows, { siteId: "e0172401", url: URL_, page: "https://agpartners.net/cash-bids/" });
  for (const x of s) {
    assert.equal(x.manifest.lat, null, "the feed carries no coordinate and a centroid is a different place");
    assert.equal(x.manifest.lon, null);
    assert.equal(x.manifest.enabled, false, "nothing ships enabled off a probe");
    assert.match(x.manifest.note, /SET THIS/);
    assert.equal(x.manifest.operator, "SET THIS");
    assert.ok(!("apiKey" in x.manifest), "a probe must not put a key in a manifest");
    assert.ok(!("apiKeyEnv" in x.manifest), "a browser source holds no key at all -- theirs is in their own page");
    assert.ok(!/apikey=/i.test(x.manifest.url));
    assert.equal(x.manifest.browserPage, "https://agpartners.net/cash-bids/");
  }
});

test("a skeleton with its blanks filled is a manifest the loader accepts", () => {
  /* The point of the skeleton is that the only work left is the work that
     needs a human: which town, where it is, and where that came from. */
  const [first] = skeleton(rows, { siteId: "e0172401", url: URL_, page: "https://agpartners.net/cash-bids/", operator: "Ag Partners Cooperative" });
  const filled = {
    ...first.manifest, id: "agpartners-redwing", state: "MN",
    website: "https://agpartners.net/cash-bids/",
    note: "Confirmed from Sig's own network capture on 2026-08-20.",
    lat: 44.564869, lon: -92.541631,
  };
  assert.deepEqual(validateSource(filled), []);
});

test("the mode is left OUT when nothing explains the board, so it refuses loudly", () => {
  /* Silence here is the right answer: with no cashRounding the identity guard
     stays strict, and a board whose arithmetic we have not understood refuses
     with the residuals printed rather than publishing under a guess. */
  const odd = rows.map((r, i) => (i === 0 ? { ...r, cash: r.cash + 0.05 } : r));
  const s = skeleton(odd, { siteId: "e0172401", url: URL_, page: "https://agpartners.net/cash-bids/" });
  const rw = s.find((x) => x.manifest.locationId === "7239");
  assert.equal(rw._evidence.mode, null);
  assert.ok(!("cashRounding" in rw.manifest));
});

test("the key goes in a header and never into the URL the probe prints", () => {
  /* This script logs the URLs it asks for, and this is a public repository
     whose Actions logs anybody can read. */
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return { status: 200, ok: true, text: async () => "[]" };
  };
  try {
    return ask("/sites/E0266901/cash-bids?units=us", { key: "SUPERSECRET" }).then((r) => {
      assert.equal(seen.length, 1);
      assert.equal(seen[0].headers.apikey, "SUPERSECRET");
      assert.ok(!seen[0].url.includes("SUPERSECRET"), "the key must not be in the url");
      assert.ok(!/apikey=/i.test(seen[0].url));
      assert.ok(!r.url.includes("SUPERSECRET"), "nor in what it returns for printing");
    });
  } finally { globalThis.fetch = real; }
});

test("a failure comes back as a value, not as a thrown error", () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  try {
    return ask("/sites/x/cash-bids", { key: "k" }).then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.status, 0);
      assert.match(r.error, /ENOTFOUND/);
    });
  } finally { globalThis.fetch = real; }
});

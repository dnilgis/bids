/* The recon script, on the shapes it will actually meet.
 *
 * These URLs are the ones this project has measured -- Ag Partners' DTN feed,
 * Big River's board, Flash Grain's AgHost page, Albert Lea's Grain Desk slug,
 * Farmers Cooperative Society's fragment -- plus the four families the
 * 2026-08-20 sweep found on dozens of co-operatives each and that nothing can
 * yet read. A signature that stops matching is an operator that silently
 * becomes "no known platform", which reads like an answer and is not one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerprint, findFeeds, countLocations, readList, SIGNATURES } from "../scripts/discover.mjs";
import { looksLikeData } from "../lib/cdp.mjs";

const KNOWN = {
  "dtn-cs":         "https://api.dtn.com/markets/sites/e0172401/cash-bids?units=us",
  "graindesk":      "https://marketplace.graindiscovery.com/api/public-sites/albertleaelevator/cash-bids",
  "aghost":         "https://flashgrains.com/index.cfm?show=11&mid=3",
  "cashbidssingle": "https://example.test/cashbidssingle-2121",
  "fragment":       "https://www.farmerscoopsociety.com/ajax/homepage/dtn-cash-bids",
  "stonehedge":     "https://stonehedge.stonex.com/component/bids?key=REDACTEDKEYVALUE&cols=name,cash",
  "barchart":       "https://new.marketplace.barchart.com/cash-bids",
  "bushel":         "https://portal.bushelpowered.com/arthur/welcome",
  "agricharts":     "https://www.heartlandcoop.com/markets/cashgrid.php",
};

for (const [platform, url] of Object.entries(KNOWN)) {
  test(`recognises ${platform}`, () => {
    assert.equal(fingerprint(url)?.platform, platform, url);
  });
}

test("every signature in the table is covered by a test above", () => {
  // Otherwise a signature can be added, never exercised, and be wrong.
  const tested = new Set(Object.keys(KNOWN));
  const missing = SIGNATURES.map((s) => s.platform).filter((p) => !tested.has(p));
  assert.deepEqual(missing, [], `untested signatures: ${missing.join(", ")}`);
});

test("the DTN site id comes back, and is the path segment", () => {
  assert.equal(fingerprint(KNOWN["dtn-cs"]).siteId, "e0172401");
});

test("the Grain Desk slug comes back", () => {
  assert.equal(fingerprint(KNOWN.graindesk).slug, "albertleaelevator");
});

test("THE STONEX KEY IS NEVER REPORTED, only that there is one", () => {
  // It is somebody's credential and this log is a public Actions log. The
  // fact that a key is required is the finding; its value is not.
  const f = fingerprint(KNOWN.stonehedge);
  assert.equal(f.key, "<present>");
  assert.ok(!JSON.stringify(f).includes("REDACTEDKEYVALUE"), JSON.stringify(f));
});

test("noise is not a platform", () => {
  for (const u of [
    "https://www.google-analytics.com/collect?v=2",
    "https://fonts.gstatic.com/s/inter.woff2",
    "https://example.test/",
    "https://cdn.example.test/bundle.js",
  ]) assert.equal(fingerprint(u), null, u);
});

test("a malformed url is not a match and does not throw", () => {
  assert.equal(fingerprint("not a url"), null);
  assert.equal(fingerprint(""), null);
});

test("api.dtn.com is matched on the host, not on a substring of it", () => {
  // `includes("api.dtn.com")` would match an attacker-shaped or merely
  // confusing host, and this decides which adapter parses the bytes.
  assert.equal(fingerprint("https://api.dtn.com.evil.test/markets/sites/x/cash-bids"), null);
});

test("the same feed asked for twice is one feed", () => {
  const r = { responses: [
    { url: KNOWN["dtn-cs"], status: 200, mime: "application/json", body: "[]" },
    { url: KNOWN["dtn-cs"] + "&_=1724170000", status: 200, mime: "application/json", body: "[]" },
  ] };
  assert.equal(findFeeds(r).length, 1);
});

test("two different platforms on one page are two feeds", () => {
  const r = { responses: [
    { url: KNOWN["dtn-cs"], status: 200, mime: "application/json", body: "[]" },
    { url: KNOWN.barchart, status: 200, mime: "text/html", body: "" },
  ] };
  assert.equal(findFeeds(r).length, 2);
});

test("a dedupe prefers the copy that actually has a body", () => {
  const r = { responses: [
    { url: KNOWN["dtn-cs"], status: 200, mime: "application/json", body: null },
    { url: KNOWN["dtn-cs"], status: 200, mime: "application/json", body: "[1]" },
  ] };
  assert.equal(findFeeds(r)[0].bytes, 3);
});

test("counts the towns behind Ag Partners' real payload", () => {
  // FOUR, AND NOT THIRTEEN. Thirteen is the figure for the LIVE feed -- 208
  // rows captured 2026-08-20 -- and this fixture is a 25-row excerpt of it
  // carrying Red Wing Grain LLC, Goodhue, Eyota and Traverse. The first draft
  // of this test asserted 13 because 13 is the number in the project's notes,
  // which is how a headline figure gets attached to a file that never
  // contained it. Counted from the bytes in the repository, not recalled.
  const body = readFileSync(new URL("../fixtures/dtn-cs-agpartners-e0172401.json", import.meta.url), "utf8");
  const rows = JSON.parse(body);
  assert.equal(rows.length, 25, "the fixture changed; re-derive the expected count");
  assert.equal(countLocations(body), new Set(rows.map((r) => r.location.id)).size);
  assert.equal(countLocations(body), 4);
});

test("null is not zero", () => {
  // "no towns in this feed" and "this shape is not one I can count" are
  // different findings and the log must not merge them.
  assert.equal(countLocations("not json"), null);
  assert.equal(countLocations("[]"), null);
  assert.equal(countLocations(null), null);
  assert.equal(countLocations('[{"cash":1}]'), null, "no location key at all");
});

test("a row missing its location does not shrink the count silently", () => {
  // Counting distinct values over a partial column would report 1 town for a
  // feed whose second row has no town, which is worse than reporting nothing.
  assert.equal(countLocations('[{"location":"A"},{"cash":2}]'), null);
});

test("looksLikeData keeps feeds and drops furniture", () => {
  assert.ok(looksLikeData("https://x.test/api/cash-bids", "application/json"));
  assert.ok(looksLikeData("https://x.test/markets/cashgrid.php", "text/html"));
  assert.ok(!looksLikeData("https://x.test/about", "text/html"));
});

test("THE MIME OVERRULES A TEMPTING URL", () => {
  // These are the cases that make the mime checks load-bearing, and the first
  // draft of this test did not contain them: it used `logo.png` and `app.js`,
  // whose URLs the word rule rejects anyway, so deleting either mime check
  // left every assertion passing. A widget bundle really is called
  // `cash-bids-widget.js` and a hero photo really is called `grain.jpg`, and
  // both would otherwise be kept as data and dumped into the log.
  assert.ok(!looksLikeData("https://x.test/js/cash-bids-widget.js", "application/javascript"));
  assert.ok(!looksLikeData("https://x.test/img/grain-elevator.jpg", "image/jpeg"));
  assert.ok(!looksLikeData("https://x.test/css/market-board.css", "text/css"));
  assert.ok(!looksLikeData("https://x.test/fonts/price.woff2", "font/woff2"));
});

test("the candidate list carries its own provenance", () => {
  assert.deepEqual(
    readList("# a comment\n\nhttps://a.test/bids   # Someone Co-op, WI\n\n  https://b.test/x\n"),
    ["https://a.test/bids", "https://b.test/x"]);
});

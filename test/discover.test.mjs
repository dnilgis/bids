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

/* THREE OUTCOMES, AND TWO OF THEM LOOK IDENTICAL IF YOU ONLY COUNT FEEDS.
 *
 * Found by inspection on 2026-08-20: pointed at a closed port, captureAll
 * returned zero responses, no error, and a clean-looking result -- exactly
 * what a page that loads fine and runs an unrecognised widget returns. Across
 * a batch of fifty-six that is the difference between the adapter queue and a
 * retry list. Page.navigate reports it; nothing was asking.
 */
import { verdict } from "../scripts/discover.mjs";

const DTN = "https://api.dtn.com/markets/sites/e0172401/cash-bids?units=us";

test("a recognised feed is a finding", () => {
  const v = verdict({ responses: [{ url: DTN, status: 200, mime: "application/json", body: "[]" }] });
  assert.equal(v.kind, "feeds");
  assert.equal(v.feeds.length, 1);
});

test("a page that loaded but ran something unknown is THE QUEUE", () => {
  const v = verdict({ responses: [
    { url: "https://portal.bushelpowered.com/x/cash-bids", status: 200, mime: "application/json", body: "[]" },
  ], navError: null });
  // bushel has a signature, so use a host that has none:
  const w = verdict({ responses: [
    { url: "https://widgets.example.test/board", status: 200, mime: "text/html", body: "" },
  ], navError: null });
  assert.equal(w.kind, "no-platform");
  assert.deepEqual(w.hosts, ["widgets.example.test"]);
  assert.equal(v.kind, "feeds", "bushel is recognised even without an adapter");
});

test("a page that never loaded is NOT a finding about the operator", () => {
  const v = verdict({ responses: [], navError: "net::ERR_NAME_NOT_RESOLVED" });
  assert.equal(v.kind, "unreachable");
  assert.equal(v.why, "net::ERR_NAME_NOT_RESOLVED");
});

test("a thrown capture is unreachable, not an empty page", () => {
  const v = verdict({ responses: [], error: "the devtools socket never opened" });
  assert.equal(v.kind, "unreachable");
});

test("a navigation error does not mask a feed that still arrived", () => {
  // A page can report a nav error for a sub-resource path and still have
  // delivered the board. The feed wins: we have the bytes.
  const v = verdict({ responses: [{ url: DTN, status: 200, mime: "application/json", body: "[]" }],
                      navError: "net::ERR_ABORTED" });
  assert.equal(v.kind, "feeds");
});

test("no responses and no error at all is still the queue, not a retry", () => {
  assert.equal(verdict({ responses: [] }).kind, "no-platform");
});

/* WHAT THE FIRST REAL RUN TAUGHT, 2026-08-20.
 * Twenty co-operative pages on the runner. Six recognised feeds, and four
 * defects in this script that only real traffic could have shown.
 */
import { roster } from "../scripts/discover.mjs";

test("bushelops.com is Bushel too", () => {
  // Gateway FS called centre.bushelops.com and futures.bushelops.com and was
  // filed as "no known platform".
  for (const h of ["https://centre.bushelops.com/x", "https://futures.bushelops.com/y",
                   "https://portal.bushelpowered.com/z", "https://a.o.bushelsites.com/cash-bids"])
    assert.equal(fingerprint(h)?.platform, "bushel", h);
});

test("a vendor's domain with no matching path is a LEAD, not a shrug", () => {
  // Five Star called api.dtn.com 204 times; the run said "no known platform".
  const v = verdict({ responses: [
    { url: "https://api.dtn.com/some/other/path", status: 200, mime: "application/json" },
    { url: "https://www.google-analytics.com/collect", status: 200, mime: "" },
  ] });
  assert.equal(v.kind, "no-platform");
  assert.deepEqual(v.leads, [{ platform: "dtn-cs", host: "api.dtn.com" }]);
});

test("a lead names its host, so a weather widget can be dismissed", () => {
  // Topflight calls agwx.dtn.com. Right vendor, wrong product.
  assert.equal(verdict({ responses: [{ url: "https://agwx.dtn.com/w", status: 200, mime: "" }] })
    .leads[0].host, "agwx.dtn.com");
});

test("NO BODY is not an EMPTY body", () => {
  // The run printed "0B" for StoneHedge, Barchart and a 403 from Pearl City.
  // Three handed over nothing; one answered with nothing. Same display.
  const none  = findFeeds({ responses: [{ url: KNOWN.stonehedge, status: 200, mime: "text/html", body: null }] })[0];
  const empty = findFeeds({ responses: [{ url: KNOWN.barchart,   status: 200, mime: "text/html", body: "" }] })[0];
  assert.equal(none.bytes, null, "a body that never arrived");
  assert.equal(empty.bytes, 0, "a body that arrived and was empty");
});

test("a truncated body says so", () => {
  const f = findFeeds({ responses: [
    { url: KNOWN.agricharts, status: 200, mime: "text/html", body: "x".repeat(400000), truncated: true }] })[0];
  assert.equal(f.truncated, true);
});

test("the roster gives the towns, which is what a source file needs", () => {
  const body = readFileSync(new URL("../fixtures/dtn-cs-agpartners-e0172401.json", import.meta.url), "utf8");
  const names = roster(body);
  assert.equal(names.length, countLocations(body));
  assert.deepEqual(names.map((n) => n.name).sort(),
    ["Eyota", "Goodhue", "Red Wing Grain LLC", "Traverse"]);
  assert.ok(names.every((n) => n.id != null), "a town without its id cannot be keyed");
});

test("an unreadable roster is null, not an empty list", () => {
  assert.equal(roster("[]"), null);
  assert.equal(roster("not json"), null);
  assert.equal(roster('[{"cash":1}]'), null);
  assert.equal(roster(null), null);
});

/* ---- A BYTE COUNT IS NOT EVIDENCE ----------------------------------------
 *
 * The 2026-08-20 sweep found ten Bushel operators — seven of them CHS regions,
 * the largest single win left — and reported each as
 * `200 application/json 899B  .../GetMarketsConfig`. Eight hundred and
 * ninety-nine bytes captured, held, and thrown away. A config that small is
 * almost certainly naming the request that carries the board.
 */
import { peek, redactBody, candidates, shouldPeek } from "../scripts/discover.mjs";

test("a small config is printed, so it can name the next request", () => {
  const body = '{"marketsUrl":"https://api.bushelpowered.com/v1/cash-bids","siteId":"chs-il"}';
  const p = peek(body);
  assert.match(p, /cash-bids/);
  assert.match(p, /chs-il/);
});

test("THEIR KEY STILL DOES NOT GO IN OUR LOG", () => {
  // Public in their own page, and that is not a reason to write it down.
  const p = peek('{"url":"https://a.test/b","apikey":"SECRET123","token":"T0K3N"}');
  assert.doesNotMatch(p, /SECRET123/);
  assert.doesNotMatch(p, /T0K3N/);
  assert.match(p, /<redacted>/);
  assert.match(p, /a\.test/, "the useful part survives redaction");
});

test("a key in a query string inside a body is redacted too", () => {
  assert.doesNotMatch(redactBody("see https://a.test/b?apikey=ABC123&units=us"), /ABC123/);
  assert.match(redactBody("see https://a.test/b?apikey=ABC123&units=us"), /units=us/);
});

test("the peek is bounded, because a log is not a place to paste a page", () => {
  const p = peek("x".repeat(5000), 600);
  assert.ok(p.length < 700, `peek was ${p.length} chars`);
  assert.match(p, /\[\+4400 more\]/);
});

test("nothing to peek at is null, not an empty line", () => {
  assert.equal(peek(null), null);
  assert.equal(peek(""), null);
  assert.equal(peek("   \n\t "), null);
});

test("candidates ranks the board above the bundle", () => {
  const c = candidates({ responses: [
    { url: "https://x.test/main.js", mime: "application/javascript", status: 200, body: "x".repeat(90000) },
    { url: "https://api.x.test/v1/cash-bids", mime: "application/json", status: 200, body: "{}".repeat(500) },
    { url: "https://x.test/hero.png", mime: "image/png", status: 200, body: null },
  ]});
  assert.equal(c[0].url, "https://api.x.test/v1/cash-bids");
  assert.ok(!c.some((r) => /\.js$|\.png$/.test(r.url)), "a bundle or an image is not a candidate");
});

test("AND A FAILED RESPONSE IS NOT A CANDIDATE", () => {
  // A 404 on a bid-shaped URL is the loudest possible false lead.
  const c = candidates({ responses: [
    { url: "https://api.x.test/v1/cash-bids", mime: "application/json", status: 404, body: "" },
  ]});
  assert.deepEqual(c, []);
});

test("no responses is not a crash", () => {
  assert.deepEqual(candidates({ responses: [] }), []);
  assert.deepEqual(candidates({}), []);
  assert.deepEqual(candidates(null), []);
});

test("A BODY IS ONLY PRINTED WHEN IT IS A LEAD AND NOT AN ANSWER", () => {
  // The Bushel case: 899 bytes, no towns, no roster — print it.
  assert.equal(shouldPeek({ towns: null, names: null, bytes: 899 }), true);
  // A roster IS the answer; the body adds nothing.
  assert.equal(shouldPeek({ towns: 13, names: null, bytes: 899 }), false);
  assert.equal(shouldPeek({ towns: null, names: [{ id: 1, name: "Dunlap" }], bytes: 899 }), false);
  // A board is tens of thousands of bytes and pasting one in a log helps nobody.
  assert.equal(shouldPeek({ towns: null, names: null, bytes: 45608 }), false);
  // Nothing was handed over, and an empty body is not a lead.
  assert.equal(shouldPeek({ towns: null, names: null, bytes: null }), false);
  assert.equal(shouldPeek({ towns: null, names: null, bytes: 0 }), false);
  // An empty roster array is not a roster.
  assert.equal(shouldPeek({ towns: null, names: [], bytes: 899 }), true);
});

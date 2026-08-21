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

/* ---- A TYPO MUST NOT BE ABLE TO IMPERSONATE A FINDING ---------------------
 *
 * 2026-08-21: a stray "s" left in the workflow's `urls` box silently overrode a
 * `list` selection of bushel-candidates. The run asked one page, called "s",
 * got "Cannot navigate to invalid URL", and the tally reported
 * `unreachable (retry these): 1` — which reads exactly like a co-operative
 * whose site was down and is worth another go.
 */
import { badTargets, refuseRun } from "../scripts/discover.mjs";

test("a real page is accepted", () => {
  assert.deepEqual(badTargets(["https://www.allied.coop/grain/cash-bids",
                               "http://grain.northsideelevator.com/index.cfm?show=11"]), []);
});

test("A STRAY CHARACTER IS REFUSED, NOT PROBED", () => {
  assert.deepEqual(badTargets(["s"]), ["s"]);
  assert.deepEqual(badTargets([""]), [""]);
  assert.deepEqual(badTargets(["www.aceethanol.com"]), ["www.aceethanol.com"],
    "no scheme is not a url, however much it looks like one");
});

test("and so is anything that is not the web", () => {
  // Pointing a browser at the runner's own disk is not a thing this tool
  // should be able to be asked to do.
  for (const u of ["file:///etc/passwd", "data:text/html,x", "ftp://a.test/b", "javascript:1"])
    assert.deepEqual(badTargets([u]), [u], u);
});

test("one bad entry condemns the batch, rather than being dropped", () => {
  // A run that quietly drops one of twenty is a run whose tally cannot be
  // trusted — and the tally is the whole output.
  const list = ["https://a.test/b", "s", "https://c.test/d"];
  assert.deepEqual(badTargets(list), ["s"]);
});

test("nothing at all is not a crash", () => {
  assert.deepEqual(badTargets([]), []);
  assert.deepEqual(badTargets(null), []);
  assert.deepEqual(badTargets(undefined), []);
});

test("THE REFUSAL ITSELF IS TESTED, NOT JUST THE PREDICATE", () => {
  /* Third time tonight a decision has been pulled out of a runnable block
     because no test could reach it. `if (import.meta.url === ...)` is by
     definition not under `node --test`, so anything that decides something has
     to live above that line. */
  assert.equal(refuseRun(["https://a.test/b", "https://c.test/d"]), null,
    "a clean batch is not refused");
  const r = refuseRun(["https://a.test/b", "s"]);
  assert.ok(Array.isArray(r), "a batch with a typo in it is refused");
  assert.equal(r.length, 2, "one line per bad entry, plus the summary");
  assert.match(r[0], /^::error title=not a page::/);
  assert.match(r[0], /"s"/);
  assert.match(r.at(-1), /1 of 2 entries are not a page/);
  assert.match(r.at(-1), /LEAVE THE urls BOX EMPTY/, "and it says how to fix it");
  assert.match(refuseRun(["s"]).at(-1), /1 of 1 entry is not a page/, "singular reads right");
});

/* ---- RECOGNISING THE WRONG THING IS WORSE THAN RECOGNISING NOTHING --------
 *
 * 2026-08-21, the ten Bushel pages. Each made 33 requests. Each matched
 * exactly one "feed": an 899-byte GetMarketsConfig carrying disclaimer text
 * and a CME logo. So every page counted as recognised, the candidate list —
 * which only printed when NOTHING matched — stayed silent, and the actual
 * board sat unnamed among the other 32 responses.
 *
 * The question is not "did a signature match". It is "did we come away knowing
 * where the board is".
 */
import { shouldListCandidates } from "../scripts/discover.mjs";

test("a page that matched nothing shows its traffic", () => {
  assert.equal(shouldListCandidates([], [], []), true);
  assert.equal(shouldListCandidates(null, null, null), true);
});

test("A PAGE THAT MATCHED A CONFIG STILL SHOWS ITS TRAFFIC", () => {
  // The Bushel case exactly: one feed matched, and it taught us nothing.
  assert.equal(shouldListCandidates([{ platform: "bushel" }], [null], [null]), true);
});

test("but a page that yielded a roster does not", () => {
  // Ag-Land FS: thirteen named towns came back. The traffic list would be noise.
  assert.equal(shouldListCandidates([{ platform: "dtn-cs" }], [null],
    [[{ id: 25310, name: "Dunlap" }, { id: 4199, name: "Elmwood" }]]), false);
});

test("and neither does one that yielded a location count", () => {
  assert.equal(shouldListCandidates([{ platform: "dtn-cs" }], [13], [null]), false);
});

test("an EMPTY roster is not a roster", () => {
  // Zero named locations means the shape was read and gave nothing up, which
  // is the same position as not having read it.
  assert.equal(shouldListCandidates([{ platform: "bushel" }], [null], [[]]), true);
});

test("one feed of several yielding a roster is enough", () => {
  assert.equal(shouldListCandidates([{}, {}], [null, 3], [null, null]), false);
});

test("the peek is long enough to reach past the boilerplate", () => {
  // At 600 characters the Bushel config was cut off inside its own disclaimer
  // text, before anything useful.
  const long = '{"disclaimer":"' + "x".repeat(900) + '","marketsUrl":"https://api.test/v1/bids"}';
  assert.match(peek(long), /marketsUrl/);
});

/* ---- 81,051 BYTES IS NOT SOMETHING YOU PUT IN A LOG ----------------------
 *
 * The Bushel board from CHS Illinois is eighty-one kilobytes. An adapter
 * cannot be written without seeing its structure, and nobody wants the board
 * itself in a run log. What is actually needed is small: array or object, how
 * many entries, what keys an entry has, one value of each.
 */
import { shape } from "../scripts/discover.mjs";

const BOARD = JSON.stringify({
  type: "GetBidsListSuccess",
  bids: [{ locationName: "Rochelle", commodity: "Corn", cashPrice: 4.11, basis: -0.52,
           futuresSymbol: "ZCU26", note: "x".repeat(200) }],
  cursor: null,
});

test("the shape names the container and the row's columns", () => {
  const s = shape(BOARD).join("\n");
  assert.match(s, /bids\[0\]: object, 6 key\(s\)/);
  assert.match(s, /locationName = "Rochelle"/);
  assert.match(s, /cashPrice = 4\.11/);
  assert.match(s, /basis = -0\.52/);
});

test("A LONG VALUE IS TRUNCATED, so a board cannot arrive by the back door", () => {
  const s = shape(BOARD).join("\n");
  assert.ok(!s.includes("x".repeat(60)), "a 200-character value was printed in full");
  assert.match(s, /…/);
});

test("an array at the root is described as one", () => {
  const s = shape(JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }])).join("\n");
  assert.match(s, /array of 3/);
  assert.match(s, /\[0\]\.a = 1/);
});

test("and a huge object does not produce a huge report", () => {
  const wide = {};
  for (let i = 0; i < 500; i++) wide[`k${i}`] = i;
  const s = shape(JSON.stringify(wide));
  assert.ok(s.length < 50, `${s.length} lines from a 500-key object`);
  assert.match(s.join("\n"), /and 460 more key\(s\)/);
});

test("what is not JSON has no shape, and says so", () => {
  assert.equal(shape("not json"), null);
  assert.equal(shape(""), null);
  assert.equal(shape(null), null);
});

test("nested empty containers do not throw", () => {
  assert.ok(shape(JSON.stringify({ bids: [], meta: {} })).join("\n").includes("bids = [0]"));
});

test("EVERY BUSHEL ENDPOINT IS ITS OWN FEED", () => {
  /* `id: () => ({})` made every Bushel response on a page collapse to one in
     dedupe(), which keys on the platform plus its identifying facts. All ten
     pages on 2026-08-21 reported a single feed — the 899-byte config carrying
     a CME logo — while the board, 81,051 bytes of it from CHS Illinois, was a
     sibling response that deduped away in silence. */
  const urls = [
    "https://api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList",
    "https://api.bushelpowered.com/api/markets/aggregator/config/v1/GetMarketsConfig",
    "https://futures.bushelops.com/api/v1/cash-bids",
    "https://centre.bushelops.com/api/v1/app-config",
  ];
  for (const [u, want] of urls.map((u, i) =>
       [u, ["GetBidsList", "GetMarketsConfig", "cash-bids", "app-config"][i]]))
    assert.equal(fingerprint(u).endpoint, want, u);

  const feeds = findFeeds({ responses: urls.map((u, i) =>
    ({ url: u, status: 200, mime: "application/json", body: "x".repeat(100 * (i + 1)) })) });
  assert.equal(feeds.length, 4, "the four endpoints collapsed into fewer");
  assert.deepEqual(feeds.map((f) => f.endpoint).sort(),
    ["GetBidsList", "GetMarketsConfig", "app-config", "cash-bids"]);
});

test("but the SAME endpoint asked twice is still one feed", () => {
  // A widget that refreshes, or a retry after a 401, is not two boards.
  const u = "https://api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList";
  const feeds = findFeeds({ responses: [
    { url: u + "?t=1", status: 200, mime: "application/json", body: "aaa" },
    { url: u + "?t=2", status: 200, mime: "application/json", body: "aaa" },
  ]});
  assert.equal(feeds.length, 1);
});

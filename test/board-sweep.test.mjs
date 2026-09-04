/* THE GENERIC BOARD SWEEP
 *
 * Measured 2026-09-04 from data/platforms.json, which discover has been
 * filling for three weeks:
 *
 *     platform          sites   UNREAD
 *     aghost               38      38
 *     cashbidssingle       34      32
 *     bushel               40      16   (not swept here — see NOT_SWEEPABLE)
 *     dtn-cs               34       2
 *     graindesk            32       1
 *
 * THE FIRST RUN (91840487549) ASKED 172 AND WROTE NOTHING, and every one of
 * the three faults is tested below: a dedupe that missed 78 boards we already
 * hold, an HTML page handed to a JSON adapter, and 83 locations whose own page
 * would not give up its name.
 *
 * WHAT IS AT STAKE. This writes source manifests — files that put an elevator
 * on a map and a price in front of a farmer — from pages nobody has looked at.
 * Every check below is about the two ways that goes wrong: naming an elevator
 * we cannot place, and writing a second file for one we already read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { operatorNameFrom, sitesFor, planSite, alreadyHave, hostOf, parseArgs, SWEEPABLE,
         NOT_SWEEPABLE, boardCandidates, linkedBoards, navEvidence, readHostsOf, readKeysOf,
         siteKeyOf, WANTS_JSON, wideDirectory }
  from "../scripts/board-sweep.mjs";
import { joinDirectory } from "../scripts/agricharts-sweep.mjs";
import { extractListBids, locationHeading } from "../lib/parse.mjs";

const slugOf = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
import { adapterFor } from "../lib/adapters/index.mjs";
import { locationNames } from "../lib/parse.mjs";
import { validateSource } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fix = (f) => readFileSync(join(ROOT, "fixtures", f), "utf8");
const KNOWN = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8")).elevators;
const BYZIP = new Map(JSON.parse(readFileSync(join(ROOT, "geocodes/zip-candidates.json"), "utf8"))
  .zips.map((z) => [z.zip, z]));
const SOURCES = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")));

/* ── who the board says it belongs to ─────────────────────────────────── */

test("every non-AgriCharts fixture names its own operator", () => {
  /* Each of these matches the operator a human wrote into that board's
     manifest, which is the only check that means anything here. */
  assert.equal(operatorNameFrom(fix("flashgrain-cashbids-2026-08-19.html")), "Flash Grain");
  assert.equal(operatorNameFrom(fix("ace-3578.html")), "Ace Ethanol LLC");
  assert.equal(operatorNameFrom(fix("bigriver-2121.html")), "Big River Resources");
});

test("and the AgriCharts boards still name theirs", () => {
  /* This function has to be a superset of the one in agricharts-sweep.mjs or
     the two sweeps disagree about who an operator is. */
  assert.equal(operatorNameFrom(fix("agricharts-legacyfarmers.html")), "Legacy Farmers Cooperative");
  assert.equal(operatorNameFrom(fix("agricharts-cashgrid-agtegra.html")), "Agtegra");
});

test("boilerplate is stripped from both ends, and repeatedly", () => {
  assert.equal(operatorNameFrom("<title>Cash Bids - Ace Ethanol LLC</title>"), "Ace Ethanol LLC");
  assert.equal(operatorNameFrom("<title>Farmward Cooperative Cash Bid JSI - Cash Bids</title>"),
               "Farmward Cooperative", "the boilerplate stacks on two of the 47 cashgrid boards");
  assert.equal(operatorNameFrom("<title>Welcome to Doon Elevator | Grain Bids</title>"), "Doon Elevator");
});

test("it falls back to the h1 when there is no title", () => {
  assert.equal(operatorNameFrom(fix("fcs-cashbids-2026-08-19.html")), "Sioux Center Corn");
});

test("page furniture is not an operator", () => {
  for (const h of ["<title>Cash Bids</title>", "<title>Bids</title>", "<title>   </title>",
                   "<title>2026</title>", "<h1>Prices</h1>", ""])
    assert.equal(operatorNameFrom(h), null, `${h} was read as an operator`);
});

/* ── which sites this run asks ────────────────────────────────────────── */

test("only platforms with an adapter, and never agricharts", () => {
  /* agricharts has its own sweep, which knows about mobile boards, cashgrid
     boards and the quote pages they need. Two writers on one artefact has bitten
     this repository three times. */
  assert.ok(!SWEEPABLE.includes("agricharts"));
  assert.ok(!SWEEPABLE.includes("agricharts-cashgrid"));
  const plat = { sites: {
    "https://a.example/": { platform: "aghost", boardPage: "https://a.example/bids" },
    "https://b.example/": { platform: "barchart", boardPage: "https://b.example/bids" },
    "https://c.example/": { platform: "agricharts", boardPage: "https://c.example/bids" },
    "https://d.example/": { platform: "stonehedge", boardPage: "https://d.example/bids" },
  } };
  const got = sitesFor(plat, [], { platform: null, only: null, start: 0, limit: Infinity });
  assert.deepEqual(got.map((s) => s.platform), ["aghost"]);
});

test("a site with no board page on file is not guessed at", () => {
  const plat = { sites: { "https://a.example/": { platform: "aghost" } } };
  assert.deepEqual(sitesFor(plat, [], { platform: null, only: null, start: 0, limit: Infinity }), []);
  /* THE ONE THING THAT EXCUSES IT is a site key, because then the endpoint is
     built and the page is not needed. Four graindesk sites are in exactly that
     state: a slug on file, no boardPage discover ever captured. */
  const keyed = { sites: { "https://fcalindsay.com/markets/":
    { platform: "graindesk", ids: [{ slug: "fcalindsay" }] } } };
  assert.deepEqual(sitesFor(keyed, [], { platform: null, only: null, start: 0, limit: Infinity })
    .map((s) => s.site), ["https://fcalindsay.com/markets/"]);
});

test("a board we already read is not asked again", () => {
  /* Re-reading a board we have is a request to somebody else's server for an
     answer that is already on disk. */
  const plat = { sites: {
    "https://a.example/": { platform: "aghost", boardPage: "https://a.example/bids?x=1" },
    "https://b.example/": { platform: "aghost", boardPage: "https://boards.b.example/bids" },
  } };
  /* Matched on the HOST. A board URL we already read is on a host we already
     read, so the host is the wider and sufficient test — and it also catches a
     second board served from the same host under a different path. */
  const read = [{ url: "https://a.example/bids?x=9" }];       // same host, different query
  assert.deepEqual(sitesFor(plat, read, { platform: null, only: null, start: 0, limit: Infinity })
    .map((s) => s.site), ["https://b.example/"]);
  const read2 = [{ url: "https://boards.b.example/something-else" }];   // same host, other path
  assert.deepEqual(sitesFor(plat, read2, { platform: null, only: null, start: 0, limit: Infinity })
    .map((s) => s.site), ["https://a.example/"]);
  const read3 = [{ url: "https://www.a.example/bids" }];      // www is the same host
  assert.deepEqual(sitesFor(plat, read3, { platform: null, only: null, start: 0, limit: Infinity })
    .map((s) => s.site), ["https://b.example/"]);
});

test("a source whose url is a shared API is still matched by the site it names", () => {
  /* THE FAULT THAT COST 78 REQUESTS, run 91840487549. A bushel manifest's
     `url` is api.bushelpowered.com — the operator's own site is in
     `browserPage` and `website`. Deduping on `url` alone therefore reported
     every CHS region this repository has polled since August as unread, and
     the sweep went and asked all of them. */
  const plat = { sites: {
    "https://chs-texoma.com/": { platform: "aghost", boardPage: "https://chs-texoma.com/grain/cash-bids/" },
    "https://elsewhere.example/": { platform: "aghost", boardPage: "https://elsewhere.example/bids" },
  } };
  const viaBrowserPage = [{ url: "https://api.bushelpowered.com/api/x",
                            browserPage: "https://www.chs-texoma.com/grain/cash-bids/" }];
  assert.deepEqual(sitesFor(plat, viaBrowserPage, { platform: null, only: null, start: 0, limit: Infinity })
    .map((s) => s.site), ["https://elsewhere.example/"]);
  const viaWebsite = [{ url: "https://api.bushelpowered.com/api/x",
                        website: "https://chs-texoma.com/" }];
  assert.deepEqual(sitesFor(plat, viaWebsite, { platform: null, only: null, start: 0, limit: Infinity })
    .map((s) => s.site), ["https://elsewhere.example/"]);
  assert.ok(readHostsOf(viaBrowserPage).has("chs-texoma.com"));
  assert.ok(readHostsOf(viaWebsite).has("chs-texoma.com"));
});

test("on a platform that shares one API host the KEY decides, not the host", () => {
  /* Every dtn-cs source reads api.dtn.com and every graindesk source reads
     marketplace.graindiscovery.com. A host test on the endpoint would skip all
     of them or none of them; what identifies a board is the site key. */
  const plat = { sites: {
    "https://one.example/": { platform: "dtn-cs", boardPage: "https://one.example/cash-bids/",
                              ids: [{ siteId: "E0221901" }] },
    "https://two.example/": { platform: "dtn-cs", boardPage: "https://two.example/cash-bids/",
                              ids: [{ siteId: "E0079501" }] },
    "https://three.example/": { platform: "graindesk", boardPage: "https://three.example/",
                                ids: [{ slug: "abbyvillecoop" }] },
  } };
  const read = [{ url: "https://api.dtn.com/markets/sites/e0221901/cash-bids?units=us" },
                { url: "https://marketplace.graindiscovery.com/api/public-sites/abbyvillecoop/cash-bids" }];
  assert.deepEqual(sitesFor(plat, read, { platform: null, only: null, start: 0, limit: Infinity })
    .map((s) => s.site), ["https://two.example/"]);
  /* Case is not identity: DTN writes e0030901 in a URL and E0221901 in an id. */
  assert.ok(readKeysOf(read).has("dtn:E0221901"));
  assert.equal(siteKeyOf({ ids: [{ siteId: "e0221901" }] }, "dtn-cs"), "dtn:E0221901");
  /* A siteId declared as its own field, not only inside the URL. */
  assert.ok(readKeysOf([{ url: "https://api.dtn.com/x", siteId: "E0386101" }]).has("dtn:E0386101"));
  /* GRAIN DESK SLUGS ARE MIXED CASE — sources/ carries "addisGrain" — and a
     slug that came back capitalised differently would look like a second
     elevator and get a second manifest. Identity folds; the URL does not.
     Nothing here changes the case of a slug we FETCH: boardCandidates copies
     it through verbatim, because their server does care. */
  assert.equal(siteKeyOf({ ids: [{ slug: "addisGrain" }] }, "graindesk"), "gd:addisgrain");
  assert.ok(readKeysOf([{ url: "https://marketplace.graindiscovery.com/api/public-sites/addisGrain/cash-bids" }])
    .has("gd:addisgrain"));
  assert.equal(boardCandidates("https://x/", { ids: [{ slug: "addisGrain" }] }, "graindesk")[0].url,
    "https://marketplace.graindiscovery.com/api/public-sites/addisGrain/cash-bids");
});

test("bushel is named as not-swept, with the reason, rather than silently dropped", () => {
  /* Its 40 classified sites record no per-site key: their `ids` carry endpoint
     names like "modernizr2.0.6-custom.js". The board is a keyed runtime call,
     which is what scripts/bushel-probe.mjs drives a browser to watch. A
     platform missing from a sweep with no reason recorded reads as an
     oversight, and a second half-writer on one platform is how this repository
     got two manifests for one elevator. */
  assert.ok(!SWEEPABLE.includes("bushel"));
  assert.match(NOT_SWEEPABLE.bushel, /bushel-probe/);
  for (const p of ["bushel", "barchart", "agricharts", "stonehedge"]) {
    assert.ok(!SWEEPABLE.includes(p));
    assert.ok((NOT_SWEEPABLE[p] || "").length > 20, `${p} is excluded with no reason on file`);
  }
});

/* ── which URL actually serves the board ──────────────────────────────── */

test("a JSON platform's endpoint is built from the key, not taken from the board page", () => {
  /* 130 of 172 refused with "the response is not JSON" in run 91840487549 and
     every one of them was right: they had been handed the operator's HTML.
     Both shapes below are copied from manifests that have been polling for
     weeks — sources/aglandfs-admcc.json and sources/abbyvillecoop-abbyville.json. */
  const dtn = boardCandidates("https://buckleybrosinc.com/",
    { boardPage: "https://buckleybrosinc.com/cash-bids/", ids: [{ siteId: "E0221901" }] }, "dtn-cs");
  assert.equal(dtn[0].url, "https://api.dtn.com/markets/sites/E0221901/cash-bids?units=us");
  const gd = boardCandidates("https://fcalindsay.com/markets/",
    { boardPage: undefined, ids: [{ slug: "fcalindsay" }] }, "graindesk");
  assert.equal(gd[0].url, "https://marketplace.graindiscovery.com/api/public-sites/fcalindsay/cash-bids");
  /* And a JSON board is asked for JSON. */
  assert.ok(WANTS_JSON.has("dtn-cs") && WANTS_JSON.has("graindesk"));
  assert.ok(!WANTS_JSON.has("aghost") && !WANTS_JSON.has("cashbidssingle"));
});

test("with no key on file the board page is still tried, and says so", () => {
  const c = boardCandidates("https://x.example/", { boardPage: "https://x.example/bids", ids: [] }, "dtn-cs");
  assert.equal(c.length, 1);
  assert.equal(c[0].url, "https://x.example/bids");
  assert.match(c[0].why, /no siteId/);
});

test("a cashbidssingle prefix with the id cut off is not offered as a URL", () => {
  /* discover recorded 28 of these as ".../cashbidssingle-" with no number.
     A prefix is not a location page; the site root serves the same board on
     this vendor and is tried instead. */
  const c = boardCandidates("https://adellcoop.com/",
    { boardPage: "https://adellcoop.com/cashbidssingle-" }, "cashbidssingle");
  assert.ok(!c.some((x) => x.url.endsWith("cashbidssingle-")));
  assert.deepEqual(c.map((x) => x.url), ["https://adellcoop.com/"]);
  /* When the id IS there it is the first thing asked. */
  const d = boardCandidates("https://npacoop.com/",
    { boardPage: "https://npacoop.com/cashbidssingle-1595" }, "cashbidssingle");
  assert.equal(d[0].url, "https://npacoop.com/cashbidssingle-1595");
});

test("an aghost site offers its own host's cash-bids view, and its AgHost host", () => {
  const c = boardCandidates("https://al-corn.com/",
    { boardPage: "https://al-corn.com/cash-bids/", hosts: ["al-corn.com", "x.aghost.net", "www.google-analytics.com"] },
    "aghost");
  const urls = c.map((x) => x.url);
  assert.equal(urls[0], "https://al-corn.com/cash-bids/");
  assert.ok(urls.includes("https://x.aghost.net/index.cfm?show=11&mid=3"));
  assert.ok(urls.includes("https://al-corn.com/index.cfm?show=11&mid=3"));
  /* No duplicates: the shape is the one sources/flashgrain-granton.json reads. */
  assert.equal(new Set(urls).size, urls.length);
  /* Every candidate carries the reason it is being tried, so a site that fails
     them all prints four diagnoses and not "no board (4 tried)". */
  for (const x of c) assert.ok(x.why && x.why.length > 8);
});

test("the grid one click away is followed from the page's own links, not guessed", () => {
  const html = `<nav><a href="/index.cfm?show=11&amp;mid=7">Cash Bids</a>
    <a href="index.cfm?show=11&mid=9">Grain</a>
    <a href="/index.cfm?show=4">About</a></nav>`;
  const got = linkedBoards(html, "https://al-corn.com/cash-bids/", "aghost");
  /* Resolved against the PAGE, which is what a browser does: the root-relative
     href lands at the root and the bare one lands beside the page it was
     written on. Getting that backwards would ask for a URL nobody serves. */
  assert.deepEqual(got, ["https://al-corn.com/index.cfm?show=11&mid=7",
                         "https://al-corn.com/cash-bids/index.cfm?show=11&mid=9"]);
  /* &amp; in an href is an ampersand, not three characters of query string. */
  assert.ok(!got.some((u) => u.includes("amp;")));
  const cbs = linkedBoards(`<a href='/cashbidssingle-2451'>x</a><a href="/cashbidssingle-2452">y</a>`,
    "https://adellcoop.com/", "cashbidssingle");
  assert.deepEqual(cbs, ["https://adellcoop.com/cashbidssingle-2451",
                         "https://adellcoop.com/cashbidssingle-2452"]);
  /* A platform with no link shape to follow returns nothing rather than junk. */
  assert.deepEqual(linkedBoards(html, "https://x.example/", "dtn-cs"), []);
});

/* ── an unnamed location is a parser fault, not a directory miss ───────── */

test("the markup around an unnamed location is printed, not summarised", () => {
  /* 83 locations came back as "location 2451". lib/parse.mjs names them from
     the page's own nav and that regex matched nothing on 32 sites. Recording
     them as unplaceable elevators would send somebody to the wrong file, so
     the bytes go in the log and the regex gets fixed from the page. */
  const html = `<li><a class="tab" href="/cashbidssingle-2451" title="Adell">`
    + `<span class="t">Adell</span></a></li>`;
  const ev = navEvidence(html);
  assert.equal(ev.length, 1);
  assert.match(ev[0], /cashbidssingle-2451/);
  assert.match(ev[0], /Adell/);
  /* This is exactly the case lib/parse.mjs's regex misses: the anchor text is
     inside a <span>, so `>\s*([^<]{1,60})<` sees nothing. */
  assert.deepEqual([...locationNames(html).values()], []);
  /* A page with no reference at all is a different answer and reads as one. */
  assert.deepEqual(navEvidence("<html>nothing here</html>"), []);
});

test("the repository's own platforms.json yields the sites it claims", () => {
  const plat = JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8"));
  const got = sitesFor(plat, SOURCES, { platform: null, only: null, start: 0, limit: Infinity });
  /* MEASURED, NOT ASPIRATIONAL. This asserted >100 and passed on 172, and 78
     of that 172 were boards this repository already polls — the number was
     the fault, not the evidence for it. The floor is now a real one: the
     38 aghost sites alone have never been read. */
  assert.ok(got.length >= 38, `only ${got.length} unread sweepable sites`);
  const byPlatform = {};
  for (const s of got) byPlatform[s.platform] = (byPlatform[s.platform] || 0) + 1;
  assert.equal(byPlatform.aghost, 38, "every aghost site is unread and must stay in the queue");
  assert.ok(!("bushel" in byPlatform), "bushel is bushel-probe's, not this sweep's");
  for (const s of got) {
    assert.ok(SWEEPABLE.includes(s.platform));
    assert.ok(/^https?:\/\//.test(s.board), `${s.site} has no board URL`);
  }
});

/* ── the same elevator under a second name ────────────────────────────── */

test("an elevator already read is not written again under a new id", () => {
  /* THE CASE THAT PROVES IT. Big River's board is bigriverbids.com, so this
     sweep would call the Boyceville location `bigriverbids-boyceville` — and
     the manifest that has read that elevator since the first day of this
     repository is called `boyceville`. Two files, one board, one elevator,
     both polling it. sitesFor() happens to skip that site because a source
     reads its host; a board on a host no source names would walk past that. */
  const url = "https://bigriverbids.com/cashbidssingle-2121";
  const html = fix("bigriver-2121.html");
  const rows = adapterFor("cashbidssingle")(html, url);
  const args = { html, url, site: "https://bigriverresources.com/", platform: "cashbidssingle",
                 rows, known: KNOWN, byZip: BYZIP, existingIds: new Set() };

  const loose = planSite({ ...args, have: new Set() });
  assert.ok(loose.write.some((w) => w.id === "bigriverbids-boyceville"),
            "without the guard the duplicate is written — if this stops being true the test is stale");

  const tight = planSite({ ...args, have: alreadyHave(SOURCES) });
  assert.ok(!tight.write.some((w) => w.id === "bigriverbids-boyceville"), "the duplicate is caught");
  assert.ok(tight.skip.some((s) => /already read under another id/.test(s.why)), "and says why");
  assert.ok(tight.write.some((w) => w.id === "bigriverbids-dyersville"),
            "and Dyersville, which we do NOT read, is still written");
});

test("alreadyHave keys on the elevator, not on the file name", () => {
  const have = alreadyHave([{ operator: "Big River Resources", location: "Boyceville", state: "WI" }]);
  assert.ok(have.has("bigriverresources|boyceville|WI"));
  assert.ok(have.has(`${"bigriverresources"}|${"boyceville"}|WI`));
  assert.ok(!have.has("bigriverresources|dyersville|IA"));
});

/* ── what it writes ───────────────────────────────────────────────────── */

test("a planned manifest is valid, and says which platform it is", () => {
  const url = "https://bigriverbids.com/cashbidssingle-2121";
  const html = fix("bigriver-2121.html");
  const rows = adapterFor("cashbidssingle")(html, url);
  const plan = planSite({ html, url, site: "https://bigriverresources.com/",
                          platform: "cashbidssingle", rows, known: KNOWN, byZip: BYZIP,
                          existingIds: new Set(), have: new Set() });
  assert.ok(plan.ok);
  assert.equal(plan.operator, "Big River Resources");
  assert.ok(plan.write.length >= 2);
  for (const w of plan.write) {
    assert.deepEqual(validateSource(w.json, new Set()), []);
    assert.equal(w.json.platform, "cashbidssingle");
    assert.ok(w.json.location && w.json.state && w.json.zip, `${w.id} has no town`);
    assert.match(w.json.note, /board-sweep\.mjs/);
    assert.match(w.json._pending, /cashRounding is NOT set/,
                 "a rounding mode must be measured, never inherited");
  }
});

test("a board whose operator is not in the directory writes nothing and says who", () => {
  /* Flash Grain and Ace Ethanol are not in Barchart's directory at all — they
     are two of the 271 elevators this repository carries and Barchart does
     not. The queue is a list of names, not a number. */
  const url = "https://flashgrains.com/index.cfm?show=11&mid=3";
  const html = fix("flashgrain-cashbids-2026-08-19.html");
  const rows = adapterFor("aghost")(html, url);
  const plan = planSite({ html, url, site: "https://flashgrains.com/", platform: "aghost",
                          rows, known: KNOWN, byZip: BYZIP, existingIds: new Set(), have: new Set() });
  assert.equal(plan.write.length, 0, "no town, no manifest");
  assert.equal(plan.unmatched.length, 2);
  for (const u of plan.unmatched) {
    assert.equal(u.operator, "Flash Grain");
    assert.ok(u.rows > 0 && u.label && u.platform && u.url,
              "the worklist row carries everything needed to place it by hand");
  }
  assert.deepEqual(plan.unmatched.map((u) => u.label).sort(), ["Granton", "Thorp"]);
});

test("a directory match with no state writes nothing", () => {
  /* joinDirectory can return a record it matched on the operator while the
     branch or the state is blank. A manifest with no state is a wrong answer
     in front of somebody: lib/board.mjs cannot band it, the geocoder cannot
     check the coordinate is in the right region, and the merge drops it. */
  const rows = [{ location: "Nowhere", locationId: "1", commodity: "Corn" }];
  const html = "<title>Testing Grain Co</title>";
  const noState = [{ facility: "Testing Grain Co", branch: "Nowhere", city: "Nowhere",
                     state: "", zip: "00000", phone: null }];
  const p1 = planSite({ html, url: "https://x/b", site: "https://x/", platform: "aghost",
                        rows, known: noState, byZip: BYZIP, existingIds: new Set(), have: new Set() });
  assert.equal(p1.write.length, 0, "no state, no manifest");
  assert.equal(p1.unmatched.length, 1, "and it goes on the worklist instead");

  const noBranch = [{ facility: "Testing Grain Co", branch: "", city: "Nowhere",
                      state: "IA", zip: "50001", phone: null }];
  const p2 = planSite({ html, url: "https://x/b", site: "https://x/", platform: "aghost",
                        rows, known: noBranch, byZip: BYZIP, existingIds: new Set(), have: new Set() });
  assert.equal(p2.write.length, 0, "no branch, no id worth writing");
});

test("a board that names no operator is refused rather than filed under a guess", () => {
  const plan = planSite({ html: "<html><body>prices</body></html>", url: "https://x/b",
                          site: "https://x/", platform: "aghost",
                          rows: [{ location: "Somewhere", locationId: "1", commodity: "Corn" }],
                          known: KNOWN, byZip: BYZIP, existingIds: new Set(), have: new Set() });
  assert.equal(plan.ok, false);
  assert.match(plan.why, /name no operator/);
  assert.equal(plan.write.length, 0);
});

test("--platform and --limit are read, and nothing else is assumed", () => {
  const c = parseArgs(["--platform", "aghost", "--limit", "5", "--write"]);
  assert.equal(c.platform, "aghost");
  assert.equal(c.limit, 5);
  assert.equal(c.write, true);
  assert.equal(parseArgs([]).write, false, "writing is never the default");
  assert.equal(parseArgs([]).platform, null);
});

test("hostOf strips www and is not fooled by a path", () => {
  assert.equal(hostOf("https://www.Example.COM/a/b?c=1"), "example.com");
  assert.equal(hostOf("not a url"), null);
});


/* ── the location a board names, and the two directories that place it ──── */

test("the heading above the board names the location when the nav will not", () => {
  /* Run 91847384302 asked 32 cashbidssingle sites and found NO
     "cashbidssingle-<id>" reference at all — not one, in 238,098 bytes of
     Adell Cooperative. Eighty locations posting real prices came back as
     "location 2451". The captures below are that run's own bytes. */
  const want = {
    "cashbidssingle-agassizvalleygraincom.html": "AVG Barnesville",
    "cashbidssingle-bertholdfarmerscom.html": "Berthold",
    "cashbidssingle-countrygraincooperativecom.html": "Eldridge",
    "cashbidssingle-crossroadscoopcom.html": "Bridgeport",
    "cashbidssingle-dakotamidlandcom.html": "Voltaire",
  };
  for (const [f, town] of Object.entries(want)) {
    const rows = extractListBids(fix(join("board-sweep", f)), f);
    assert.ok(rows.length > 0, `${f} read no rows`);
    assert.deepEqual([...new Set(rows.map((r) => r.location))], [town], f);
  }
});

test("a heading that is page furniture is refused, not filed as a town", () => {
  /* Adell Cooperative's is "Cash Bids". Filing that would put a place called
     Cash Bids on a map, which is the exact failure Rule 1 is about. */
  const rows = extractListBids(fix(join("board-sweep", "cashbidssingle-adellcoopcom.html")),
                               "adell");
  assert.deepEqual([...new Set(rows.map((r) => r.location))], ["location 2451"]);
  for (const t of ["Cash Bids", "Markets", "News", "Futures", "Hours", "Bids", "Prices",
                   "Berthold Farmers Announcements", "CGC Updates"])
    assert.equal(locationHeading(t), null, `"${t}" is furniture, not a place`);
  for (const t of ["Berthold", "AVG Barnesville", "Voltaire", "Eldridge"])
    assert.equal(locationHeading(t), t);
});

test("when a page offers both, the NAV name wins over the heading", () => {
  /* THE SEAM, NOT THE RULE. No fixture in this repository has a nav name AND
     a differing heading, so swapping the precedence changes no captured
     output and a mutation of it survives silently. It still matters, and the
     case is the ordinary multi-location one: a nav name is keyed on the id the
     ROW carries, a heading only on where it sits. Let a heading win and a
     three-location board collapses into one town — the wrong town for two of
     them, published as fact. */
  const row = (id, cash) => `<ul class='fcControls1'>`
    + `<li class='c1'><span>Sep</span><img onclick="showChart('x?CashBidsLocationID=${id}')"></li>`
    + `<li class='c2'>${cash}</li><li class='c3'>-0.50</li></ul>`;
  const hdr = `<ul class='fcControlsSubHdr'><li>Delivery</li><li>Bid</li><li>Basis</li></ul>`;
  const html = `<a href="/cashbidssingle-11">Alpha</a><a href="/cashbidssingle-22">Beta</a>`
    + `<h2 class="fcControls">Gamma</h2><h3 class='fcControls'>Corn</h3>${hdr}`
    + row(11, "4.10") + row(22, "4.20");
  const rows = extractListBids(html, "t");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.location), ["Alpha", "Beta"]);
  /* And with the nav gone the heading is what is left, for both. */
  const noNav = html.replace(/<a href="\/cashbidssingle-\d+">[^<]*<\/a>/g, "");
  assert.deepEqual(extractListBids(noNav, "t").map((r) => r.location), ["Gamma", "Gamma"]);
});

test("THE NAV STILL WINS. Big River's three towns are unchanged", () => {
  /* The heading is a fallback and must stay one: a nav name is keyed on the id
     the row itself carries, where a heading is only keyed on position. Big
     River's board is the first this repository ever read. */
  const rows = extractListBids(fix("bigriver-2121.html"), "bigriver");
  assert.deepEqual([...new Set(rows.map((r) => r.location))].sort(),
                   ["Boyceville", "Dyersville", "Monmouth"]);
  assert.equal(rows.length, 14);
});

test("both directories are asked, and the ones we wrote ourselves are excluded", () => {
  const dir = JSON.parse(readFileSync(join(ROOT, "data/directory.json"), "utf8"));
  const wide = wideDirectory(dir);
  assert.ok(wide.length > 1500, `only ${wide.length} rows from the merged directory`);
  /* CIRCULARITY. directory.json carries every source in sources/ with status
     "read". Joining a board against manifests derived from boards measures
     nothing — the same trap that made the `website` join score 33% on nothing
     but sites we already read. */
  const ours = dir.elevators.filter((e) => e.status === "read");
  assert.ok(ours.length > 100, "expected the merged directory to carry our own sources");
  /* Not one of them is eligible to place a board. */
  const wideNames = new Set(wide.map((r) => `${slugOf(r.facility)}|${slugOf(r.branch)}`));
  const leaked = ours.filter((e) => wideNames.has(`${slugOf(e.operator)}|${slugOf(e.location)}`))
    .filter((e) => !dir.elevators.some((k) => k.status !== "read"
      && slugOf(k.operator) === slugOf(e.operator) && slugOf(k.location) === slugOf(e.location)));
  assert.deepEqual(leaked.map((e) => e.id), [],
    "rows this repository wrote are eligible to place a board — that is circular");
  const both = KNOWN.concat(wide);
  /* Complementary, measured on run 91847384302's own captures. */
  assert.ok(joinDirectory(KNOWN, "Agassiz Valley Grain", "AVG Barnesville"),
            "Barchart carries the branch name");
  assert.equal(joinDirectory(KNOWN, "Country Grain Cooperative", "Eldridge"), null,
               "and does not carry Eldridge");
  assert.ok(joinDirectory(wide, "Country Grain Cooperative", "Eldridge"),
            "the registry does");
  for (const [op, l] of [["Agassiz Valley Grain", "AVG Barnesville"],
                         ["Country Grain Cooperative", "Eldridge"],
                         ["Berthold Farmers", "Berthold"],
                         ["Dakota Midland Grain", "Voltaire"]])
    assert.ok(joinDirectory(both, op, l), `${op} / ${l} places against neither directory`);
});

test("main() actually asks BOTH directories — the wiring, not the rule", () => {
  /* Three times now a correct, tested function has sat in this repository
     unwired: scaleByContract was right, had tests, and scaleFutures never
     called it. wideDirectory() being correct says nothing about whether the
     sweep loads it. This reads the seam. */
  const src = readFileSync(join(ROOT, "scripts/board-sweep.mjs"), "utf8");
  const body = src.slice(src.indexOf("export async function main"));
  assert.match(body, /wideDirectory\(/, "main() never calls wideDirectory()");
  assert.match(body, /data\/directory\.json/, "main() never reads the merged directory");
  assert.match(body, /barchart\.concat\(wide\)/,
    "main() reads both and hands the join only one of them");
  /* A directory.json that will not parse must not take the sweep down with
     it: the Barchart set alone is still a directory. */
  assert.match(body, /catch \{ wide = \[\]; \}/);
});

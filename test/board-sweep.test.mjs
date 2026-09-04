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
         siteKeyOf, WANTS_JSON, wideDirectory, townInState, placeFromBoard }
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

/* ── a town and a state, both read off the board ───────────────────────── */

test("a merchant's label peels to a town, and the operator's own name comes off first", async () => {
  /* Run 91852779678 read 36 Scoular locations across twelve states — real
     prices, 194 rows — and placed NONE, because joinDirectory was handed the
     label verbatim and no directory has a town called "Scoular Goodland".
     Every case below is a label that run actually returned. */
  const { normaliseLabel } = await import("../lib/place.mjs");
  const S = "ScoularView";
  const cases = [
    ["Big Springs, NE", "Big Springs", "NE"],
    ["Scoular Goodland", "Goodland", null],
    ["Scoular-Downs", "Downs", null],
    ["Scoular - Butte, MT", "Butte", "MT"],
    ["Grainton Cash Bids", "Grainton", null],
    ["Scoular Julesburg Cash Bids", "Julesburg", null],
    ["Minneapolis, KS", "Minneapolis", "KS"],
  ];
  for (const [raw, town, st] of cases) {
    const got = normaliseLabel(raw, S);
    assert.equal(got.town, town, raw);
    assert.equal(got.state, st, raw);
  }
  /* TWO LETTERS AFTER A COMMA ARE NOT AUTOMATICALLY A STATE. Dropping the
     US_STATES check changes none of the cases above, which is exactly how a
     wrong state gets published: "Wilson, Jr" would file a bid in New Jersey
     and "Grain Co, Ll" in nowhere. The list is what makes the comma safe. */
  for (const raw of ["Wilson, Jr", "Hartley, Sr", "Grain Co, Ll", "Elevator, Xx"]) {
    assert.equal(normaliseLabel(raw, S).state, null, raw);
  }
  assert.equal(normaliseLabel("Springfield, Il", S).state, "IL", "case is not identity");
  assert.equal(normaliseLabel("Dover, de", S).state, "DE");
});

test("THE ORDER IS THE POINT: strip the operator, then ask if it is a destination", async () => {
  /* destinationReason() flags "Scoular Goodland" as a destination, and on
     anybody else's board it would be right. On Scoular's board it is Scoular's
     yard at Goodland. Ask about the REMAINDER, not the label — otherwise a
     merchant can never publish its own elevators. And AGP and Bunge are still
     refused, because they are not Scoular. */
  const { normaliseLabel, destinationReason } = await import("../lib/place.mjs");
  assert.ok(destinationReason("Scoular Goodland"), "the raw label does read as a destination");
  assert.equal(normaliseLabel("Scoular Goodland", "ScoularView").town, "Goodland");
  for (const raw of ["AGP - Manning", "Bunge - Council Bluffs"]) {
    const got = normaliseLabel(raw, "ScoularView");
    assert.equal(got.town, null, raw);
    assert.match(got.why, /destination, not a town/);
  }
});

test("a co-op named after its town keeps its town", async () => {
  /* The operator-remainder check refuses "One Earth Energy Cash Bids" on One
     Earth Energy's board — a company with its first word peeled off, dressed
     up as a town. It must NOT refuse "Berthold" on Berthold Farmers' board:
     that is the town of Berthold, North Dakota, and the manifest written for
     it on run 91852779678 is correct. A label the board wrote whole stands;
     only a fragment this function manufactured has to prove itself. */
  const { normaliseLabel } = await import("../lib/place.mjs");
  assert.equal(normaliseLabel("Berthold", "Berthold Farmers").town, "Berthold");
  assert.equal(normaliseLabel("Eldridge", "Country Grain Cooperative").town, "Eldridge");
  assert.equal(normaliseLabel("Voltaire", "Dakota Midland Grain").town, "Voltaire");
  const one = normaliseLabel("One Earth Energy Cash Bids", "One Earth Energy");
  assert.equal(one.town, null);
  assert.match(one.why, /the operator's own name/);
});

test("our own placeholder never round-trips into a town", async () => {
  /* extractListBids() writes "location 2451" when a board names nothing. If
     that reached a directory it would put a place called Location 2451 on a
     map, sourced from nothing but our own fallback string. */
  const { normaliseLabel } = await import("../lib/place.mjs");
  for (const raw of ["location 2451", "location unknown", "Location 3559"]) {
    const got = normaliseLabel(raw, "Adell Cooperative");
    assert.equal(got.town, null, raw);
    assert.match(got.why, /this repository's own placeholder/);
  }
});

test("an initialism is not a town", async () => {
  const { normaliseLabel } = await import("../lib/place.mjs");
  for (const [raw, op] of [["NWGG", "Northwest Grain Growers"], ["PGG", "Pomeroy Grain"],
                           ["FGC Cash Bids", "Farmers Grain Company of Roseville"]]) {
    const got = normaliseLabel(raw, op);
    assert.equal(got.town, null, raw);
    assert.match(got.why, /initialism/);
  }
});

test("a town in a state places from any neighbour, but a state is never inferred", () => {
  const known = [
    { facility: "Aaa Coop", branch: "Fremont", city: "Fremont", state: "NE", zip: "68025" },
    { facility: "Bbb Grain", branch: "Fremont East", city: "Fremont", state: "NE", zip: "68025" },
    { facility: "Ccc Ag", branch: "Fremont", city: "Fremont", state: "OH", zip: "43420" },
  ];
  /* ELEVEN ROWS FOR FREMONT, NEBRASKA ARE ELEVEN NEIGHBOURS OF THE SAME YARD.
     They are not being asked which elevator this is — Scoular's is in none of
     them — they are being asked where Fremont is, and they agree. */
  const hit = townInState(known, "Fremont", "NE");
  assert.equal(hit.city, "Fremont");
  assert.equal(hit.state, "NE");
  assert.equal(hit.zip, "68025", "both Nebraska rows agree, so the ZIP is taken");
  /* A DISAGREEMENT TAKES NO ZIP rather than the first one. */
  const split = townInState([...known,
    { facility: "Ddd", branch: "Fremont", city: "Fremont", state: "NE", zip: "68026" }],
    "Fremont", "NE");
  assert.equal(split.zip, null);
  /* AND THE STATE IS LOAD-BEARING. There are Fremonts in a dozen states. */
  assert.equal(townInState(known, "Fremont", null), null);
  assert.equal(townInState(known, "Fremont", "IA"), null);
  assert.equal(townInState(known, "Fremont", "OH").zip, "43420");
});

test("the board's own town and state place a yard no directory carries", () => {
  /* Scoular is in no directory this repository holds under any name the
     operator join would find, and "Big Springs, NE" is nonetheless a town and
     a state, written by the operator, on the same page as the price. The
     directory is enrichment here, not a gate. */
  const empty = [];
  const p = placeFromBoard(empty, "ScoularView", "Big Springs, NE");
  assert.equal(p.city, "Big Springs");
  assert.equal(p.state, "NE");
  assert.equal(p.zip, null, "no ZIP is taken from anywhere");
  assert.match(p.placedBy, /the board's own label/);
  /* NO STATE, NO PLACE. A town alone repeats across a dozen states, so a
     label that peels to a bare town and nothing else is refused and goes on
     the worklist with the town it peeled to. */
  assert.equal(placeFromBoard(empty, "ScoularView", "Scoular Goodland"), null);
  assert.equal(placeFromBoard(empty, "Adell Cooperative", "location 2451"), null);
  /* A DIRECTORY ROW STILL WINS, and the branch name wins over the peel:
     "AVG Barnesville" is not a town and IS what Barchart calls that elevator. */
  const withBranch = [{ facility: "Agassiz Valley Grain", branch: "AVG Barnesville",
                        city: "Barnesville", state: "MN", zip: "56514" }];
  const b = placeFromBoard(withBranch, "Agassiz Valley Grain", "AVG Barnesville");
  assert.equal(b.city, "Barnesville");
  assert.match(b.placedBy, /at this label/);
});

test("every manifest records HOW its town was placed", () => {
  /* A town that appears with no provenance is indistinguishable from one
     somebody typed in — the same rule fill_states.mjs follows for states. */
  const src = readFileSync(join(ROOT, "scripts/board-sweep.mjs"), "utf8");
  const body = src.slice(src.indexOf("export function manifestFor"));
  assert.match(body, /HOW THIS PLACE WAS PLACED/);
  assert.match(body, /dir\.placedBy/);
  assert.match(body, /normaliseLabel\(\) in lib\/place\.mjs/);
  /* And the sweep must actually call it — the rule, then the wiring. */
  const main = src.slice(src.indexOf("export async function main"));
  assert.match(src, /placeFromBoard\(known, operator, loc\.label/);
  assert.match(src, /import \{ normaliseLabel, US_STATES \} from "\.\.\/lib\/place\.mjs"/);
});

test("a location whose rows cannot band says so in the manifest it writes", async () => {
  /* Run 91859042090 wrote 23 manifests and TWENTY carried a commodity name
     matching no band. Every one of those rows was destined to be withheld at
     the first poll, and nothing between the write and that poll said so. A
     sweep that writes a source it can already tell will publish nothing is not
     writing a source, it is filing a problem for later. */
  const { unbandable } = await import("../scripts/board-sweep.mjs");
  const src = { bands: { corn: [2, 12] } };
  const rowsOf = (f, n = 3) => Array.from({ length: n }, () => ({ futures: f }));

  /* NOTHING TO REPORT when the futures column settles it — which is the whole
     point of the contract fallback, and this must not double-report it. */
  assert.deepEqual(unbandable(src, new Map([["Yc", rowsOf("Dec 26 Corn")]])), []);
  assert.deepEqual(unbandable(src, new Map([["Corn", rowsOf("Dec 26 Corn")]])), []);

  /* AND IT CARRIES THE EVIDENCE. A report that says "Bly has no band" and
     stops has thrown away the one column a person would look at next. */
  const bad = unbandable(src, new Map([["Bly", rowsOf("Nov 26 Whatever", 4)]]));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].commodity, "Bly");
  assert.equal(bad[0].rows, 4);
  assert.match(bad[0].futures, /Nov 26 Whatever/);

  /* It uses the SOURCE's own bands, so a manifest that has already been
     corrected stops reporting. */
  assert.deepEqual(unbandable({ bands: { bly: [2, 12] } },
    new Map([["Bly", rowsOf("Nov 26 Whatever")]])), []);
  assert.deepEqual(unbandable(src, null), [], "no rows collected is not a complaint");
});

test("the _pending it writes tells the next person what NOT to do", () => {
  /* The tempting fix for a band refusal is to copy a neighbour's band until
     the message stops. That publishes a number nothing checked. */
  const src = readFileSync(join(ROOT, "scripts/board-sweep.mjs"), "utf8");
  assert.match(src, /WILL NOT PUBLISH AS WRITTEN/);
  assert.match(src, /Do not copy a neighbour's band to make the refusal stop/);
  assert.match(src, /A band is a misplaced-decimal guard, not a taxonomy/);
  /* The rule, and then the wiring: planSite must actually call it. */
  assert.match(src, /const nb = unbandable\(m, loc\.byCommodity\);/);
  assert.match(src, /byCommodity: new Map\(\)/);
  assert.match(src, /e\.byCommodity\.get\(r\.commodity\)\.push\(r\)/);
});

/* ── a typo and an empty queue are different answers ────────────────────── */

test("a platform name that is not a platform is refused, not reported as empty", async () => {
  /* 2026-09-04: I told Sig to run this with `--only hillsdale`, and the
     dispatch form has five boxes. "hillsdale" went into the PLATFORM box, two
     above the one I meant. sitesFor() filters every site out on an unknown
     platform, so the run would have printed "nothing unread on a sweepable
     platform" — a sentence that is false, reads like good news, and sends the
     next person to look at the data instead of at the box they typed in.
     
     "Nothing to do" and "you asked for something that does not exist" must
     never share a message. */
  const { main } = await import("../scripts/board-sweep.mjs");
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(" "));
  let code;
  try { code = await main(["--platform", "hillsdale"]); } finally { console.log = log; }
  assert.equal(code, 1, "an unusable request must not exit 0");
  const out = said.join("\n");
  assert.match(out, /"hillsdale" is not a platform/);
  /* And it says where the value probably belongs, because that IS the mistake
     this was — not a lecture about valid values with no way forward. */
  assert.match(out, /Did you mean the "only" box\?/);
  assert.match(out, /aghost, cashbidssingle, dtn-cs, graindesk/);
  assert.ok(!/nothing unread on a sweepable platform/.test(out),
    "the false reassurance must not also be printed");
});

test("a platform excluded on purpose says WHY, not that it is unknown", async () => {
  /* bushel is a real platform this repository reads; it is bushel-probe's.
     Telling someone it does not exist would be a lie, and would send them to
     add it. */
  const { main } = await import("../scripts/board-sweep.mjs");
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(" "));
  let code;
  try { code = await main(["--platform", "bushel"]); } finally { console.log = log; }
  assert.equal(code, 1);
  const out = said.join("\n");
  assert.match(out, /It is a platform this repository knows/);
  assert.match(out, /bushel-probe/);
  assert.ok(!/Did you mean the "only" box/.test(out), "it is not a typo, so do not guess at one");
});

test("an --only that matches nothing names the hosts that ARE unread", async () => {
  /* Same distinction one level down. A filter that matched nothing is a typo;
     it is not the same as having read everything, and a run that cannot tell
     the difference teaches people to shrug at a zero. */
  const { main } = await import("../scripts/board-sweep.mjs");
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(" "));
  let code;
  try { code = await main(["--only", "zzz-no-such-site"]); } finally { console.log = log; }
  assert.equal(code, 1);
  const out = said.join("\n");
  assert.match(out, /none of the \d+ unread site\(s\) has "zzz-no-such-site" in its URL/);
  assert.match(out, /the unread hosts are:|nearest:/);
});

test("--only hillsdale finds the board the worklist names", async () => {
  /* The instruction that started this: 18 Hillsdale locations posting real
     prices, all still "location NNNN". This is the filter that reaches them. */
  const plat = JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8"));
  const got = sitesFor(plat, SOURCES,
    { platform: null, only: ["hillsdale"], start: 0, limit: Infinity });
  assert.equal(got.length, 1);
  assert.match(got[0].site, /hillsdaleelevator\.com/);
  assert.equal(got[0].platform, "cashbidssingle");
});

/* ── the locations are a tab strip, and the tabs are not links ──────────── */

test("18 Hillsdale locations get their towns from the tab strip", async () => {
  /* Run 91871303720: 18 locations, 126 rows, and not one
     "cashbidssingle-<id>" reference in 267,641 bytes. The names were on the
     page the whole time, in a responsive tab widget whose strip and panels are
     siblings written by one control. */
  const { extractListBids, tabLocationNames, locationTabNames } = await import("../lib/parse.mjs");
  const html = fix(join("board-sweep", "cashbidssingle-hillsdaleelevatorcom.html"));
  const rows = extractListBids(html, "hillsdale");
  assert.equal(rows.length, 126);
  const towns = [...new Set(rows.map((r) => r.location))];
  assert.equal(towns.length, 18);
  assert.deepEqual(towns.slice(0, 6),
    ["Hillsdale/Fenton", "Annawan", "Geneseo", "Orion", "Galesburg", "Abingdon"]);
  assert.ok(towns.includes("Galva"), "Galva is the label the earlier worklist could not name");
  assert.ok(!towns.some((t) => /^location \d+$/.test(t)), "no id survived as a name");
});

test("THE CONTAINER ID, NOT THE POSITION OF THE <ul>", async () => {
  /* That page has TWO `resp-tabs-list` strips and the FIRST is the futures
     commodity tabs — Corn, Soybeans, Wheat, Live Cattle. Taking "the tab
     strip" would have named eighteen elevators after cattle contracts. */
  const { locationTabNames } = await import("../lib/parse.mjs");
  const html = fix(join("board-sweep", "cashbidssingle-hillsdaleelevatorcom.html"));
  const { names } = locationTabNames(html);
  assert.equal(names.length, 18);
  for (const c of ["Corn", "Soybeans", "Wheat", "Live Cattle"])
    assert.ok(!names.includes(c), `"${c}" is a futures tab, not a location`);
  assert.equal(names[0], "Hillsdale/Fenton");
});

test("POSITIONAL, SO THE COUNTS MUST AGREE", async () => {
  /* Pairing by position is the weakest join in this repository. It is made
     only when the strip has exactly as many tabs as the board has distinct
     ids: a widget rendered in step. Anything else is a page whose shape has
     changed, and a wrong town on a real elevator is worse than no town. */
  const { tabLocationNames } = await import("../lib/parse.mjs");
  const strip = (...n) => `<div id='CashBidsLocationTabs_1'><ul class='resp-tabs-list'>`
    + n.map((x) => `<li><div><span>${x}</span></div></li>`).join("") + `</ul></div>`;
  assert.deepEqual([...tabLocationNames(strip("A", "B"), ["1", "2"])], [["1", "A"], ["2", "B"]]);
  assert.equal(tabLocationNames(strip("A", "B", "C"), ["1", "2"]).size, 0,
    "three tabs for two panels is a page that changed shape");
  assert.equal(tabLocationNames(strip("A"), ["1", "2"]).size, 0);
  /* A board that keys no rows at all, with one tab, still names its one
     location — Dakota Midland's case, measured. */
  assert.deepEqual([...tabLocationNames(strip("Voltaire"), [])], [[null, "Voltaire"]]);
  assert.equal(tabLocationNames(strip("A", "B"), []).size, 0, "two tabs, no ids, no answer");
  assert.equal(tabLocationNames("<html>nothing</html>", ["1"]).size, 0);
});

test("the nav still outranks the tab strip, and Big River is untouched", async () => {
  const { extractListBids } = await import("../lib/parse.mjs");
  const rows = extractListBids(fix("bigriver-2121.html"), "bigriver");
  assert.equal(rows.length, 14);
  assert.deepEqual([...new Set(rows.map((r) => r.location))].sort(),
                   ["Boyceville", "Dyersville", "Monmouth"]);

  /* THE SEAM, NOT THE RULE. No captured board has BOTH a nav and a tab strip
     — Hillsdale has tabs and no nav, Big River a nav and no tabs — so
     swapping the precedence changes no fixture and a mutation of it survives.
     It still matters: a nav name is keyed on the id the row itself carries,
     where a tab is paired by POSITION, which is the weakest join here. When
     both speak, the one that cannot be off by one wins. */
  const row = (id, cash) => `<ul class='fcControls1'>`
    + `<li class='c1'><span>Sep</span><img onclick="x('y?CashBidsLocationID=${id}')"></li>`
    + `<li class='c2'>${cash}</li><li class='c3'>-0.50</li></ul>`;
  const html = `<a href="/cashbidssingle-11">Alpha</a><a href="/cashbidssingle-22">Beta</a>`
    + `<div id='CashBidsLocationTabs_1'><ul class='resp-tabs-list'>`
    + `<li><div><span>Wrong One</span></div></li><li><div><span>Wrong Two</span></div></li></ul></div>`
    + `<h3 class='fcControls'>Corn</h3>`
    + `<ul class='fcControlsSubHdr'><li>Delivery</li><li>Bid</li><li>Basis</li></ul>`
    + row(11, "4.10") + row(22, "4.20");
  assert.deepEqual(extractListBids(html, "t").map((r) => r.location), ["Alpha", "Beta"]);
  /* Take the nav away and the strip answers — in order. */
  const noNav = html.replace(/<a href="\/cashbidssingle-\d+">[^<]*<\/a>/g, "");
  assert.deepEqual(extractListBids(noNav, "t").map((r) => r.location), ["Wrong One", "Wrong Two"]);
});

/* ── an industry word is not an identity ────────────────────────────────── */

test("a facility called plain ELEVATOR is not every operator with Elevator in its name", async () => {
  /* Measured 2026-09-04: slug("Hillsdale Elevator Company") contains
     "elevator", so joinDirectory matched a directory row called plain
     "ELEVATOR" in Britton, South Dakota — and another whose facility field is
     a run-together list of eleven South Dakota businesses. Only the label test
     kept a bid at Hillsdale, Illinois out of Britton. */
  const { joinDirectory, GENERIC_NAME_WORDS } = await import("../scripts/agricharts-sweep.mjs");
  const dir = [
    { facility: "ELEVATOR", branch: "BRITTON", city: "BRITTON", state: "SD" },
    { facility: "Hillsdale Elevator", branch: "Clinton", city: "Clinton", state: "IA", zip: "52732" },
  ];
  assert.equal(joinDirectory(dir, "Hillsdale Elevator Company", "BRITTON"), null,
    "a shared industry word is not evidence that these are the same company");
  /* And the real match still works — the shared prefix there is a name. */
  const good = joinDirectory(dir, "Hillsdale Elevator Company", "Clinton");
  assert.equal(good.state, "IA");
  for (const w of ["elevator", "farmers", "coop", "grain", "company", "cooperat"])
    assert.ok(GENERIC_NAME_WORDS.has(w.slice(0, 8)), `"${w}" should be a generic word`);
  assert.ok(!GENERIC_NAME_WORDS.has("hillsdal"));
  assert.ok(!GENERIC_NAME_WORDS.has("scoular"));
});

/* ── the operator's own footer address is a hint, never a placement ─────── */

test("the footer state goes on the worklist, and never into a manifest", async () => {
  const { operatorAddress, placeFromBoard } = await import("../scripts/board-sweep.mjs");
  const got = operatorAddress(fix(join("board-sweep", "cashbidssingle-hillsdaleelevatorcom.html")));
  assert.equal(got.state, "IL");
  assert.equal(got.zip, "61257");
  assert.ok(!("town" in got), "a footer with no comma before the town yields half a street address");

  /* HILLSDALE IS THE OPERATOR THAT PROVES WHY IT IS ONLY A HINT. Their board
     also carries Clinton and CHS Davenport, which are in IOWA — so "the
     company is in Illinois, therefore its yards are" is false for the very
     operator that suggested it. */
  assert.equal(placeFromBoard([], "Hillsdale Elevator Company", "Geneseo"), null,
    "a bare town plus a footer state must not place anything");
  const src = readFileSync(join(ROOT, "scripts/board-sweep.mjs"), "utf8");
  assert.match(src, /THIS IS A HINT AND NOT A PLACEMENT/);
  assert.match(src, /stateHint: clean\.state \? "" : \(homeAddress\?\.state \?\? ""\)/);
  assert.match(src, /operator,label,town,state,stateHint,why/);
});

test("two states in a footer name no home state", async () => {
  const { operatorAddress } = await import("../scripts/board-sweep.mjs");
  assert.equal(operatorAddress("<p>Ames, IA 50010</p><p>Lincoln, NE 68508</p>"), null);
  assert.equal(operatorAddress("<p>Ames, IA 50010</p><p>Boone, IA 50036</p>").state, "IA");
  assert.equal(operatorAddress("<p>nothing here</p>"), null);
  /* TWO CAPITALS BEFORE A FIVE-DIGIT NUMBER ARE NOT AUTOMATICALLY A STATE.
     Dropping the US_STATES check changed no test until this line: "Smith, Jr"
     does not match [A-Z]{2} at all, so the first version of this case proved
     nothing. */
  assert.equal(operatorAddress("<p>Acme Supply, XX 60601</p>"), null);
  assert.equal(operatorAddress("<p>Suite 3, AB 60601</p>"), null);
  assert.equal(operatorAddress("<p>Peoria, IL 61601</p>").state, "IL");
});

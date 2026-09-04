/* THE GENERIC BOARD SWEEP
 *
 * Measured 2026-09-04 from data/platforms.json, which discover has been
 * filling for three weeks:
 *
 *     platform          sites   read
 *     aghost               38      1
 *     cashbidssingle       34      1
 *     bushel               40     24
 *     dtn-cs               34     20
 *     graindesk            32     27
 *
 * aghost and cashbidssingle have a working adapter, a board URL recorded for
 * every site, and ONE SOURCE READ BETWEEN THEM. Nothing was missing but a
 * script that walks the list. 172 sites are unread across the five.
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
import { operatorNameFrom, sitesFor, planSite, alreadyHave, hostOf, parseArgs, SWEEPABLE }
  from "../scripts/board-sweep.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
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

test("the repository's own platforms.json yields the sites it claims", () => {
  const plat = JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8"));
  const got = sitesFor(plat, SOURCES, { platform: null, only: null, start: 0, limit: Infinity });
  assert.ok(got.length > 100, `only ${got.length} unread sweepable sites`);
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

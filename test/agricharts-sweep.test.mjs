/* The sweep, on the four boards it has already been proved against.
 *
 * This script writes source manifests on the runner — hundreds of them — so
 * every part of it that decides WHAT goes in a file is tested here against the
 * captured boards and the directory the ids were built from by hand.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE is the one that says the sweep produces
 * the SAME source ids as the 23 manifests already live. If it produced
 * `kokomograincom-amboy` instead of `kokomograin-amboy`, nothing would break,
 * nothing would error, and the repository would quietly acquire a second copy
 * of every elevator it already reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  mobileCandidates, operatorFrom, websiteFrom, operatorSlug, slug, joinDirectory,
  phoneOf, manifestFor, agrichartsHosts, parseArgs, hostsFor, main,
} from "../scripts/agricharts-sweep.mjs";
import { validateSource } from "../lib/sources.mjs";
import { VERIFIED_BY } from "../lib/adapters/agricharts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const KNOWN = JSON.parse(read("data/known-elevators.json")).elevators;

/* ── where a board might live ────────────────────────────────────────────── */

test("both measured hostname forms are tried", () => {
  const c = mobileCandidates("https://thefarmerselevator.com/");
  // The Farmers Elevator is served at mobile.<vanity>; Legacy Farmers at
  // <sub>.mobile.agricharts.com. Neither form implies the other.
  assert.ok(c.includes("https://mobile.thefarmerselevator.com/cash/prices.php"));
  assert.ok(c.includes("https://thefarmerselevator.mobile.agricharts.com/cash/prices.php"));
});

test("a host already on agricharts.com needs no guessing", () => {
  assert.deepEqual(mobileCandidates("https://laboltfarmersgrain456.agricharts.com/"),
    ["https://laboltfarmersgrain456.mobile.agricharts.com/cash/prices.php"]);
});

test("www is stripped and a hyphenated label is tried both ways", () => {
  const c = mobileCandidates("https://www.pce-coops.com/");
  assert.ok(c.includes("https://mobile.pce-coops.com/cash/prices.php"));
  assert.ok(c.includes("https://pce-coops.mobile.agricharts.com/cash/prices.php"));
  // pce-coops.agricharts.com is real, and so is agland for ag-land.com; one
  // request each settles which spelling this operator uses.
  assert.ok(c.includes("https://pcecoops.mobile.agricharts.com/cash/prices.php"));
});

test("a junk url produces no requests at all", () => {
  assert.deepEqual(mobileCandidates("not a url"), []);
  assert.deepEqual(mobileCandidates(""), []);
});

test("candidates are deduplicated, because each one is a request", () => {
  const c = mobileCandidates("https://acoop2.com/");
  assert.equal(new Set(c).size, c.length);
});

/* ── reading who they are off their own page ─────────────────────────────── */

const BOARDS = {
  "agricharts-kokomograin.html":        ["Kokomo Grain", "https://www.kokomograin.com/"],
  "agricharts-legacyfarmers.html":      ["Legacy Farmers Cooperative", "https://www.legacyfarmers.com/"],
  "agricharts-wheatfieldgrain.html":    ["Wheatfield Grain", "https://www.wheatfieldgrain.com/"],
  "agricharts-thefarmerselevator.html": ["The Farmers Elevator Grain & Supply Assn.", "https://www.thefarmerselevator.com/"],
  "agricharts-kellergrain.html":        ["Keller Grain & Feed Inc.", "https://www.kellergrain.com/"],
};

for (const [f, [operator, website]] of Object.entries(BOARDS)) {
  test(`${f}: the operator and their own website come off the page`, () => {
    const html = read(`fixtures/${f}`);
    assert.equal(operatorFrom(html), operator);
    assert.equal(websiteFrom(html), website);
  });
}

test("a page whose title says nothing yields no operator, rather than a bad one", () => {
  assert.equal(operatorFrom("<html><title>Cash Prices</title></html>"), null);
  assert.equal(operatorFrom("<html></html>"), null);
});

test("no main-website link falls back to the site we came from", () => {
  assert.equal(websiteFrom("<html></html>", "https://acoop2.com/"), "https://acoop2.com/");
  assert.equal(websiteFrom("<html></html>"), null);
});

/* ── THE IDS HAVE TO BE THE ONES ALREADY IN sources/ ─────────────────────── */

/* A sweep that names Amboy `kokomograincom-amboy` breaks nothing, errors on
 * nothing, and silently gives the repository a second copy of every elevator it
 * already reads — two files, two pins, two prices for one yard. */
test("the sweep would rebuild the ids of the manifests already live", () => {
  const live = readdirSync(join(ROOT, "sources"))
    .filter((f) => /^(kokomograin|legacyfarmers|wheatfieldgrain|thefarmerselevator)-/.test(f));
  assert.ok(live.length >= 20, `expected the live AgriCharts manifests, found ${live.length}`);
  for (const f of live) {
    const m = JSON.parse(read(`sources/${f}`));
    const id = `${operatorSlug(m.url)}-${slug(m.location)}`;
    assert.equal(id, m.id, `${f} would be rewritten as ${id}`);
  }
});

test("operatorSlug on both hostname forms", () => {
  assert.equal(operatorSlug("https://kokomograin.mobile.agricharts.com/cash/prices.php"), "kokomograin");
  assert.equal(operatorSlug("https://mobile.thefarmerselevator.com/cash/prices.php"), "thefarmerselevator");
  assert.equal(operatorSlug("nonsense"), null);
});

/* ── the directory join ──────────────────────────────────────────────────── */

test("a branch on the board finds its town in the directory", () => {
  const d = joinDirectory(KNOWN, "Kokomo Grain", "Amboy");
  assert.ok(d, "Kokomo Grain / Amboy is in data/known-elevators.json");
  assert.equal(d.city, "Amboy");
  assert.equal(d.state, "IN");
  assert.equal(d.zip, "46911");
});

/* A LOCATION WITH NO DIRECTORY ENTRY GETS NO MANIFEST, and that is the rule
 * this test exists to keep. Paw Paw is on Wheatfield Grain's board with 27 rows
 * of real prices and is not in the directory. There is no honest town for it,
 * so it waits. Rule 1. */
test("a location the directory does not carry returns nothing", () => {
  assert.equal(joinDirectory(KNOWN, "Wheatfield Grain", "Paw Paw"), null);
  assert.equal(joinDirectory(KNOWN, "Legacy Farmers Cooperative", "East Findlay"), null);
  assert.equal(joinDirectory(KNOWN, "Kokomo Grain", ""), null);
});

test("the join never crosses operators", () => {
  // "Amboy" is a branch of Kokomo Grain. Asking for another company's Amboy
  // must not hand back Kokomo's row with Kokomo's phone number on it.
  assert.equal(joinDirectory(KNOWN, "Some Other Elevator Co", "Amboy"), null);
});

test("phone numbers come out in one shape, or not at all", () => {
  assert.equal(phoneOf("(765) 395-7787"), "17653957787");
  assert.equal(phoneOf("765-395-7787"), "17653957787");
  assert.equal(phoneOf("17653957787"), "17653957787");
  assert.equal(phoneOf("N/A"), null);
  assert.equal(phoneOf(null), null);
});

/* ── the manifest it would write ─────────────────────────────────────────── */

const LOC = { locationId: "20018", label: "Amboy", rows: 12,
              commodities: new Set(["Corn", "Soybeans", "Wheat"]) };
const DIR = joinDirectory(KNOWN, "Kokomo Grain", "Amboy");

test("a written manifest passes the same validation the loader applies", () => {
  const m = manifestFor({ id: "kokomograin-amboy", operator: "Kokomo Grain Co.",
    website: "https://www.kokomograin.com/", url: "https://kokomograin.mobile.agricharts.com/cash/prices.php",
    loc: LOC, dir: DIR, zipCoord: { lat: 40.6105, lon: -85.9497 } });
  assert.deepEqual(validateSource(m, new Set()), []);
  assert.equal(m.platform, "agricharts");
  assert.equal(m.identityAlternative, VERIFIED_BY);
  assert.equal(m.locationId, "20018");
  assert.equal(m.latPrecision, "town");
  assert.equal(m.address, null, "no street address exists in the directory; none is invented");
});

test("a manifest with no coordinate says so, and says how to get one", () => {
  const m = manifestFor({ id: "x-y", operator: "Kokomo Grain Co.", website: "https://x/",
    url: "https://x/cash/prices.php", loc: LOC, dir: DIR, zipCoord: null });
  assert.equal(m.lat, null);
  assert.equal(m.lon, null);
  assert.equal("latPrecision" in m, false, "half a claim is worse than none");
  assert.match(m._pending, /geocode fill/);
  assert.deepEqual(validateSource(m, new Set()), []);
});

/* Winamac trades NGMO Waxy, which no default band matches. Without a band that
   source publishes nothing and refuses; with one it publishes seven rows. */
test("a commodity outside the default bands gets one", () => {
  const waxy = manifestFor({ id: "x-y", operator: "Kokomo Grain Co.", website: "https://x/",
    url: "https://x/cash/prices.php", dir: DIR, zipCoord: null,
    loc: { ...LOC, commodities: new Set(["NGMO Waxy"]) } });
  assert.ok(waxy.bands.waxy, "NGMO Waxy matches no default band");
  assert.deepEqual(waxy.bands.waxy, [2.0, 12.0]);
  const plain = manifestFor({ id: "x-y", operator: "K", website: "https://x/",
    url: "https://x/cash/prices.php", loc: LOC, dir: DIR, zipCoord: null });
  assert.equal(plain.bands.waxy, undefined, "and nothing else acquires one");
});

/* ── the host list ───────────────────────────────────────────────────────── */

test("the sweep's site list is the platform ledger's, not a copy", () => {
  const hosts = agrichartsHosts(JSON.parse(read("data/platforms.json")));
  assert.ok(hosts.length > 150, `expected ~211 AgriCharts sites, found ${hosts.length}`);
  for (const h of hosts) assert.match(h, /^https?:\/\//);
  assert.equal(new Set(hosts).size, hosts.length);
});

test("dry run is the default", () => {
  assert.equal(parseArgs([]).write, false);
  assert.equal(parseArgs(["--write"]).write, true);
  assert.equal(parseArgs(["--limit", "40", "--start", "10"]).limit, 40);
  assert.equal(parseArgs(["--limit", "40", "--start", "10"]).start, 10);
});

/* ── one whole board, planned end to end ─────────────────────────────────── */

/* Everything above tests a decision in isolation. This tests the function that
 * makes all of them together, on the four boards that are already live — so the
 * expected answer is known exactly: the same locations, the same ids, and the
 * same three that cannot be given a town. */
import { planBoard } from "../scripts/agricharts-sweep.mjs";
import { parseBoard, mergeQuotes, extract } from "../lib/adapters/agricharts.mjs";

const FIXDIR = join(ROOT, "fixtures");
const CONTRACTS = mergeQuotes(readdirSync(FIXDIR).filter((f) => /^agricharts-quotes-/.test(f))
  .map((f) => read(`fixtures/${f}`)));
const ZIPS = new Map(JSON.parse(read("geocodes/zip-candidates.json")).zips.map((z) => [z.zip, z]));

const PLANS = {
  "agricharts-kokomograin.html": {
    url: "https://kokomograin.mobile.agricharts.com/cash/prices.php", locations: 8, write: 8, unmatched: 0 },
  "agricharts-legacyfarmers.html": {
    url: "https://legacyfarmers.mobile.agricharts.com/cash/prices.php", locations: 10, write: 8, unmatched: 2 },
  "agricharts-wheatfieldgrain.html": {
    url: "https://wheatfieldgrain.mobile.agricharts.com/cash/prices.php", locations: 7, write: 6, unmatched: 1 },
  "agricharts-thefarmerselevator.html": {
    url: "https://mobile.thefarmerselevator.com/cash/prices.php", locations: 1, write: 1, unmatched: 0 },
};

for (const [f, want] of Object.entries(PLANS)) {
  test(`${f}: plans ${want.write} manifest(s) and reports ${want.unmatched} without a town`, () => {
    const html = read(`fixtures/${f}`);
    const rows = extract(html, want.url, { contracts: CONTRACTS });
    const plan = planBoard({ html, url: want.url, site: want.url, rows, known: KNOWN,
                             byZip: ZIPS, existingIds: new Set() });
    assert.ok(plan.ok, plan.why);
    assert.equal(plan.locations, want.locations);
    assert.equal(plan.write.length, want.write);
    assert.equal(plan.unmatched.length, want.unmatched);
    for (const w of plan.write) assert.deepEqual(validateSource(w.json, new Set()), []);
  });

  /* AND RUN AGAINST WHAT IS ALREADY THERE IT WRITES NOTHING. This is the test
     that stops a nightly sweep from re-writing every manifest in the repository
     — and, worse, from quietly reverting a coordinate somebody corrected. */
  test(`${f}: a second pass over the live repository writes nothing`, () => {
    const html = read(`fixtures/${f}`);
    const rows = extract(html, want.url, { contracts: CONTRACTS });
    const live = new Set(readdirSync(join(ROOT, "sources")).map((x) => x.replace(/\.json$/, "")));
    const plan = planBoard({ html, url: want.url, site: want.url, rows, known: KNOWN,
                             byZip: ZIPS, existingIds: live });
    assert.equal(plan.write.length, 0, `would rewrite ${plan.write.map((w) => w.id).join(", ")}`);
    assert.equal(plan.skip.length, want.write);
    for (const s of plan.skip) assert.match(s.why, /already exists/);
  });
}

test("across the four boards, three locations are known and cannot be placed", () => {
  const all = Object.entries(PLANS).flatMap(([f, want]) => {
    const html = read(`fixtures/${f}`);
    const rows = extract(html, want.url, { contracts: CONTRACTS });
    return planBoard({ html, url: want.url, site: want.url, rows, known: KNOWN,
                       byZip: ZIPS, existingIds: new Set() }).unmatched;
  });
  assert.deepEqual(all.map((u) => u.label).sort(), ["East Findlay", "North Findlay", "Paw Paw"]);
  // They are real elevators posting real prices, so the report has to carry
  // enough to act on: which board, which location id, how many rows.
  for (const u of all) {
    assert.match(String(u.locationId), /^\d+$/);
    assert.ok(u.rows > 0);
    assert.match(u.url, /^https:\/\//);
  }
});

/* ── a board that names no place at all ──────────────────────────────────── */

/* THIRTEEN OF THE 23 CAPTURES HAVE ONE LOCATION AND NO NAME FOR IT. Aurora
 * Elevator, Keller Grain, Offerle, Horse Heaven and the rest head their tables
 * with the COMMODITY and carry no location filter, so nothing on the page says
 * where they are. The board IS the operator, and the directory knows where the
 * operator is — but only when it knows of exactly one of them. */
test("a single-location board with no name is placed by its operator", () => {
  const d = joinDirectory(KNOWN, "Aurora Elevator", null, { soleLocation: true });
  assert.ok(d, "Aurora Elevator Inc. is one row in the directory");
  assert.equal(d.city, "Aurora");
  assert.equal(d.state, "IA");
});

test("and only when the board really has one location", () => {
  assert.equal(joinDirectory(KNOWN, "Aurora Elevator", null), null,
    "without soleLocation this must not fire — a 49-location board would take the first row");
});

/* TWO ROWS FOR ONE COMPANY IS NOT AN ANSWER. There is nothing on the page to
   choose between them, so it reports rather than picks. Rule 1. */
test("an operator with several rows is reported, not guessed at", () => {
  const d = joinDirectory(KNOWN, "Kokomo Grain", null, { soleLocation: true });
  assert.equal(d, null, "Kokomo Grain has nine branches; none of them is 'the' one");
});

test("a nameless location on a multi-location board is still reported", () => {
  const html = read("fixtures/agricharts-farmersco-operative.html");
  const rows = extract(html, "https://x/", { contracts: CONTRACTS });
  const plan = planBoard({ html, url: "https://x/", site: "https://x/", rows, known: KNOWN,
                           byZip: ZIPS, existingIds: new Set() });
  assert.equal(plan.write.length, 45, "45 of Dorchester's 49 are in the directory");
  assert.equal(plan.unmatched.length, 4);
  for (const w of plan.write) assert.deepEqual(validateSource(w.json, new Set()), []);
});

/* ────────────────────────────────────────────────────────────────────────
   THE HOSTS FILE IS READ THE WAY EVERY OTHER PROBE LIST IS READ

   --hosts used to require a WHOLE LINE to be a URL:

       .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l))

   Measured 2026-09-03 against the eleven files in probe-lists/: that read
   ZERO urls out of barchart-sites.txt, bushel-candidates.txt,
   discover-candidates.txt and dtn-sites.txt, and 169 of 194 out of
   everything-unasked-20260829.txt. A sweep pointed at any of the first four
   would have reported "0 site(s)" and exited green, which is exactly the
   failure scripts/agricharts-probe.mjs already hit once and already fixed --
   so the fix is to use ITS reader, not a second copy of one.

   The one file both readers agreed on, national-2026-08-26.txt, went 477 to
   475. Both differences are the same two lines listed twice; nothing is lost.
   ──────────────────────────────────────────────────────────────────────── */
import { urlsFrom } from "../scripts/agricharts-probe.mjs";

test("a hosts file may annotate its lines", () => {
  const list = [
    "# AGRICHARTS OPERATORS WE DO NOT READ",
    "#",
    "https://heartlandcoop.com/          # 48 — Heartland Coop",
    "https://agtegra.com/                # 21 — Agtegra",
    "",
    "   https://farmerswin.com/   ",
  ].join("\n");
  assert.deepEqual(urlsFrom(list), [
    "https://heartlandcoop.com/", "https://agtegra.com/", "https://farmerswin.com/",
  ]);
});

test("a commented-out site is not asked", () => {
  assert.deepEqual(urlsFrom("# https://retired.example.com/\nhttps://live.example.com/"),
                   ["https://live.example.com/"]);
});

test("the same site twice is asked once", () => {
  assert.deepEqual(urlsFrom("https://a.example.com/\nhttps://a.example.com/"),
                   ["https://a.example.com/"]);
});

test("the shipped list resolves to the sites its own header claims", () => {
  /* THE HEADER IS PROSE AND PROSE GOES STALE. This is the check that the
     number written at the top is the number the sweep will actually ask. */
  const text = readFileSync(join(ROOT, "probe-lists/agricharts-uncovered-2026-09-03.txt"), "utf8");
  const claimed = Number(text.match(/^#\s*(\d+) sites,/m)[1]);
  assert.equal(urlsFrom(text).length, claimed);
});

test("every line of the shipped list is a site the sweep can build candidates for", () => {
  for (const u of urlsFrom(readFileSync(join(ROOT, "probe-lists/agricharts-uncovered-2026-09-03.txt"), "utf8"))) {
    assert.ok(mobileCandidates(u).length > 0, `no candidate for ${u}`);
  }
});

/* WHAT WILL THE SWEEP ACTUALLY ASK? Testing urlsFrom() on its own passes
   whether or not the sweep calls it -- the reader was never the broken part,
   the wiring was. hostsFor() is the seam, and these go through it. */
test("hostsFor reads an annotated file, comments and all", () => {
  const files = { "list.txt": "# a note\nhttps://a.example.com/   # 48 — A Co\nhttps://b.example.com/\n" };
  assert.deepEqual(
    hostsFor({ hosts: "list.txt", only: null, start: 0, limit: Infinity }, {}, (f) => files[f]),
    ["https://a.example.com/", "https://b.example.com/"]);
});

test("hostsFor falls back to platforms.json when no file is named", () => {
  const platforms = { sites: { "https://x.example.com": { platform: "agricharts" },
                               "https://y.example.com": { platform: "bushel" } } };
  assert.deepEqual(
    hostsFor({ hosts: null, only: null, start: 0, limit: Infinity }, platforms, () => { throw new Error("must not read"); }),
    ["https://x.example.com"]);
});

test("hostsFor still honours --only and --start/--limit on a file", () => {
  const files = { "l.txt": ["https://a.example.com/", "https://b.example.com/", "https://c.example.com/"].join("\n") };
  const read = (f) => files[f];
  assert.deepEqual(hostsFor({ hosts: "l.txt", only: ["b."], start: 0, limit: Infinity }, {}, read),
                   ["https://b.example.com/"]);
  assert.deepEqual(hostsFor({ hosts: "l.txt", only: null, start: 1, limit: 1 }, {}, read),
                   ["https://b.example.com/"]);
});

test("the sweep asks every site in the shipped list", () => {
  /* End to end through the real parseArgs, the real file, the real seam. */
  const cfg = parseArgs(["--hosts", "probe-lists/agricharts-uncovered-2026-09-03.txt"]);
  const got = hostsFor(cfg, {}, (f) => readFileSync(join(ROOT, f), "utf8"));
  const claimed = Number(read("probe-lists/agricharts-uncovered-2026-09-03.txt").match(/^#\s*(\d+) sites,/m)[1]);
  assert.equal(got.length, claimed);
  assert.ok(got.includes("https://heartlandcoop.com/"));
});

test("main asks the file it was given, not data/platforms.json", async () => {
  /* THE MUTATION THIS EXISTS FOR: main() reverting to agrichartsHosts() and
     ignoring --hosts altogether. Every hostsFor test still passes, the run
     goes green, and 211 sites nobody asked for get asked. main() prints its
     tally BEFORE it fetches a single quote page, so a fetcher that answers
     nothing is enough to read it. */
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(" "));
  let code;
  try {
    code = await main(["--hosts", "list.txt"], {
      readText: (f) => (f === "list.txt"
        ? "# note\nhttps://one.example.com/   # 3 — One\nhttps://two.example.com/\n"
        : readFileSync(join(ROOT, f), "utf8")),
      get: async () => ({ ok: false, error: "no network in a test" }),
    });
  } finally { console.log = log; }
  assert.match(said[0], /AGRICHARTS SWEEP — 2 site\(s\)/);
  assert.equal(code, 1, "no quotes means no manifests, and that is a failure");
});

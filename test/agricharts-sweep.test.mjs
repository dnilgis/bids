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
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  mobileCandidates, operatorFrom, websiteFrom, operatorSlug, slug, joinDirectory,
  phoneOf, manifestFor, agrichartsHosts, parseArgs, hostsFor, main, resolveHostsPath,
  describeHostsError, IO, cashgridCandidates, boardCandidates, verdictFor, rank, kindOf,
  captureName, readBoard, BOARD_KINDS,
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
      exists: (f) => f === "list.txt",
      listLists: () => ["list.txt"],
      get: async () => ({ ok: false, error: "no network in a test" }),
    });
  } finally { console.log = log; }
  assert.match(said[0], /AGRICHARTS SWEEP — 2 site\(s\)/);
  assert.equal(code, 1, "no quotes means no manifests, and that is a failure");
});

/* ────────────────────────────────────────────────────────────────────────
   WHAT SOMEBODY TYPES INTO THE BOX

   Run 91604425422, 2026-09-03. The hosts box got

       hosts = probe-lists/agricharts-uncovered-2026-09-03.txt

   which is character-for-character the line the instructions gave — label and
   value in one code span, which reads as "type this". The run refused and
   asked nothing, which is the right failure, but the instruction was mine and
   so was the failure. The label comes off in resolveHostsPath().
   ──────────────────────────────────────────────────────────────────────── */
const LISTS = ["agricharts-mobile.txt", "agricharts-uncovered-2026-09-03.txt"];
const onDisk = new Set(LISTS.map((f) => `probe-lists/${f}`));
const rhp = (v) => resolveHostsPath(v, (p) => onDisk.has(p), () => LISTS);

test("the label the instructions printed is not part of the path", () => {
  assert.equal(rhp("hosts = probe-lists/agricharts-uncovered-2026-09-03.txt").path,
               "probe-lists/agricharts-uncovered-2026-09-03.txt");
  assert.equal(rhp("hosts: probe-lists/agricharts-mobile.txt").path,
               "probe-lists/agricharts-mobile.txt");
  assert.equal(rhp("  host = probe-lists/agricharts-mobile.txt  ").path,
               "probe-lists/agricharts-mobile.txt");
});

test("a plain path still works, and so do quotes round it", () => {
  assert.equal(rhp("probe-lists/agricharts-mobile.txt").path, "probe-lists/agricharts-mobile.txt");
  assert.equal(rhp('"probe-lists/agricharts-mobile.txt"').path, "probe-lists/agricharts-mobile.txt");
  assert.equal(rhp("hosts = 'probe-lists/agricharts-mobile.txt'").path,
               "probe-lists/agricharts-mobile.txt");
});

test("the file name on its own is enough, with or without .txt", () => {
  /* "the list you sent me" is a name, not a path, and probe-lists/ is the only
     place these live. */
  assert.equal(rhp("agricharts-uncovered-2026-09-03.txt").path,
               "probe-lists/agricharts-uncovered-2026-09-03.txt");
  assert.equal(rhp("agricharts-mobile").path, "probe-lists/agricharts-mobile.txt");
});

test("a name that resolves to nothing is refused, not guessed at", () => {
  assert.equal(rhp("probe-lists/nope.txt").path, undefined);
  assert.equal(rhp("").path, undefined);
  assert.equal(rhp("   ").path, undefined);
});

test("the refusal names what would have satisfied it", () => {
  const { error } = rhp("hosts = probe-lists/typo.txt");
  const said = describeHostsError(error);
  assert.match(said, /hosts was "hosts = probe-lists\/typo\.txt"/, "it repeats what it got");
  assert.match(said, /probe-lists\/typo\.txt/, "it says what it tried");
  assert.match(said, /agricharts-uncovered-2026-09-03\.txt/, "it lists what is there");
  assert.match(said, /Nothing was asked/);
});

test("an empty box is told the difference between blank and wrong", () => {
  assert.match(describeHostsError(rhp("").error), /Leave it blank to sweep data\/platforms\.json/);
});

test("a hosts value that resolves to nothing stops the run", async () => {
  /* THE FAILURE THIS MUST NEVER HAVE: falling through to platforms.json and
     sweeping 211 sites that were not the ones asked for. */
  const said = [];
  const err = console.error, log = console.log;
  console.error = (...a) => said.push(a.join(" "));
  console.log = () => {};
  let code;
  try {
    code = await main(["--hosts", "hosts = nope.txt"], {
      readText: () => { throw new Error("must not read anything"); },
      exists: () => false,
      listLists: () => LISTS,
      get: async () => { throw new Error("must not ask anybody anything"); },
    });
  } finally { console.error = err; console.log = log; }
  assert.equal(code, 1);
  assert.match(said.join("\n"), /no such hosts file/);
});

test("the shipped list resolves from its bare name", () => {
  /* End to end against the real repository: this is the value a person is
     most likely to type. */
  const r = resolveHostsPath("agricharts-uncovered-2026-09-03", IO.exists, IO.listLists);
  assert.equal(r.path, "probe-lists/agricharts-uncovered-2026-09-03.txt");
  assert.ok(hostsFor({ hosts: r.path, only: null, start: 0, limit: Infinity }, {}, IO.readText).length > 0);
});

/* ────────────────────────────────────────────────────────────────────────
   THE THIRD URL SHAPE, AND SAYING WHAT HAPPENED

   Run 91606919069 asked 61 AgriCharts operators for a mobile board and found
   two. Measured afterwards: of the 211 sites data/platforms.json calls
   agricharts, our 84 sources come from SIXTEEN distinct mobile boards and only
   18 of the 211 have one we read. The mobile subdomain converts about 8.5% of
   the platform — 2 of 61 is that base rate, not a broken list.

   The other shape is /markets/cashgrid.php, and it is not a guess: it is the
   canonical AgriCharts URL in test/discover.test.mjs and there are twenty more
   in probe-lists/.

   And every one of those 59 sites printed the same line — "no mobile board
   (2 tried)" — which covers a dead host, a 403, a wrong path and a board in a
   shape we cannot parse. Four different next moves, reported identically.
   ──────────────────────────────────────────────────────────────────────── */

test("cashgridCandidates asks the operator's own domain, with and without www", () => {
  assert.deepEqual(cashgridCandidates("https://heartlandcoop.com/"), [
    "https://heartlandcoop.com/markets/cashgrid.php",
    "https://www.heartlandcoop.com/markets/cashgrid.php",
    "https://heartlandcoop.agricharts.com/markets/cashgrid.php",
  ]);
});

test("an agricharts host is already the answer and is not guessed at twice", () => {
  assert.deepEqual(cashgridCandidates("https://pce-coops.agricharts.com/anything"),
                   ["https://pce-coops.agricharts.com/markets/cashgrid.php"]);
});

test("a hyphenated label is tried flat too, as the mobile candidates are", () => {
  const c = cashgridCandidates("https://www.farmersco-operative.com/grain/grain-cash-bids");
  assert.ok(c.includes("https://farmersco-operative.agricharts.com/markets/cashgrid.php"),
            "the spelling probe-lists/everything-unasked-20260829.txt line 114 already carries");
  assert.ok(c.includes("https://farmerscooperative.agricharts.com/markets/cashgrid.php"));
});

test("a URL that will not parse yields no candidates rather than throwing", () => {
  assert.deepEqual(cashgridCandidates("not a url"), []);
  assert.deepEqual(cashgridCandidates(null), []);
});

test("boardCandidates puts the proven shape first", () => {
  const c = boardCandidates("https://heartlandcoop.com/");
  assert.equal(c[0], "https://mobile.heartlandcoop.com/cash/prices.php",
               "a mobile board is the shape already known to parse; ask for it first");
  assert.ok(c.includes("https://www.heartlandcoop.com/markets/cashgrid.php"));
  assert.equal(new Set(c).size, c.length, "no URL is asked twice");
});

test("verdictFor tells four kinds of nothing apart", () => {
  const v = (r) => verdictFor(r).why;
  assert.match(v({ ok: false, error: "TypeError: fetch failed" }), /^unreachable/);
  assert.equal(v({ ok: true, status: 403, body: "", bytes: 0 }), "HTTP 403");
  assert.equal(v({ ok: true, status: 404, body: "x", bytes: 1 }), "HTTP 404");
  assert.match(v({ ok: true, status: 200, bytes: 9000, body: "welcome to our co-op" }),
               /200 but no cash prices/);
  assert.match(v({ ok: true, status: 200, bytes: 9000, body: "<h1>Cash Prices</h1><table class='grid'>" }),
               /PRICES BUT NOT THE TABLE WE KNOW/);
});

test("only the shape the adapter parses counts as a board", () => {
  /* Accepting a page that merely mentions prices would hand parseBoard() a
     document it must refuse, turning a fetch problem into a parse problem and
     losing the fact that the fetch worked. */
  assert.equal(verdictFor({ ok: true, status: 200, bytes: 9000,
                            body: '<table class="cashprices"> cash price' }).board, true);
  assert.equal(verdictFor({ ok: true, status: 200, bytes: 9000,
                            body: "<h1>Cash Prices</h1>" }).board, false);
  assert.equal(verdictFor({ ok: true, status: 200, bytes: 200,
                            body: '<table class="cashprices">' }).board, false, "too small to be a board");
});

test("a site's one line is its most interesting candidate, not its last", () => {
  /* Four dead spellings and one 403 is a 403: that is the one with something
     behind it, and it is a different piece of work from a dead host. */
  const dead = "unreachable: getaddrinfo ENOTFOUND";
  assert.ok(rank("HTTP 403") > rank(dead));
  assert.ok(rank("200, PRICES BUT NOT THE TABLE WE KNOW") > rank("HTTP 403"));
  assert.ok(rank("HTTP 404") > rank("200 but no cash prices (900B)") === false
            || rank("HTTP 404") > rank(dead), "a live site outranks a dead one");
});

test("kindOf does not claim a board is a no-board verdict", () => {
  assert.match(kindOf("200, cashprices table"), /served the board/);
});

/* The seven quote pages, by root, read off the same fixtures the parser tests
   use. Without priced contracts main() refuses before it asks for a board, and
   the refusal is correct — so a test about boards has to satisfy it. */
const QUOTE_FIXTURE_FOR = (u) => {
  const root = /[?&]root=([A-Z]+)/.exec(u)?.[1];
  const byRoot = { ZC: "corn", ZS: "soybeans", ZW: "wheat-chicago", KE: "wheat-kc",
                   MW: "wheat-mpls", ZO: "oats", ZR: "rice" };
  const name = byRoot[root];
  return name ? readFileSync(join(ROOT, `fixtures/agricharts-quotes-${name}.html`), "utf8") : null;
};

test("main asks the cashgrid shape and says what each candidate did", async () => {
  /* END TO END. The fake network reproduces 91606919069's shape: no mobile
     board anywhere, and a cashgrid page that answers 403 — the case the old
     log could not distinguish from "there is nothing there". */
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(" "));
  const asked = [];
  try {
    await main(["--hosts", "l.txt"], {
      readText: (f) => (f === "l.txt" ? "https://heartlandcoop.com/\n" : readFileSync(join(ROOT, f), "utf8")),
      exists: (f) => f === "l.txt",
      listLists: () => ["l.txt"],
      get: async (u) => {
        asked.push(u);
        if (/cash\/prices\.php/.test(u)) return { ok: false, error: "getaddrinfo ENOTFOUND" };
        if (/cashgrid\.php/.test(u)) return { ok: true, status: 403, body: "", bytes: 0 };
        /* The real quote pages, so the run gets past its own "no CBOT quotes"
           refusal and reaches the boards this test is about. */
        const f = QUOTE_FIXTURE_FOR(u);
        return f ? { ok: true, status: 200, body: f, bytes: f.length }
                 : { ok: true, status: 200, body: "", bytes: 0 };
      },
    });
  } finally { console.log = log; }
  const out = said.join("\n");
  assert.ok(asked.some((u) => /markets\/cashgrid\.php/.test(u)), "it asked the cashgrid shape");
  assert.match(out, /HTTP 403/, "the log says 403, not 'no board (2 tried)'");
  assert.match(out, /heartlandcoop\.com\/markets\/cashgrid\.php/, "and names the URL that said it");
  assert.match(out, /answered 403 — a header question/, "and tallies it as work, not as absence");
});

test("the site's verdict is the interesting candidate even when a dead one comes after it", async () => {
  /* THE MUTATION THIS EXISTS FOR: taking the LAST candidate's verdict. Sites
     are asked in a fixed order and the informative answer is rarely last —
     heartlandcoop.com asks the bare domain before www, so a 403 on the first
     would be buried under an ENOTFOUND on the second and the run would tally
     it as "no host answered at all". That is the difference between a header
     problem worth an afternoon and a dead end. */
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(" "));
  try {
    await main(["--hosts", "l.txt"], {
      readText: (f) => (f === "l.txt" ? "https://example-coop.com/\n" : readFileSync(join(ROOT, f), "utf8")),
      exists: (f) => f === "l.txt",
      listLists: () => ["l.txt"],
      get: async (u) => {
        if (/^https:\/\/example-coop\.com\/markets\/cashgrid\.php$/.test(u))
          return { ok: true, status: 403, body: "", bytes: 0 };       // first cashgrid: interesting
        if (/cashgrid\.php|cash\/prices\.php/.test(u))
          return { ok: false, error: "getaddrinfo ENOTFOUND" };        // everything after: dead
        const f = QUOTE_FIXTURE_FOR(u);
        return f ? { ok: true, status: 200, body: f, bytes: f.length } : { ok: true, status: 200, body: "", bytes: 0 };
      },
    });
  } finally { console.log = log; }
  const out = said.join("\n");
  assert.match(out, /1\s+answered 403 — a header question/, out.slice(-600));
  assert.doesNotMatch(out, /1\s+no host answered at all/,
                      "the dead candidates that came after must not be the site's verdict");
});

/* ────────────────────────────────────────────────────────────────────────
   CAPTURING THE BOARDS WE CANNOT READ YET

   Run 91611899805, 61 sites, both URL shapes:

       47  served prices in a table we cannot parse yet
       10  answered 500
        2  answered 403 — a header question, not a missing board

   Not a header problem, not robots, not a missing board. Forty-seven sites
   serve a 200 with cash prices in it, mostly at
   <label>.agricharts.com/markets/cashgrid.php, in a table shape the adapter
   does not know. A parser gets written against bytes somebody received.
   ──────────────────────────────────────────────────────────────────────── */

test("--capture takes a directory, or defaults to fixtures, and eats no other flag", () => {
  assert.equal(parseArgs(["--capture"]).capture, "fixtures");
  assert.equal(parseArgs(["--capture", "debug/boards"]).capture, "debug/boards");
  const cfg = parseArgs(["--capture", "--hosts", "x.txt"]);
  assert.equal(cfg.capture, "fixtures");
  assert.equal(cfg.hosts, "x.txt", "--capture must not swallow the next flag");
  assert.equal(parseArgs([]).capture, null, "off unless asked for");
});

test("a capture is named for the shape, not only the operator", () => {
  /* fixtures/agricharts-auroraelevator.html is already that operator's MOBILE
     board. Two different documents under one name is how a parser ends up
     tested against the wrong evidence. */
  assert.equal(captureName("https://auroraelevator.agricharts.com/markets/cashgrid.php"),
               "agricharts-cashgrid-auroraelevator.html");
  assert.equal(captureName("https://www.uniontowncoop.com/markets/cashgrid.php"),
               "agricharts-cashgrid-uniontowncoop.html");
  assert.equal(captureName("not a url"), null);
});

test("the same operator's two spellings capture to one name", () => {
  /* uniontowncoop answered on BOTH www.uniontowncoop.com and
     uniontowncoop.agricharts.com in run 91611899805. That is one board. */
  assert.equal(captureName("https://uniontowncoop.agricharts.com/markets/cashgrid.php"),
               captureName("https://www.uniontowncoop.com/markets/cashgrid.php"));
});

test("capture writes only the boards it could not parse, and only when asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-cap-"));
  const board = `<html><h1>Cash Prices</h1><table class="grid"><tr><td>Corn</td></tr></table>${"x".repeat(900)}</html>`;
  const io = {
    readText: (f) => (f === "l.txt" ? "https://example-coop.com/\n" : readFileSync(join(ROOT, f), "utf8")),
    exists: (f) => f === "l.txt",
    listLists: () => ["l.txt"],
    get: async (u) => {
      if (/example-coop\.agricharts\.com/.test(u))
        return { ok: true, status: 200, body: board, bytes: board.length };
      if (/cashgrid\.php|cash\/prices\.php/.test(u)) return { ok: true, status: 404, body: "", bytes: 0 };
      const f = QUOTE_FIXTURE_FOR(u);
      return f ? { ok: true, status: 200, body: f, bytes: f.length } : { ok: true, status: 200, body: "", bytes: 0 };
    },
  };
  const quiet = console.log; console.log = () => {};
  try {
    await main(["--hosts", "l.txt"], io);
    assert.equal(existsSync(join(ROOT, "fixtures/agricharts-cashgrid-examplecoop.html")), false,
                 "no --capture, no writing");
    await main(["--hosts", "l.txt", "--capture", dir], io);
  } finally { console.log = quiet; }
  const written = readdirSync(dir);
  assert.deepEqual(written, ["agricharts-cashgrid-examplecoop.html"]);
  assert.equal(readFileSync(join(dir, written[0]), "utf8"), board,
               "verbatim and unedited — a fixture is the bytes, not a summary of them");
  rmSync(dir, { recursive: true, force: true });
});

test("a fixture already on file is kept, and --refresh replaces it", async () => {
  /* A FIXTURE IS FROZEN EVIDENCE. Rewriting it every run turns a diff that
     means "the specimen moved" into noise nobody reads. */
  const dir = mkdtempSync(join(tmpdir(), "sweep-cap-"));
  const file = join(dir, "agricharts-cashgrid-examplecoop.html");
  writeFileSync(file, "OLD CAPTURE FROM AN EARLIER RUN");
  const board = `<html>Cash Prices<table class="grid">${"y".repeat(900)}</table></html>`;
  const io = {
    readText: (f) => (f === "l.txt" ? "https://example-coop.com/\n" : readFileSync(join(ROOT, f), "utf8")),
    exists: (f) => f === "l.txt",
    listLists: () => ["l.txt"],
    get: async (u) => {
      if (/example-coop\.agricharts\.com/.test(u))
        return { ok: true, status: 200, body: board, bytes: board.length };
      if (/cashgrid\.php|cash\/prices\.php/.test(u)) return { ok: true, status: 404, body: "", bytes: 0 };
      const f = QUOTE_FIXTURE_FOR(u);
      return f ? { ok: true, status: 200, body: f, bytes: f.length } : { ok: true, status: 200, body: "", bytes: 0 };
    },
  };
  const quiet = console.log; console.log = () => {};
  try {
    await main(["--hosts", "l.txt", "--capture", dir], io);
    assert.equal(readFileSync(file, "utf8"), "OLD CAPTURE FROM AN EARLIER RUN", "kept");
    await main(["--hosts", "l.txt", "--capture", dir, "--refresh"], io);
    assert.equal(readFileSync(file, "utf8"), board, "--refresh replaces it");
  } finally { console.log = quiet; }
  rmSync(dir, { recursive: true, force: true });
});

test("a board we CAN parse is never captured — it is not evidence of a gap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-cap-"));
  const good = `<html>cash price<table class="cashprices">${"z".repeat(900)}</table></html>`;
  const quiet = console.log; console.log = () => {};
  try {
    await main(["--hosts", "l.txt", "--capture", dir], {
      readText: (f) => (f === "l.txt" ? "https://example-coop.com/\n" : readFileSync(join(ROOT, f), "utf8")),
      exists: (f) => f === "l.txt",
      listLists: () => ["l.txt"],
      get: async (u) => {
        if (/cash\/prices\.php/.test(u)) return { ok: true, status: 200, body: good, bytes: good.length };
        if (/cashgrid\.php/.test(u)) return { ok: true, status: 404, body: "", bytes: 0 };
        const f = QUOTE_FIXTURE_FOR(u);
        return f ? { ok: true, status: 200, body: f, bytes: f.length } : { ok: true, status: 200, body: "", bytes: 0 };
      },
    });
  } finally { console.log = quiet; }
  assert.deepEqual(readdirSync(dir), [], "it parsed, or refused to parse — either way it is not a capture");
  rmSync(dir, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────
   ONE PLATFORM, TWO DOCUMENTS

   AgriCharts serves a MOBILE board and a CASHGRID, and the sweep only ever
   knew the first. Measured 2026-09-03 across the repo's own fixtures: 21 read
   as mobile, 45 as cashgrid. The 45 carry 506 locations — more elevators than
   this repository currently reads at all.
   ──────────────────────────────────────────────────────────────────────── */
import { VERIFIED_BY as CASHGRID_STAMP } from "../lib/adapters/agricharts-cashgrid.mjs";

const QUOTES = CONTRACTS;
const fix = (f) => readFileSync(join(ROOT, "fixtures", f), "utf8");
const cashgrids = () => readdirSync(join(ROOT, "fixtures"))
  .filter((f) => /^agricharts-cashgrid-/.test(f)).sort();

test("the operator's name is not '- Cash Bids'", () => {
  /* The mobile board titles itself "Cash Prices - X mobile site"; the cashgrid
     titles itself "X - Cash Bids". Left alone, the name handed to
     joinDirectory() was "AgMark LLC. - Cash Bids", which matches nothing in
     Barchart's directory — all 47 boards would have gone to the unmatched list
     looking like a directory problem. */
  assert.equal(operatorFrom("<title>AgMark LLC.  - Cash Bids</title>"), "AgMark LLC.");
  assert.equal(operatorFrom("<title>Agtegra - Cash Bids</title>"), "Agtegra");
  /* Two of the 47 stack it — an internal template name in the <title>. */
  assert.equal(operatorFrom("<title>Farmward Cooperative Cash Bid JSI - Cash Bids</title>"),
               "Farmward Cooperative");
  assert.equal(operatorFrom("<title>Leiters Grain Cash Bid JSI site - Cash Bids</title>"),
               "Leiters Grain");
});

test("the mobile titles are untouched by that", () => {
  assert.equal(operatorFrom(fix("agricharts-legacyfarmers.html")), "Legacy Farmers Cooperative");
  assert.equal(operatorFrom(fix("agricharts-agplusinc.html")), "Ag Plus, Inc");
  assert.equal(operatorFrom(fix("agricharts-balkgrain.html")), "Balk Grain and Trucking, Inc.");
});

test("every cashgrid capture yields a usable operator name", () => {
  const bad = cashgrids().filter((f) => {
    const o = operatorFrom(fix(f));
    return o && /cash\s*bid|jsi\b/i.test(o);
  });
  assert.deepEqual(bad, [], `these still carry boilerplate: ${bad.join(", ")}`);
});

test("which parser reads a board is decided by the board, never by the URL", () => {
  /* faasfeed serves the MOBILE cashprices table at its /markets/cashgrid.php
     address. A URL-shaped guess hands that page to the wrong parser and calls
     the refusal a broken board. */
  const faas = readBoard(fix("agricharts-cashgrid-faasfeed.html"),
                         "https://faasfeed.agricharts.com/markets/cashgrid.php", QUOTES);
  assert.equal(faas.kind, "mobile", "read by its shape, not its address");
  const hull = readBoard(fix("agricharts-cashgrid-hullfeed.html"), "https://x/", QUOTES);
  assert.equal(hull.kind, "cashgrid");
  assert.ok(hull.rows.length > 0);
});

test("readBoard says what each parser said when neither reads it", () => {
  const r = readBoard("<html>nothing here at all</html>", "https://x/", QUOTES);
  assert.equal(r.kind, null);
  assert.equal(r.tried.length, 2, "both were tried and both said why");
  assert.ok(r.tried.some((t) => /^mobile:/.test(t)));
  assert.ok(r.tried.some((t) => /^cashgrid:/.test(t)));
});

test("every fixture in the repository is read by one of the two, or refused by both", () => {
  const by = { mobile: 0, cashgrid: 0, refused: [] };
  for (const f of readdirSync(join(ROOT, "fixtures")).filter((x) => /^agricharts-(?!quotes)/.test(x))) {
    const r = readBoard(fix(f), "https://x/", QUOTES);
    if (r.kind) by[r.kind]++; else by.refused.push(f);
  }
  assert.ok(by.cashgrid >= 45, `only ${by.cashgrid} cashgrid boards`);
  assert.ok(by.mobile >= 21, `only ${by.mobile} mobile boards`);
  /* The refusals are named, not counted. Butterfield and Westco publish no
     basis at all; Heartland's cashgrid page has no board on it. */
  assert.deepEqual(by.refused.sort(), [
    "agricharts-butterfieldgrain.html",
    "agricharts-cashgrid-heartlandcoop.html",
    "agricharts-westco.html",
  ].sort());
});

test("verdictFor knows a cashgrid board is a board", () => {
  const page = (n) => ({ ok: true, status: 200, bytes: 9000,
    body: "function writeBidCell(basis){}" + "writeBidCell(-1,false,0,false,56,'c=1&l=2&d=U26',false);".repeat(n) });
  assert.equal(verdictFor(page(3)).board, true);
  assert.match(verdictFor(page(3)).why, /cashgrid \(3 price cell/);
  /* THE DEFINITION CONTAINS THE STRING TOO. A page carrying the machinery and
     no bids matches once and is not a board. */
  assert.equal(verdictFor(page(0)).board, false);
  assert.match(verdictFor(page(0)).why, /machinery but NO PRICE CELLS/);
  assert.match(kindOf(verdictFor(page(0)).why), /no bids on it/);
  assert.match(kindOf(verdictFor(page(3)).why), /served the board/);
});

test("a cashgrid manifest says cashgrid, and carries the cashgrid stamp", () => {
  const loc = { locationId: "77", label: "Somewhere", rows: 4, commodities: new Set(["Corn"]) };
  const dir = { branch: "SOMEWHERE", city: "Somewhere", state: "IA", zip: "50001", phone: null };
  const m = manifestFor({ id: "x-somewhere", operator: "X Co", website: "https://x.com/",
                          url: "https://x.agricharts.com/markets/cashgrid.php",
                          loc, dir, zipCoord: null, kind: "cashgrid" });
  assert.equal(m.platform, "agricharts-cashgrid");
  assert.equal(m.identityAlternative, CASHGRID_STAMP);
  assert.match(m.note, /cashgrid board at/);
  assert.match(m.note, /true by construction/);
  assert.doesNotMatch(m.note, /futures CHANGE and no futures/, "that is the mobile board's story");
  assert.doesNotMatch(m.note, /Visit Our Main Website/, "the cashgrid has no such link");
});

test("a mobile manifest is exactly what it was", () => {
  const loc = { locationId: "77", label: "Somewhere", rows: 4, commodities: new Set(["Corn"]) };
  const dir = { branch: "SOMEWHERE", city: "Somewhere", state: "IA", zip: "50001", phone: null };
  const m = manifestFor({ id: "x-somewhere", operator: "X Co", website: "https://x.com/",
                          url: "https://x.mobile.agricharts.com/cash/prices.php",
                          loc, dir, zipCoord: null });
  assert.equal(m.platform, "agricharts", "the default is still mobile");
  assert.match(m.note, /mobile board at/);
  assert.match(m.note, /futures CHANGE and no futures/);
  assert.match(m.note, /Visit Our Main Website/);
});

test("the manifests a cashgrid board plans all validate", () => {
  const known = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8")).elevators;
  const byZip = new Map(JSON.parse(readFileSync(join(ROOT, "geocodes/zip-candidates.json"), "utf8"))
    .zips.map((z) => [z.zip, z]));
  const url = "https://farmerswin.agricharts.com/markets/cashgrid.php";
  const html = fix("agricharts-cashgrid-farmerswin.html");
  const board = readBoard(html, url, QUOTES);
  assert.equal(board.kind, "cashgrid");
  const plan = planBoard({ html, url, site: "https://farmerswin.com/", rows: board.rows,
                           known, byZip, existingIds: new Set(), kind: "cashgrid" });
  assert.ok(plan.ok, plan.why);
  assert.equal(plan.operator, "Farmers Win Cooperative");
  assert.ok(plan.write.length >= 19, `only ${plan.write.length} manifests planned`);
  for (const w of plan.write) {
    assert.equal(w.json.platform, "agricharts-cashgrid");
    assert.equal(validateSource(w.json, new Set()).length, 0,
                 `${w.id}: ${validateSource(w.json, new Set()).join("; ")}`);
    assert.ok(w.json.location && w.json.state && w.json.zip, `${w.id} has no town`);
  }
});

test("the whole capture set plans 253 manifests from an empty repository", () => {
  /* THE NUMBER THIS WORK IS FOR. Recomputed here rather than remembered: if a
     capture, the directory or the join changes, this says so instead of the
     README quietly going stale. */
  const known = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8")).elevators;
  const byZip = new Map(JSON.parse(readFileSync(join(ROOT, "geocodes/zip-candidates.json"), "utf8"))
    .zips.map((z) => [z.zip, z]));
  /* AN EMPTY SET ON PURPOSE. Seeded from sources/, this test measured the
     DIFFERENCE between the captures and the repository — so the moment run
     91672980386 wrote those 233 manifests, the same captures planned nothing
     and the test that proved the work went red because the work shipped. What
     is worth guarding is what these boards CONTAIN, which does not change when
     the repo catches up. */
  const seen = new Set();
  let write = 0, unmatched = 0;
  for (const f of cashgrids()) {
    const slugName = f.slice("agricharts-cashgrid-".length, -".html".length);
    const url = `https://${slugName}.agricharts.com/markets/cashgrid.php`;
    const html = fix(f);
    const board = readBoard(html, url, QUOTES);
    if (!board.kind) continue;
    const plan = planBoard({ html, url, site: `https://${slugName}.com/`, rows: board.rows,
                             known, byZip, existingIds: seen, kind: board.kind });
    if (!plan.ok) continue;
    for (const w of plan.write) seen.add(w.id);
    write += plan.write.length; unmatched += plan.unmatched.length;
  }
  assert.ok(write >= 250, `only ${write} manifests plannable from the captures`);
  /* The unmatched are a QUEUE, not a rounding error: real elevators posting
     real prices that data/known-elevators.json cannot give a town to. */
  assert.ok(unmatched > 0, "every location matching would be surprising, not good news");
});

test("no two boards plan the same id", () => {
  /* A generated id is an identity. Two boards deriving the same one silently
     overwrite each other's elevator. */
  const known = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8")).elevators;
  const byZip = new Map();
  const seen = new Set();
  const ids = [];
  for (const f of cashgrids()) {
    const slugName = f.slice("agricharts-cashgrid-".length, -".html".length);
    const url = `https://${slugName}.agricharts.com/markets/cashgrid.php`;
    const board = readBoard(fix(f), url, QUOTES);
    if (!board.kind) continue;
    const plan = planBoard({ html: fix(f), url, site: `https://${slugName}.com/`, rows: board.rows,
                             known, byZip, existingIds: seen, kind: board.kind });
    if (!plan.ok) continue;
    for (const w of plan.write) { ids.push(w.id); seen.add(w.id); }
  }
  assert.equal(new Set(ids).size, ids.length, "duplicate ids across boards");
});

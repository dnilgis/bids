import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { familyOf, namesMatch, hostMatches, pickLinks, pathAllowed, digestOf, looksLikeBoard, shardOf, isSharedHost,
  pathProbes, docStatus }
  from "../lib/elevsites.mjs";
import { parseListLine, buildWorklist, captureUrls } from "../scripts/elevsites-list.mjs";
import { parseArgs, allowedBy, robotsFor } from "../scripts/capture-pages.mjs";

test("family folds old spellings the way the coverage plan did", () => {
  assert.equal(familyOf("Consolidated Grain & Barge Co. - Cahokia"), "CGB");
  assert.equal(familyOf("CHS Inc. - Direct Ship"), "CHS");
  assert.equal(familyOf("Meyer Brothers Grain"), familyOf("MEYER BROTHERS GRAIN"));
});

test("names match only on their distinctive words", () => {
  assert.ok(namesMatch("Meyer Brothers Grain", "MEYER BROTHERS GRAIN INC"));
  assert.ok(namesMatch("Cadott Grain Service LLC", "Cadott Grain Service"));
  assert.ok(namesMatch("Wheaton Dumont Coop", "Wheaton-Dumont Cooperative Elevator"));
  // one shared word that is not the leading one
  assert.ok(!namesMatch("Cargill Soybean Processing Plant", "Grain Processing Corporation"));
  // one distinctive word each, the rest disagrees
  assert.ok(!namesMatch("Minnesota Soybean Processors", "Minnesota Valley Grain"));
  assert.ok(!namesMatch("Dakota Grain Co Inc", "Dakota Midland Grain"));
  assert.ok(!namesMatch("Meyer Grain", "Meyer Feed"));
  // generic words alone never match
  assert.ok(!namesMatch("Farmers Elevator Co", "Farmers Cooperative Elevator"));
});

test("a bare host matches only when it spells the company", () => {
  assert.ok(hostMatches("meyerbrothersgrain.com", "Meyer Brothers Grain"));
  assert.ok(hostMatches("pandoragrain.com", "Pandora Grain and Supply Inc"));
  assert.ok(!hostMatches("grain.com", "Grain Co"));
  assert.ok(!hostMatches("heartland.agricharts.com", "Heartland"));
  assert.ok(isSharedHost("facebook.com") && isSharedHost("heartland.agricharts.com") && !isSharedHost("testcoop.com"));
});

test("probe-list comment lines give url, name and town", () => {
  assert.deepEqual(parseListLine("https://agriwaypartners.com/  # Agri-Way Partners, LLC.; Cedar Rapids, IA; proved by phone; barchart"),
    { url: "https://agriwaypartners.com/", name: "Agri-Way Partners, LLC.", place: "Cedar Rapids, IA" });
  assert.equal(parseListLine("https://heartlandcoop.com/      #  48 — Heartland Coop").name, "Heartland Coop");
  assert.equal(parseListLine("E0149201  https://www.countrypartnerscoop.com/grain/cash-bids   Country Partners Cooperative  # 13").name,
    "Country Partners Cooperative");
  assert.equal(parseListLine("https://acoop2.com/").name, "");
  assert.equal(parseListLine("no url here"), null);
});

test("worklist: one company, its rows, its site; duplicate-only companies are not captured", () => {
  const dir = { elevators: [
    { id: "a", operator: "Meyer Brothers Grain", location: "Elk Mound", state: "WI", platform: null },
    { id: "b", operator: "MEYER BROTHERS GRAIN INC", location: "Menomonie", state: "WI", platform: null },
    { id: "c", operator: "Zed Feed", location: "Ames", state: "IA", platform: null, duplicateSuspect: true },
    { id: "d", operator: "Read Already", location: "X", state: "KS", platform: "dtn" },
  ] };
  const sites = { named: [{ url: "http://meyergrain.com/cash-bids", name: "Meyer Brothers Grain", from: "probe-lists/x.txt" },
                          { url: "https://zedfeed.com/", name: "Zed Feed", from: "probe-lists/x.txt" }], bare: [] };
  const wl = buildWorklist(dir, sites);
  const m = wl.find((c) => c.company === familyOf("Meyer Brothers Grain"));
  assert.equal(m.rows, 2); assert.equal(m.upperMidwest, 2); assert.equal(m.sites[0].host, "meyergrain.com");
  assert.ok(!wl.some((c) => c.names?.includes("Read Already")));
  const urls = captureUrls(wl).map((u) => u.url);
  assert.deepEqual(urls, ["http://meyergrain.com/", "http://meyergrain.com/cash-bids"]);
});

test("link picker: bid-looking links on the same site or a bid platform, strongest first", () => {
  const html = `<a href="/about">About</a><a href="/grain/cash-bids/">Cash Bids</a><a href="/markets">Markets</a>
    <a href="https://othersite.com/bids">Bids elsewhere</a><a href="https://heartland.agricharts.com/markets/cash.php">Grain</a>
    <a href="/docs/bids.pdf">Bids PDF</a><a href="mailto:x@y.com">Bids by mail</a><a href="/login">Bids login</a>`;
  const got = pickLinks(html, "https://www.testcoop.com/", 3).map((l) => l.url);
  // a hand-off to a bid platform is the strongest lead there is
  assert.deepEqual(got, ["https://heartland.agricharts.com/markets/cash.php", "https://www.testcoop.com/grain/cash-bids/",
                         "https://www.testcoop.com/markets"]);
});

test("robots: longest rule wins, Allow wins a tie, other agents ignored, no file allows", () => {
  const r = "User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /markets/\nAllow: /markets/cash.php\nDisallow: /*.pdf$\n";
  assert.equal(pathAllowed(r, "/"), true);
  assert.equal(pathAllowed(r, "/markets/futures.php"), false);
  assert.equal(pathAllowed(r, "/markets/cash.php"), true);
  assert.equal(pathAllowed(r, "/docs/bids.pdf"), false);
  assert.equal(pathAllowed(r, "/docs/bids.pdf?x=1"), true);
  assert.equal(pathAllowed("", "/anything"), true);
  assert.equal(pathAllowed("User-agent: *\nDisallow:\n", "/x"), true);
  assert.equal(pathAllowed("User-agent: *\nDisallow: /\n", "/x"), false);
  assert.equal(allowedBy({ text: "", unreachable: true }, "https://a.com/"), false);
});

test("robots.txt is asked once per site and a 5xx means skip the site", async () => {
  let calls = 0;
  const f = async () => { calls++; return { ok: false, status: 503, text: async () => "" }; };
  const cache = new Map();
  const a = await robotsFor("https://a.com", cache, f);
  await robotsFor("https://a.com", cache, f);
  assert.equal(calls, 1); assert.equal(a.unreachable, true);
  const b = await robotsFor("https://b.com", cache, async () => ({ ok: false, status: 404, text: async () => "" }));
  assert.equal(allowedBy(b, "https://b.com/cash-bids"), true);
});

test("digest keeps the readable part; a board needs a crop word and three prices", () => {
  const html = `<html><head><title> Cash  Bids </title><script src="//www.dtnpf.com/x.js"></script><style>.a{}</style></head>
    <body><iframe src="https://portal.bushelpowered.com/x"></iframe><table><tr><th>Corn</th></tr><tr><td>3.85</td><td>-0.42</td><td>3.91</td></tr></table>
    <a href="/bids.pdf">PDF bids</a><a href="https://facebook.com/coop">fb</a></body></html>`;
  const d = digestOf({ pageUrl: "https://coop.com/bids", html, responses: [{ url: "https://www.dtnpf.com/x.js" }, { url: "https://www.dtnpf.com/y", body: "{}" }] });
  assert.equal(d.title, "Cash Bids");
  assert.ok(d.looksLikeBoard);
  assert.ok(!d.text.includes(".a{}"));
  assert.deepEqual(d.scripts, ["https://www.dtnpf.com/x.js"]);
  assert.deepEqual(d.iframes, ["https://portal.bushelpowered.com/x"]);
  assert.equal(d.pdfLinks[0].url, "https://coop.com/bids.pdf");
  assert.deepEqual(d.facebook, ["https://facebook.com/coop"]);
  assert.equal(d.responseHosts["dtnpf.com"], 2);
  assert.deepEqual(d.dataResponses, ["https://www.dtnpf.com/y"]);
  assert.ok(!looksLikeBoard("Corn is our business since 1921. Call 555-1234."));
  assert.ok(!looksLikeBoard("3.85 3.91 4.02 but no crop named"));
});

test("shards: one host always in one shard, every shard in range", () => {
  assert.equal(shardOf("https://a.com/x", 8), shardOf("https://a.com/y?z", 8));
  for (const u of ["https://a.com/", "https://b.org/", "http://c.net/"]) assert.ok(shardOf(u, 5) >= 0 && shardOf(u, 5) < 5);
  assert.equal(shardOf("https://a.com/", 1), 0);
});

test("capture args: --follow is capped, --shard must be i/n", () => {
  assert.equal(parseArgs(["--out", "x", "--follow", "9"]).follow, 6);
  assert.equal(parseArgs(["--out", "x", "--depth", "5"]).depth, 2);
  assert.equal(parseArgs(["--out", "x"]).pick, "bids");
  assert.deepEqual(parseArgs(["--out", "x", "--paths", "/cash-bids,/grain"]).paths, ["/cash-bids", "/grain"]);
  assert.throws(() => parseArgs(["--out", "x", "--pick", "everything"]));
  assert.deepEqual(parseArgs(["--out", "x", "--shard", "3/8"]).shard, [3, 8]);
  assert.throws(() => parseArgs(["--shard", "8/8"]));
});

test("the committed worklist and capture list agree and name no denied host", () => {
  if (!existsSync(new URL("../data/gaps/elevsites.json", import.meta.url))) return;
  const w = JSON.parse(readFileSync(new URL("../data/gaps/elevsites.json", import.meta.url), "utf8"));
  const list = readFileSync(new URL("../probe-lists/elevsites.txt", import.meta.url), "utf8")
    .split("\n").filter((l) => /^https?:/.test(l)).map((l) => l.split(/\s+/)[0]);
  assert.equal(list.length, w.counts.pages);
  assert.equal(new Set(list).size, list.length);
  assert.ok(w.counts.companiesWithSite > 0 && w.counts.rowsWithSite <= w.counts.realRows);
});

test("schedule picker: discount, drying and storage links first, PDFs only when named so, grain pages as steps", () => {
  const html = `<a href="/about">About</a><a href="/grain">Grain</a><a href="/docs/Grain-Discount-Schedule.pdf">2026 Discounts</a>
    <a href="/docs/menu.pdf">Lunch menu</a><a href="/storage-rates">Storage rates</a><a href="https://other.com/discounts">Discounts</a>
    <a href="/feed">Feed</a>`;
  const got = pickLinks(html, "https://www.testcoop.com/", 5, "schedule");
  assert.deepEqual(got.map((l) => l.url), ["https://www.testcoop.com/docs/Grain-Discount-Schedule.pdf",
    "https://www.testcoop.com/storage-rates", "https://www.testcoop.com/grain"]);
  assert.equal(got[0].pdf, true);
  // bids mode is unchanged: no PDF, no schedule link
  assert.ok(!pickLinks(html, "https://www.testcoop.com/", 5).some((l) => /pdf|storage/.test(l.url)));
});

test("land picker: county offices and sales links, a vendor host when the link names the office", () => {
  const html = `<a href="/departments/assessor">Assessor</a><a href="https://beacon.schneidercorp.com/?site=StoryCountyIA">Property search (Beacon)</a>
    <a href="https://www.facebook.com/storycounty">Assessor on Facebook</a><a href="https://parks.example.org/">Parks</a>
    <a href="/files/2025-sales-list.pdf">2025 sales list</a><a href="/jobs">Jobs</a><a href="/news">News</a>`;
  const got = pickLinks(html, "https://www.storycountyiowa.gov/", 6, "land").map((l) => l.url);
  assert.ok(got.includes("https://www.storycountyiowa.gov/departments/assessor"));
  assert.ok(got.includes("https://beacon.schneidercorp.com/?site=StoryCountyIA"));
  assert.ok(got.includes("https://www.storycountyiowa.gov/files/2025-sales-list.pdf"));
  assert.ok(!got.some((u) => /facebook|parks|jobs|news/.test(u)), got);
});

test("path probes stay on the listed origin; the document status comes from the main response", () => {
  assert.deepEqual(pathProbes("https://coop.com/home?x=1", ["/cash-bids", "/grain", "/cash-bids", "javascript:x", "//evil.com"]),
    ["https://coop.com/cash-bids", "https://coop.com/grain"]);
  assert.deepEqual(pathProbes("not a url", ["/a"]), []);
  assert.equal(docStatus("https://coop.com/grain", [{ url: "https://coop.com/x.js", status: 200, mime: "text/javascript" },
    { url: "https://coop.com/grain/", status: 404, mime: "text/html" }]), 404);
  assert.equal(docStatus("https://coop.com/a", []), null);
});

test("county sites: one row per county FIPS in the ten states, one site per host, https first", async () => {
  const { countiesFrom, listLines, QUERY } = await import("../scripts/county-sites-list.mjs");
  const j = { results: { bindings: [
    { fips: { value: "19169" }, item: { value: "Q1" }, label: { value: "Story County" }, site: { value: "http://www.storycountyiowa.gov" } },
    { fips: { value: "19169" }, site: { value: "https://www.storycountyiowa.gov/" } },
    { fips: { value: "39001" }, label: { value: "Adams County" } },
    { fips: { value: "55025" }, site: { value: "https://www.countyofdane.com/" } },
    { fips: { value: "19000" } }] } };
  const c = countiesFrom(j);
  assert.deepEqual(c.map((x) => [x.fips, x.state, x.name, x.sites]),
    [["19169", "IA", "Story County", ["https://www.storycountyiowa.gov/"]], ["39001", "OH", "Adams County", []]]);
  assert.deepEqual(listLines(c), ["https://www.storycountyiowa.gov/  # 19169 Story County, IA"]);
  assert.ok(QUERY.includes('STRSTARTS(?fips, "38")') && QUERY.includes("P856"));
});

test("schedules list: one home page per company host, read companies first, platform hosts never", async () => {
  const { unreadCompanies, buildList } = await import("../scripts/schedules-list.mjs");
  const read = [{ company: "R:A Coop", read: true, url: "https://acoop.com/", locations: 2, upperMidwest: 0, states: {} },
                { company: "R:B Grain", read: true, url: "https://bgrain.com/", locations: 1, upperMidwest: 1, states: {} }];
  const un = unreadCompanies("https://acoop.com/x  # A COOP\nhttps://c.agricharts.com/m  # C\nhttps://dfarm.com/bids  # D FARM\nhttps://dfarm.com/  # D FARM",
    new Set(["acoop.com"]));
  assert.deepEqual(un.map((c) => [c.company, c.url]), [["U:D FARM", "https://dfarm.com/"]]);
  assert.deepEqual(buildList(read, un).map((c) => c.company), ["R:B Grain", "R:A Coop", "U:D FARM"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { familyOf, namesMatch, hostMatches, pickLinks, pathAllowed, digestOf, looksLikeBoard, shardOf, isSharedHost }
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
  assert.equal(parseArgs(["--out", "x", "--follow", "9"]).follow, 5);
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

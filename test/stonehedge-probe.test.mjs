/* The StoneHedge capture kit, on the shapes it will meet, with no network.
 *
 * Nothing here is a StoneHedge board, because none has ever been captured --
 * that is what the kit is for. The fixtures below are INVENTED to exercise the
 * script's plumbing (does it find a widget URL, scrub a key, refuse politely,
 * merge a summary), and they are named as such. No adapter is tested here or
 * anywhere yet, and no test may pretend a specimen exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, urlsFrom, stonehedgeUrlsFromList, deriveSites, componentRefs, secretsOf, scrub,
         priceTable, slugOf, makeFetcher, run, tally, UA, MAX_PAGES } from "../scripts/stonehedge-probe.mjs";
import { captureAll, findBrowser } from "../lib/cdp.mjs";

const KEY = "ZZTESTKEY0123456789ABCDEFGHIJKL";
const COMPONENT = `https://stonehedge.stonex.com/component/bids?key=${KEY}&cols=date%2Cbasis%2Ccash%2Cmonth&locs=AAA%2CBBB&hideRows=true`;

/* ---- which sites: derived from the repo's own data ---------------------- */

test("the site list comes from data/platforms.json and the probe lists, not from a typed list", () => {
  const platforms = JSON.parse(readFileSync("data/platforms.json", "utf8"));
  const lists = readdirSync("probe-lists").filter((f) => f.endsWith(".txt"))
    .map((f) => ({ name: `probe-lists/${f}`, text: readFileSync(`probe-lists/${f}`, "utf8") }));
  const sites = deriveSites({ platforms, lists });
  const names = sites.map((s) => s.site);
  for (const want of ["agvalley.com", "mrga.com", "scottequityexchange.com", "frontiercooperative.com"])
    assert.ok(names.includes(want), `${want} is one of the four operators the roster names; got ${names}`);
  assert.ok(sites.every((s) => s.pages.length >= 1 && s.pages.length <= MAX_PAGES), "bounded per site");
  const frontier = sites.find((s) => s.site === "frontiercooperative.com");
  assert.equal(frontier.pages[0], "https://www.frontiercooperative.com/grain/cash-bids",
               "the page a person verified is asked first");
  assert.equal(new Set(names).size, names.length, "one entry per domain");
  assert.ok(!names.includes("poetgrain.com"), "a POET plant sits just above the STONEHEDGE heading and is not one");
  assert.ok(sites.every((s) => !s.pages.some((p) => /\.pdf/i.test(p))));
});

test("a list URL counts only when its own comment names StoneHedge or StoneX", () => {
  const text = `https://a.example/grain  # StoneHedge widget
https://b.example/grain
#    VERIFIED stonehedge — B Co-op
https://c.example/grain
#    VERIFIED barchart — C
https://stonehedge.stonex.com/component/bids?key=x   # StoneX
# https://d.example/  StoneHedge
https://e.example/last

# ========
# STONEHEDGE  --  3 page(s)
https://f.example/bids.pdf   # StoneX PDF fallback`;
  assert.deepEqual(stonehedgeUrlsFromList(text), ["https://a.example/grain", "https://b.example/grain"],
                   "a heading after a blank line belongs to the next section; a PDF is not a board");
});

test("--url narrows the run to that site", () => {
  const s = deriveSites({ platforms: { sites: { "https://x.example/": { platform: "stonehedge" }, "https://y.example/": { platform: "stonehedge" } } },
                          explicit: ["https://www.y.example/cash-bids"] });
  assert.deepEqual(s.map((x) => x.site), ["y.example"]);
  assert.equal(s[0].pages[0], "https://www.y.example/cash-bids");
});

test("a pasted list is split on any whitespace", () => {
  assert.deepEqual(urlsFrom("https://a.example/ https://b.example/\nhttps://a.example/"), ["https://a.example/", "https://b.example/"]);
  assert.deepEqual(parseArgs(["--url", "https://a.example/", "https://b.example/", "--refresh", "--no-browser"]).urls.length, 2);
});

/* ---- finding the widget, and never keeping its key ---------------------- */

test("the widget URL is found in every spelling it turns up in", () => {
  const plain = `<iframe src="${COMPONENT.replace(/&/g, "&amp;")}"></iframe>`;
  assert.deepEqual(componentRefs(plain), [COMPONENT]);
  assert.deepEqual(componentRefs(`x="//stonehedge.stonex.com/component/bids?key=${KEY}"`), [`https://stonehedge.stonex.com/component/bids?key=${KEY}`]);
  assert.deepEqual(componentRefs(`{"u":"https:\\/\\/stonehedge.stonex.com\\/component\\/bids?key=${KEY}\\u0026cols=cash"}`),
                   [`https://stonehedge.stonex.com/component/bids?key=${KEY}&cols=cash`]);
  assert.deepEqual(componentRefs(`href="/x?u=${encodeURIComponent(COMPONENT)}"`), [COMPONENT]);
  assert.deepEqual(componentRefs("<p>Data provided by StoneX</p>"), []);
});

test("THE KEY IS SCRUBBED FROM EVERYTHING WRITTEN, in every spelling", () => {
  const secrets = secretsOf([COMPONENT]);
  assert.deepEqual(secrets, [KEY]);
  const text = `a ${COMPONENT} b ${encodeURIComponent(COMPONENT)} c ${encodeURIComponent(encodeURIComponent(KEY))} d {"key":"${KEY}"} e bare ${KEY}`;
  const out = scrub(text, secrets);
  assert.ok(!out.includes(KEY), out);
  assert.ok(!out.includes(encodeURIComponent(KEY)));
  assert.match(out, /locs=AAA%2CBBB/, "the location ids are the specimen and stay readable");
});

/* ---- is there a price table --------------------------------------------- */

test("price-table detection says what it saw, and says no to a shell", () => {
  const html = `<table><tr><th>Location</th><th>Cash Price</th><th>Basis</th></tr>
   <tr><td>A</td><td>4.1250</td><td>-0.35</td></tr><tr><td>B</td><td>4.20</td><td>-0.30</td></tr></table>`;
  assert.equal(priceTable(html, "text/html").seen, true);
  assert.equal(priceTable("<div id=root></div><script src=/a.js></script>", "text/html").seen, false);
  assert.equal(priceTable(`{"items":[{"name":"A","cash":4.12},{"name":"B","cash":"4.20"}]}`, "application/json").seen, true);
  assert.equal(priceTable(`[{"id":"1","name":"Casselton"},{"id":"2","name":"Leonard"}]`, "application/json").seen, false,
               "a location list has no price in it");
  assert.equal(priceTable("", "text/html").seen, false);
});

test("slugs", () => {
  assert.equal(slugOf("https://www.mrga.com/"), "mrga");
  assert.equal(slugOf("www.mrga.com"), "mrga");
  assert.equal(slugOf("agvalley.com"), "agvalley");
});

/* ---- the fetcher is polite ---------------------------------------------- */

test("it waits between requests, honours Retry-After once, and does not retry a 403", async () => {
  let t = 0; const slept = [];
  const sleep = async (ms) => { slept.push(ms); t += ms; };
  const seq = [{ s: 429, ra: "7" }, { s: 200 }, { s: 403 }];
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push(init.headers["user-agent"]);
    const n = seq.shift();
    return { status: n.s, url, headers: { get: (h) => (h === "retry-after" ? n.ra ?? null : "text/html") }, arrayBuffer: async () => Buffer.from("x") };
  };
  const f = makeFetcher({ fetchFn, sleep, delayMs: 1000, now: () => t });
  const a = await f.get("https://a.example/");
  assert.equal(a.status, 200);
  assert.ok(slept.includes(7000), `waited the Retry-After: ${slept}`);
  assert.match(a.retried, /429 first/);
  const b = await f.get("https://a.example/2");
  assert.equal(b.status, 403);
  assert.equal(seq.length, 0, "exactly three requests: 429, its one retry, and the 403 not retried");
  assert.ok(f.state.delayMs > 1000, "and it slowed down");
  assert.ok(seen.every((u) => u === UA));
  assert.equal(UA, "agsist-bidreader/1.0 (+https://agsist.com; posted bid)");
});

/* ---- a whole run, against a local server and a mocked browser ----------- */

const shell = `<!doctype html><div id="root"></div>`;
const rendered = `<html><body><table><tr><th>Location</th><th>Cash</th><th>Basis</th></tr>
<tr><td>X</td><td>4.10</td><td>-0.30</td></tr><tr><td>Y</td><td>4.15</td><td>-0.25</td></tr></table>
<a href="${COMPONENT}">again</a></body></html>`;
const captureMock = (calls) => async (o) => {
  calls.push(o.pageUrl);
  return { pageUrl: o.pageUrl, quiet: true, navError: null, dom: o.pageUrl.includes("component") ? rendered : `<iframe src="${COMPONENT}"></iframe>`,
    responses: [
      { url: `https://stonehedge.stonex.com/component/bids?key=<redacted>`, status: 200, mime: "text/html", body: shell },
      { url: "https://api.stonehedge.stonex.com/settings/v1/locations", status: 200, mime: "application/json", body: `[{"id":"AAA","name":"X"}]` },
      { url: `https://api.stonehedge.stonex.com/offers/v1/offers?k=1`, status: 200, mime: "application/json", body: `{"offers":[{"cash":4.1,"basis":-0.3},{"cash":4.15,"basis":-0.25}],"echo":"${COMPONENT}"}` },
      { url: "https://api.stonehedge.stonex.com/x.js", status: 200, mime: "application/javascript", body: "var a" },
      { url: "https://tracker.example/pixel", status: 200, mime: "text/html", body: "no" },
    ] };
};
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "sh-")); return { d, opts: { ...parseArgs([]), out: join(d, "fixtures"), gaps: join(d, "gaps", "stonehedge-probe.json"), delayMs: 0, platforms: join(d, "none.json"), listsDir: join(d, "nolists") } }; };
const quiet = { sleep: async () => {}, log: () => {} };

test("WIDGET IN THE MARKUP: page kept, widget loaded once, responses kept, key nowhere on disk", async () => {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<html><iframe src="${COMPONENT.replace(/&/g, "&amp;")}"></iframe></html>`); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { d, opts } = tmp(); const calls = [];
  opts.urls = [`http://localhost:${srv.address().port}/grain`];
  const { summary, code } = await run(opts, { ...quiet, captureFn: captureMock(calls) });
  srv.close();
  assert.equal(code, 0);
  assert.equal(calls.length, 1, "one browser load: the widget");
  assert.ok(calls[0].includes(`key=${KEY}`), "the browser is driven with the real key, in memory only");
  const s = summary.sites[0];
  assert.equal(s.status, "captured");
  assert.equal(s.priceTable.seen, true);
  const files = readdirSync(opts.out);
  assert.ok(files.includes("stonehedge-localhost-page.html") && files.includes("stonehedge-localhost-component-rendered.html"), files.join());
  assert.equal(files.filter((f) => f.endsWith(".json")).length, 2, "the two json responses");
  assert.ok(files.some((f) => /-bids-.*\.html$/.test(f)), "and the widget's own app shell");
  assert.ok(!files.some((f) => /pixel|x-.*\.txt|\.js$/.test(f)), "not the script and not the tracker");
  for (const f of [...files.map((x) => join(opts.out, x)), opts.gaps])
    assert.ok(!readFileSync(f, "utf8").includes(KEY), `key leaked into ${f}`);
  assert.ok(!JSON.stringify(summary).includes(KEY));
  assert.deepEqual(tally(summary.sites).byStatus, { captured: 1 });
  assert.match(summary.redaction, /only edit/);
});

test("WIDGET INJECTED BY SCRIPT: the rendered page is loaded first, then the widget", async () => {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><script>/*injects it*/</script></html>"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { opts } = tmp(); const calls = [];
  opts.urls = [`http://localhost:${srv.address().port}/`];
  const { summary } = await run(opts, { ...quiet, captureFn: captureMock(calls) });
  srv.close();
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].includes("component") && calls[1].includes("component"));
  assert.equal(summary.sites[0].status, "captured");
  assert.ok(existsSync(join(opts.out, "stonehedge-localhost-page-rendered.html")));
});

test("--no-browser is said out loud, not reported as 'no board'", async () => {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { opts } = tmp(); opts.browser = false;
  opts.urls = [`http://localhost:${srv.address().port}/`];
  const { summary } = await run(opts, { ...quiet, captureFn: async () => { throw new Error("must not be called"); } });
  srv.close();
  assert.equal(summary.sites[0].status, "no-widget-in-markup");
});

test("a fixture already on disk is frozen unless --refresh", async () => {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<iframe src="${COMPONENT}"></iframe>`); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { opts } = tmp(); opts.urls = [`http://localhost:${srv.address().port}/`];
  await run(opts, { ...quiet, captureFn: captureMock([]) });
  const f = join(opts.out, "stonehedge-localhost-page.html");
  writeFileSync(f, "FROZEN");
  const { summary } = await run(opts, { ...quiet, captureFn: captureMock([]) });
  assert.equal(readFileSync(f, "utf8"), "FROZEN");
  assert.match(JSON.stringify(summary.sites[0].pages), /frozen evidence/);
  opts.refresh = true;
  await run(opts, { ...quiet, captureFn: captureMock([]) });
  assert.notEqual(readFileSync(f, "utf8"), "FROZEN");
  srv.close();
});

test("REFUSALS: a 403 is a finding not a failure; three in a row stop the run; exit stays 0", async () => {
  const { opts } = tmp();
  opts.urls = ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"];
  let asked = 0;
  const fetchFn = async (url) => { asked++; return { status: 403, url, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from("Forbidden") }; };
  const { summary, code } = await run(opts, { ...quiet, fetchFn, captureFn: async () => { throw new Error("no browser for a refused site"); } });
  assert.equal(code, 0);
  assert.deepEqual(summary.sites.map((s) => s.status), ["refused", "refused", "refused", "not-asked"]);
  assert.match(summary.stopped, /three sites in a row/);
  assert.ok(asked <= 12);
});

test("nothing answering at all is exit 1", async () => {
  const { opts } = tmp(); opts.urls = ["https://a.example/"];
  const fetchFn = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  const { summary, code } = await run(opts, { ...quiet, fetchFn, captureFn: async () => ({}) });
  assert.equal(summary.sites[0].status, "unreachable");
  assert.equal(code, 1);
});

test("a partial run keeps what an earlier run learned about the other sites", async () => {
  const { d, opts } = tmp();
  const fetchFn = async (url) => ({ status: 200, url, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from(`<iframe src="${COMPONENT}"></iframe>`) });
  opts.urls = ["https://a.example/", "https://b.example/"];
  await run(opts, { ...quiet, fetchFn, captureFn: captureMock([]) });
  opts.urls = ["https://b.example/"];
  const { summary } = await run(opts, { ...quiet, fetchFn, captureFn: captureMock([]) });
  assert.deepEqual(summary.sites.map((s) => s.site), ["a.example", "b.example"]);
});

/* ---- the one change to lib/cdp.mjs, against a real browser --------------- */

let browser = null; try { browser = findBrowser(); } catch { /* none here */ }
test("captureAll({snapshotDom}) returns the RENDERED document, and nothing extra when off",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><div id="r"></div><script>document.getElementById("r").innerHTML="<table><tr><td>Leonard</td><td>4.11</td></tr></table>"</script></body></html>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const on = await captureAll({ pageUrl: url, browser, timeoutMs: 15000, quietMs: 800, snapshotDom: true });
  const off = await captureAll({ pageUrl: url, browser, timeoutMs: 15000, quietMs: 800 });
  srv.close();
  assert.match(on.dom, /<td>Leonard<\/td><td>4\.11<\/td>/, "the script-drawn table, not the shell");
  assert.ok(!("dom" in off), "off means the result shape is unchanged");
});

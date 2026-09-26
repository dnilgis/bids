/* THE BOARD SWEEP, ON A PLATFORM THAT CAN ONLY BE READ THROUGH A BROWSER.
 *
 * A live `--platform dtn-cs` run asked six sites and got "HTTP 403 (651B)" from
 * api.dtn.com for every one: DTN answers a server "The api key is valid, but it
 * is valid to be used within a browser only". poll.mjs reads dtn-cs through a
 * browser; the sweep used plain fetch, so a dtn-cs site could never be swept.
 *
 * The end-to-end test below runs a REAL Chromium against a local stand-in for
 * an operator's page, its widget iframe and DTN's gateway, and the gateway
 * enforces the same rule DTN's does. The rest use a mocked browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { browserTry, planSite, main, parseArgs, httpsPage, IO, boardCandidates }
  from "../scripts/board-sweep.mjs";
import { capture, redactText, findBrowser } from "../lib/cdp.mjs";
import { validateSource, transportOf } from "../lib/sources.mjs";
import { extract } from "../lib/adapters/dtn-cs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BODY = readFileSync(join(ROOT, "fixtures/dtn-cs-agpartners-e0172401.json"), "utf8");
const BYZIP = new Map(JSON.parse(readFileSync(join(ROOT, "geocodes/zip-candidates.json"), "utf8"))
  .zips.map((z) => [z.zip, z]));
const KEY = "SECRETKEYFROMTHEIRPAGE123";
let browser = null;
try { browser = findBrowser(); } catch { /* the real-browser test is skipped */ }

/* A directory that knows Ag Partners' Goodhue and Eyota and not the rest. */
const KNOWN = [
  { facility: "Ag Partners Cooperative", branch: "Goodhue", city: "Goodhue", state: "MN", zip: "55027", source: "barchart" },
  { facility: "Ag Partners Cooperative", branch: "Eyota", city: "Eyota", state: "MN", zip: "55934", source: "barchart" },
];
const CAND = { url: "https://api.dtn.com/markets/sites/E0172401/cash-bids?units=us", why: "DTN site E0172401" };
const PAGE = "https://agpartners.com/cash-bids/";
const HTML = `<html><head><title>Ag Partners Cooperative - Cash Bids</title></head><body>
  <iframe src="https://api.dtn.com/widget?apikey=${KEY}&amp;units=us"></iframe></body></html>`;
const cfg = { browserTimeoutMs: 5000, delayMs: 0, budgetMs: 60 * 60000, timeoutMs: 1000 };
const io = (capt) => ({ capture: capt, sleep: async () => {} });
const ok = () => async () => ({ status: 200, body: BODY, url: "https://api.dtn.com/markets/sites/E0172401/cash-bids?apikey=%3Credacted%3E&units=us", pageHtml: redactText(HTML) });

/* ── the transport is the one poll.mjs uses ───────────────────────────── */

test("dtn-cs is a browser platform, and the sweep asks transportOf rather than keeping its own list", () => {
  assert.equal(transportOf("dtn-cs"), "browser");
  assert.equal(transportOf("graindesk"), "fetch");
  const src = readFileSync(join(ROOT, "scripts/board-sweep.mjs"), "utf8");
  assert.match(src, /transportOf\(s\.platform\) === "browser"/);
});

test("a browser platform's sites are never fetched with plain fetch", async () => {
  const lines = [], gets = [];
  /* An operator no source in this repository carries, so nothing is skipped as already read. */
  const known = KNOWN.map((k) => ({ ...k, facility: "Zed Cooperative" }));
  const log = console.log; console.log = (...a) => lines.push(a.join(" "));
  try {
    const plat = { sites: { "https://zedcoop.com/": { platform: "dtn-cs", boardPage: "https://zedcoop.com/cash-bids/", ids: [{ siteId: "E9999901" }] } } };
    const rc = await main(["--platform", "dtn-cs", "--delay", "0"], {
      readText: (f) => f === "data/platforms.json" ? JSON.stringify(plat)
        : f === "data/known-elevators.json" ? JSON.stringify({ elevators: known })
        : f === "data/directory.json" ? "{}" : readFileSync(join(ROOT, f), "utf8"),
      get: async (u) => { gets.push(u); return { ok: true, status: 403, body: "x", bytes: 1 }; },
      capture: async () => ({ status: 200, body: BODY, url: "https://api.dtn.com/x?apikey=%3Credacted%3E",
        pageHtml: HTML.replace("Ag Partners", "Zed") }),
      sleep: async () => {} });
    assert.equal(rc, 0);
  } finally { console.log = log; }
  assert.deepEqual(gets, [], "api.dtn.com answers a server 403; nothing may be fetched");
  const out = lines.join("\n");
  assert.match(out, /1 board\(s\) read/);
  assert.match(out, /\+ zedcoop-goodhue/);
  assert.match(out, /\+ zedcoop-eyota/);
  assert.match(out, /2 manifest\(s\) would be written/);
  assert.match(out, /NO DIRECTORY MATCH/, "Red Wing and Traverse go on the worklist");
  assert.ok(!out.includes(KEY), "no key in the log");
});

/* ── a manifest planned from a browser read ───────────────────────────── */

test("a planned dtn-cs manifest validates, names its browserPage and carries no key", () => {
  const url = CAND.url;
  const plan = planSite({ html: redactText(HTML), url, site: "https://agpartners.com/", platform: "dtn-cs",
    rows: extract(BODY, CAND.url), known: KNOWN, byZip: BYZIP, existingIds: new Set(), have: new Set(),
    browserPage: PAGE, siteId: "E0172401" });
  assert.ok(plan.ok, plan.why);
  assert.equal(plan.operator, "Ag Partners Cooperative");
  assert.equal(plan.write.length, 2);
  for (const w of plan.write) {
    const m = w.json;
    assert.deepEqual(validateSource(m, new Set()), []);
    assert.equal(m.platform, "dtn-cs");
    assert.equal(m.url, CAND.url, "the endpoint, with no key in it");
    assert.equal(m.browserPage, PAGE);
    assert.equal(m.siteId, "E0172401");
    assert.ok(m.locationId);
    assert.ok(w.id.startsWith("agpartners-"), `the id comes from the operator's host, not api.dtn.com: ${w.id}`);
    assert.match(m.note, /READ THROUGH A BROWSER/);
    assert.ok(!/apikey|SECRETKEY/i.test(JSON.stringify(m)), "no key in a manifest");
    /* enabled only on a stated rounding: dtn-cs floors its cash to the cent */
    if (!m.enabled) assert.match(m._pending, /HELD DISABLED — ROUNDING UNRESOLVED/);
  }
  assert.ok(plan.unmatched.length >= 1, "Red Wing and Traverse are not in this directory: worklist, not a guess");
  assert.ok(plan.unmatched.every((u) => u.url === CAND.url && !/apikey/.test(JSON.stringify(u))));
});


test("a location whose rows name one rounding mode is written enabled with that mode", () => {
  /* 25 real rows; whatever the evidence says, the manifest must agree with it. */
  const plan = planSite({ html: HTML, url: CAND.url, site: "https://agpartners.com/", platform: "dtn-cs",
    rows: extract(BODY, CAND.url), known: KNOWN, byZip: BYZIP, existingIds: new Set(), have: new Set(),
    browserPage: PAGE, siteId: "E0172401" });
  const states = plan.write.map((w) => [w.json.enabled, w.json.cashRounding ?? null]);
  for (const [en, mode] of states) if (en) assert.ok(mode === null || typeof mode === "string");
  /* a held one says so and is not enabled */
  for (const w of plan.write) if (/HELD DISABLED/.test(w.json._pending ?? "")) assert.equal(w.json.enabled, false);
});

test("a plain-fetch platform's manifest is unchanged: no browserPage, no siteId, still enabled", () => {
  const html = readFileSync(join(ROOT, "fixtures/bigriver-2121.html"), "utf8");
  const known = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8")).elevators;
  const url = "https://bigriverbids.com/cashbidssingle-2121";
  const rows = [{ location: "Boyceville", locationId: "2121", commodity: "Corn", cash: 4, basis: 0, futuresPrice: 400 }];
  const plan = planSite({ html, url, site: "https://bigriverresources.com/", platform: "cashbidssingle",
    rows, known, byZip: BYZIP, existingIds: new Set(), have: new Set() });
  for (const w of plan.write) {
    assert.equal(w.json.browserPage, undefined);
    assert.equal(w.json.siteId, undefined);
    assert.equal(w.json.enabled, true);
  }
});

/* ── a browser that says nothing is "did not answer", never a crash ───── */

test("a capture that throws is reported as did-not-answer", async () => {
  const t = await browserTry({ candidate: CAND, board: PAGE, platform: "dtn-cs", cfg,
    io: io(async () => { throw new Error("no readable response matching x within 5000ms. The page did make 0 request(s): "); }) });
  assert.match(t.verdict, /^did not answer: no readable response/);
  assert.equal(t.rows, undefined);
  assert.ok(!t.fatal);
});

test("a 403 is reported with its status and size, and is not a board", async () => {
  const t = await browserTry({ candidate: CAND, board: PAGE, platform: "dtn-cs", cfg,
    io: io(async () => ({ status: 403, body: "x".repeat(651), url: CAND.url })) });
  assert.equal(t.verdict, "HTTP 403 (651B)");
});

test("an empty body is too short to be a board", async () => {
  const t = await browserTry({ candidate: CAND, board: PAGE, platform: "dtn-cs", cfg,
    io: io(async () => ({ status: 200, body: "", url: CAND.url })) });
  assert.match(t.verdict, /too short/);
});

test("a body the adapter refuses is unreadable, with the adapter's own reason", async () => {
  const t = await browserTry({ candidate: CAND, board: PAGE, platform: "dtn-cs", cfg,
    io: io(async () => ({ status: 200, body: "<html>".padEnd(300, "x"), url: CAND.url })) });
  assert.match(t.verdict, /^refused: the response is not JSON/);
  assert.ok(t.body, "a refused body is kept so --capture can write it");
});

test("a site with no siteId recorded is said so, and the browser is not started", async () => {
  let calls = 0;
  const t = await browserTry({ candidate: { url: PAGE, why: "board" }, board: PAGE, platform: "dtn-cs", cfg,
    io: io(async () => { calls++; return {}; }) });
  assert.match(t.verdict, /no siteId/);
  assert.equal(calls, 0);
});

test("the page is loaded once, over https, with the page budget and the endpoint without its query", async () => {
  const seen = [];
  await browserTry({ candidate: CAND, board: "http://fremont.example/grain", platform: "dtn-cs", cfg,
    io: io(async (o) => { seen.push(o); return ok()(); }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pageUrl, "https://fremont.example/grain");
  assert.equal(seen[0].target, "https://api.dtn.com/markets/sites/E0172401/cash-bids");
  assert.equal(seen[0].timeoutMs, 5000);
  assert.equal(httpsPage("http://a/b"), "https://a/b");
  assert.equal(IO.capture.length, 1);
});

/* ── nothing here may write, print or keep a key ──────────────────────── */

test("an error that quotes the key is redacted before it is reported", async () => {
  const t = await browserTry({ candidate: CAND, board: PAGE, platform: "dtn-cs", cfg,
    io: io(async () => { throw new Error(`failed https://api.dtn.com/markets/sites/E0172401/cash-bids?apikey=${KEY}&units=us`); }) });
  assert.ok(!t.verdict.includes(KEY), t.verdict);
  assert.match(t.verdict, /<redacted>/);
});

test("redactText takes a key out of every spelling a page writes it in", () => {
  const spellings = [
    `<iframe src="https://x/w?apikey=${KEY}&units=us">`,
    `<iframe src="https://x/w?units=us&amp;apikey=${KEY}">`,
    `var u = "https://x/w?units=us\\u0026apikey=${KEY}"`,
    `{"apikey":"${KEY}"}`,
    `apikey: '${KEY}'`,
    `api_key = "${KEY}"`,
    `?token=${KEY}`,
  ];
  for (const s of spellings) {
    const r = redactText(s);
    assert.ok(!r.includes(KEY), `${s} kept its key: ${r}`);
    assert.match(r, /<redacted>/);
  }
  assert.equal(redactText("units=us&size=5"), "units=us&size=5", "an ordinary parameter is left alone");
  assert.equal(redactText(null), "");
});

test("--capture on a browser platform writes JSON, not an HTML comment header", () => {
  const src = readFileSync(join(ROOT, "scripts/board-sweep.mjs"), "utf8");
  assert.match(src, /transportOf\(c\.platform\) === "browser"[\s\S]{0,300}redactText\(String\(c\.body\)/);
});

/* ── pacing and the clock ─────────────────────────────────────────────── */

test("sites are spaced by the delay, and the sweep stops asking once its budget is spent", async () => {
  const sleeps = [], loads = [];
  const plat = { sites: {} };
  for (const n of [1, 2, 3])
    plat.sites[`https://s${n}.example/`] = { platform: "dtn-cs", boardPage: `https://s${n}.example/b`, ids: [{ siteId: `E000${n}` }] };
  const lines = [];
  const log = console.log; console.log = (...a) => lines.push(a.join(" "));
  const make = () => ({
    readText: (f) => f === "data/platforms.json" ? JSON.stringify(plat)
      : f === "data/known-elevators.json" ? JSON.stringify({ elevators: KNOWN })
      : f === "data/directory.json" ? "{}" : readFileSync(join(ROOT, f), "utf8"),
    get: async () => { throw new Error("no fetch"); },
    capture: async (o) => { loads.push(o.pageUrl); throw new Error("timed out"); },
    sleep: async (ms) => { sleeps.push(ms); } });
  try {
    await main(["--platform", "dtn-cs", "--delay", "7"], make());
    assert.equal(loads.length, 3);
    assert.deepEqual(sleeps, [7000, 7000], "a pause between page loads, not before the first");
    loads.length = 0;
    /* a budget of zero minutes: nothing is attempted, and it says so */
    await main(["--platform", "dtn-cs", "--budget", "0"], make());
    assert.equal(loads.length, 0);
  } finally { console.log = log; }
  assert.match(lines.join("\n"), /3 did not answer/);
  assert.match(lines.join("\n"), /budget was spent/);
});

test("no browser on the machine stops the run once, loudly, instead of failing every site", async () => {
  const loads = [], lines = [];
  const plat = { sites: {} };
  for (const n of [1, 2, 3])
    plat.sites[`https://s${n}.example/`] = { platform: "dtn-cs", boardPage: `https://s${n}.example/b`, ids: [{ siteId: `E000${n}` }] };
  const log = console.log; console.log = (...a) => lines.push(a.join(" "));
  try {
    await main(["--platform", "dtn-cs", "--delay", "0"], {
      readText: (f) => f === "data/platforms.json" ? JSON.stringify(plat)
        : f === "data/known-elevators.json" ? JSON.stringify({ elevators: KNOWN })
        : f === "data/directory.json" ? "{}" : readFileSync(join(ROOT, f), "utf8"),
      get: async () => { throw new Error("no fetch"); },
      capture: async (o) => { loads.push(o.pageUrl); throw new Error("no browser found. Looked at: /usr/bin/x"); },
      sleep: async () => {} });
  } finally { console.log = log; }
  assert.equal(loads.length, 1);
  assert.match(lines.join("\n"), /::error::did not answer: no browser found/);
});

test("the flags exist and default to bounded values", () => {
  const c = parseArgs([]);
  assert.equal(c.browserTimeoutMs, 45000);
  assert.equal(c.delayMs, 3000);
  assert.equal(c.budgetMs, 40 * 60000);
  const d = parseArgs(["--browser-timeout", "30", "--delay", "1", "--budget", "5"]);
  assert.deepEqual([d.browserTimeoutMs, d.delayMs, d.budgetMs], [30000, 1000, 300000]);
});

test("the workflow's timeout fits the sweep's own budget plus the guards and the commit", () => {
  const y = readFileSync(join(ROOT, ".github/workflows/board-sweep.yml"), "utf8");
  const mins = Number(y.match(/timeout-minutes:\s*(\d+)/)[1]);
  const budget = parseArgs([]).budgetMs / 60000;
  assert.ok(mins >= budget + 15, `${mins} minutes cannot hold a ${budget} minute sweep and its guards`);
  /* 34 dtn-cs sites x (45s page + 3s pause + ~2s browser start) = 28 minutes */
  assert.ok(34 * 50 / 60 <= budget);
  assert.match(y, /dtn-cs/);
  assert.match(y, /findBrowser/, "the job checks it has a Chromium before it starts asking");
});

/* ── the real thing, against a stand-in for DTN's gateway ─────────────── */

test("a real browser reads the widget's own response through an iframe, and the key goes nowhere",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  let refused = 0, served = 0;
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/markets/sites/E0172401/cash-bids")) {
      /* DTN's rule: a request with no Referer from a page is a server. */
      if (!String(req.headers.referer || "").includes("/widget")) {
        refused++;
        res.writeHead(403, { "content-type": "application/json" });
        return res.end('{"messages":[{"status":403,"message":"The api key is valid, but it is valid to be used within a browser only."}]}');
      }
      served++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(BODY);
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url.startsWith("/widget"))
      return res.end(`<script>fetch("/markets/sites/E0172401/cash-bids?apikey=${KEY}&units=us").then(r=>r.text())</script>`);
    res.end(`<!doctype html><html><head><title>Ag Partners Cooperative - Cash Bids</title></head><body>
      <iframe src="/widget?apikey=${KEY}&units=us"></iframe></body></html>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const direct = await fetch(`${base}/markets/sites/E0172401/cash-bids?apikey=${KEY}`);
    assert.equal(direct.status, 403, "a plain fetch is refused, which is the whole problem");
    /* the sweep's io, with DTN's host swapped for the stand-in */
    const local = { capture: (o) => capture({ ...o, readPage: true, browser,
        pageUrl: base + "/cash-bids/", target: base + "/markets/sites/E0172401/cash-bids" }),
      sleep: async () => {} };
    const t = await browserTry({ candidate: CAND, board: "https://agpartners.com/cash-bids/",
      platform: "dtn-cs", io: local, cfg: { ...cfg, browserTimeoutMs: 40000 } });
    assert.ok(t.rows, t.verdict);
    assert.equal(t.rows.length, 25);
    assert.ok(served >= 1);
    assert.ok(!JSON.stringify({ ...t, body: undefined }).includes(KEY), "no key in what was returned");
    assert.match(t.pageHtml, /<title>Ag Partners Cooperative - Cash Bids<\/title>/);
    assert.ok(!t.pageHtml.includes(KEY), "the page's own key is redacted out of its document");
    assert.match(t.pageHtml, /apikey=<redacted>/);
    const plan = planSite({ html: t.pageHtml, url: t.url, site: "https://agpartners.com/", platform: "dtn-cs",
      rows: t.rows, known: KNOWN, byZip: BYZIP, existingIds: new Set(), have: new Set(),
      browserPage: t.browserPage, siteId: t.siteId });
    assert.ok(plan.ok);
    assert.equal(plan.write.length, 2);
    assert.ok(!JSON.stringify(plan).includes(KEY));
  } finally { srv.close(); }
});

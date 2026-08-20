/* The browser transport.
 *
 * DTN answered the first version of the probe, from the Actions runner, with:
 *
 *   "The api key is valid, but it is valid to be used within a browser only."
 *
 * So a `dtn-cs` source is LOADED, in a real Chromium, on the customer's own
 * public page, and what we read is the response their own widget asked for.
 * The end-to-end test below stands up a server that enforces the same rule
 * their gateway does — no Referer from a cash-bids page, no data — so it fails
 * for the same reason the real one would if this ever went back to fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { redactUrl, matchesTarget, findBrowser, capture, captureAll, looksLikeData, BROWSER_CANDIDATES } from "../lib/cdp.mjs";
import { extract } from "../lib/adapters/dtn-cs.mjs";
import { transportOf, PLATFORM_TRANSPORT } from "../lib/sources.mjs";

/* ---- the key must not survive into anything we print or commit ----------- */

test("a key in a captured URL is redacted, in every spelling", () => {
  /* The whole reason keys were moved to a header today was to keep them out of
     log lines in a public repository. The browser has no such discipline: it
     asks for ...cash-bids?apikey=exwhq… and that URL is what comes back, gets
     printed, and is stamped into source.url in the committed file. */
  assert.equal(redactUrl("https://api.dtn.com/x?apikey=exwhqAFLCNJeAo9hG8gjGj8r1APimbja&units=us"),
               "https://api.dtn.com/x?apikey=%3Credacted%3E&units=us");
  for (const k of ["apikey", "api_key", "key", "token", "secret", "sig"])
    assert.ok(!redactUrl(`https://x.test/a?${k}=SUPERSECRET`).includes("SUPERSECRET"), k);
  /* Case, and a value that would break a naive split. */
  assert.ok(!redactUrl("https://x.test/a?APIKEY=A%26B=C&z=1").includes("A%26B"));
  /* Something that is not a url at all still gets scrubbed. */
  assert.ok(!redactUrl("not a url ?apikey=SUPERSECRET&x=1").includes("SUPERSECRET"));
  /* And a url with nothing to hide is left alone. */
  assert.equal(redactUrl("https://x.test/a?units=us"), "https://x.test/a?units=us");
});

/* ---- which response are we waiting for ---------------------------------- */

test("a response matches on origin and path, never on the query string", () => {
  const target = "https://api.dtn.com/markets/sites/e0172401/cash-bids?units=us";
  /* The widget appends its own parameters and the key, and the key must never
     be written into a manifest for us to match against. */
  assert.ok(matchesTarget("https://api.dtn.com/markets/sites/e0172401/cash-bids?apikey=X&units=us", target));
  assert.ok(matchesTarget("https://api.dtn.com/markets/sites/e0172401/cash-bids", target));
  assert.ok(!matchesTarget("https://api.dtn.com/markets/sites/E0266901/cash-bids", target),
    "another site id on the same page must not be mistaken for ours");
  assert.ok(!matchesTarget("https://api.dtn.com/markets/sites/e0172401/locations", target));
  assert.ok(!matchesTarget("https://evil.test/markets/sites/e0172401/cash-bids", target),
    "same path, different origin, is a different thing entirely");
  assert.ok(!matchesTarget(null, target));
  assert.ok(!matchesTarget("https://x.test/a", null));
});

/* ---- finding a browser --------------------------------------------------- */

test("BIDS_BROWSER wins, and a wrong one says so rather than falling back", () => {
  assert.equal(findBrowser({ BIDS_BROWSER: "/my/chrome" }, (p) => p === "/my/chrome"), "/my/chrome");
  assert.throws(() => findBrowser({ BIDS_BROWSER: "/nope" }, () => false), /nothing there/);
});

test("the candidate list is tried in order and GitHub's own Chrome is on it", () => {
  assert.equal(findBrowser({}, (p) => p === "/usr/bin/chromium"), "/usr/bin/chromium");
  /* ubuntu-latest ships Google Chrome; without this the workflow would need to
     download a browser on every poll. */
  assert.ok(BROWSER_CANDIDATES.includes("/usr/bin/google-chrome"));
  assert.equal(findBrowser({}, () => true), BROWSER_CANDIDATES[0], "most specific first");
  assert.throws(() => findBrowser({}, () => false), /no browser found/);
});

test("dtn-cs is the platform that is read through a browser, and it is the only one", () => {
  assert.equal(transportOf("dtn-cs"), "browser");
  for (const p of ["cashbidssingle", "aghost", "fragment", "graindesk", "first-party"])
    assert.equal(transportOf(p), "fetch", p);
  assert.deepEqual(Object.keys(PLATFORM_TRANSPORT), ["dtn-cs"]);
});

/* ---- end to end, against a server that enforces DTN's own rule ----------- */

let browser = null;
try { browser = findBrowser(); } catch { /* reported by the test below */ }

test("a real browser captures the widget's own response, and the adapter reads it", { skip: browser ? false : "no browser on this machine" }, async () => {
  const json = readFileSync(new URL("../fixtures/dtn-cs-agpartners-e0172401.json", import.meta.url), "utf8");
  let apiHits = 0, blockedHits = 0, refused = 0;
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/markets/sites/e0172401/cash-bids")) {
      apiHits++;
      /* THE SAME CHECK THEIR GATEWAY MAKES. A plain fetch sends no Referer and
         gets the 403 that started all of this. */
      if (!String(req.headers.referer || "").includes("/cash-bids/")) {
        refused++;
        res.writeHead(403, { "content-type": "application/json" });
        return res.end('{"messages":[{"type":"Authorization","id":"AGW-403=002","status":403,' +
          '"message":"The api key is valid, but it is valid to be used within a browser only."}]}');
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(json);
    }
    if (/\.(png|css)$/.test(req.url)) { blockedHits++; res.writeHead(200); return res.end(""); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><img src="/logo.png"><link rel=stylesheet href="/a.css">
      <script>fetch("/markets/sites/e0172401/cash-bids?apikey=PUBLICKEYFROMTHEIRPAGE&units=us")
        .then(r => r.json()).then(d => { document.title = d.length + " bids"; });</script>
      </body></html>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    /* First: prove the server really does refuse a plain fetch, so the test
       below is testing something. */
    const direct = await fetch(`${base}/markets/sites/e0172401/cash-bids?apikey=X`);
    assert.equal(direct.status, 403);
    assert.match(await direct.text(), /within a browser only/);

    const got = await capture({ pageUrl: `${base}/cash-bids/`, target: `${base}/markets/sites/e0172401/cash-bids`, browser, timeoutMs: 40000 });
    assert.equal(got.status, 200);
    assert.ok(!got.url.includes("PUBLICKEYFROMTHEIRPAGE"), "the captured url must not carry their key");
    assert.match(got.url, /apikey=%3Credacted%3E|apikey=<redacted>/);

    const rows = extract(got.body, got.url);
    assert.equal(rows.length, 25);
    assert.deepEqual([...new Set(rows.map((r) => r.location))],
      ["Red Wing Grain LLC", "Goodhue", "Eyota", "Traverse"]);
    assert.equal(rows[0].futuresPrice, 478.75);

    assert.equal(blockedHits, 0, "images and stylesheets are blocked: we want one JSON body, not their whole page");
    assert.ok(apiHits >= 1);
  } finally { srv.close(); }
});

test("a page that never asks for it gives up with what it DID ask for", { skip: browser ? false : "no browser on this machine" }, async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><body><script>fetch("/something/else");</script></body></html>');
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(
      capture({ pageUrl: `${base}/cash-bids/`, target: `${base}/markets/sites/x/cash-bids`, browser, timeoutMs: 6000 }),
      (e) => /no readable response matching/.test(e.message) && /something\/else/.test(e.message));
  } finally { srv.close(); }
});

test("CHROME_BIN is believed when it is real and ignored when it is not", () => {
  /* GitHub's ubuntu images set it. Taking their word for it beats hard-coding
     a path an image refresh can move — but only if something is actually there,
     or a stale variable would mask every candidate on the list. */
  assert.equal(findBrowser({ CHROME_BIN: "/gh/chrome" }, (p) => p === "/gh/chrome"), "/gh/chrome");
  assert.equal(findBrowser({ CHROME_BIN: "/gone" }, (p) => p === "/usr/bin/chromium"), "/usr/bin/chromium");
  /* BIDS_BROWSER still wins, and still refuses to fall back if it is wrong. */
  assert.equal(findBrowser({ CHROME_BIN: "/gh/chrome", BIDS_BROWSER: "/mine" }, () => true), "/mine");
});

/* captureAll, against a real browser.
 *
 * The point of it is that it is NOT told what to look for, so a mock that
 * replays a scripted socket would be testing the mock. */

test("captureAll finds the feed without being told its url", { skip: browser ? false : "no browser on this machine" }, async () => {
  const FEED = '[{"location":{"id":1,"name":"Alpha"},"cashPrice":4.11}]';
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/api/cash-bids")) {
      res.writeHead(200, { "content-type": "application/json" }); return res.end(FEED);
    }
    if (req.url.startsWith("/hero.png")) { res.writeHead(200, {"content-type":"image/png"}); return res.end("x"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><img src="/hero.png"><script>
      fetch("/api/cash-bids?apikey=THEIRPUBLICKEY&units=us").then(r=>r.json())</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await captureAll({ pageUrl: base + "/", browser, timeoutMs: 40000, quietMs: 1500 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.navError, null, "the page loaded, so there is no navigation error");
    const feed = r.responses.find((x) => x.url.includes("/api/cash-bids"));
    assert.ok(feed, `feed not seen among ${r.responses.map((x) => x.url).join(", ")}`);
    assert.equal(feed.body, FEED, "the body is kept, not just the url");
    assert.ok(!JSON.stringify(r.responses).includes("THEIRPUBLICKEY"), "their key must not reach the log");
  } finally { srv.close(); }
});

test("A PAGE THAT NEVER LOADED SAYS SO", { skip: browser ? false : "no browser on this machine" }, async () => {
  /* Zero feeds on a dead host and zero feeds on a page running an
     unrecognised widget are the same output unless this is populated, and
     across a batch that is the difference between a retry and the adapter
     queue. The 2026-08-20 run hit it twice -- coopfe.com and ludlowcoop.com
     both came back with "0 response(s) ... hosts seen: none".

     A CLOSED PORT WE OWNED A MOMENT AGO, so the refusal is certain and the
     port is a legal one -- Chromium answers ERR_UNSAFE_PORT for a few low
     ports, which would pass this test for the wrong reason. */
  const srv = createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dead = `http://127.0.0.1:${srv.address().port}/`;
  await new Promise((r) => srv.close(r));

  const r = await captureAll({ pageUrl: dead, browser, timeoutMs: 15000, quietMs: 1000 });
  assert.ok(r, "captureAll must never throw: one dead page must not lose the batch");
  assert.ok(r.navError, `expected a navigation error, got ${JSON.stringify(r.navError)}`);
  assert.match(r.navError, /ERR_CONNECTION_REFUSED/);
  assert.equal(r.responses.length, 0);
});

/* ---- ONE UNREADABLE MATCH MUST NOT LOSE THE BOARD ------------------------
 *
 * Measured 2026-08-20 on the runner: probing Ag-Land FS and Insight FS, both
 * fscooperatives.com, `capture` returned "the response matched but its body
 * never became readable" — while `captureAll` had pulled 45,608 bytes off the
 * same Ag-Land page minutes before. capture took the FIRST matching response,
 * cleared its timeout, failed to read a body from it, and rejected with no way
 * back. Two co-operatives and sixteen locations lost to it.
 *
 * These pages are also the production path: the thirteen live Ag Partners
 * sources are read by this function on every poll.
 */
test("a matching response with no body does not end the capture", { skip: browser ? false : "no browser on this machine" }, async () => {
  const REAL = '{"board":"this one"}';
  let hits = 0;
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/markets/sites/x/cash-bids")) {
      hits++;
      /* First ask: a 204, which cannot carry a body. This is the shape that
         used to be fatal. Second ask: the board. */
      if (hits === 1) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(REAL);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>
      fetch("/markets/sites/x/cash-bids?first=1")
        .then(() => fetch("/markets/sites/x/cash-bids?units=us"));
    </script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const got = await capture({ pageUrl: `${base}/cash-bids/`,
      target: `${base}/markets/sites/x/cash-bids`, browser, timeoutMs: 30000 });
    assert.equal(got.status, 200, "resolved on the bodyless response");
    assert.equal(got.body, REAL);
    assert.equal(hits, 2, "the second request was never made");
  } finally { srv.close(); }
});

test("when nothing readable ever arrives, the error says matches were seen", { skip: browser ? false : "no browser on this machine" }, async () => {
  // "no response matched" and "several matched and none would open" are
  // different faults with different fixes, and the log has to tell them apart.
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/markets/sites/x/cash-bids")) { res.writeHead(204); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><script>fetch("/markets/sites/x/cash-bids?a=1")</script>');
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(
      capture({ pageUrl: `${base}/cash-bids/`, target: `${base}/markets/sites/x/cash-bids`, browser, timeoutMs: 6000 }),
      (e) => /no readable response matching/.test(e.message));
  } finally { srv.close(); }
});

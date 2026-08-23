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
import { redactUrl, matchesTarget, findBrowser, capture, captureAll, looksLikeData, readBody, BROWSER_CANDIDATES } from "../lib/cdp.mjs";
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

test("the browser is for platforms whose page fetches its own board", () => {
  /* THIS USED TO SAY "AND IT IS THE ONLY ONE", and it was true when written.
     Bushel joined on 2026-08-21 for exactly the same reason dtn-cs is here:
     their board arrives from api.bushelpowered.com in a request the customer's
     own page makes at runtime, so a plain GET of the page returns a shell.
     A test that pins down how many there are, rather than which ones and why,
     goes red the day the answer is legitimately different. */
  for (const p of ["dtn-cs", "bushel"])
    assert.equal(transportOf(p), "browser", p);
  for (const p of ["cashbidssingle", "aghost", "fragment", "graindesk", "first-party"])
    assert.equal(transportOf(p), "fetch", p);
  /* Still a closed set: a platform is on the browser deliberately or not at
     all, because the browser is slow and a page we do not need to run is a
     page we should not run. */
  assert.deepEqual(Object.keys(PLATFORM_TRANSPORT).sort(), ["bushel", "dtn-cs"]);
});

/* ---- end to end, against a server that enforces DTN's own rule ----------- */

let browser = null;
try { browser = findBrowser(); } catch { /* reported by the test below */ }

test("a real browser captures the widget's own response, and the adapter reads it", { skip: browser ? false : "no browser on this machine" }, async () => {
  const json = readFileSync(new URL("../fixtures/dtn-cs-agpartners-e0172401.json", import.meta.url), "utf8");
  let apiHits = 0, blockedHits = 0, cssHits = 0, refused = 0;
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
    if (/\.png$/.test(req.url)) { blockedHits++; res.writeHead(200); return res.end(""); }
    if (/\.css$/.test(req.url)) { cssHits++; res.writeHead(200, {"content-type":"text/css"}); return res.end("body{}"); }
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

    assert.equal(blockedHits, 0, "images are blocked: we want one JSON body, not their whole page");
    /* THE STYLESHEET IS ALLOWED THROUGH, and it is meant to be. Blocking it
       cost Ag-Land FS and Insight FS entirely on 2026-08-20: starved of its
       CSS, their Next.js app made 6,285 requests in forty-five seconds and
       never once asked for the board. */
    assert.equal(cssHits, 1, "the stylesheet must not be blocked");
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

test("A STYLESHEET IS NOT BLOCKED, AND THAT IS NOT A DETAIL", async () => {
  /* Ag-Land FS and Insight FS, 2026-08-20: capture made 6,285 and 7,089
     requests in forty-five seconds and never reached api.dtn.com, while
     captureAll had read the same Ag-Land page in fifty-three requests and come
     away with 45,608 bytes of board. The only difference in how the two
     functions touch the network was `*.css` on this block list.
     A test, not a comment, because the next person tidying this list will see
     a stylesheet nobody reads and a bandwidth saving, and they will be wrong. */
  const src = readFileSync(new URL("../lib/cdp.mjs", import.meta.url), "utf8");
  /* The empty one is capture's deliberate reset -- `setBlockedURLs({urls: []})`
     before it sets its own -- and it is not a block list. */
  const lists = [...src.matchAll(/setBlockedURLs",\s*\{\s*urls:\s*\[([\s\S]*?)\]/g)]
    .map((m) => m[1]).filter((l) => /"/.test(l));
  assert.ok(lists.length >= 2, `expected both readers' block lists, found ${lists.length}`);
  for (const l of lists) assert.ok(!/\.css/.test(l), `a reader still blocks css: ${l.trim()}`);
  const tokens = lists.map((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort().join(","));
  assert.equal(new Set(tokens).size, 1,
    `the two readers block different things and they meet the same pages:\n  ${tokens.join("\n  ")}`);
});


/* ---- a body that never arrived must say why ------------------------------
   readBody swallowed every error for twelve attempts and returned with
   rec.body still null, which prints downstream as "NO BODY HANDED OVER" — the
   same words an empty response gets. Measured 2026-08-22: all three StoneHedge
   pages reported no body, United Cooperative's 24 Wisconsin location ids were
   sitting right there in the query string, and nothing in the log said whether
   the response was empty, evicted, or refused. --dump could not help either,
   because it needs a body it does not have. */

test("THE REASON A BODY DID NOT ARRIVE IS KEPT, not swallowed", async () => {
  const rec = {};
  const send = async () => { throw new Error("No resource with given identifier found"); };
  await readBody(send, "req-1", rec, 400000, 3, 0);
  assert.equal(rec.body, undefined, "still no body, which was never the complaint");
  assert.match(rec.bodyError, /No resource with given identifier/);
  assert.equal(rec.bodyTries, 3, "and how hard it tried before giving up");
});

test("a body that arrives late still arrives, and records no error", async () => {
  const rec = {};
  let n = 0;
  const send = async () => {
    if (++n < 3) throw new Error("not ready");
    return { base64Encoded: false, body: "<table>bids</table>" };
  };
  await readBody(send, "req-2", rec, 400000, 6, 0);
  assert.equal(rec.body, "<table>bids</table>");
  assert.equal(rec.bodyError, undefined, "it worked in the end, so there is nothing to report");
});

test("AN EMPTY BODY IS AN ANSWER AND SAYS SO", () => {
  /* 0 bytes read is a different finding from a body that could not be read,
     and the log used to print both as "0B". */
  const rec = {};
  return readBody(async () => ({ base64Encoded: false, body: "" }), "r", rec, 4000, 2, 0)
    .then(() => {
      assert.equal(rec.body, "");
      assert.match(rec.bodyNote, /really was empty/);
      assert.equal(rec.bodyError, undefined);
    });
});

test("a base64 body is decoded before the cap is applied", async () => {
  const rec = {};
  const send = async () => ({ base64Encoded: true, body: Buffer.from("bids").toString("base64") });
  await readBody(send, "r", rec, 400000, 2, 0);
  assert.equal(rec.body, "bids");
});


/* ---- the rescue, against a real browser ----------------------------------
 *
 * Measured 2026-08-22 on United Cooperative, Beaver Dam: discover found
 * `stonehedge.stonex.com/component/bids` carrying twenty-four Wisconsin
 * location ids, and every attempt to read it came back
 * "No resource with given identifier found (-32000)". Their page has no
 * iframe; Chromium had simply let the body go.
 *
 * The server below reproduces the SHAPE of that, deterministically: a fetch
 * from inside the page gets headers and then a destroyed socket, so the body
 * is unreadable; the same URL asked for as a top-level navigation answers
 * normally. That is the case the rescue exists for.
 */
test("A BODY THE PAGE CANNOT SURRENDER IS ASKED FOR AGAIN, AS A PAGE",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  const BOARD = "<table><tr><td>Beaver Dam</td><td>4.11</td></tr></table>";
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/component/bids")) {
      /* A navigation gets the board. A subresource fetch gets headers and then
         the socket pulled, which is what leaves the renderer with nothing to
         hand over. */
      if ((req.headers["sec-fetch-mode"] ?? "") === "navigate") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(BOARD);
      }
      res.writeHead(200, { "content-type": "text/html", "content-length": "999" });
      res.flushHeaders?.();
      return res.socket.destroy();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>
      fetch("/component/bids?key=THEIRPUBLICKEY&locs=A,B").catch(()=>{})</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await captureAll({ pageUrl: base + "/", browser, timeoutMs: 40000,
                                 quietMs: 1200, rescueWaitMs: 800 });
    const feed = r.responses.find((x) => x.url.includes("/component/bids"));
    assert.ok(feed, `feed not seen among ${r.responses.map((x) => x.url).join(", ")}`);
    assert.ok(feed.rescue, "the rescue must have run and said so");
    assert.match(feed.body ?? "", /Beaver Dam/, "and it must have come back with the board");
    assert.match(feed.rescue, /re-requested as a page/);
    /* THE KEY STILL NEVER REACHES THE RECORD. The rescue re-requests the
       unredacted URL and must not put it anywhere that gets printed. */
    assert.ok(!JSON.stringify(r.responses).includes("THEIRPUBLICKEY"),
      "their key must not reach the log, rescue or no rescue");
  } finally { srv.close(); }
});

test("a feed that reads normally is never rescued",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  /* The rescue costs a page load and changes the provenance of a body, so it
     must not fire when the first read worked. */
  const FEED = '[{"location":{"id":1,"name":"Alpha"},"cashPrice":4.11}]';
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/api/cash-bids")) {
      res.writeHead(200, { "content-type": "application/json" }); return res.end(FEED);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>fetch("/api/cash-bids").then(r=>r.json())</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await captureAll({ pageUrl: base + "/", browser, timeoutMs: 40000, quietMs: 1200 });
    const feed = r.responses.find((x) => x.url.includes("/api/cash-bids"));
    assert.equal(feed.body, FEED);
    assert.equal(feed.rescue, undefined, "nothing to rescue, so nothing was");
    assert.equal(feed.bodyError, undefined);
  } finally { srv.close(); }
});


test("THE RESCUE BUDGET GOES TO THE MOST BOARD-LIKE, NOT THE FIRST TO ARRIVE",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  /* Measured 2026-08-23 on United Cooperative: FIVE unreadable bodies against a
     cap of three. The three it spent were a Barchart bundle, a second copy of
     it and a stylesheet; `stonehedge.stonex.com/component/bids` was fourth in
     the queue and printed "not re-requested". The cap was right. The order was
     not. Here the board is requested LAST and the cap is ONE. */
  const BOARD = "<table><tr><td>Beaver Dam</td><td>4.11</td></tr></table>";
  const unreadable = (res) => {
    res.writeHead(200, { "content-type": "text/html", "content-length": "999" });
    res.flushHeaders?.();
    res.socket.destroy();
  };
  const srv = createServer((req, res) => {
    if ((req.headers["sec-fetch-mode"] ?? "") === "navigate" && req.url.startsWith("/component/bids")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(BOARD);
    }
    if (/^\/(component\/bids|vendor\.js|second\.js|styles\.css|logo-thing\.js)/.test(req.url)) return unreadable(res);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>
      ["/vendor.js","/second.js","/styles.css","/logo-thing.js","/component/bids?key=K&locs=A"]
        .forEach(u => fetch(u).catch(()=>{}));</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await captureAll({ pageUrl: base + "/", browser, timeoutMs: 40000,
                                 quietMs: 1200, rescueWaitMs: 800,
                                 rescueMax: 1, keep: () => true });
    const board = r.responses.find((x) => x.url.includes("/component/bids"));
    assert.ok(board, "the board response must have been seen");
    assert.match(board.body ?? "", /Beaver Dam/,
      "the one rescue available must have been spent on the board, not on a bundle");
    const spent = r.responses.filter((x) => /re-requested as a page/.test(x.rescue ?? ""));
    assert.equal(spent.length, 1, "and only one, because the cap is one");
  } finally { srv.close(); }
});


test("A PAGE THAT HANGS COSTS SECONDS, NOT THE BATCH",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  /* Measured 2026-08-23: a sweep of 44 candidates was killed by the job's
     55-minute wall at page 24, wedged on one site. `send` resolves only when a
     reply arrives and has no timeout, so the rescue's Page.navigate to a page
     that never answers waited for ever. The capture loop had its own deadline;
     the rescue had nothing. */
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/component/bids")) {
      if ((req.headers["sec-fetch-mode"] ?? "") === "navigate") return;   // never answers
      res.writeHead(200, { "content-type": "text/html", "content-length": "999" });
      res.flushHeaders?.();
      return res.socket.destroy();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>fetch("/component/bids?key=K").catch(()=>{})</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const began = Date.now();
  try {
    const r = await captureAll({ pageUrl: base + "/", browser, timeoutMs: 20000,
                                 quietMs: 1000, rescueWaitMs: 200,
                                 rescueNavMs: 1500, rescueBudgetMs: 4000 });
    const took = Date.now() - began;
    assert.ok(took < 40000, `a hanging rescue must not run away; took ${took}ms`);
    const feed = r.responses.find((x) => x.url.includes("/component/bids"));
    assert.ok(feed, "the response is still reported");
    assert.match(feed.rescue ?? "", /did not answer|budget/,
      "and it says the rescue timed out rather than going quiet about it");
  } finally { srv.close(); }
});


test("AN API ANSWERING A BROWSER IS NOT THE BOARD",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  /* Measured 2026-08-23. Navigating to Bushel's GetBidsList returned
     "<h1>Whitelabel Error Page</h1> … status=404"; futures.bushelops.com
     returned "not found"; AgriCharts returned "403 Forbidden". Every one came
     back 200-with-HTML and would have been recorded as that feed's body — an
     error page wearing a board's URL. */
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/api/GetBidsList")) {
      if ((req.headers["sec-fetch-mode"] ?? "") === "navigate") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html><body><h1>Whitelabel Error Page</h1>status=404</body></html>");
      }
      res.writeHead(200, { "content-type": "application/json", "content-length": "999" });
      res.flushHeaders?.();
      return res.socket.destroy();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>fetch("/api/GetBidsList?key=K").catch(()=>{})</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await captureAll({ pageUrl: base + "/", browser, timeoutMs: 25000,
                                 quietMs: 1000, rescueWaitMs: 400 });
    const feed = r.responses.find((x) => x.url.includes("GetBidsList"));
    assert.ok(feed, "the response is still reported");
    assert.equal(feed.body, null, "the error page must NOT become the feed's body");
    assert.match(feed.rescue ?? "", /HTML document where the original was/,
      "and the refusal says exactly what it refused and why");
  } finally { srv.close(); }
});

test("an HTML feed is still rescued, because that is what the rescue is for",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  /* The guard is on JSON-became-HTML. StoneHedge's board IS html and must
     still come back. */
  const BOARD = "<div class=\"bid-group\">Beaver Dam</div>";
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/component/bids")) {
      if ((req.headers["sec-fetch-mode"] ?? "") === "navigate") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(BOARD);
      }
      res.writeHead(200, { "content-type": "text/html", "content-length": "999" });
      res.flushHeaders?.();
      return res.socket.destroy();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>fetch("/component/bids?key=K").catch(()=>{})</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await captureAll({ pageUrl: base + "/", browser, timeoutMs: 25000,
                                 quietMs: 1000, rescueWaitMs: 400 });
    const feed = r.responses.find((x) => x.url.includes("/component/bids"));
    assert.match(feed.body ?? "", /Beaver Dam/, "an HTML board still comes back");
  } finally { srv.close(); }
});

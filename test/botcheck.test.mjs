/* A BOT CHECK IS TOLD APART FROM A SLOW PAGE, ENDS THE READ IN SECONDS, AND IS
 * ASKED AGAIN EVERY FEW HOURS, NOT EVERY PASS -- 2026-10-20.
 *
 * The real case: www.newcoop.com (66 NEW Cooperative boards on one page) has
 * answered our browser with a Cloudflare challenge on most passes since 15:30
 * UTC Oct 19. Each pass loaded it, waited out the browser clock and, when the
 * clock was 45s, printed "no readable response ... within 45000ms" (index.json
 * at 02:20 UTC Oct 20), which reads like a slow site.
 *
 * Nothing here gets past a check. The tests below pin that seeing one STOPS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { botCheckSign, BotCheck, capture, findBrowser } from "../lib/cdp.mjs";
import { acceptOf } from "../lib/sources.mjs";
import { botCheckMarks, botCheckWaiting, isSkip, Skipped } from "../lib/breaker.mjs";

const BOARD = readFileSync(new URL("../fixtures/newcoop-cashbids-2026-10-02.html", import.meta.url), "utf8");
/* The shape of Cloudflare's managed-challenge page: its title, its options
   object and its orchestrate script. Not a capture (none is in the repo); the
   markers are the ones Cloudflare documents and serves on every such page. */
const CHECK = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="360"></head><body><div class="main-wrapper" role="main">
<noscript>Enable JavaScript and cookies to continue</noscript></div>
<script>(function(){window._cf_chl_opt={cvId: '3',cZone: "www.newcoop.com",cType: 'managed'};
var cpo=document.createElement('script');cpo.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=x';
document.getElementsByTagName('head')[0].appendChild(cpo);}());</script></body></html>`;

test("their real board is NOT a bot check, though Cloudflare's passive script is on it", () => {
  /* fixtures/newcoop-cashbids-2026-10-02.html line 12854 loads
     /cdn-cgi/challenge-platform/scripts/jsd/main.js. The old test in poll.mjs
     matched "challenge-platform" anywhere. */
  assert.match(BOARD, /\/cdn-cgi\/challenge-platform\/scripts\/jsd\/main\.js/);
  assert.equal(botCheckSign({ headers: { "content-type": "text/html" }, body: BOARD }), "");
  assert.equal(acceptOf("newcoop")(BOARD), true);
});

test("the challenge page is one, by its header or by its own markers", () => {
  assert.equal(botCheckSign({ headers: { "CF-Mitigated": "challenge" }, body: "" }), "cf-mitigated: challenge");
  assert.equal(botCheckSign({ body: CHECK }), "_cf_chl_opt");
  assert.equal(botCheckSign({ body: "<html><head><title>Just a moment...</title></head></html>" }), '"Just a moment..."');
  assert.equal(botCheckSign({ body: '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/x"></script>' }),
    "challenge-platform/h/");
  assert.equal(acceptOf("newcoop")(CHECK), false, "and it is not the board");
  assert.equal(botCheckSign({ headers: { "cf-mitigated": "" }, body: '{"bids":[]}' }), "");
});

test("a BotCheck says so in words a reader of index.json understands", () => {
  const e = new BotCheck("www.newcoop.com", "cf-mitigated: challenge");
  assert.equal(e.botCheck, true);
  assert.match(e.message, /^blocked by a bot check: www\.newcoop\.com answered our browser with a Cloudflare challenge page/);
  assert.doesNotMatch(e.message, /no readable response|within \d+ms/, "it is not a timeout");
});

/* ---- the backoff ---------------------------------------------------------- */
const key = (s) => `${s.browserPage ?? ""}|${s.url}`;
const nc = (id) => ({ id, url: "https://www.newcoop.com/cash-bids", browserPage: "https://www.newcoop.com/cash-bids" });

test("a page that showed a bot check waits BOT_CHECK_BACKOFF_H, then is asked once", () => {
  const at = Date.parse("2026-10-20T10:40:28.466Z");
  const rows = new Map([["newcoop-afton", { botCheckAt: "2026-10-20T10:40:28.466Z" }],
                        ["newcoop-lamoni", { botCheckAt: "2026-10-20T09:00:00Z" }],
                        ["other", {}]]);
  const srcs = [nc("newcoop-afton"), nc("newcoop-lamoni"), { id: "other", url: "https://x.example/b" }];
  const marks = botCheckMarks(srcs, rows, key);
  assert.equal(marks.size, 1, "one page, however many sources sit on it");
  assert.equal(marks.get(key(srcs[0])), at, "the latest mark on the page wins");
  const k = key(srcs[0]);
  assert.equal(botCheckWaiting(marks, k, at + 10 * 60_000, 3), true, "the next pass, ten minutes on: not asked");
  assert.equal(botCheckWaiting(marks, k, at + 2.9 * 3600_000, 3), true);
  assert.equal(botCheckWaiting(marks, k, at + 3 * 3600_000, 3), false, "three hours on: asked again");
  assert.equal(botCheckWaiting(marks, key(srcs[2]), at, 3), false, "an unmarked page is always asked");
});

test("poll.mjs: a bot check is a skip that did ask, marks the page, and a board clears it", () => {
  const poll = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  /* held before any load, for both transports */
  const gp = poll.indexOf("async function getPage(s)");
  const held = poll.indexOf("if (botCheckWaiting(key))", gp);
  assert.ok(held > gp && held < poll.indexOf("if (pages.has(key)) return pages.get(key);", gp),
    "the hold is checked before the page cache and before any browser is started");
  assert.ok(held < poll.indexOf('if (transportOf(s.platform) === "browser")', gp));
  /* the reprieve does not spend a slot on a page that is waiting out a check */
  assert.match(poll, /reprieveAt - t > STARVING_MS && !botCheckWaiting\(k, reprieveAt\)/);
  /* the browser catch reads cdp's own verdict and no longer the bare word */
  const i = poll.indexOf("A BOT CHECK IS THE SITE SAYING NO");
  const block = poll.slice(i, i + 2400);
  assert.match(block, /e\?\.botCheck === true \|\| \/challenges\\\.cloudflare\\\.com\|challenge-platform\\\/h\\\/\//);
  assert.match(block, /new Skipped\(`blocked by a bot check: /);
  assert.ok(i < poll.indexOf("if (breaker.fail(s.platform, e.message, operatorOf(s)))"),
    "checked before the breaker counts a failure");
  assert.match(poll, /if \(e\?\.botCheck === true\) \{ r\.attemptedAt = now; r\.botCheckAt = now; \}/);
  assert.match(poll, /delete r\.botCheckAt;/);
  assert.match(poll, /\.\.\.\(prevRow\.get\(s\.id\)\?\.botCheckAt \? \{ botCheckAt: prevRow\.get\(s\.id\)\.botCheckAt \} : \{\}\)/,
    "the mark rides on a skipped row, and a carried row keeps it with the rest of the row");
  /* and it stays a skip: streak untouched */
  assert.equal(isSkip(Object.assign(new Skipped("blocked by a bot check"), { botCheck: true })), true);
});

/* ---- end to end, in a real browser --------------------------------------- */
let browser = null;
try { browser = findBrowser(); } catch { /* no browser here */ }

test("a challenge at the board's address ends the read in seconds, as a BotCheck",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    res.end(CHECK);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const page = `http://127.0.0.1:${srv.address().port}/cash-bids`;
  const t0 = Date.now();
  try {
    await assert.rejects(
      capture({ pageUrl: page, target: page, browser, timeoutMs: 40000, accept: acceptOf("newcoop"),
                botCheckGraceMs: 1500 }),
      (e) => e instanceof BotCheck && /blocked by a bot check: 127\.0\.0\.1:\d+/.test(e.message));
    const ms = Date.now() - t0;
    assert.ok(ms < 15000, `it waited ${ms}ms; the whole 40s clock is what this replaces`);
  } finally { srv.close(); }
});

test("a check page that turns into the board on its own is still read (2026-10-02)",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  /* The site's own reload, not ours: the first answer is a check page that
     reloads itself; the second is the board. */
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/html" });
    if (hits === 1) return res.end(CHECK.replace("</body>", "<script>setTimeout(() => location.reload(), 300)</script></body>"));
    res.end(BOARD);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const page = `http://127.0.0.1:${srv.address().port}/cash-bids`;
  try {
    const got = await capture({ pageUrl: page, target: page, browser, timeoutMs: 30000,
                                accept: acceptOf("newcoop"), botCheckGraceMs: 6000 });
    assert.equal(acceptOf("newcoop")(got.body), true);
    assert.ok(hits >= 2);
  } finally { srv.close(); }
});

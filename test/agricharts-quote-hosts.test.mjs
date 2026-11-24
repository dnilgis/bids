/* THE CBOT QUOTE COMES FROM THE DESKTOP SITE'S FEED FIRST, THE MOBILE PAGES AFTER.
 *
 * Since the pass after 2026-11-20T15:08Z every *.mobile.agricharts.com host
 * answers HTTP 500. Every board on the platforms that check their rows against
 * the CBOT quote then refused, by design, and froze. The desktop futures pages
 * of the same platform answer the same runner, and their numbers come from
 * one quote feed (the script their own page loads). That feed is asked first;
 * the mobile pages are the fallback.
 *
 * What must NOT change is the check itself: the same contracts, the same
 * tolerance, and no quotes still means no publish. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUOTE_FEED_URL, quoteSources, quoteUrls, isQuotePage, isQuoteFeed, parseQuoteFeed,
  parseQuotes, readQuotes, mergeQuotes, extract, AgriChartsRefused, QUOTE_FEED_ROOTS, quoteFeedRootUrl,
} from "../lib/adapters/agricharts.mjs";
import { SHARED_PAGES } from "../lib/adapters/index.mjs";
import { QUOTE_PROVIDERS, readShared, AGSIST_PRICES_URL } from "../lib/quotes.mjs";

const fx = (f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const FEED = "desktop-agricharts-quotes-www-marketdata-jsquote-php-varname-quotes-symbols-zc-1-zc-2-zc-3.html";
const EGRAINS = "desktop-agricharts-quotes-ceagrain-markets-fixed-php-page-egrains.html";
const feed = () => fx(FEED);

test("the feed is asked first and the mobile pages last", () => {
  const sets = quoteSources();
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[0], [QUOTE_FEED_URL, ...QUOTE_FEED_ROOTS.map(quoteFeedRootUrl)]);
  assert.deepEqual(QUOTE_FEED_ROOTS, ["ZR", "ZC", "ZS", "ZW"], "rice first: the strip form carries none");
  assert.deepEqual(sets.at(-1), quoteUrls());
  for (const u of sets.at(-1)) assert.match(new URL(u).host, /\.mobile\.agricharts\.com$/);
});

test("the feed URL is exactly the one the desktop futures page loads", () => {
  const page = fx(EGRAINS);
  const src = page.match(/src="(\/\/www\.agricharts\.com\/marketdata\/jsquote\.php[^"]*)"/)[1]
    .replace(/&amp;/g, "&");
  assert.equal("https:" + src, QUOTE_FEED_URL);
  const log = JSON.parse(fx("desktop-agricharts-quotes-captures.json"));
  const row = log.find((r) => r.file === FEED);
  assert.equal(row.url, QUOTE_FEED_URL, "the fixture is the answer to this exact URL");
  assert.equal(row.status, 200);
  assert.ok(!Number.isNaN(Date.parse(row.capturedAt)));
  assert.match(row.userAgent, /agsist-bidreader/, "asked as the poller asks");
});

test("the per-root feed URL is the one the desktop root page loads, and each was captured", () => {
  const page = fx("desktop-agricharts-quotes-ceagrain-markets-quotes-php-root-zc.html").replace(/&amp;/g, "&");
  assert.ok(page.includes(quoteFeedRootUrl("ZC").replace(/^https:/, "")), "quotes.php?root=ZC loads this form");
  const log = JSON.parse(fx("desktop-agricharts-quotes-captures.json"));
  for (const root of QUOTE_FEED_ROOTS) {
    const row = log.find((r) => r.url === quoteFeedRootUrl(root));
    assert.ok(row, `${root}: captured from the runner`);
    assert.equal(row.status, 200);
    assert.match(row.userAgent, /agsist-bidreader/);
    assert.ok(parseQuoteFeed(fx(row.file)).filter((q) => q.priced && q.root === root).length >= 7, root);
  }
});

test("the desktop pages themselves carry no price table, so the feed is what is read", () => {
  assert.equal(isQuotePage(fx(EGRAINS)), false);
  assert.equal(isQuotePage(fx("desktop-agricharts-quotes-ceagrain-markets-quotes-php-root-zc.html")), false);
  assert.equal(isQuoteFeed(feed()), true);
  assert.equal(isQuotePage(feed()), true);
});

test("every platform on the CBOT quote reads the same sets and rejects a non-quote page", () => {
  const specs = Object.entries(SHARED_PAGES).filter(([, s]) => s.urls[0] === QUOTE_FEED_URL);
  assert.ok(specs.length >= 10, `found ${specs.length}`);
  for (const [name, s] of specs) {
    assert.deepEqual([s.urls, ...s.alternates], quoteSources(), name);
    assert.equal(s.accepts, isQuotePage, `${name} would parse any 200`);
    assert.equal(s.providers, QUOTE_PROVIDERS, `${name} reads the second quote source too`);
  }
});

test("a 500 page, an empty answer and a cash board are not quote pages", () => {
  assert.equal(isQuotePage(""), false);
  assert.equal(isQuotePage("<html><head><title>500 Internal Server Error</title></head></html>"), false);
  assert.equal(isQuotePage(fx("agricharts-kellergrain.html")), false);
  assert.equal(isQuotePage(fx("agricharts-quotes-corn.html")), true);
});

test("the feed reads into the same contract shape, in cents", () => {
  const qs = parseQuoteFeed(feed());
  const by = (s) => qs.find((q) => q.symbol === s);
  assert.deepEqual(
    { ...by("ZCZ26") },
    { symbol: "ZCZ26", root: "ZC", monthCode: "Z", year: 2026, name: "Corn",
      title: "Corn December 2026", lastCents: 435, lastRaw: "435", priced: true, unit: "bushel",
      grain: "Corn", notation: "eighths", settled: false, flag: null, changeCents: 0.75, at: "11/24/26",
      /* 12:31:45 on the feed's Central clock; the previous session's settlement on its date */
      tradedAt: "2026-11-24T18:31:45.000Z", settlements: { "2026-11-23": 434.25 }, source: "agricharts-feed" });
  assert.equal(by("ZSF27").lastCents, 1238.25);
  assert.equal(by("ZWZ26").lastCents, 572);
  assert.equal(by("KEZ26").lastCents, 615);
  assert.equal(by("ZOZ26").lastCents, 361.5);
  /* Minneapolis is quoted in dollars (basecode C), as on the mobile page */
  assert.equal(by("MWZ26").lastCents, 638.75);
  assert.equal(by("MWZ26").changeCents, -1.25);
  /* meal and oil sit in the feed and are never priced as a bushel */
  for (const s of ["ZMZ26", "ZLZ26"]) { assert.equal(by(s).priced, false); assert.equal(by(s).lastCents, null); }
  /* a root this system does not price stays unpriced */
  assert.equal(by("KWZ26").priced, false);
  const priced = qs.filter((q) => q.priced);
  assert.equal(priced.length, 41);
  for (const q of priced) assert.ok(q.lastCents > 100 && q.lastCents < 3000, `${q.symbol} ${q.lastCents}`);
});

test("an unknown unit, an off-grid price or a missing last is unpriced, never guessed", () => {
  const one = (fields) => `var quotes = {\n\t'ZC*1': {\n${fields}\n\t}\n};`;
  const base = "symbol: 'ZCZ26', name: 'Corn', basecode: '2', last: '435', change: '1', tradetime: '20261124120000'";
  assert.equal(parseQuoteFeed(one(base))[0].lastCents, 435);
  assert.throws(() => parseQuoteFeed(one(base.replace("basecode: '2'", "basecode: '7'"))), AgriChartsRefused);
  assert.throws(() => parseQuoteFeed(one(base.replace("last: '435'", "last: '435.1'"))), AgriChartsRefused);
  assert.throws(() => parseQuoteFeed(one(base.replace("last: '435'", "last: ''"))), AgriChartsRefused);
  assert.throws(() => parseQuoteFeed(one(base.replace("last: '435'", "last: '0'"))), AgriChartsRefused);
  assert.throws(() => parseQuoteFeed("<html>500</html>"), AgriChartsRefused);
});

test("readQuotes picks the reader by shape; the mobile reader is unchanged", () => {
  const corn = fx("agricharts-quotes-corn.html");
  assert.deepEqual(readQuotes(corn), parseQuotes(corn));
  assert.deepEqual(readQuotes(feed()), parseQuoteFeed(feed()));
});

test("feed and mobile pages merge into one strip, one entry per symbol, the first answer winning", () => {
  const both = mergeQuotes([feed(), fx("agricharts-quotes-corn.html")]);
  const syms = both.map((q) => q.symbol);
  assert.equal(new Set(syms).size, syms.length);
  assert.equal(both.find((q) => q.symbol === "ZCZ26").lastCents, 435);
  const ctx = SHARED_PAGES["agricharts-cashgrid"].build([feed()]);
  assert.equal(ctx.contracts.filter((c) => c.priced).length, 41);
});

test("the check is exactly as strict: no quotes still refuses", () => {
  const board = fx("agricharts-kellergrain.html");
  assert.throws(() => extract(board, "u", null), AgriChartsRefused);
  assert.throws(() => extract(board, "u", { contracts: [] }), AgriChartsRefused);
});

/* THE FALLBACK ORDER, RUN. The poller and the board sweep both hand their own
   fetch to lib/quotes.mjs readShared, so this runs the order they run, against
   a fake network: which URLs are asked, in what order, and what comes back. */
const FEED_SET = quoteSources()[0];
const run = async (answer) => {
  const asked = [];
  const r = await readShared(SHARED_PAGES.agricharts, async (u) => { asked.push(u); return answer(u); },
    { now: new Date("2026-11-24T18:45:00Z") });
  return { asked, ...r };
};
const ok = (body) => ({ ok: true, body });
const http500 = { ok: false, error: "HTTP 500" };
const isMobile = (u) => /\.mobile\.agricharts\.com\//.test(u);
const isAgsist = (u) => u === AGSIST_PRICES_URL;

test("the poller's order, run: a feed that answers means the mobile pages are never asked", async () => {
  const { asked, ctx } = await run((u) => (FEED_SET.includes(u) ? ok(feed()) : isAgsist(u) ? http500 : ok("")));
  assert.deepEqual(asked.filter((u) => !isAgsist(u)), FEED_SET, "every feed url, and nothing else from AgriCharts");
  assert.ok(asked.some(isAgsist), "the second source is asked on its own, every pass");
  assert.equal(asked.filter(isMobile).length, 0);
  assert.ok(ctx.contracts.filter((c) => c.priced).length >= 41);
});

test("the poller's order, run: a feed that fails sends it to the mobile pages, in order", async () => {
  const corn = fx("agricharts-quotes-corn.html");
  const { asked, ctx, problems } = await run((u) => (FEED_SET.includes(u) ? http500
    : isMobile(u) ? (/root=ZC$/.test(u) ? ok(corn) : http500) : http500));
  const ac = asked.filter((u) => !isAgsist(u));
  assert.deepEqual(ac, [...FEED_SET, ...quoteUrls()], "the feed set first, then all seven mobile pages");
  assert.ok(ctx === null || ctx.contracts.every((c) => !c.priced),
    "September's mobile capture is stale on a November clock, so nothing is priced");
  assert.ok(problems.some((p) => /HTTP 500/.test(p)));
});

test("the poller's order, run: a 200 that is not a quote page is a failure, not a page", async () => {
  const { asked, ctx } = await run((u) => (isAgsist(u) ? http500 : ok("<html>500 Internal Server Error</html>")));
  assert.equal(asked.filter(isMobile).length, 7, "it fell through to the mobile pages");
  assert.equal(ctx, null, "and with nothing readable anywhere there is no context: every board refuses");
});

test("the poller and the board sweep run that one reader", () => {
  const poll = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(poll, /import \{ readShared, describeQuotes, sharedWarnings \} from "\.\.\/lib\/quotes\.mjs"/);
  assert.match(poll, /await readShared\(spec, get,/);
  assert.match(poll, /for \(const line of sharedWarnings\(platform, spec, problems, ctx\)\) console\.error\(line\)/,
    "its warnings are the lines lib/quotes.mjs sharedWarnings writes (run for real in quote-sources.test.mjs)");
  const sweep = readFileSync(new URL("../scripts/board-sweep.mjs", import.meta.url), "utf8");
  assert.match(sweep, /await readShared\(spec, get\)/);
  const ac = readFileSync(new URL("../scripts/agricharts-sweep.mjs", import.meta.url), "utf8");
  assert.match(ac, /for \(const set of quoteSources\(\)\)/);
});

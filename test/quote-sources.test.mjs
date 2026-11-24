/* A SECOND, INDEPENDENT CBOT QUOTE SOURCE FOR THE BOARD CHECK (lib/quotes.mjs).
 *
 * From the pass after 2026-11-20T15:08Z every AgriCharts quote page answered
 * HTTP 500, and every source on the six platforms that check against it
 * refused and froze for four days. agsist's own published futures file is the
 * second provider. Everything here runs on frozen real answers of both:
 *
 *   fixtures/agsist-prices-2026-11-20T1516Z.json   the file the 15:17Z pass would have read
 *   fixtures/agsist-prices-2026-11-24T1835Z.json   six minutes before the feed capture below
 *   fixtures/agsist-prices-2026-11-24T1816Z.json   the rewrite before that one
 *   fixtures/agsist-prices-2026-11-21T0601Z.json   a weekend file: every entry settled, no close_time
 *   fixtures/desktop-agricharts-quotes-www-marketdata-jsquote-*.html   the AgriCharts feed, 2026-11-24
 *   fixtures/replay-2026-11-20T1517Z-frozen-sources.json   what the 15:17Z pass refused
 *
 * Synthetic input appears only where a real capture cannot show the case (two
 * providers that disagree), and it is a one-number edit of a real capture. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  parseAgsistPrices, isAgsistPrices, combineQuotes, compareQuotes, freshness, readShared,
  agsistScheduleOpen, agsistOpenMinutes, AGSIST_PRICES_URL, QUOTE_MAX_AGE_DAYS, TICK_CENTS,
  AGSIST_MAX_OPEN_MIN, AGSIST_MAX_OPEN_MIN_DAY, cbotDaySession, agsistAgeLimit, QUOTE_PROVIDERS,
  describeQuotes, sharedWarnings,
} from "../lib/quotes.mjs";
import {
  parseQuoteFeed, mergeQuotes, quoteSources, fitToContracts, rootsFor, MAX_FIT_CENTS, extract,
  AgriChartsRefused,
} from "../lib/adapters/agricharts.mjs";
import { SHARED_PAGES, adapterFor } from "../lib/adapters/index.mjs";
import { extract as fivestar, FiveStarRefused } from "../lib/adapters/fivestar.mjs";
import { extract as stonehedge, StoneHedgeRefused } from "../lib/adapters/stonehedge.mjs";

const fx = (f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const FIX = readdirSync(new URL("../fixtures/", import.meta.url));
const AG_1120 = fx("agsist-prices-2026-11-20T1516Z.json");
const AG_1124 = fx("agsist-prices-2026-11-24T1835Z.json");
const AG_1124_1816 = fx("agsist-prices-2026-11-24T1816Z.json");
const AG_WEEKEND = fx("agsist-prices-2026-11-21T0601Z.json");
const FEED = fx("desktop-agricharts-quotes-www-marketdata-jsquote-php-varname-quotes-symbols-zc-1-zc-2-zc-3.html");
const ROOT_FEED = (r) => fx(FIX.find((f) => f.includes(`allsymbols-${r}-`)));
const BOARD = fx("agricharts-cashgrid-tettensgrain.html");     // prices off ZCZ26 and ZCH27
const AGRICHARTS_URLS = quoteSources().flat();

const http500 = { ok: false, error: "HTTP 500" };
/* The network as the poller sees it: AgriCharts answering `ac`, agsist answering `ag`. */
const net = ({ ac = () => http500, ag = () => http500 } = {}) => async (u) =>
  (u === AGSIST_PRICES_URL ? ag(u) : AGRICHARTS_URLS.includes(u) ? ac(u) : { ok: false, error: "unknown url" });
const read = (network, now) => readShared(SHARED_PAGES["agricharts-cashgrid"], network, { now: new Date(now) });
const cashgrid = (ctx) => adapterFor("agricharts-cashgrid", ctx ?? undefined);

/* ---------- the provider and its fields ---------- */

test("agsist's file reads into the board check's contract shape, dated contracts only", () => {
  assert.equal(isAgsistPrices(AG_1124), true);
  assert.equal(isAgsistPrices(FEED), false);
  assert.equal(isAgsistPrices("<html>500</html>"), false);
  const qs = parseAgsistPrices(AG_1124);
  const z = qs.find((q) => q.symbol === "ZCZ26");
  assert.deepEqual({ ...z, settlements: undefined }, {
    symbol: "ZCZ26", root: "ZC", monthCode: "Z", year: 2026, name: "Corn", title: null,
    lastCents: 435, lastRaw: "435", priced: true, unit: "bushel", grain: "Corn", notation: "cents",
    settled: false, flag: null, priceKind: "last", changeCents: 0.75, at: "11/24/26",
    /* close_time is agsist's fetch clock, kept as fetchedAt and never read as a trade time */
    tradedAt: null, fetchedAt: "2026-11-24T18:35:23.000Z",
    settlements: undefined, fileWrittenAt: "2026-11-24T18:35:43.000Z", source: "agsist" });
  assert.deepEqual(z.settlements, { "2026-11-19": 439, "2026-11-20": 434.5, "2026-11-23": 434.25 });
  /* the contracts it carries, by root; no rice (only the continuous ZR=F, no month) and no Minneapolis */
  const byRoot = {};
  for (const q of qs) byRoot[q.root] = (byRoot[q.root] ?? 0) + 1;
  assert.deepEqual(byRoot, { ZC: 7, ZS: 8, ZW: 6, KE: 3, ZO: 3 });
  for (const q of qs) assert.equal(q.lastCents % 0.25, 0, `${q.symbol} on the quarter-cent grid`);
  /* continuous and "-nearby" keys are never read as a contract */
  assert.equal(new Set(qs.map((q) => q.symbol)).size, qs.length);
});

test("not the file, or a file with no dated grain contract, is refused", () => {
  assert.throws(() => parseAgsistPrices("{}"), /not agsist's prices file/);
  const j = JSON.parse(AG_1124);
  for (const k of Object.keys(j.quotes)) if (/\.CBT$/.test(j.quotes[k].ticker)) delete j.quotes[k];
  assert.throws(() => parseAgsistPrices(JSON.stringify(j)), /no dated grain contract/);
});

/* The file carries ZCZ26.CBT under three keys (corn-dec, corn-dec26, corn-nearby). */
const keysOf = (j, ticker) => Object.keys(j.quotes).filter((k) => j.quotes[k].ticker === ticker);

test("a key agsist itself marks stale or withheld is not read", () => {
  const j = JSON.parse(AG_1124);
  assert.deepEqual(keysOf(j, "ZCZ26.CBT"), ["corn-dec", "corn-dec26", "corn-nearby"]);
  j.stale_keys = keysOf(j, "ZCZ26.CBT");
  assert.equal(parseAgsistPrices(JSON.stringify(j)).some((q) => q.symbol === "ZCZ26"), false);
  const w = JSON.parse(AG_1124);
  w.withheld_keys = Object.fromEntries(keysOf(w, "ZCH27.CBT").map((k) => [k, "roll"]));
  assert.equal(parseAgsistPrices(JSON.stringify(w)).some((q) => q.symbol === "ZCH27"), false);
});

test("both providers are every contract shape the check reads, tagged with who said it", () => {
  const feed = mergeQuotes([FEED, ROOT_FEED("zr")]);
  for (const q of [...feed.filter((x) => x.priced), ...parseAgsistPrices(AG_1124)])
    for (const k of ["symbol", "root", "monthCode", "year", "lastCents", "unit", "at", "tradedAt", "settlements", "source"])
      assert.ok(k in q, `${q.source} ${q.symbol} has ${k}`);
});

/* ---------- the two providers on the same day ---------- */

test("the real captures agree on every settlement they share, and that is what is compared", () => {
  const now = new Date("2026-11-24T18:45:00Z");
  const c = combineQuotes([{ source: "agricharts", contracts: parseQuoteFeed(FEED) },
                           { source: "agsist", contracts: parseAgsistPrices(AG_1124) }], { now });
  assert.equal(c.notes.withheld.length, 0);
  assert.equal(c.notes.confirmed, 24, "24 contracts carried by both, settlement for 2026-11-23 identical");
  assert.equal(c.find((q) => q.symbol === "ZSF27").confirmedBy[0], "agsist");
  /* The prices differ by three ticks: the feed's 1238.25 is a trade at 18:31:45Z;
     agsist's 1239.00 is what its fetch read at 18:35:29Z (close_time is its fetch
     clock, not a print). Only their shared settlement is compared, and it agrees. */
  const a = parseQuoteFeed(FEED).find((q) => q.symbol === "ZSF27");
  const b = parseAgsistPrices(AG_1124).find((q) => q.symbol === "ZSF27");
  assert.ok(Math.abs(a.lastCents - b.lastCents) > TICK_CENTS.ZS);
  assert.equal(b.tradedAt, null);
  assert.deepEqual(compareQuotes(a, b), { compared: 1, gap: null });
  /* AgriCharts is first: its quote is the one used wherever it has one */
  assert.equal(c.find((q) => q.symbol === "ZSF27").source, "agricharts-feed");
  assert.match(describeQuotes(c), /41 from agricharts-feed, 2 from agsist; 24 confirmed/);
});

test("disagreement: more than one tick on the same settlement withholds that contract from both", () => {
  const now = new Date("2026-11-24T18:45:00Z");
  const bumped = (by) => {
    const j = JSON.parse(AG_1124);
    for (const k of keysOf(j, "ZCZ26.CBT")) j.quotes[k].settles["2026-11-23"] += by;   // the one synthetic number
    return parseAgsistPrices(JSON.stringify(j));
  };
  const both = (ag) => combineQuotes([{ source: "agricharts", contracts: parseQuoteFeed(FEED) },
                                      { source: "agsist", contracts: ag }], { now });
  const off = both(bumped(0.5));
  const z = off.find((q) => q.symbol === "ZCZ26");
  assert.equal(z.priced, false);
  assert.equal(z.lastCents, null);
  assert.match(z.withheld, /ZCZ26 settlement for 2026-11-23: agricharts-feed 434.25c, agsist 434.75c/);
  assert.equal(off.notes.withheld.length, 1);
  assert.equal(off.find((q) => q.symbol === "ZCH27").priced, true, "only that contract");
  /* exactly one tick is not a disagreement */
  assert.equal(both(bumped(0.25)).find((q) => q.symbol === "ZCZ26").priced, true);
  /* and the board: rows priced off ZCZ26 refuse, the ZCH27 rows still publish */
  const rows = cashgrid({ contracts: off })(BOARD, "u");
  assert.ok(rows.length > 0 && rows.every((r) => r.futures === "ZCH27"));
  assert.ok(rows.unreconciled.some((u) => /ZCZ26/.test(u.why)));
});

test("a last trade is compared only when both prints are the same moment, on two trade clocks", () => {
  const a = parseQuoteFeed(FEED).find((q) => q.symbol === "ZCZ26");
  /* a second provider with a real trade clock (agsist has none; see the next test) */
  const b = { ...a, source: "another-trade-clock", settlements: {} };
  const at = (q, iso, cents) => ({ ...q, tradedAt: iso, lastCents: cents });
  assert.match(compareQuotes(a, at(b, "2026-11-24T18:32:30.000Z", 435.5)).gap, /last trade/);
  assert.equal(compareQuotes(a, at(b, "2026-11-24T18:32:30.000Z", 435.25)).gap, null);
  assert.equal(compareQuotes(a, at(b, "2026-11-24T18:33:00.000Z", 440)).gap, null, "76 s apart is not one moment");
});

/* agsist's close_time laid onto the feed's own trade clock, contract by
   contract, to the second: the stamps line up exactly as they did on the
   real passes where agsist's fetch fell within a minute of a feed trade. */
const onFeedClock = (body) => {
  const j = JSON.parse(body);
  const clock = new Map(parseQuoteFeed(FEED).filter((q) => q.tradedAt).map((q) => [q.symbol, q.tradedAt]));
  let n = 0;
  for (const v of Object.values(j.quotes)) {
    const s = String(v?.ticker ?? "").replace(/\.CBT$/, "");
    if (clock.has(s)) { v.close_time = clock.get(s).replace(".000Z", "Z"); n++; }
  }
  return { body: JSON.stringify(j), n };
};

test("agsist is compared on settlements only: its fetch clock laid on the feed's trade clock withholds nothing", () => {
  const now = new Date("2026-11-24T18:45:00Z");
  const feed = parseQuoteFeed(FEED);
  for (const [name, body] of [["18:35Z", AG_1124], ["18:16Z", AG_1124_1816]]) {
    const { body: shifted, n } = onFeedClock(body);
    assert.ok(n > 20, `${name}: ${n} entries restamped`);
    const ag = parseAgsistPrices(shifted);
    assert.ok(ag.every((q) => q.tradedAt === null), "close_time is never read as a trade time");
    /* prices more than a tick apart on contracts whose stamps now match to the second */
    const apart = ag.filter((q) => {
      const f = feed.find((x) => x.symbol === q.symbol);
      return f && Math.abs(f.lastCents - q.lastCents) > TICK_CENTS[q.root];
    });
    assert.ok(apart.length >= 5, `${name}: ${apart.map((q) => q.symbol).join(" ")}`);
    const c = combineQuotes([{ source: "agricharts", contracts: feed }, { source: "agsist", contracts: ag }], { now });
    assert.equal(c.notes.withheld.length, 0, `${name}: ${c.notes.withheld.join(" | ")}`);
    assert.equal(c.notes.confirmed, 24, `${name}: the 2026-11-23 settlements are still compared, and agree`);
    for (const q of apart) assert.equal(c.find((x) => x.symbol === q.symbol).priced, true, q.symbol);
  }
});

/* ---------- a weekend or holiday file ---------- */

test("a weekend file: every entry settled with no close_time, read as that date's settlement", async () => {
  const j = JSON.parse(AG_WEEKEND);
  const cbt = Object.values(j.quotes).filter((v) => /\.CBT$/.test(v?.ticker ?? ""));
  assert.ok(cbt.length > 20 && cbt.every((v) => v.close_kind === "settle" && !("close_time" in v)));
  const qs = parseAgsistPrices(AG_WEEKEND);
  assert.equal(qs.length, 27);
  for (const q of qs) {
    assert.deepEqual([q.settled, q.priceKind, q.tradedAt, q.at], [true, "settlement", null, "11/20/26"], q.symbol);
    assert.equal(q.settlements["2026-11-20"], q.lastCents, q.symbol);
  }
  const z = qs.find((q) => q.symbol === "ZCZ26");
  assert.deepEqual([z.lastCents, z.changeCents], [434.5, -4.5]);
  /* fresh and stale by the existing rules */
  const at = (now) => freshness(z, new Date(now));
  assert.equal(at("2026-11-21T18:00:00Z").ok, true, "Saturday noon CT");
  assert.equal(at("2026-11-23T00:30:00Z").ok, true, "Sunday 18:30 CT, before agsist's job reopens");
  assert.match(at("2026-11-23T03:00:00Z").why, /minutes of its own schedule ago \(limit 120\)/,
    "Sunday 21:00 CT with no rewrite since Saturday: the job stopped");
  assert.match(at("2026-11-25T15:00:00Z").why, /5 days before 2026-11-25/);
  /* end to end: AgriCharts down on the Saturday, the boards publish on Friday's settlements */
  const r = await read(net({ ag: () => ({ ok: true, body: AG_WEEKEND }) }), "2026-11-21T18:00:00Z");
  assert.equal(r.ctx.contracts.filter((q) => q.priced).length, 27);
  const rows = cashgrid(r.ctx)(BOARD, "u");
  assert.equal(rows.length, 57);
  assert.deepEqual([...new Set(rows.map((x) => `${x.futures} ${x.futuresPrice}`))].sort(), ["ZCH27 448.75", "ZCZ26 434.5"]);
  assert.ok(rows.every((x) => x.quoteSource === "agsist"));
});

/* ---------- what prices a row, and the row says so ---------- */

test("agsist prices from its settlement for the session when it has one, and every row names its quote source", async () => {
  const j = JSON.parse(AG_1124);
  /* one number added: the 2026-11-24 ZCZ26 settlement, 434 (the per-root feed's 's' entry), in agsist's settles */
  for (const k of keysOf(j, "ZCZ26.CBT")) j.quotes[k].settles["2026-11-24"] = 434;
  const body = JSON.stringify(j);
  const z = parseAgsistPrices(body).find((q) => q.symbol === "ZCZ26");
  assert.deepEqual([z.lastCents, z.settled, z.flag, z.priceKind, z.changeCents], [434, true, "s", "settlement", -0.25]);
  /* without one for its session, its last price, named as such */
  const h = parseAgsistPrices(body).find((q) => q.symbol === "ZCH27");
  assert.deepEqual([h.lastCents, h.settled, h.priceKind], [451, false, "last"]);
  /* AgriCharts down after the close: the rows are priced off agsist and say so */
  const r = await read(net({ ag: () => ({ ok: true, body }) }), "2026-11-24T20:40:00Z");
  const rows = cashgrid(r.ctx)(BOARD, "u");
  assert.deepEqual([...new Set(rows.map((x) => `${x.futures} ${x.futuresPrice} ${x.quoteSource}`))].sort(),
    ["ZCH27 451 agsist", "ZCZ26 434 agsist"]);
  /* both up: the feed prices them, and they say that */
  const up = (u) => ({ ok: true, body: u.includes("allsymbols") ? ROOT_FEED(u.match(/allsymbols=(\w+)/)[1].toLowerCase()) : FEED });
  const r2 = await read(net({ ac: up, ag: () => ({ ok: true, body }) }), "2026-11-24T20:40:00Z");
  assert.ok(cashgrid(r2.ctx)(BOARD, "u").every((x) => x.quoteSource === "agricharts-feed"));
});

/* ---------- agsist's file age ---------- */

test("agsist's file-age limit: 45 open minutes in the day session, 120 elsewhere", () => {
  assert.deepEqual([AGSIST_MAX_OPEN_MIN_DAY, AGSIST_MAX_OPEN_MIN], [45, 120]);
  assert.equal(cbotDaySession(new Date("2026-11-24T14:29:00Z")), false);   // Tue 08:29 CT
  assert.equal(cbotDaySession(new Date("2026-11-24T14:30:00Z")), true);    // Tue 08:30 CT
  assert.equal(cbotDaySession(new Date("2026-11-24T19:19:00Z")), true);    // Tue 13:19 CT
  assert.equal(cbotDaySession(new Date("2026-11-24T19:20:00Z")), false);   // Tue 13:20 CT
  assert.equal(cbotDaySession(new Date("2026-11-21T16:00:00Z")), false);   // Sat 10:00 CT
  assert.equal(agsistAgeLimit("2026-11-24T16:00:00Z"), 45);
  assert.equal(agsistAgeLimit("2026-11-24T08:00:00Z"), 120);
  const q = (w) => ({ symbol: "ZCZ26", source: "agsist", at: "11/24/26", tradedAt: null, fileWrittenAt: w });
  /* day session: written 09:00 CT */
  assert.equal(freshness(q("2026-11-24T15:00:00Z"), new Date("2026-11-24T15:45:00Z")).ok, true);
  assert.match(freshness(q("2026-11-24T15:00:00Z"), new Date("2026-11-24T15:50:00Z")).why,
    /50 minutes of its own schedule ago \(limit 45 in the day session\)/);
  /* the real files: 18:16:47Z read at 18:35Z (the longest day gap measured, 2026-11-18 to 11-24, is 20.1 minutes) */
  assert.ok(parseAgsistPrices(AG_1124_1816).every((x) => freshness(x, new Date("2026-11-24T18:35:00Z")).ok));
  /* overnight: written 02:00 CT */
  assert.equal(freshness(q("2026-11-24T08:00:00Z"), new Date("2026-11-24T09:55:00Z")).ok, true);
  assert.match(freshness(q("2026-11-24T08:00:00Z"), new Date("2026-11-24T10:05:00Z")).why,
    /125 minutes of its own schedule ago \(limit 120\)$/);
});

/* ---------- the run log ---------- */

test("a failed agsist read logs its own warning when AgriCharts is healthy", async () => {
  const spec = SHARED_PAGES["agricharts-cashgrid"];
  const up = (u) => ({ ok: true, body: u.includes("allsymbols") ? ROOT_FEED(u.match(/allsymbols=(\w+)/)[1].toLowerCase()) : FEED });
  const now = "2026-11-24T18:45:00Z";
  const r = await read(net({ ac: up }), now);
  assert.ok(r.ctx);
  const w = sharedWarnings("agricharts-cashgrid", spec, r.problems, r.ctx);
  assert.equal(w.length, 1);
  assert.match(w[0], /^::warning title=agricharts-cashgrid second quote source::agsist could not be read \(1 failure\(s\)\): agsist: https:\/\/raw\.githubusercontent\.com\/dnilgis\/agsist\/main\/data\/prices\.json -> HTTP 500\. agricharts was read; quotes come from it alone this pass, without a second-source check\.$/);
  assert.doesNotMatch(w[0], /shared page\(s\)/);
  /* AgriCharts down, agsist up: the shared-page warning, as before */
  const r2 = await read(net({ ag: () => ({ ok: true, body: AG_1124 }) }), now);
  const w2 = sharedWarnings("agricharts-cashgrid", spec, r2.problems, r2.ctx);
  assert.equal(w2.length, 1);
  assert.match(w2[0], /^::warning title=agricharts-cashgrid shared page\(s\)::\d+ failed — .*continues on those\.$/);
  /* both down: the shared-page warning says every source refuses, and agsist's failure is named beside it */
  const r3 = await read(net(), now);
  const w3 = sharedWarnings("agricharts-cashgrid", spec, r3.problems, r3.ctx);
  assert.equal(w3.length, 2);
  assert.match(w3[0], /shared page\(s\).*Nothing was read, so every agricharts-cashgrid source will refuse/);
  assert.match(w3[1], /^::warning title=agricharts-cashgrid second quote source::agsist could not be read \(1 failure\(s\)\): .*HTTP 500\.$/);
  assert.deepEqual(sharedWarnings("agricharts-cashgrid", spec, [], r.ctx), []);
});

/* ---------- freshness ---------- */

test("stale quote = missing: a trade date more than four days old", () => {
  const q = parseQuoteFeed(FEED).find((x) => x.symbol === "ZCZ26");     // traded 2026-11-24
  assert.equal(QUOTE_MAX_AGE_DAYS, 4);
  assert.equal(freshness(q, new Date("2026-11-28T23:00:00Z")).ok, true);
  assert.match(freshness(q, new Date("2026-11-29T15:00:00Z")).why, /5 days before 2026-11-29/);
  const c = combineQuotes([{ source: "agricharts", contracts: parseQuoteFeed(FEED) }],
    { now: new Date("2026-11-29T15:00:00Z") });
  assert.equal(c.filter((x) => x.priced).length, 0);
  assert.match(c.find((x) => x.symbol === "ZCZ26").missing, /no fresh quote/);
  assert.throws(() => extract(fx("agricharts-kellergrain.html"), "u", { contracts: c }), AgriChartsRefused);
});

test("stale feed guard: a feed whose trade dates stopped is missing, and the second source fills in", async () => {
  const now = "2026-11-29T15:00:00Z";
  const ag = JSON.parse(AG_1124);
  ag.fetched = "2026-11-29T14:50:00Z";
  for (const v of Object.values(ag.quotes)) { v.close_time = "2026-11-29T14:49:00Z"; v.close_date = "2026-11-29"; }
  const r = await read(net({ ac: () => ({ ok: true, body: FEED }), ag: () => ({ ok: true, body: JSON.stringify(ag) }) }), now);
  assert.ok(r.notes.stale.some((s) => /agricharts-feed/.test(s)));
  assert.equal(r.ctx.contracts.find((q) => q.symbol === "ZCZ26").source, "agsist");
});

test("agsist's file must be alive on its own schedule, holidays included", () => {
  /* its job's hours, Central: Fri before 14:00 and from 23:30, Sat before 02:00 */
  assert.equal(agsistScheduleOpen(new Date("2026-11-20T19:55:00Z")), true);   // Fri 13:55
  assert.equal(agsistScheduleOpen(new Date("2026-11-20T20:05:00Z")), false);  // Fri 14:05
  assert.equal(agsistScheduleOpen(new Date("2026-11-21T06:00:00Z")), true);   // Sat 00:00
  assert.equal(agsistScheduleOpen(new Date("2026-11-21T20:00:00Z")), false);  // Sat 14:00
  assert.equal(agsistScheduleOpen(new Date("2026-11-23T01:00:00Z")), true);   // Sun 19:00
  /* written Friday 13:55: fresh through the weekend's closed hours, stale once its schedule runs on without it */
  const at = (now, fetched) => freshness({ symbol: "ZCZ26", source: "agsist", at: "11/20/26",
    tradedAt: "2026-11-20T19:55:00.000Z", fileWrittenAt: fetched }, new Date(now));
  assert.equal(at("2026-11-21T07:00:00Z", "2026-11-20T19:55:00Z").ok, true, "5 + 90 open minutes");
  assert.match(at("2026-11-21T09:00:00Z", "2026-11-20T19:55:00Z").why, /155 minutes of its own schedule/);
  /* the capture of 15:16Z read at Friday 19:30Z: its job ran on and it was not rewritten */
  assert.equal(agsistOpenMinutes("2026-11-20T15:16:19Z", "2026-11-20T19:30:00Z") > AGSIST_MAX_OPEN_MIN, true);
  const c = combineQuotes([{ source: "agsist", contracts: parseAgsistPrices(AG_1120) }],
    { now: new Date("2026-11-20T19:30:00Z") });
  assert.equal(c.filter((q) => q.priced).length, 0);
});

/* ---------- the feed's settled ('s') and previous-session ('p') entries ---------- */

test("settled ('s') entries carry today's settlement, previous-session ('p') ones only yesterday's", () => {
  const zc = parseQuoteFeed(ROOT_FEED("zc"));                    // captured 14:31 CT, after the close
  const z = zc.find((q) => q.symbol === "ZCZ26");
  assert.equal(z.flag, "s");
  assert.equal(z.settled, true);
  assert.equal(z.lastCents, 434);
  assert.deepEqual(z.settlements, { "2026-11-23": 434.25, "2026-11-24": 434 });
  const p = parseQuoteFeed(FEED).find((q) => q.symbol === "ZOK27");
  assert.equal(p.flag, "p");
  assert.equal(p.settled, false);
  assert.equal(p.lastCents, 381.75);
  assert.equal(p.settlements["2026-11-24"], undefined);
  assert.equal(freshness(p, new Date("2026-11-24T19:00:00Z")).ok, true);
});

test("rice is in the per-root feed, priced per hundredweight; agsist names no rice contract", () => {
  const zr = parseQuoteFeed(ROOT_FEED("zr"));
  assert.deepEqual(zr.map((q) => q.symbol), ["ZRF27", "ZRH27", "ZRK27", "ZRN27", "ZRU27", "ZRX27", "ZRF28"]);
  const f = zr[0];
  assert.equal(f.lastCents, 1883.5);
  assert.equal(f.unit, "hundredweight");
  assert.equal(f.settlements["2026-11-23"], 1884.5);
  /* agsist's continuous rice shows the same 2026-11-23 settlement, 18.845, and names no month */
  const rice = JSON.parse(AG_1124).quotes.rice;
  assert.equal(rice.ticker, "ZR=F");
  assert.equal(Math.round(rice.settles["2026-11-23"] * 1000) / 1000, 18.845);
  assert.equal(parseAgsistPrices(AG_1124).some((q) => q.root === "ZR"), false);
});

/* ---------- the four outages, end to end through the poller's reader ---------- */

test("AgriCharts down (HTTP 500) and the second source up: the boards publish", async () => {
  const r = await read(net({ ag: () => ({ ok: true, body: AG_1124 }) }), "2026-11-24T18:45:00Z");
  assert.ok(r.problems.some((p) => /agricharts: .*HTTP 500/.test(p)));
  const rows = cashgrid(r.ctx)(BOARD, "u");
  assert.equal(rows.length, 57);
  assert.deepEqual([...new Set(rows.map((x) => `${x.futures} ${x.futuresPrice}`))].sort(), ["ZCH27 451", "ZCZ26 435"]);
  assert.ok(r.ctx.contracts.filter((q) => q.priced).every((q) => q.source === "agsist"));
});

test("both down: no context, and every board refuses", async () => {
  const r = await read(net(), "2026-11-24T18:45:00Z");
  assert.equal(r.ctx, null);
  assert.throws(() => cashgrid(undefined)(BOARD, "u"));
  assert.throws(() => adapterFor("agricharts-cashgrid", { contracts: [] })(BOARD, "u"), /no CBOT quotes/);
  assert.throws(() => extract(fx("agricharts-kellergrain.html"), "u", null), AgriChartsRefused);
});

test("both up: AgriCharts is used, agsist confirms, and a broken agsist file changes nothing", async () => {
  const up = { ac: (u) => ({ ok: true, body: u.includes("allsymbols") ? ROOT_FEED(u.match(/allsymbols=(\w+)/)[1].toLowerCase()) : FEED }) };
  const r = await read(net({ ...up, ag: () => ({ ok: true, body: AG_1124 }) }), "2026-11-24T20:40:00Z");
  assert.equal(r.ctx.contracts.find((q) => q.symbol === "ZCZ26").source, "agricharts-feed");
  assert.ok(r.notes.confirmed > 0);
  const r2 = await read(net({ ...up, ag: () => ({ ok: true, body: "<html>404</html>" }) }), "2026-11-24T20:40:00Z");
  assert.ok(r2.problems.some((p) => /agsist: .*not the expected page/.test(p)));
  /* the strip feed's 435 (12:31 CT) is first in the set and wins over the per-root feed's settled 434 */
  assert.equal(r2.ctx.contracts.find((q) => q.symbol === "ZCZ26").lastCents, 435);
  assert.equal(r2.ctx.contracts.find((q) => q.symbol === "ZCZ28").source, "agricharts-feed",
    "a deferred the strip form leaves out comes from the per-root feed");
});

test("the providers are read in order: AgriCharts, then agsist", () => {
  assert.deepEqual(QUOTE_PROVIDERS.map((p) => p.source), ["agricharts", "agsist"]);
  assert.deepEqual(QUOTE_PROVIDERS[0].sets, quoteSources());
  assert.deepEqual(QUOTE_PROVIDERS[1].sets, [[AGSIST_PRICES_URL]]);
  assert.match(AGSIST_PRICES_URL, /^https:\/\/raw\.githubusercontent\.com\/dnilgis\/agsist\/main\/data\/prices\.json$/);
  const log = JSON.parse(fx("agsist-prices-captures.json"));
  for (const row of log) {
    assert.equal(row.url, AGSIST_PRICES_URL);
    assert.equal(JSON.parse(fx(row.file)).fetched, row.fetched);
  }
});

/* ---------- a grain with no priced contract is refused, not waved through ---------- */

test("kellergrain with no soybean contract: the soybean rows are refused, the corn rows publish", () => {
  const all = mergeQuotes(FIX.filter((f) => /^agricharts-quotes-/.test(f)).map(fx));
  const board = fx("agricharts-kellergrain.html");
  const full = extract(board, "u", { contracts: all });
  assert.equal(full.filter((r) => /soy/i.test(r.commodity)).length, 4);
  const noZS = extract(board, "u", { contracts: all.filter((c) => c.root !== "ZS") });
  assert.equal(noZS.filter((r) => /soy/i.test(r.commodity)).length, 0, "no soybean row is stamped as checked");
  assert.equal(noZS.length, full.length - 4);
  assert.equal(noZS.unreconciled.filter((u) => /no ZS contract is priced/.test(u.why)).length, 4);
  /* a withheld contract counts as no contract */
  const withheld = all.map((c) => (c.root === "ZS" ? { ...c, priced: false, lastCents: null, withheld: "x" } : c));
  assert.equal(extract(board, "u", { contracts: withheld }).length, full.length - 4);
});

test("fitToContracts hands back the rows it could not check, for every caller", () => {
  const row = (commodity, implied) => ({ commodity, impliedFuturesCents: implied, delivery: "d", location: "x" });
  const fit = fitToContracts([row("Corn", 435), row("Soybeans", 1238)],
    [{ symbol: "ZCZ26", root: "ZC", priced: true, lastCents: 435, grain: "Corn" }]);
  assert.equal(fit.checked, 1);
  assert.deepEqual(fit.unpriced.map((r) => r.commodity), ["Soybeans"]);
  assert.equal(fit.nearest.get(fit.unpriced[0]), undefined);
});

/* The quotes these real boards are checked against, as the existing adapter
   tests build them (test/own-board.test.mjs TONIGHT; test/stonehedge.test.mjs
   contracts(): the futures the priced StoneHedge boards print, ZW stand-ins). */
const FIVESTAR_QUOTES = [
  ["ZCZ26", 499], ["ZCH27", 513.5], ["ZCN27", 524.5], ["ZCZ27", 515.25],
  ["ZSX26", 1277], ["ZSF27", 1293.25], ["ZSH27", 1303.25], ["ZSN27", 1318], ["ZSX27", 1250],
].map(([symbol, lastCents]) => ({ symbol, lastCents, priced: true, root: symbol.slice(0, 2),
  grain: symbol.startsWith("ZC") ? "corn" : "soybeans", source: "agsist" }));
const SH = (s) => fx(`stonehedge-${s}-component-rendered.html`);
const SH_URL = "https://stonehedge.stonex.com/component/bids?locs=x";
const stonehedgeQuotes = () => {
  const cm = new Map();
  for (const s of ["agvalley", "cendakcooperative", "mrga", "rivervalleycoop"])
    for (const r of stonehedge(SH(s), SH_URL)) if (/^[A-Z]{2}[FGHJKMNQUVXZ]\d\d$/.test(r.futures)) cm.set(r.futures, r.futuresPrice);
  cm.set("ZWZ26", 590); cm.set("ZWN27", 620);
  return [...cm].map(([symbol, lastCents]) => ({ symbol, root: symbol.slice(0, 2), lastCents, priced: true, source: "agsist" }));
};

test("Five Star, run: a grain with no priced contract is refused row by row, the rest publish and name their source", () => {
  const board = fx("fivestar-bids-2026-10-01.html");
  const full = fivestar(board, "u", { contracts: FIVESTAR_QUOTES });
  const soy = full.filter((r) => r.commodity === "Soybeans").length;
  assert.ok(soy > 0);
  const noZS = fivestar(board, "u", { contracts: FIVESTAR_QUOTES.filter((c) => c.root !== "ZS") });
  assert.equal(noZS.filter((r) => r.commodity === "Soybeans").length, 0, "no soybean row is stamped as checked");
  assert.equal(noZS.length, full.length - soy);
  assert.ok(noZS.unreconciled.filter((u) => /no ZS contract is priced/.test(u.why)).length >= soy);
  /* a withheld contract counts as no contract */
  const withheld = FIVESTAR_QUOTES.map((c) => (c.root === "ZS" ? { ...c, priced: false, lastCents: null, withheld: "x" } : c));
  assert.equal(fivestar(board, "u", { contracts: withheld }).length, full.length - soy);
  for (const r of noZS) assert.equal(r.quoteSource, "agsist", `${r.raw} names the source it was checked against`);
  /* and with no priced contract at all, the board refuses */
  assert.throws(() => fivestar(board, "u", { contracts: withheld.map((c) => ({ ...c, priced: false, lastCents: null })) }),
    FiveStarRefused);
});

test("StoneHedge, run: unpriced grains are refused on both the fitted and the named path", () => {
  const Q = stonehedgeQuotes();
  /* Milnor prints neither price nor month: fitted */
  const milnor = stonehedge(SH("milnorgrain"), SH_URL, { contracts: Q });
  assert.equal(milnor.length, 22);
  const m2 = stonehedge(SH("milnorgrain"), SH_URL, { contracts: Q.filter((c) => c.root !== "ZS") });
  assert.equal(m2.length, 16);
  assert.equal(m2.some((r) => r.commodity === "Soybeans"), false);
  assert.equal(m2.unreconciled.filter((u) => /no ZS contract is priced/.test(u.why)).length, 6);
  for (const r of m2) assert.equal(r.quoteSource, "agsist");
  /* Frontier names its contract month: named */
  const frontier = stonehedge(SH("frontiercooperative"), SH_URL, { contracts: Q });
  const hrw = frontier.filter((r) => /HRW/.test(r.commodity)).length;
  assert.equal(hrw, 15);
  const f2 = stonehedge(SH("frontiercooperative"), SH_URL, { contracts: Q.filter((c) => c.root !== "KE") });
  assert.equal(f2.length, frontier.length - hrw);
  assert.equal(f2.unreconciled.filter((u) => /quote pages do not carry for KE/.test(u.why)).length, hrw);
  /* a majority unpriced refuses the board: Milnor with corn and soybeans both gone */
  assert.throws(() => stonehedge(SH("milnorgrain"), SH_URL, { contracts: Q.filter((c) => c.root !== "ZS" && c.root !== "ZC") }),
    StoneHedgeRefused);
});

/* ---------- the replay: the real 2026-11-20 15:17Z pass ---------- */

/* What each platform's adapter asks of the quote, applied to the rows each
   frozen source last published (its file at that commit):
     named  the row's own contract must be priced; cashgrid prices cash off it,
            Heartland, Landus, QT Market and StoneHedge also check cash minus
            basis lands within MAX_FIT_CENTS of it
     fit    the nearest priced contract of the row's grain within MAX_FIT_CENTS
            (agricharts mobile, Five Star), refusing the board on a majority */
const NAMED_PRICES = new Set(["agricharts-cashgrid", "agricharts-cashgrid-browser"]);
const NAMED_FITS = new Set(["heartland", "landus", "qtmarket", "stonehedge"]);
function replaySource(s, commodities, contracts) {
  const bySymbol = new Map(contracts.filter((c) => c.priced).map((c) => [c.symbol, c]));
  const rows = s.rows.map(([ci, month, cash, basisCents]) => ({
    commodity: commodities[ci], futuresMonth: month, impliedFuturesCents: Math.round((cash * 100 - basisCents) * 1e4) / 1e4 }));
  let kept = 0, misses = 0, checked = 0;
  const named = NAMED_PRICES.has(s.platform) || NAMED_FITS.has(s.platform);
  /* a StoneHedge board that names no contract is fitted, as its adapter does */
  for (const r of named ? rows.filter((x) => x.futuresMonth) : []) {
    const q = bySymbol.get(r.futuresMonth);
    if (!q) continue;
    checked++;
    if (NAMED_FITS.has(s.platform) && Math.abs(q.lastCents - r.impliedFuturesCents) > MAX_FIT_CENTS) { misses++; continue; }
    kept++;
  }
  const toFit = named ? (s.platform === "stonehedge" ? rows.filter((x) => !x.futuresMonth) : []) : rows;
  if (toFit.length) {
    const fit = fitToContracts(toFit.filter((r) => rootsFor(r.commodity)), contracts);
    checked += fit.checked; misses += fit.misses?.length ?? 0; kept += fit.checked - (fit.misses?.length ?? 0);
  }
  const publishes = kept > 0 && !(NAMED_PRICES.has(s.platform) ? false : misses * 2 >= checked);
  return { publishes, kept, rows: rows.length };
}

const REPLAY = JSON.parse(fx("replay-2026-11-20T1517Z-frozen-sources.json"));
const replay = async (network) => {
  const r = await read(network, REPLAY.passAt);
  const out = { sources: 0, publish: 0, rows: 0, kept: 0, byPlatform: {} };
  for (const s of REPLAY.sources) {
    const v = r.ctx ? replaySource(s, REPLAY.commodities, r.ctx.contracts) : { publishes: false, kept: 0, rows: s.rows.length };
    out.sources++; out.rows += v.rows; out.kept += v.kept;
    const p = (out.byPlatform[s.platform] ??= { sources: 0, publish: 0 });
    p.sources++;
    if (v.publishes) { out.publish++; p.publish++; }
  }
  return { ...out, ctx: r.ctx };
};

test("replay of the real 15:17Z pass: the fixture is what that pass refused for want of quotes", () => {
  assert.equal(REPLAY.passAt, "2026-11-20T15:17:01Z");
  assert.equal(REPLAY.sources.length + REPLAY.noFile.length, 1367);
  const by = {};
  for (const s of [...REPLAY.sources, ...REPLAY.noFile.map(([id, platform]) => ({ platform }))])
    by[s.platform] = (by[s.platform] ?? 0) + 1;
  assert.deepEqual(by, { agricharts: 38, "agricharts-cashgrid": 1144, "agricharts-cashgrid-browser": 30,
    fivestar: 15, heartland: 54, landus: 5, qtmarket: 14, stonehedge: 67 });
});

test("replay of the real 15:17Z pass: as it ran (AgriCharts 500, no second source), nothing publishes", async () => {
  const r = await replay(net());
  assert.equal(r.ctx, null);
  assert.equal(r.publish, 0);
});

test("replay of the real 15:17Z pass: with the second source, the frozen sources publish", async () => {
  const r = await replay(net({ ag: () => ({ ok: true, body: AG_1120 }) }));
  assert.equal(r.ctx.contracts.filter((q) => q.priced).length, 27);
  assert.equal(r.sources, 1346);
  assert.equal(r.rows, 16399);
  assert.equal(r.publish, REPLAY_EXPECT.publish, JSON.stringify(r.byPlatform));
  assert.equal(r.kept, REPLAY_EXPECT.kept);
  assert.deepEqual(r.byPlatform, REPLAY_EXPECT.byPlatform);
});

/* 1,341 of the 1,346 frozen sources with a file publish on agsist's 15:16Z file
   alone. The five that do not name only contracts the file does not carry:
   Minneapolis wheat (agtegra-mansfield, mkap-wahpeton), KEN27 (shawneefeed-
   okarchekingfisher; the file carries KC wheat to May 2027), and the expired
   ZSX26 on boards whose last good read was in September and October
   (lfdfarmers-decaturbids, mercerlandmark-mpsstmarys). Rows: 14,955 of 16,399
   kept; the rest name MW, KEN27, KEZ27, ZSF28 or ZWN28, or miss by more than
   5c (mostly Heartland, whose own check anchors differently). */
const REPLAY_EXPECT = {
  publish: 1341,
  kept: 14955,
  byPlatform: {
    "agricharts-cashgrid": { sources: 1123, publish: 1118 }, landus: { sources: 5, publish: 5 },
    fivestar: { sources: 15, publish: 15 }, qtmarket: { sources: 14, publish: 14 },
    agricharts: { sources: 38, publish: 38 }, heartland: { sources: 54, publish: 54 },
    stonehedge: { sources: 67, publish: 67 }, "agricharts-cashgrid-browser": { sources: 30, publish: 30 },
  },
};

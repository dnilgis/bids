/* THE SECOND QUOTE SOURCE IN THE EVENING, THE SOURCE CALENDAR, AND WHO
 * PRICED A BOARD (lib/quotes.mjs, lib/board.mjs).
 *
 * Real answers:
 *   fixtures/desktop-agricharts-quotes-www-marketdata-jsquote-php-varname-quotes-allsymbols-*.html
 *       the AgriCharts per-root feed at 2026-11-24T20:31:52Z (14:31 CT), after
 *       the close: every contract settled ('s'), today's settlement and the
 *       previous session's (ysettlement on ytradedate, 2026-11-23)
 *   fixtures/agsist-prices-2026-11-24T1946Z.json
 *       agsist's last rewrite of that day, the file every pass read from 19:50Z
 *       until its job reopened at 00:45Z: settles through 2026-11-23, today's
 *       price a last ("close_kind": "last")
 *
 * Synthetic input is a date edit of a real capture, where no capture can show
 * the case (a source frozen on a Friday, a holiday). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  parseAgsistPrices, combineQuotes, describeQuotes, freshness, lastClosedSession, cbotSessionDay,
  sourceBehind, CBOT_CLOSED,
} from "../lib/quotes.mjs";
import { mergeQuotes, parseQuoteFeed } from "../lib/adapters/agricharts.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { buildFile } from "../lib/board.mjs";
import { toConfig } from "../lib/sources.mjs";

const fx = (f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const FIX = readdirSync(new URL("../fixtures/", import.meta.url));
const ROOT_FEED = (r) => fx(FIX.find((f) => f.includes(`allsymbols-${r}-`)));
const EVENING_FEED = () => mergeQuotes(["zc", "zs", "zw", "zr"].map(ROOT_FEED));
const AG_1946 = fx("agsist-prices-2026-11-24T1946Z.json");
const AG_1124 = fx("agsist-prices-2026-11-24T1835Z.json");
const BOARD = fx("agricharts-cashgrid-tettensgrain.html");

const evening = (now, feed = EVENING_FEED()) => combineQuotes(
  [{ source: "agricharts", contracts: feed }, { source: "agsist", contracts: parseAgsistPrices(AG_1946) }],
  { now: new Date(now) });

/* ---------- the evening cross-check ---------- */

test("the evening captures: the two sources share the 2026-11-23 settlement and confirm on it", () => {
  const feed = EVENING_FEED();
  const z = feed.find((q) => q.symbol === "ZCZ26");
  assert.deepEqual(z.settlements, { "2026-11-23": 434.25, "2026-11-24": 434 });
  const a = parseAgsistPrices(AG_1946).find((q) => q.symbol === "ZCZ26");
  assert.deepEqual(a.settlements, { "2026-11-19": 439, "2026-11-20": 434.5, "2026-11-23": 434.25 });
  assert.equal(a.priceKind, "last", "agsist has no 2026-11-24 settlement until its day rolls over");
  /* from the capture to the last pass before the feed's own day rolls (17:00 CT) */
  for (const now of ["2026-11-24T20:40:00Z", "2026-11-24T22:50:00Z"]) {
    const c = evening(now);
    assert.equal(c.notes.confirmed, 21, now);
    assert.deepEqual([c.notes.withheld.length, c.notes.stale.length], [0, 0], now);
    assert.equal(c.filter((q) => q.priced).length, 63, now);
    assert.match(describeQuotes(c), /57 from agricharts-feed, 6 from agsist; 21 confirmed/);
  }
});

test("after the feed's 17:00 CT roll the two share no settlement date: nothing confirmed, nothing withheld", () => {
  /* The live passes from 2026-11-24T23:00Z logged "0 confirmed" on the same
     agsist file that confirmed 27 at 22:50Z. The feed's previous session
     becomes 2026-11-24 (ysettlement on ytradedate), agsist's settles still end
     at 2026-11-23, and neither carries the other's date until agsist's day
     rolls at 00:00 CT. The edit: the previous session moved onto today's. */
  const rolled = ["zc", "zs", "zw", "zr"].map((r) => ROOT_FEED(r)
    .replace(/ysettlement: '[^']*'/g, "ysettlement: '0'"));
  const feed = mergeQuotes(rolled).map((q) => ({ ...q, settlements: Object.fromEntries(
    Object.entries(q.settlements).filter(([d]) => d === "2026-11-24")) }));
  const c = evening("2026-11-24T23:00:00Z", feed);
  assert.deepEqual([c.notes.confirmed, c.notes.withheld.length], [0, 0]);
  assert.equal(c.filter((q) => q.priced).length, 63, "every contract still priced, from the feed first");
});

/* ---------- the CBOT calendar ---------- */

test("the last closed session: weekends, the 13:20 CT close, Thanksgiving and Christmas", () => {
  assert.ok(CBOT_CLOSED.has("2026-11-26") && CBOT_CLOSED.has("2026-12-25"));
  assert.equal(cbotSessionDay("2026-11-27"), true, "the Friday after Thanksgiving trades");
  const at = (iso) => lastClosedSession(new Date(iso));
  assert.equal(at("2026-11-23T16:00:00Z"), "2026-11-20", "Mon 10:00 CT: Friday's session");
  assert.equal(at("2026-11-23T19:19:00Z"), "2026-11-20", "Mon 13:19 CT");
  assert.equal(at("2026-11-23T19:20:00Z"), "2026-11-23", "Mon 13:20 CT: Monday has closed");
  assert.equal(at("2026-11-21T18:00:00Z"), "2026-11-20", "Saturday");
  assert.equal(at("2026-11-26T20:00:00Z"), "2026-11-25", "Thanksgiving: Wednesday's session");
  assert.equal(at("2026-11-27T16:00:00Z"), "2026-11-25", "Fri 10:00 CT after Thanksgiving");
  assert.equal(at("2026-11-27T19:30:00Z"), "2026-11-27");
  assert.equal(at("2026-12-26T18:00:00Z"), "2026-12-24", "Saturday after Christmas");
  assert.equal(at("2026-12-28T16:00:00Z"), "2026-12-24");
  assert.equal(at("2026-12-28T19:20:00Z"), "2026-12-28");
});

/* The evening feed laid onto another day: every trade date moved to `ymd`. */
const frozenAt = (ymd) => {
  const [y, m, d] = ymd.split("-");
  return EVENING_FEED().map((q) => ({ ...q, at: `${m}/${d}/${y.slice(2)}`, settlements: {},
    tradedAt: q.tradedAt ? `${ymd}T19:19:59.000Z` : null }));
};
const alone = (feed, now) => combineQuotes([{ source: "agricharts", contracts: feed }], { now: new Date(now) });

test("a feed frozen at Friday's close is missing once Monday's session has closed, not on Wednesday", () => {
  const feed = frozenAt("2026-11-20");
  /* the four-day rule alone passes every contract through Tuesday */
  assert.ok(feed.every((q) => !q.priced || freshness(q, new Date("2026-11-24T18:00:00Z")).ok));
  assert.equal(sourceBehind(feed, new Date("2026-11-23T16:00:00Z")), null, "Mon 10:00 CT: Friday is the last session");
  assert.equal(alone(feed, "2026-11-23T16:00:00Z").filter((q) => q.priced).length, 57);
  for (const now of ["2026-11-23T19:30:00Z", "2026-11-24T18:00:00Z"]) {
    const c = alone(feed, now);
    assert.equal(c.filter((q) => q.priced).length, 0, now);
    assert.match(c.find((q) => q.symbol === "ZCZ26").missing,
      /newest trade is dated 2026-11-20, before the 2026-11-23 session/);
  }
  /* agsist alive on Tuesday fills in, and the frozen feed is not compared */
  const c = combineQuotes([{ source: "agricharts", contracts: feed },
                           { source: "agsist", contracts: parseAgsistPrices(AG_1124) }],
                          { now: new Date("2026-11-24T18:45:00Z") });
  assert.equal(c.find((q) => q.symbol === "ZCZ26").source, "agsist");
  assert.deepEqual([c.notes.confirmed, c.notes.withheld.length], [0, 0]);
});

test("holidays: a Wednesday feed passes Thanksgiving, a Thursday feed passes Christmas weekend", () => {
  const thanks = frozenAt("2026-11-25");
  assert.equal(sourceBehind(thanks, new Date("2026-11-26T22:00:00Z")), null);
  assert.equal(sourceBehind(thanks, new Date("2026-11-27T16:00:00Z")), null);
  assert.match(sourceBehind(thanks, new Date("2026-11-27T19:30:00Z")), /before the 2026-11-27 session/);
  const xmas = frozenAt("2026-12-24");
  assert.equal(alone(xmas, "2026-12-26T18:00:00Z").filter((q) => q.priced).length, 57);
  assert.equal(alone(xmas, "2026-12-28T16:00:00Z").filter((q) => q.priced).length, 57);
  assert.equal(alone(xmas, "2026-12-28T19:30:00Z").filter((q) => q.priced).length, 0);
});

test("a thin contract that did not trade stays priced while its source is current", () => {
  /* ZOK27 had no trade on 2026-11-24; agsist dates it 2026-11-23 at 23:00Z */
  const c = evening("2026-11-24T23:00:00Z");
  const o = c.find((q) => q.symbol === "ZOK27");
  assert.deepEqual([o.source, o.at, o.priced], ["agsist", "11/23/26", true]);
});

/* ---------- which source priced the board ---------- */

const DIXON = toConfig({
  id: "tettensgrain-tettensdixon", operator: "Tettens Grain", location: "Tettens - Dixon", state: "IL",
  platform: "agricharts-cashgrid", url: "https://tettensgrain.agricharts.com/markets/cashgrid.php",
  locationId: "82107", identityAlternative: "agricharts-cashgrid:contract-named+heading-agrees",
  bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] }, cashRounding: "round-cent-either",
});

test("the board build counts the quote source of the rows it publishes, outside the committed file", () => {
  const ctx = { contracts: evening("2026-11-24T20:40:00Z") };
  const built = buildFile(BOARD, { now: "2026-11-24T20:40:00Z", sourceUrl: DIXON.url, source: DIXON,
    extract: adapterFor("agricharts-cashgrid", ctx) });
  assert.ok(built.file.count > 0);
  assert.deepEqual(built.quoteSources, { "agricharts-feed": built.file.count });
  assert.ok(built.file.bids.every((b) => !("quoteSource" in b)), "the committed rows keep their pinned keys");
  /* the feed down: the same rows, priced off agsist, and the count says so */
  const ag = { contracts: combineQuotes([{ source: "agsist", contracts: parseAgsistPrices(AG_1946) }],
    { now: new Date("2026-11-24T20:40:00Z") }) };
  const b2 = buildFile(BOARD, { now: "2026-11-24T20:40:00Z", sourceUrl: DIXON.url, source: DIXON,
    extract: adapterFor("agricharts-cashgrid", ag) });
  assert.deepEqual(b2.quoteSources, { agsist: b2.file.count });
});

test("the poller carries the counts onto the source's index row", () => {
  const poll = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(poll, /if \(built\.quoteSources\) r\.quoteSources = built\.quoteSources;/);
});

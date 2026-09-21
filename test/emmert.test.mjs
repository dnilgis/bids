/*
 * TWO ELEVATORS THAT PUBLISH THEIR OWN FEED.
 *
 * Badger Grain Supply (Wheeler, WI) and Midwest Commodity Service (Baldwin, WI)
 * post bids.json beside their index.html under CC0-1.0. The fixtures are those
 * two files exactly as they were served on 2026-09-20, taken from the sites'
 * own repositories and not edited. Every mutation below is applied to a copy,
 * in the test, so what is asserted is always "this real feed, broken this one
 * way".
 *
 *     node --test test/emmert.test.mjs
 *
 * No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { extract, VERIFIED_BY, EmmertRefused } from "../lib/adapters/emmert.mjs";
import { ADAPTERS } from "../lib/adapters/index.mjs";
import { PLATFORMS, validateSource, toConfig } from "../lib/sources.mjs";
import { buildFile } from "../lib/board.mjs";
import { WITHDRAW_H } from "../lib/freshness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fixture = (n) => readFileSync(join(ROOT, "test/fixtures", n), "utf8");
const source = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));

const BADGER = fixture("emmert-badgergrain-2026-09-20.json");
const MIDWEST = fixture("emmert-midwestcommodity-2026-09-20.json");

/* Their stamp on the day the fixtures were captured, so "fresh" and "stale"
   below are measured against the feed rather than against the clock this test
   happens to run on. */
const CAPTURED = new Date("2026-09-20T23:45:00Z");
const ex = (body, at = CAPTURED) => extract(body, "https://badgergrain.com/bids.json", { now: at });
const edit = (body, fn) => { const j = JSON.parse(body); fn(j); return JSON.stringify(j); };

test("their feed reads, and every row carries cash, basis and the stamp", () => {
  const rows = ex(BADGER);
  assert.equal(rows.length, 11, "all eleven of their posted bids");
  for (const r of rows) {
    assert.equal(r.commodity, "Corn");
    assert.ok(typeof r.delivery === "string" && r.delivery.length, "a delivery month");
    assert.ok(r.cash > 0 && r.cash < 12, `cash out of range: ${r.cash}`);
    assert.ok(r.basis < 0 && r.basis > -3, `basis out of range: ${r.basis}`);
    assert.equal(r.verifiedBy, VERIFIED_BY);
  }
  /* Their first row, off the capture. */
  assert.deepEqual(
    { delivery: rows[0].delivery, cash: rows[0].cash, basis: rows[0].basis, basisCents: rows[0].basisCents },
    { delivery: "September", cash: 4.63, basis: -0.65, basisCents: -65 });
});

test("NO FUTURES PRICE IS REPUBLISHED, which is what their terms ask", () => {
  /* cash - basis is their supplier's exchange-licensed quote arrived at by
     subtraction. It is checked (below) and then dropped. */
  for (const r of ex(BADGER)) {
    assert.equal(r.futuresPrice, null);
    assert.equal(r.futures, null);
    assert.equal(r.impliedFuturesCents, null);
  }
  assert.match(JSON.parse(BADGER).terms.note, /No exchange-licensed futures prices are included/);
});

test("the two feeds are two boards, not one copied twice", () => {
  const b = ex(BADGER), m = extract(MIDWEST, "https://midwestcommodity.com/bids.json", { now: CAPTURED });
  const key = (rows) => rows.map((r) => `${r.delivery}:${r.cash}`).join(",");
  assert.notEqual(key(b), key(m), "both sources would publish identical prices");
});

test("A WITHDRAWN FEED PUBLISHES NOTHING. They say so themselves.", () => {
  /* Their tooling sets a status other than "ok" and their own page prints
     "Call for today's price". Republishing the last figures under that is the
     worst thing this adapter could do. */
  assert.throws(() => ex(edit(BADGER, (j) => { j.status = "withdrawn"; })),
    (e) => e instanceof EmmertRefused && /withdrawn this price themselves/.test(e.message));
});

test("a feed their own site stopped refreshing is stale, however fresh OUR read is", () => {
  /* checkedAt on the file we write says when we read THEM. `observed` is when
     they last read the board behind the price, and it is the only stamp that
     can catch a site that stopped rebuilding. */
  const justInside = new Date(Date.parse(JSON.parse(BADGER).observed) + (WITHDRAW_H - 0.5) * 3600e3);
  assert.equal(ex(BADGER, justInside).length, 11, "half an hour inside the line must still publish");

  const justOutside = new Date(Date.parse(JSON.parse(BADGER).observed) + (WITHDRAW_H + 0.5) * 3600e3);
  assert.throws(() => ex(BADGER, justOutside),
    (e) => e instanceof EmmertRefused && /past the 14h withdrawal line/.test(e.message));
});

test("a stamp in the future is a broken clock, not a fresh read", () => {
  const early = new Date(Date.parse(JSON.parse(BADGER).observed) - 3 * 3600e3);
  assert.throws(() => ex(BADGER, early), /in the FUTURE/);
});

test("no readable stamp at all is refused rather than assumed current", () => {
  assert.throws(() => ex(edit(BADGER, (j) => { j.observed = "whenever"; })),
    /no readable `observed` stamp/);
  assert.throws(() => ex(edit(BADGER, (j) => { delete j.observed; })),
    /no readable `observed` stamp/);
});

test("THE COLUMNS SWAPPED IS THE FAILURE THIS CAN ACTUALLY CATCH", () => {
  /* There is no futures column to check against, so the sign of the cash cell
     and cash - basis landing in the band are the structural guards available.
     Swapped on their real feed, every cash cell goes negative and the board is
     refused before the band is reached -- a bid of -0.65 is not a bid. */
  assert.throws(() => ex(edit(BADGER, (j) => {
    for (const b of j.bids) { const c = b.cashPrice; b.cashPrice = b.basis; b.basis = c; }
  })), (e) => e instanceof EmmertRefused && /cash is -0\.65/.test(e.message));

  /* And the band is what catches a swap that stays positive: a basis printed
     as +4.63 with 0.65 in the cash cell implies a futures of -3.98. */
  assert.throws(() => ex(edit(BADGER, (j) => {
    for (const b of j.bids) { b.basis = 4.63; b.cashPrice = 0.65; }
  })), (e) => e instanceof EmmertRefused && /implies -3\.98, outside corn 2-12/.test(e.message));
});

test("a decimal in the wrong place on one row drops that row, not the board", () => {
  const rows = ex(edit(BADGER, (j) => { j.bids[0].cashPrice = 46.3; }));
  assert.equal(rows.length, 10, "the other ten still publish");
  assert.ok(rows.unreconciled.some((u) => /implies 46\.95/.test(u)),
    `the refusal was not recorded: ${JSON.stringify(rows.unreconciled)}`);
});

test("a commodity with no band is refused, not guessed at", () => {
  assert.throws(() => ex(edit(BADGER, (j) => { for (const b of j.bids) b.commodity = "Sorghum"; })),
    /no futures band for "Sorghum"/);
});

test("a schema they have not published yet is not read with this one's assumptions", () => {
  assert.throws(() => ex(edit(BADGER, (j) => { j.schema = "emmert-cash-bids/3"; })),
    /this adapter reads emmert-cash-bids\/2/);
  assert.throws(() => ex(edit(BADGER, (j) => { j.schema = "emmert-cash-bids/1"; })),
    /this adapter reads emmert-cash-bids\/2/);
});

test("a page that is not the feed at all is refused plainly", () => {
  assert.throws(() => ex("<!doctype html><title>Badger Grain</title>"),
    /did not answer with JSON at all/);
  assert.throws(() => ex(edit(BADGER, (j) => { j.bids = []; })), /carries no bids/);
});

/* ── the manifests ──────────────────────────────────────────────────────── */

const IDS = ["badgergrain-wheeler", "midwestcommodity-baldwin"];

test("both manifests are valid, and declare the alternative the adapter stamps", () => {
  const seen = new Set();
  for (const id of IDS) {
    const s = source(id);
    assert.deepEqual(validateSource(s, seen), [], `${id} is not a valid manifest`);
    seen.add(s.id);
    assert.ok(PLATFORMS.includes(s.platform), `${s.platform} is not a known platform`);
    assert.ok(ADAPTERS[s.platform], `no adapter is registered for ${s.platform}`);
    /* THE DECLARATION AND THE STAMP MUST BE THE SAME STRING. buildFile refuses
       the board when they differ, and the message points at the manifest, so a
       typo here is a source that silently never publishes. */
    assert.equal(s.identityAlternative, VERIFIED_BY,
      `${id} declares "${s.identityAlternative}" and the adapter stamps "${VERIFIED_BY}"`);
    assert.equal(s.locationId, null, "one feed is one location; a null says that deliberately");
    assert.match(s.url, /^https:\/\/[a-z.]+\/bids\.json$/, `${id} does not read the feed`);
  }
});

test("EACH MANIFEST READS ITS OWN ELEVATOR'S HOST", () => {
  /* Two sources, two hosts, one adapter. Pointing both at one host is how two
     elevators end up publishing one elevator's prices, and nothing downstream
     could tell. */
  const hosts = IDS.map((id) => new URL(source(id).url).hostname);
  assert.equal(new Set(hosts).size, 2, `both sources read ${hosts[0]}`);
  assert.ok(hosts.includes("badgergrain.com") && hosts.includes("midwestcommodity.com"), hosts.join(", "));
});

test("a whole board is built from the real feed and passes every guard", () => {
  const now = CAPTURED;
  for (const [id, body] of [["badgergrain-wheeler", BADGER], ["midwestcommodity-baldwin", MIDWEST]]) {
    const s = source(id);
    const { file } = buildFile(body, {
      now, sourceUrl: s.url, source: toConfig(s),
      extract: (b, u) => extract(b, u, { now }),
    });
    assert.equal(file.status, "ok", `${id} did not publish`);
    assert.equal(file.count, 11, `${id} published ${file.count} rows`);
    assert.equal(file.source.name, s.operator);
    for (const b of file.bids) {
      assert.equal(b.futuresPriceCents, null, "a futures price reached the published file");
      assert.ok(b.cash > 0, "a row published without a price");
      assert.equal(typeof b.basisCents, "number");
    }
  }
});

test("and the same board with their status withdrawn publishes nothing at all", () => {
  const s = source("badgergrain-wheeler");
  assert.throws(() => buildFile(edit(BADGER, (j) => { j.status = "held"; }), {
    now: CAPTURED, sourceUrl: s.url, source: toConfig(s),
    extract: (b, u) => extract(b, u, { now: CAPTURED }),
  }), /withdrawn this price themselves/);
});

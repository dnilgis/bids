/*
 * ELEVATORS THAT POST THEIR OWN BASIS ON agsist.com.
 *
 * The feed is the agsist Worker's GET /elev/feed. It is not live yet, so the
 * fixtures follow the contract the Worker is being built to (one listing per
 * elevator, basis per crop and delivery period, bids_updated_at). Quotes are
 * pinned numbers in the shape the shared CBOT quote pages produce.
 *
 *     node --test test/agsist-portal.test.mjs
 *
 * No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract, parseFeed, deliveryLabel, chicagoDay, bidProblem, listingInfo,
         VERIFIED_BY, FEED_URL, PortalRefused } from "../lib/adapters/agsist-portal.mjs";
import { ADAPTERS, SHARED_PAGES, adapterFor } from "../lib/adapters/index.mjs";
import { PLATFORMS, wireOf, transportOf, loadSources, toConfig, validateSource } from "../lib/sources.mjs";
import { buildFile, isRefusal } from "../lib/board.mjs";
import { decide } from "../lib/decide.mjs";
import { quoteUrls } from "../lib/adapters/agricharts.mjs";
import { plan, sourceFor, registryMatch, existingPortalSources } from "../scripts/portal-sources.mjs";
import { shardOf } from "../scripts/merge_bids.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = (f) => readFileSync(`${ROOT}test/fixtures/agsist-portal/${f}`, "utf8");
const TWO = FX("feed-two.json"), ONE = FX("feed-one.json");
const MALFORMED = FX("feed-malformed.html"), WRONG = FX("feed-wrong-shape.json");

/* 10:00 in Ladoga on 2026-10-13. */
const NOW = Date.parse("2026-10-13T15:00:00Z");
const QUOTES = { ZCZ26: 423.25, ZCH27: 438.5, ZCU26: 410, ZSX26: 1012.75, ZWN27: 561 };
const shared = (over = {}, nowMs = NOW) => ({
  nowMs,
  contracts: Object.entries({ ...QUOTES, ...over }).map(([symbol, lastCents]) => ({
    symbol, lastCents, priced: lastCents != null, root: symbol.slice(0, 2), at: "10/13/26 9:58",
  })),
});
const REGISTRY = JSON.parse(readFileSync(`${ROOT}geocodes/places.json`, "utf8")).registry;
const listing = (body, id) => JSON.parse(body).elevators.find((e) => e.id === id);
const srcFor = (id, body = TWO) => sourceFor(listing(body, id), REGISTRY, NOW);
const build = (id, body = TWO, ctx = shared()) => {
  const s = srcFor(id);
  return buildFile(body, { now: new Date(NOW).toISOString(), sourceUrl: FEED_URL,
                           source: toConfig(s), extract: adapterFor("agsist-portal", ctx) });
};
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return null; };

/* ── the platform is wired ─────────────────────────────────────────────── */

test("agsist-portal is a platform with an adapter, read as JSON over a plain fetch, on the shared quote pages", () => {
  assert.ok(PLATFORMS.includes("agsist-portal"), "a platform missing from PLATFORMS is DROPPED at load");
  assert.equal(typeof ADAPTERS["agsist-portal"], "function");
  assert.equal(wireOf("agsist-portal"), "json");
  assert.equal(transportOf("agsist-portal"), "fetch");
  assert.deepEqual(SHARED_PAGES["agsist-portal"].urls, quoteUrls(),
    "the same seven quote pages, so the pass fetches them once for every platform");
});

/* ── a two-elevator feed ───────────────────────────────────────────────── */

test("a two-elevator feed: every current row of both listings, cash = CBOT quote + their basis", () => {
  const rows = extract(TWO, FEED_URL, shared());
  assert.deepEqual([...new Set(rows.map((r) => r.locationId))], ["bunge-ladoga-in", "test-grain-darlington-in"]);
  const b = rows.filter((r) => r.locationId === "bunge-ladoga-in");
  assert.equal(b.length, 5, "six rows posted, the September row has ended");
  const octnov = b.find((r) => r.commodity === "Corn" && r.delivery === "Oct/Nov");
  assert.equal(octnov.cash, 3.8825, "423.25c + (-35c) = 388.25c");
  assert.equal(octnov.basis, -0.35);
  assert.equal(octnov.basisCents, -35);
  assert.equal(octnov.futures, "ZCZ26");
  assert.equal(octnov.futuresPrice, null, "the quote is not republished");
  assert.equal(octnov.verifiedBy, VERIFIED_BY);
  assert.equal(octnov.postedAt, "2026-10-13T12:05:00.000Z");
  assert.equal(b.find((r) => r.commodity === "Soybeans").cash, 9.5775, "1012.75c - 55c");
  assert.equal(b.find((r) => r.commodity === "Wheat").cash, 5.01);
  assert.equal(b.find((r) => r.delivery.startsWith("Jan")).cash, 4.165);
});

test("a label that does not say its months gets them from the elevator's own dates", () => {
  const asOf = new Date(NOW).toISOString();
  assert.equal(deliveryLabel("Oct/Nov", "2026-10-01", "2026-11-30", asOf), "Oct/Nov");
  assert.equal(deliveryLabel("Harvest", "2026-10-01", "2026-10-31", asOf), "Harvest (Oct 2026)");
  assert.equal(deliveryLabel("Jan", "2027-01-01", "2027-01-31", asOf), "Jan",
    "a bare Jan in October reads as this coming January, which is what the dates say");
  assert.equal(deliveryLabel("Jan", "2028-01-01", "2028-01-31", asOf), "Jan 2028",
    "the year is added only when the words alone would read as other dates");
  assert.equal(deliveryLabel("Oct/Nov", "2027-10-01", "2027-11-30", asOf), "Oct/Nov 2027");
  assert.equal(deliveryLabel("Dec/Jan", "2026-12-01", "2027-01-31", asOf), "Dec/Jan");
  assert.equal(deliveryLabel("Late", "2026-12-01", "2027-01-31", asOf), "Late (Dec/Jan 26-27)");
  const rows = extract(TWO, FEED_URL, shared());
  assert.ok(rows.some((r) => r.delivery === "Harvest (Oct 2026)"));
});

test("each portal source publishes its own listing and nothing of the other's", () => {
  const a = build("bunge-ladoga-in");
  assert.equal(a.file.count, 5);
  assert.equal(a.file.source.locationId, "bunge-ladoga-in");
  assert.equal(a.file.source.contact.phone, "765-555-0142");
  assert.equal(a.file.source.contact.email, null);
  assert.equal(a.file.source.portal.hours, "Mon-Fri 7-5, Sat 7-12");
  assert.equal(a.file.source.portal.harvestHours, "7am-9pm through Nov 15");
  assert.equal(a.file.source.portal.contactName, "Wyatt");
  assert.equal(a.file.source.portal.note, "Dump closes at 8:30pm sharp during harvest.");
  assert.equal(a.postedAt, "2026-10-13T12:05:00.000Z");
  assert.equal(a.verified, 0, "cash - basis = futures is not claimed: it would pass by construction");
  for (const r of a.file.bids) assert.equal(r.futuresPriceCents, null);
  const d = build("test-grain-darlington-in");
  assert.equal(d.file.count, 2);
  assert.deepEqual(d.file.bids.map((r) => r.cash), [3.9325, 9.6275]);
  assert.equal(d.postedAt, "2026-10-12T20:30:00.000Z");
});

test("pricedAt is when the elevator posted, not when the futures under it moved", () => {
  const a = build("bunge-ladoga-in");
  const first = decide(null, a.file, { postedAt: a.postedAt });
  assert.equal(first.file.pricedAt, "2026-10-13T12:05:00.000Z");
  assert.equal(first.file.checkedAt, new Date(NOW).toISOString());
  /* Futures up two cents an hour later: cash moves, the posting time does not. */
  const later = buildFile(TWO, { now: new Date(NOW + 3600e3).toISOString(), sourceUrl: FEED_URL,
    source: toConfig(srcFor("bunge-ladoga-in")),
    extract: adapterFor("agsist-portal", shared({ ZCZ26: 425.25 }, NOW + 3600e3)) });
  const v = decide(first.file, later.file, { postedAt: later.postedAt });
  assert.equal(v.write, true);
  assert.equal(v.file.pricedAt, "2026-10-13T12:05:00.000Z");
  assert.equal(v.file.bids[0].cash, 3.9025);
  /* "No change today": same numbers, new posting time. Written, not a move. */
  const again = decide(v.file, { ...later.file, checkedAt: new Date(NOW + 3700e3).toISOString() },
                       { postedAt: "2026-10-14T12:00:00.000Z" });
  assert.equal(again.write, true);
  assert.equal(again.changed, false);
  assert.equal(again.file.pricedAt, new Date(NOW + 3700e3).toISOString(),
    "a posting time ahead of our own read is clamped to the read");
  const again2 = decide(v.file, { ...later.file, checkedAt: "2026-10-14T13:00:00.000Z" },
                        { postedAt: "2026-10-14T12:00:00.000Z" });
  assert.equal(again2.file.pricedAt, "2026-10-14T12:00:00.000Z");
});

test("a board without a posting clock keeps the old pricedAt rule", () => {
  const a = build("bunge-ladoga-in");
  const v = decide({ ...a.file, pricedAt: "2026-10-01T00:00:00Z", checkedAt: new Date(NOW - 60e3).toISOString() },
                   a.file);
  assert.equal(v.file.pricedAt, "2026-10-01T00:00:00Z");
});

/* ── an expired row, and a listing whose rows have all ended ───────────── */

test("a row whose delivery has ended is left out, by the elevator's own calendar", () => {
  const rows = extract(TWO, FEED_URL, shared());
  assert.ok(!rows.some((r) => r.futures === "ZCU26"), "Sep ended 2026-09-30");
  assert.equal(rows.expired.length, 1);
  /* 2026-10-01 at 04:30Z is still Sep 30 in Ladoga: the row is current. */
  const lateNight = extract(TWO, FEED_URL, shared({}, Date.parse("2026-10-01T04:30:00Z")));
  assert.ok(lateNight.some((r) => r.futures === "ZCU26"));
  assert.equal(chicagoDay(Date.parse("2026-10-01T04:30:00Z")), "2026-09-30");
  assert.equal(chicagoDay(Date.parse("2026-10-01T05:30:00Z")), "2026-10-01");
});

test("a listing in the feed with nothing current is an empty board, not a lost location", () => {
  const d = JSON.parse(TWO);
  d.elevators[1].bids = [{ crop: "corn", period: "Sep", start: "2026-09-01", end: "2026-09-30", futures: "ZCU26", basis: -0.3 }];
  const e = refusal(() => build("test-grain-darlington-in", JSON.stringify(d)));
  assert.ok(isRefusal(e));
  assert.equal(e.empty, true, "poll.mjs counts this as posting nothing and clears the streak");
  /* The other listing is untouched. */
  assert.equal(build("bunge-ladoga-in", JSON.stringify(d)).file.count, 5);
});

/* ── a closed-today elevator ───────────────────────────────────────────── */

test("closed today: the bids still publish and closedUntil travels with the listing", () => {
  const s = srcFor("test-grain-darlington-in");
  assert.equal(s.portal.closedUntil, "2026-10-14T04:59:59.999Z", "end of 2026-10-13 in America/Chicago");
  const d = build("test-grain-darlington-in");
  assert.equal(d.file.source.portal.closedUntil, "2026-10-14T04:59:59.999Z");
  /* The next day the stamp is in the past and the generator drops it. */
  const tomorrow = sourceFor(listing(TWO, "test-grain-darlington-in"), REGISTRY, Date.parse("2026-10-14T12:00:00Z"));
  assert.equal(tomorrow.portal.closedUntil, null);
  /* And on the shard the site reads. */
  const sh = shardOf("p", [{ operator: "Test Grain Co", city: "Darlington", state: "IN" }], null, s.phone, s.portal);
  assert.equal(sh.info.closedUntil, "2026-10-14T04:59:59.999Z");
  assert.equal(sh.info.hours, "Mon-Fri 7-4");
  assert.ok(!("info" in shardOf("p", [{ operator: "X" }])), "every other shard keeps its keys");
});

/* ── a malformed feed ──────────────────────────────────────────────────── */

test("a malformed feed is a refusal for every portal source, never a crash and never an empty board", () => {
  for (const body of [MALFORMED, WRONG, "", '{"ok":false,"error":"kv"}']) {
    const e = refusal(() => build("bunge-ladoga-in", body));
    assert.ok(e, `accepted ${body.slice(0, 40)}`);
    assert.ok(isRefusal(e), `${e.constructor.name}: ${e.message}`);
    assert.notEqual(e.empty, true, "a broken feed is not the elevator posting nothing");
  }
  assert.throws(() => parseFeed(MALFORMED), PortalRefused);
});

test("a malformed feed changes no source file", () => {
  const existing = new Map([["portal-bunge-ladoga-in", srcFor("bunge-ladoga-in")]]);
  for (const body of [MALFORMED, WRONG, ""]) {
    const p = plan(body, existing, REGISTRY, NOW);
    assert.equal(p.ok, false);
    assert.equal(p.write.size, 0);
  }
});

test("no CBOT quotes this pass: refused, nothing guessed", () => {
  const e = refusal(() => build("bunge-ladoga-in", TWO, { contracts: [], nowMs: NOW }));
  assert.ok(isRefusal(e));
  assert.match(e.message, /no CBOT quotes/);
});

test("a bad row is refused and named; the rest of the listing publishes", () => {
  const d = JSON.parse(TWO);
  d.elevators[0].bids.push({ crop: "corn", period: "Mar", start: "2027-03-01", end: "2027-03-31", futures: "ZSH27", basis: -0.3 });
  d.elevators[0].bids.push({ crop: "corn", period: "May", start: "2027-05-01", end: "2027-05-31", futures: "ZCK27", basis: -0.3 });
  d.elevators[0].bids.push({ crop: "corn", period: "Feb", start: "2027-02-01", end: "2027-02-28", futures: "ZCH27", basis: -4 });
  const a = build("bunge-ladoga-in", JSON.stringify(d));
  assert.equal(a.file.count, 5);
  const why = a.unreconciled.map((u) => u.why).join(" | ");
  assert.match(why, /priced off ZC, not ZS/);
  assert.match(why, /ZCK27 is not on this pass's CBOT quote pages/);
  assert.match(why, /outside -3\.\.2/);
  assert.equal(bidProblem({ crop: "corn", period: "x", start: "2026-02-30", end: "2026-03-01", futures: "ZCH26", basis: 0 }) !== null, true);
  assert.equal(bidProblem({ crop: "oats", period: "x", start: "2026-02-01", end: "2026-03-01", futures: "ZOH26", basis: 0 }) !== null, true);
  assert.equal(bidProblem({ crop: "corn", period: "x", start: "2026-02-01", end: "2026-03-01", futures: "ZCF26", basis: 0 }) !== null, true,
    "corn has no January contract");
  assert.equal(bidProblem({ crop: "corn", period: "x", start: "2026-02-01", end: "2026-03-01", futures: "ZCH26", basis: -0.355 }) !== null, true);
});

/* ── the source files, from the feed ───────────────────────────────────── */

test("a source file per listing, valid, placed by the listing, and Bunge Ladoga linked to its registry row", () => {
  const p = plan(TWO, new Map(), REGISTRY, NOW);
  assert.equal(p.ok, true);
  assert.deepEqual([...p.write.keys()].sort(), ["portal-bunge-ladoga-in", "portal-test-grain-darlington-in"]);
  const b = p.write.get("portal-bunge-ladoga-in");
  assert.deepEqual(validateSource(b), []);
  assert.equal(b.registryId, "reg:IN|bungeusagrainllc|ladoga");
  assert.equal(b.operator, "Bunge Ladoga",
    "the elevator's own name; the registry link (registryId) is what merges the grey pin");
  assert.equal(b.location, "Ladoga");
  assert.equal(b.zip, "47954");
  assert.deepEqual([b.lat, b.lon], [39.9132, -86.8031]);
  assert.equal(b.phone, "765-555-0142");
  assert.equal(b.email, null);
  assert.equal(b.url, FEED_URL);
  assert.equal(b.locationId, "bunge-ladoga-in");
  assert.equal(b.identityAlternative, VERIFIED_BY);
  assert.equal(b.country, "US");
  assert.equal(b.currency, "USD");
  assert.ok(!JSON.stringify(b).includes("@"), "no email anywhere in a source file");
  const t = p.write.get("portal-test-grain-darlington-in");
  assert.equal(t.registryId, null);
  assert.equal(t.operator, "Test Grain Co");
  const { sources, errors } = loadSources([...p.write.values()]);
  assert.deepEqual(errors, []);
  assert.equal(sources.length, 2);
});

test("the registry link wants one row, in that town, of that business", () => {
  assert.equal(registryMatch({ name: "Bunge Ladoga", town: "Ladoga", state: "IN" }, REGISTRY).id,
    "reg:IN|bungeusagrainllc|ladoga");
  assert.equal(registryMatch({ name: "Bunge", town: "Ladoga", state: "IL" }, REGISTRY).id, null);
  assert.equal(registryMatch({ name: "Co", town: "Ladoga", state: "IN" }, REGISTRY).id, null);
  const two = { a: { state: "IN", location: "Ladoga", operator: "Bunge North" },
                b: { state: "IN", location: "Ladoga", operator: "Bunge South" } };
  const r = registryMatch({ name: "Bunge", town: "Ladoga", state: "IN" }, two);
  assert.equal(r.id, null);
  assert.match(r.why, /2 registry rows/);
});

test("an unchanged feed writes nothing; an inactive listing (absent from the feed) is disabled; it comes back on its own", () => {
  const first = plan(TWO, new Map(), REGISTRY, NOW);
  const onDisk = new Map(first.write);
  assert.equal(plan(TWO, onDisk, REGISTRY, NOW).write.size, 0, "no churn on a feed that did not change");

  const gone = plan(ONE, onDisk, REGISTRY, NOW);
  const t = gone.write.get("portal-test-grain-darlington-in");
  assert.equal(t.enabled, false, "absent from the feed means inactive");
  assert.match(t.note, /no longer in the agsist portal feed/);
  const { sources } = loadSources([...new Map([...onDisk, ...gone.write]).values()]);
  assert.deepEqual(sources.map((s) => s.id), ["portal-bunge-ladoga-in"], "the poll stops reading it");

  const after = new Map([...onDisk, ...gone.write]);
  assert.equal(plan(ONE, after, REGISTRY, NOW).write.size, 0, "a disabled source is not rewritten every pass");
  const back = plan(TWO, after, REGISTRY, NOW).write.get("portal-test-grain-darlington-in");
  assert.equal(back.enabled, true);
});

test("the generator reads and writes only portal files", () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-"));
  try {
    writeFileSync(join(dir, "landus-adair.json"), JSON.stringify({ id: "landus-adair", platform: "landus" }));
    writeFileSync(join(dir, "portal-x.json"), JSON.stringify({ id: "portal-x", platform: "agsist-portal" }));
    writeFileSync(join(dir, "portal-bad.json"), "{");
    assert.deepEqual([...existingPortalSources(dir).keys()], ["portal-x"]);
    assert.deepEqual(readdirSync(dir).sort(), ["landus-adair.json", "portal-bad.json", "portal-x.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nothing private travels: listingInfo has no email even if a feed carried one", () => {
  const l = { ...listing(TWO, "bunge-ladoga-in"), email: "wyatt@example.com" };
  assert.ok(!JSON.stringify(listingInfo(l)).includes("example.com"));
  assert.ok(!JSON.stringify(sourceFor(l, REGISTRY, NOW)).includes("example.com"));
});

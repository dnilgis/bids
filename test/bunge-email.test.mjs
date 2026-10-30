/*
 * BUNGE'S MORNING CASH-BID EMAIL (Bunge at Ladoga, IN; "Haw Creek" to Bunge).
 *
 * Fixtures in test/fixtures/bunge-email/:
 *   plain-2026-10-14.txt     the plain-text body as Sig pasted it on 2026-10-14
 *   html-2026-10-14.html     the same bids as an HTML table (written for this:
 *                            Bunge's HTML part has not been captured yet)
 *   direct-2026-10-14.eml    multipart/alternative from noreply@mobile.bunge.us,
 *                            plain part quoted-printable, HTML part base64
 *   html-only-2026-10-14.eml the HTML part alone
 *   forwarded-2026-10-14.eml a hand forward: From is the subscriber, Bunge's
 *                            From is in the body
 * Every address in them is example.com except Bunge's sender.
 *
 *     node --test test/bunge-email.test.mjs
 *
 * No network: the IMAP tests run against a fake server on loopback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { parseEmail, htmlToText, bidDate, readDelivery, calendarContract, grainOf, checkContracts,
         snapshotOf, snapshotChanged, extract, previousBusinessDay, snapshotUrl, snapshotPath,
         BungeEmailRefused, SENDER } from "../lib/adapters/bunge-email.mjs";
import { ADAPTERS, SHARED_PAGES, adapterFor } from "../lib/adapters/index.mjs";
import { PLATFORMS, PLATFORM_TRANSPORT, wireOf, transportOf, validateSource, toConfig, localPathOf,
         loadSources, awaitingFirstFile } from "../lib/sources.mjs";
import { buildFile, isRefusal } from "../lib/board.mjs";
import { decide } from "../lib/decide.mjs";
import { quoteUrls } from "../lib/adapters/agricharts.mjs";
import { parseMessage, textOf, qpDecode, decodeWords } from "../lib/mime.mjs";
import { Imap, imapDate, quote } from "../lib/imap.mjs";
import { readMessage, bungeOrigin, run } from "../scripts/email-bids.mjs";
import { yardLosers, claimsOf } from "../lib/same-yard.mjs";
import { oneBoardPerYard, Tally } from "../scripts/merge_bids.mjs";
import { sourceFor } from "../scripts/portal-sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = (f) => readFileSync(join(ROOT, "test/fixtures/bunge-email", f));
const PLAIN = FX("plain-2026-10-14.txt").toString("utf8");
const HTML = FX("html-2026-10-14.html").toString("utf8");
const SOURCE = JSON.parse(readFileSync(join(ROOT, "sources/bunge-ladoga-email.json"), "utf8"));
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return null; };
/* 9:00 in Ladoga on Wednesday 2026-10-14. */
const NOW = Date.parse("2026-10-14T14:00:00Z");
const RECEIVED = "2026-10-14T11:02:17.000Z";
const snap = (over = {}) => ({ ...snapshotOf(parseEmail(PLAIN), RECEIVED), ...over });
/* Quotes at poll time: the market has moved since the email, the spreads have not. */
const QUOTES = { ZCZ26: 483.25, ZCH27: 497.25, ZSX26: 1291, ZSF27: 1307, ZSH27: 1315 };
const shared = (q = QUOTES, nowMs = NOW) => ({ nowMs,
  contracts: Object.entries(q).map(([symbol, lastCents]) => ({ symbol, lastCents, priced: true, root: symbol.slice(0, 2) })) });

const WANT = [
  ["Yellow Corn", "Fall 2026", 4.36, -0.45, 4.81, "ZCZ26"],
  ["Yellow Corn", "December 2026", 4.61, -0.2, 4.81, "ZCZ26"],
  ["Yellow Corn", "January 2027", 4.75, -0.2, 4.95, "ZCH27"],
  ["Yellow Corn", "February 2027", 4.78, -0.17, 4.95, "ZCH27"],
  ["Yellow Corn", "March 2027", 4.81, -0.14, 4.95, "ZCH27"],
  ["Soybeans", "Fall 2026", 12.33, -0.55, 12.88, "ZSX26"],
  ["Soybeans", "Dec 2026", 12.72, -0.32, 13.04, "ZSF27"],
  ["Soybeans", "January 2027", 12.79, -0.25, 13.04, "ZSF27"],
  ["Soybeans", "February 2027", 12.82, -0.3, 13.12, "ZSH27"],
  ["Soybeans", "March 2027", 12.87, -0.25, 13.12, "ZSH27"],
];
const asRows = (bids) => bids.map((b) => [b.commodity, b.delivery, b.cash, b.basis, b.futures, b.contract]);

/* ── the email ─────────────────────────────────────────────────────────── */

test("the plain-text email: Haw Creek is Bunge Ladoga, dated 2026-10-14, ten rows on the contracts the calendar names", () => {
  const p = parseEmail(PLAIN);
  assert.deepEqual([p.location, p.listingId, p.town, p.state, p.asOf, p.hours, p.phone],
    ["Haw Creek", "bunge-ladoga-in", "Ladoga", "IN", "2026-10-14", "08:00 - 16:30", "7659467000"]);
  assert.deepEqual(asRows(p.bids), WANT);
});

test("every row proves itself: bid = futures + basis, to the cent", () => {
  for (const b of parseEmail(PLAIN).bids)
    assert.equal(Math.round(b.futures * 100) + Math.round(b.basis * 100), Math.round(b.cash * 100), `${b.commodity} ${b.delivery}`);
});

test("a row that does not balance refuses the WHOLE email, naming the row", () => {
  const e = refusal(() => parseEmail(PLAIN.replace("December \"26\t4.61", "December \"26\t4.66")));
  assert.ok(e instanceof BungeEmailRefused);
  assert.match(e.message, /Yellow Corn December 2026: bid 4\.66 is not futures 4\.81 \+ basis -0\.2/);
  assert.match(e.message, /nothing from this email is written/);
});

test("the HTML-table version reads to exactly the same bids as the plain text", () => {
  const p = parseEmail(HTML, { html: true });
  assert.deepEqual(asRows(p.bids), WANT);
  assert.equal(p.asOf, "2026-10-14");
  assert.match(htmlToText(HTML), /^Fall "26\t4\.36\t-0\.45\t4\.81$/m, "a table row is one line, cells split by tabs");
});

test("a layout change is refused, not half-read", () => {
  const cases = {
    "columns reordered": [PLAIN.replace(/Delivery\tBid\tBasis\tFutures/g, "Delivery\tBasis\tBid\tFutures"), /Delivery Bid Basis Futures|neither a bid row/],
    "a fifth column": [PLAIN.replace("Fall \"26\t4.36\t-0.45\t4.81", "Fall \"26\t4.36\t-0.45\t4.81\t+0.02"), /neither a bid row/],
    "a commodity it does not know": [PLAIN.replace("Soybeans\n", "Sunflowers\n"), /neither a bid row nor a grain heading: "Sunflowers"/],
    "no See Bid Details": [PLAIN.replace("See Bid Details", ""), /See Bid Details|neither a bid row/],
    "no date line": [PLAIN.replace("Cash bids for Wednesday,October 14 2026\n", ""), /date/],
    "a weekday that is not that date": [PLAIN.replace("Wednesday,October 14", "Thursday,October 14"), /does not read as a date/],
    "another location": [PLAIN.replace("Cash Bids for Haw Creek", "Cash Bids for Roachdale"), /"Roachdale", which is not a location/],
    "a heading with no rows": [PLAIN.replace(/Soybeans\nDelivery\tBid\tBasis\tFutures\n[\s\S]*?See Bid Details/, "Soybeans\nDelivery\tBid\tBasis\tFutures\nSee Bid Details"), /"Soybeans" has a heading and no bid rows/],
    "not a bid email": ["Your Bunge account statement is ready.", /no "Cash Bids for <location>" heading/],
  };
  for (const [name, [body, rx]] of Object.entries(cases)) {
    const e = refusal(() => parseEmail(body));
    assert.ok(e instanceof BungeEmailRefused, `${name}: not refused`);
    assert.match(e.message, rx, name);
  }
});

test("an error never quotes an address out of the email", () => {
  const e = refusal(() => parseEmail(PLAIN.replace("Soybeans\n", "Questions? write sig@example.com\n")));
  assert.ok(e instanceof BungeEmailRefused);
  assert.doesNotMatch(e.message, /@example\.com/);
  assert.match(e.message, /<address>/);
});

test("dates and delivery labels: Bunge's spellings", () => {
  assert.equal(bidDate("Wednesday,October 14 2026"), "2026-10-14");
  assert.equal(bidDate("Friday, October 16, 2026"), "2026-10-16");
  assert.equal(bidDate("Wednesday,October 15 2026"), null, "Oct 15 2026 is a Thursday");
  assert.equal(bidDate("October 32 2026"), null);
  assert.deepEqual(readDelivery('Dec "26'), { label: "Dec 2026", words: "Dec", year: 2026, startMonth: 12 });
  assert.equal(readDelivery("January ”27").label, "January 2027", "a curly quote is a quote");
  assert.equal(readDelivery("Fall 2026").startMonth, 10);
  assert.equal(readDelivery("Spot"), null, "no year, no label");
});

test("the calendar's contract: the first month of the root on or after the period starts", () => {
  const corn = grainOf("Yellow Corn"), beans = grainOf("Soybeans"), wheat = grainOf("SRW Wheat");
  assert.equal(calendarContract(corn, 2026, 10), "ZCZ26");
  assert.equal(calendarContract(corn, 2026, 12), "ZCZ26");
  assert.equal(calendarContract(corn, 2027, 1), "ZCH27");
  assert.equal(calendarContract(beans, 2026, 12), "ZSF27", "no December beans: January's contract");
  assert.equal(calendarContract(beans, 2027, 6), "ZSN27");
  assert.equal(calendarContract(wheat, 2027, 6), "ZWN27");
  assert.equal(calendarContract(corn, 2026, null), null);
});

/* ── the contract, checked ─────────────────────────────────────────────── */

test("the email agrees with itself and with the quoted spreads: every symbol kept", () => {
  const p = parseEmail(PLAIN);
  const r = checkContracts(p.bids, shared().contracts);
  assert.deepEqual(r.symbols, WANT.map((w) => w[5]));
  assert.deepEqual(r.notes, []);
});

test("ambiguous: one contract printed at two prices keeps the rows and the price, and drops the symbol", () => {
  const p = parseEmail(PLAIN.replace('January "27\t4.75\t-0.20\t4.95', 'January "27\t4.77\t-0.20\t4.97'));
  const r = checkContracts(p.bids);
  assert.deepEqual(r.symbols.slice(0, 5), [null, null, null, null, null]);
  assert.deepEqual(r.symbols.slice(5), WANT.slice(5).map((w) => w[5]), "the beans are untouched");
  assert.match(r.notes[0], /ZCH27 is printed at both 497c and 495c/);
});

test("ambiguous: two contracts printed at one price lose their symbols", () => {
  const p = parseEmail(PLAIN.replace(/12\.88/g, "13.04").replace("Fall \"26\t12.33\t-0.55", "Fall \"26\t12.49\t-0.55"));
  const r = checkContracts(p.bids);
  assert.deepEqual(r.symbols.slice(5), [null, null, null, null, null]);
  assert.match(r.notes[0], /ZSX26 and ZSF27 are both printed at 1304c/);
});

test("ambiguous: spreads that do not match the quotes lose the grain's symbols; the market moving does not", () => {
  const p = parseEmail(PLAIN);
  /* Everything 30c higher than the email: the market moved, spreads the same. */
  const moved = Object.fromEntries(Object.entries(QUOTES).map(([k, v]) => [k, v + 30]));
  assert.deepEqual(checkContracts(p.bids, shared(moved).contracts).notes, []);
  /* Corn's H27 quoted 20c further from Z26 than the email's 14c spread: one of them is not the contract named. */
  const r = checkContracts(p.bids, shared({ ...QUOTES, ZCH27: 517.25 }).contracts);
  assert.deepEqual(r.symbols.slice(0, 5), [null, null, null, null, null]);
  assert.deepEqual(r.symbols.slice(5), WANT.slice(5).map((w) => w[5]));
  assert.match(r.notes[0], /^ZC: the email's spreads do not match the quotes/);
});

/* ── the snapshot and the adapter ──────────────────────────────────────── */

test("the snapshot holds the parsed rows, the date and when Bunge sent it, and nothing else", () => {
  const s = snap();
  assert.deepEqual(Object.keys(s), ["schema", "listingId", "bungeLocation", "town", "state", "asOf", "receivedAt", "hours", "phone", "bids"]);
  assert.deepEqual(Object.keys(s.bids[0]), ["commodity", "delivery", "cash", "basis", "futures", "contract"]);
  assert.equal(snapshotChanged(s, snap({ receivedAt: "2026-10-14T11:30:00.000Z" })), false, "the same email twice is not a change");
  assert.equal(snapshotChanged(s, snap({ asOf: "2026-10-15" })), true, "a new day with the same bids is");
  assert.equal(snapshotChanged(s, snap({ bids: s.bids.slice(1) })), true);
  assert.equal(snapshotChanged(null, s), true);
});

test("the adapter: rows in cents with the symbol, priced when Bunge sent the email", () => {
  const rows = extract(JSON.stringify(snap()), snapshotUrl("bunge-ladoga-in"), shared());
  assert.equal(rows.length, 10);
  const a = rows[0];
  assert.deepEqual([a.location, a.locationId, a.commodity, a.delivery, a.cash, a.basis, a.basisCents, a.futures, a.futuresPrice, a.postedAt],
    ["Bunge Ladoga", "bunge-ladoga-in", "Yellow Corn", "Fall 2026", 4.36, -0.45, -45, "ZCZ26", 481, RECEIVED]);
  assert.ok(rows.every((r) => Math.abs(r.futuresPrice + r.basisCents - r.cash * 100) < 1e-6));
});

test("without the quotes (their pages down) the rows still publish, on the calendar's contracts", () => {
  const rows = extract(JSON.stringify(snap()), "", { nowMs: NOW });
  assert.deepEqual(rows.map((r) => r.futures), WANT.map((w) => w[5]));
});

test("STALE: only the email's own day, or the business day after it, is published", () => {
  const body = (asOf) => JSON.stringify(snap({ asOf }));
  const at = (iso) => ({ nowMs: Date.parse(iso) });
  assert.equal(extract(body("2026-10-14"), "", at("2026-10-14T14:00:00Z")).length, 10, "today");
  assert.equal(extract(body("2026-10-13"), "", at("2026-10-14T11:00:00Z")).length, 10, "this morning, before today's email");
  assert.equal(extract(body("2026-10-16"), "", at("2026-10-19T12:00:00Z")).length, 10, "Friday's on Monday morning");
  assert.equal(extract(body("2026-10-16"), "", at("2026-10-18T12:00:00Z")).length, 10, "Friday's on Sunday");
  const e = refusal(() => extract(body("2026-10-12"), "", at("2026-10-14T14:00:00Z")));
  assert.ok(e instanceof BungeEmailRefused && isRefusal(e));
  assert.match(e.message, /^STALE: the newest Bunge email is for 2026-10-12 and today is 2026-10-14/);
  assert.match(refusal(() => extract(body("2026-10-15"), "", at("2026-10-14T14:00:00Z"))).message, /after today/);
  assert.equal(previousBusinessDay("2026-10-19"), "2026-10-16");
  /* 01:00 UTC on the 15th is still the 14th in Ladoga. */
  assert.equal(extract(body("2026-10-13"), "", at("2026-10-15T01:00:00Z")).length, 10);
});

test("a snapshot that is not one is refused", () => {
  for (const [body, rx] of [["nope", /not JSON/], [JSON.stringify({ schema: "x" }), /not bunge-email\/1/],
    [JSON.stringify({ ...snap(), bids: [] }), /no bids/], [JSON.stringify({ ...snap(), receivedAt: "x" }), /receivedAt/]])
    assert.match(refusal(() => extract(body, "", { nowMs: NOW })).message, rx);
  const tampered = snap(); tampered.bids[0].cash = 4.4;
  assert.match(refusal(() => extract(JSON.stringify(tampered), "", { nowMs: NOW })).message, /bid 4\.4 is not futures 4\.81/);
});

test("END TO END: the shipped source, through the real guards, publishes ten verified rows priced at the email", () => {
  const now = new Date(NOW).toISOString();
  const built = buildFile(JSON.stringify(snap()), { now, sourceUrl: SOURCE.url, source: toConfig(SOURCE),
    extract: adapterFor("bunge-email", shared()) });
  assert.equal(built.file.count, 10);
  assert.equal(built.verified, 10, "cash - basis = futures ran on every row");
  assert.equal(built.postedAt, RECEIVED);
  assert.deepEqual(built.withheld, []);
  assert.equal(built.file.currency, "USD");
  assert.deepEqual(built.file.bids.slice(0, 2).map((b) => [b.delivery, b.futuresMonth, b.futuresPriceCents, b.basisCents]),
    [["Fall 2026", "ZCZ26", 481, -45], ["December 2026", "ZCZ26", 481, -20]]);
  const v = decide(null, built.file, { postedAt: built.postedAt });
  assert.equal(v.file.pricedAt, RECEIVED, "the price is as old as the email, not as old as the read");
});

/* ── the platform and the source ───────────────────────────────────────── */

test("bunge-email is a platform with an adapter, JSON, read from the checkout, on the shared quote pages", () => {
  assert.ok(PLATFORMS.includes("bunge-email"));
  assert.equal(typeof ADAPTERS["bunge-email"], "function");
  assert.equal(wireOf("bunge-email"), "json");
  assert.equal(transportOf("bunge-email"), "fetch", "not a browser platform");
  assert.ok(!("bunge-email" in PLATFORM_TRANSPORT));
  assert.deepEqual(SHARED_PAGES["bunge-email"].urls, quoteUrls());
});

test("the shipped source is valid, enabled, and reads data/email/bunge-ladoga-in.json and nothing else", () => {
  assert.deepEqual(validateSource(SOURCE), []);
  assert.equal(loadSources([SOURCE]).sources.length, 1);
  assert.equal(SOURCE.url, snapshotUrl("bunge-ladoga-in"));
  assert.equal(localPathOf(SOURCE), snapshotPath("bunge-ladoga-in"));
  for (const url of ["https://raw.githubusercontent.com/dnilgis/bids/main/sources/x.json",
                     "https://raw.githubusercontent.com/dnilgis/bids/main/data/email/../index.json",
                     "https://raw.githubusercontent.com/dnilgis/bids/main/data/email/a/b.json",
                     "https://example.com/data/email/bunge-ladoga-in.json"]) {
    assert.equal(localPathOf({ ...SOURCE, url }), null, url);
    assert.ok(validateSource({ ...SOURCE, url }).some((m) => /reads a file this repository writes/.test(m)), url);
  }
  assert.equal(localPathOf({ ...SOURCE, platform: "bungeag" }), null, "only a local platform reads the checkout");
});

test("ONE BUNGE LADOGA: the email source claims exactly what the portal listing's source claims", () => {
  const feed = JSON.parse(readFileSync(join(ROOT, "test/fixtures/agsist-portal/feed-one.json"), "utf8"));
  const registry = JSON.parse(readFileSync(join(ROOT, "geocodes/places.json"), "utf8")).registry;
  const portal = sourceFor(feed.elevators.find((e) => e.id === "bunge-ladoga-in"), registry, NOW);
  assert.equal(SOURCE.locationId, portal.locationId);
  assert.equal(SOURCE.operator, portal.operator);
  assert.equal(SOURCE.location, portal.location);
  assert.equal(SOURCE.state, portal.state);
  assert.deepEqual(claimsOf(SOURCE), claimsOf(portal), "the same licence row, so one grey pin is replaced and one yard is drawn");
  assert.deepEqual(claimsOf(SOURCE), ["reg:IN|bungeusagrainllc|ladoga"]);
});

test("one yard, one board: the newer posting speaks, an unpriced source never wins, other yards are untouched", () => {
  const R = "reg:IN|bungeusagrainllc|ladoga";
  const portal = { id: "portal-bunge-ladoga-in", registryId: R };
  const email = { id: "bunge-ladoga-email", registryId: R };
  assert.deepEqual([...yardLosers([{ ...portal, pricedAt: "2026-10-14T15:00:00Z" }, { ...email, pricedAt: RECEIVED }])],
    [["bunge-ladoga-email", "portal-bunge-ladoga-in"]], "posted at 10am outranks the 6am email");
  assert.deepEqual([...yardLosers([{ ...portal, pricedAt: "2026-10-13T15:00:00Z" }, { ...email, pricedAt: RECEIVED }])],
    [["portal-bunge-ladoga-in", "bunge-ladoga-email"]], "this morning's email outranks yesterday's posting");
  assert.deepEqual([...yardLosers([{ ...portal, pricedAt: null }, { ...email, pricedAt: RECEIVED }])],
    [["portal-bunge-ladoga-in", "bunge-ladoga-email"]]);
  assert.equal(yardLosers([{ id: "a", registryId: ["r1", "r2"], pricedAt: RECEIVED },
    { id: "b", registryId: "r3", pricedAt: RECEIVED }, { id: "c", pricedAt: RECEIVED }]).size, 0);
  /* A chain: a and b share r1, b and c share r2. One yard. */
  const chain = yardLosers([{ id: "a", registryId: "r1", pricedAt: "2026-10-01T00:00:00Z" },
    { id: "b", registryId: ["r1", "r2"], pricedAt: "2026-10-02T00:00:00Z" }, { id: "c", registryId: "r2", pricedAt: "2026-10-03T00:00:00Z" }]);
  assert.deepEqual([...chain].sort(), [["a", "c"], ["b", "c"]]);
});

test("the merge sets the older board's rows aside and counts them; the map draws one pin", () => {
  const R = "reg:IN|bungeusagrainllc|ladoga";
  const files = new Map([["portal-bunge-ladoga-in", { registryId: R }], ["bunge-ladoga-email", { registryId: R }],
    ["acme-thorp", {}]]);
  const rows = [
    { source: "portal-bunge-ladoga-in", pricedAt: "2026-10-13T15:00:00Z", cash: 4.46 },
    { source: "bunge-ladoga-email", pricedAt: RECEIVED, cash: 4.36 },
    { source: "bunge-ladoga-email", pricedAt: RECEIVED, cash: 4.61 },
    { source: "acme-thorp", pricedAt: "2026-10-01T00:00:00Z", cash: 4.0 },
  ];
  const tally = new Tally();
  const kept = oneBoardPerYard(rows, files, tally);
  assert.deepEqual(kept.map((r) => r.source), ["bunge-ladoga-email", "bunge-ladoga-email", "acme-thorp"]);
  assert.equal(tally.total, 1);
  assert.match(Object.keys(tally.n)[0], /same yard as a source that posted more recently/);
  const dir = readFileSync(join(ROOT, "scripts/build_directory.mjs"), "utf8");
  assert.match(dir, /import \{ yardLosers \} from "\.\.\/lib\/same-yard\.mjs"/);
  assert.match(dir, /yardGone\.has\(elevators\[i\]\.id\)\) elevators\.splice\(i, 1\)/);
  assert.match(readFileSync(join(ROOT, "scripts/merge_bids.mjs"), "utf8"), /return oneBoardPerYard\(out, files, tally\);/);
});

test("the poller reads a local platform's file from the checkout, and skips (not fails) before the first email", () => {
  const poll = readFileSync(join(ROOT, "scripts/poll.mjs"), "utf8");
  const at = poll.indexOf("const local = localPathOf(s);");
  assert.ok(at > 0 && at < poll.indexOf("const pace = paceOf(s.platform);"), "the local read comes before any network");
  assert.match(poll.slice(at, at + 700), /throw new Skipped\(`not attempted: \$\{local\} has not been written yet/);
  assert.match(poll.slice(at, at + 700), /readFileSync\(join\(ROOT, local\), "utf8"\), url: s\.url/);
});

/* ── the message: direct, HTML only, forwarded ─────────────────────────── */

test("MIME: quoted-printable, base64 and encoded words", () => {
  assert.equal(Buffer.from(qpDecode("Fall =2226=09x=\r\ny")).toString(), 'Fall "26\txy');
  assert.equal(decodeWords("=?UTF-8?Q?Cash_Bids_for_Haw_Creek?="), "Cash Bids for Haw Creek");
  const m = parseMessage(FX("direct-2026-10-14.eml"));
  const t = textOf(m);
  assert.equal(t.text.replace(/\r\n/g, "\n").trim(), PLAIN.trim());
  assert.equal(t.html, HTML);
});

test("the email straight from Bunge: plain part read, sent time from its Date", () => {
  const r = readMessage(FX("direct-2026-10-14.eml"));
  assert.equal(r.origin, "direct");
  assert.equal(r.receivedAt, RECEIVED);
  assert.deepEqual(asRows(r.parsed.bids), WANT);
});

test("an email with only an HTML table reads the table", () => {
  const r = readMessage(FX("html-only-2026-10-14.eml"));
  assert.equal(r.origin, "direct");
  assert.deepEqual(asRows(r.parsed.bids), WANT);
});

test("a forwarded copy: Bunge's From in the body, or the original attached, reads the same bids", () => {
  const r = readMessage(FX("forwarded-2026-10-14.eml"));
  assert.equal(r.origin, "forwarded");
  assert.deepEqual(asRows(r.parsed.bids), WANT);
  /* Forwarded as an attachment: the attached message's own Date is when Bunge sent it. */
  const inner = FX("direct-2026-10-14.eml").toString("latin1");
  const outer = ["From: Subscriber <subscriber@example.com>", "To: bids-inbox@example.com", "Date: Wed, 14 Oct 2026 12:30:00 +0000",
    "Subject: Fwd: Cash Bids for Haw Creek", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="mixx"', "",
    "--mixx", "Content-Type: text/plain; charset=UTF-8", "", "see attached", "--mixx",
    "Content-Type: message/rfc822", "Content-Disposition: attachment", "", inner, "--mixx--", ""].join("\r\n");
  const a = readMessage(Buffer.from(outer, "latin1"));
  assert.equal(a.origin, "forwarded");
  assert.equal(a.receivedAt, RECEIVED);
  assert.deepEqual(asRows(a.parsed.bids), WANT);
});

test("not Bunge's, not a bid email, or failing DMARC: left alone", () => {
  const other = "From: Google <no-reply@accounts.example.com>\r\nSubject: Security alert\r\n\r\nCash bids for nothing\r\n";
  assert.deepEqual(readMessage(Buffer.from(other)), { skip: "not from Bunge" });
  const notice = "From: Bunge <noreply@mobile.bunge.us>\r\nSubject: Contract confirmation\r\n\r\nYour contract is ready.\r\n";
  assert.deepEqual(readMessage(Buffer.from(notice)), { skip: "a Bunge message that is not a cash-bid notice" });
  const spoof = FX("direct-2026-10-14.eml").toString("latin1").replace("dmarc=pass", "dmarc=fail");
  assert.deepEqual(readMessage(Buffer.from(spoof, "latin1")), { skip: "claims to be from Bunge and fails DMARC" });
  assert.equal(bungeOrigin(parseMessage(Buffer.from(other))), null);
});

/* ── the job: a fake IMAP server on loopback ───────────────────────────── */

function fakeImap(messages, { user = "inbox@example.com", pass = "abcd efgh ijkl mnop" } = {}) {
  const log = { commands: [], seen: new Set(), logins: 0 };
  const server = net.createServer((sock) => {
    sock.write("* OK fake ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let nl;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ");
        log.commands.push(/^LOGIN/i.test(cmd) ? "LOGIN ***" : cmd);
        if (/^LOGIN /i.test(cmd)) {
          log.logins++;
          sock.write(cmd === `LOGIN ${quote(user)} ${quote(pass)}` ? `${tag} OK logged in\r\n`
            : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        } else if (/^SELECT/i.test(cmd)) sock.write(`* ${messages.length} EXISTS\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (/^UID SEARCH/i.test(cmd)) sock.write(`* SEARCH ${messages.map((_, i) => i + 1).join(" ")}\r\n${tag} OK done\r\n`);
        else if (/^UID FETCH (\d+)/i.test(cmd)) {
          const uid = Number(/^UID FETCH (\d+)/i.exec(cmd)[1]);
          const raw = Buffer.from(messages[uid - 1]);
          sock.write(Buffer.concat([Buffer.from(`* ${uid} FETCH (UID ${uid} INTERNALDATE "14-Oct-2026 11:02:20 +0000" BODY[] {${raw.length}}\r\n`),
            raw, Buffer.from(`)\r\n${tag} OK fetched\r\n`)]));
        } else if (/^UID STORE (\d+) \+FLAGS \(\\Seen\)/i.test(cmd)) {
          const uid = Number(/^UID STORE (\d+)/i.exec(cmd)[1]);
          log.seen.add(uid);
          sock.write(`* ${uid} FETCH (UID ${uid} FLAGS (\\Seen))\r\n${tag} OK stored\r\n`);
        } else if (/^LOGOUT/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, log, port: server.address().port })));
}

async function job(messages, { env = {}, root, nowMs = NOW } = {}) {
  const f = await fakeImap(messages);
  const out = [], err = [];
  try {
    const code = await run({
      env: { BIDS_IMAP_USER: "inbox@example.com", BIDS_IMAP_PASSWORD: "abcd efgh ijkl mnop", ...env },
      root, nowMs,
      connect: () => new Promise((res) => { const s = net.connect(f.port, "127.0.0.1", () => res(new Imap(s, { timeoutMs: 5000 }))); }),
      log: (l) => out.push(l), error: (l) => err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n"), log: f.log };
  } finally { f.server.close(); }
}

const tmpRoot = () => mkdtempSync(join(tmpdir(), "bunge-email-"));
const OTHER = "From: Google <no-reply@accounts.example.com>\r\nSubject: hello\r\n\r\nWelcome\r\n";

test("NOT SET UP: no secrets, one line, exit 0, no connection made", async () => {
  const out = [];
  let connected = false;
  for (const env of [{}, { BIDS_IMAP_USER: "x@example.com" }, { BIDS_IMAP_PASSWORD: "p" }, { BIDS_IMAP_USER: " ", BIDS_IMAP_PASSWORD: "p" }]) {
    const code = await run({ env, root: tmpRoot(), connect: () => { connected = true; }, log: (l) => out.push(l), error: (l) => out.push(l) });
    assert.equal(code, 0);
  }
  assert.equal(connected, false);
  assert.deepEqual([...new Set(out)], ["email bids: not set up yet"]);
});

test("the job writes the snapshot, marks the emails it read seen, and leaves everything else unread", async () => {
  const root = tmpRoot();
  try {
    const r = await job([OTHER, FX("forwarded-2026-10-14.eml"), FX("direct-2026-10-14.eml")], { root });
    assert.equal(r.code, 0, r.err);
    const file = join(root, "data/email/bunge-ladoga-in.json");
    const s = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(s.asOf, "2026-10-14");
    assert.equal(s.receivedAt, "2026-10-14T11:05:40.000Z", "two copies of one day: the later-sent one is kept");
    assert.deepEqual(asRows(s.bids), WANT);
    assert.deepEqual([...r.log.seen].sort(), [2, 3], "the unrelated message stays unread");
    assert.ok(r.log.commands.some((c) => /^UID SEARCH OR UNSEEN SINCE 12-Oct-2026$/.test(c)), r.log.commands.join(" | "));
    assert.ok(r.log.commands.every((c) => !/BODY\[\]/.test(c) || /BODY\.PEEK\[\]/.test(c)), "reading must not mark seen");
    assert.match(r.out, /wrote data\/email\/bunge-ladoga-in\.json \(10 rows\)/);
    assert.match(r.out, /Yellow Corn {2}Fall 2026 +bid {3}4\.36 {2}basis -0\.45 {2}futures {3}4\.81 ZCZ26/);
    /* Nothing private in the log: no address, no password, no header. */
    const all = r.out + r.err;
    assert.doesNotMatch(all, /@/);
    assert.doesNotMatch(all, /abcd efgh/);
    assert.doesNotMatch(all, /Subject|Forwarded message|Received|Authentication-Results/i);

    /* The same email again: nothing changes, nothing written. */
    const before = readFileSync(file, "utf8");
    const again = await job([FX("direct-2026-10-14.eml")], { root });
    assert.equal(again.code, 0);
    assert.match(again.out, /no change/);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an older email does not replace a newer snapshot", async () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, "data/email"), { recursive: true });
    const newer = snap({ asOf: "2026-10-15" });
    writeFileSync(join(root, "data/email/bunge-ladoga-in.json"), JSON.stringify(newer));
    const r = await job([FX("direct-2026-10-14.eml")], { root });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(readFileSync(join(root, "data/email/bunge-ladoga-in.json"), "utf8")).asOf, "2026-10-15");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("LAYOUT CHANGED: nothing written, nothing marked seen, exit 1 with the reason", async () => {
  const root = tmpRoot();
  try {
    /* Plain text only, so there is no HTML part to fall back on. (With both
       parts, a plain part that will not read is retried as the HTML table.) */
    const broken = FX("forwarded-2026-10-14.eml").toString("latin1")
      .replace("Delivery=09Bid=09Basis=09Futures", "Delivery=09Basis=09Bid=09Futures");
    assert.notEqual(broken, FX("forwarded-2026-10-14.eml").toString("latin1"));
    const r = await job([FX("direct-2026-10-14.eml"), Buffer.from(broken, "latin1")], { root });
    assert.equal(r.code, 1);
    assert.match(r.err, /::error title=email bids: Bunge's email did not read::/);
    assert.match(r.err, /Nothing was written/);
    assert.equal(existsSync(join(root, "data/email")), false);
    assert.equal(r.log.seen.size, 0, "a refused email stays unread for the next run");
    assert.doesNotMatch(r.out + r.err, /@/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a refused login is exit 1 and never echoes the password", async () => {
  const root = tmpRoot();
  try {
    const r = await job([FX("direct-2026-10-14.eml")], { root, env: { BIDS_IMAP_PASSWORD: "wrong-secret-value" } });
    assert.equal(r.code, 1);
    assert.match(r.err, /could not open the mailbox: LOGIN was refused: \[AUTHENTICATIONFAILED\]/);
    assert.doesNotMatch(r.err + r.out, /wrong-secret-value|@/);
    assert.equal(existsSync(join(root, "data/email")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("IMAP dates and quoting", () => {
  assert.equal(imapDate(Date.parse("2026-10-12T05:00:00Z")), "12-Oct-2026");
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(SENDER, "noreply@mobile.bunge.us");
});

/* ── the workflow ──────────────────────────────────────────────────────── */

test("email-bids.yml: the secrets, a morning window, a hand button, chained to the reader, and the shared push", () => {
  const y = readFileSync(join(ROOT, ".github/workflows/email-bids.yml"), "utf8");
  assert.match(y, /BIDS_IMAP_USER: \$\{\{ secrets\.BIDS_IMAP_USER \}\}/);
  assert.match(y, /BIDS_IMAP_PASSWORD: \$\{\{ secrets\.BIDS_IMAP_PASSWORD \}\}/);
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /cron: "4,19,34,49 11-18 \* \* \*"/);
  assert.match(y, /workflow_run:\n\s+workflows: \["read boyceville"\]/);
  assert.match(readFileSync(join(ROOT, ".github/workflows/poll.yml"), "utf8"), /^name: read boyceville$/m,
    "the chain names the reader by its workflow name");
  assert.match(y, /node scripts\/email-bids\.mjs/);
  assert.match(y, /bash scripts\/commit-and-push\.sh/);
  assert.match(y, /timeout-minutes: \d+/);
});

/* ── NOT ACTIVE UNTIL THE FIRST SNAPSHOT EXISTS ────────────────────────────
   Before the mailbox is set up there is no snapshot, and the email source must
   leave nothing public: no red "down" pin on Bunge Ladoga, no claim on its
   grey licence pin. Once a snapshot has been written it is an ordinary source. */

test("awaitingFirstFile: a local source with no file yet is not active; with one it is; nothing else is affected", () => {
  const seen = [];
  const none = (p) => { seen.push(p); return false; };
  assert.equal(awaitingFirstFile(SOURCE, "/repo", none), true);
  assert.deepEqual(seen, ["/repo/data/email/bunge-ladoga-in.json"]);
  assert.equal(awaitingFirstFile(SOURCE, "/repo/", () => true), false);
  assert.equal(awaitingFirstFile({ ...SOURCE, platform: "bungeag", url: "https://www.bungeag.com/locations/decatur-in/" }, "/repo", none), false);
  const poll = readFileSync(join(ROOT, "scripts/poll.mjs"), "utf8");
  assert.match(poll, /const enabled = loaded\.filter\(\(s\) => !awaitingFirstFile\(s, ROOT, existsSync\)\);/,
    "the poller must not list a source whose first file is not written: no index row, no status anywhere");
});

/* build_directory.mjs run for real, in a scratch tree holding only Ladoga. */
function directoryFor({ snapshot, portal, index = [] }) {
  const t = mkdtempSync(join(tmpdir(), "bunge-dir-"));
  try {
    cpSync(join(ROOT, "lib"), join(t, "lib"), { recursive: true });
    mkdirSync(join(t, "scripts")); mkdirSync(join(t, "sources")); mkdirSync(join(t, "data")); mkdirSync(join(t, "geocodes"));
    cpSync(join(ROOT, "scripts/build_directory.mjs"), join(t, "scripts/build_directory.mjs"));
    const reg = JSON.parse(readFileSync(join(ROOT, "geocodes/places.json"), "utf8")).registry["IN|bungeusagrainllc|ladoga"];
    const place = { lat: 39.8726546, lon: -86.8001052, precision: "street" };
    writeFileSync(join(t, "geocodes/places.json"), JSON.stringify({ places: { "bunge-ladoga-email": place,
      "portal-bunge-ladoga-in": place }, unplaced: {}, known: {}, registry: { "IN|bungeusagrainllc|ladoga": reg } }));
    writeFileSync(join(t, "sources/bunge-ladoga-email.json"), JSON.stringify(SOURCE));
    if (portal) writeFileSync(join(t, "sources/portal-bunge-ladoga-in.json"), JSON.stringify(portal));
    if (snapshot) { mkdirSync(join(t, "data/email")); writeFileSync(join(t, "data/email/bunge-ladoga-in.json"), JSON.stringify(snapshot)); }
    writeFileSync(join(t, "data/index.json"), JSON.stringify({ sources: index }));
    execFileSync(process.execPath, [join(t, "scripts/build_directory.mjs")], { stdio: "pipe" });
    const d = JSON.parse(readFileSync(join(t, "data/directory.json"), "utf8"));
    return (d.elevators ?? d).filter((e) => /ladoga/i.test(e.location ?? ""))
      .map((e) => [e.id, e.status]).sort();
  } finally { rmSync(t, { recursive: true, force: true }); }
}

test("NO SNAPSHOT YET: the map keeps the grey licence pin, and the email source draws nothing", () => {
  assert.deepEqual(directoryFor({}), [["reg:IN|bungeusagrainllc|ladoga", "known"]]);
});

test("NO SNAPSHOT YET, portal listing live: the portal pin alone, no second pin and no red one", () => {
  const feed = JSON.parse(readFileSync(join(ROOT, "test/fixtures/agsist-portal/feed-one.json"), "utf8"));
  const registry = JSON.parse(readFileSync(join(ROOT, "geocodes/places.json"), "utf8")).registry;
  const portal = sourceFor(feed.elevators.find((e) => e.id === "bunge-ladoga-in"), registry, NOW);
  const now = new Date().toISOString();
  const got = directoryFor({ portal, index: [{ id: portal.id, health: "live", status: "ok", checkedAt: now, pricedAt: now }] });
  assert.deepEqual(got, [["portal-bunge-ladoga-in", "read"]]);
});

test("ONCE A SNAPSHOT EXISTS: the email source is an ordinary source, and normal down rules apply", () => {
  const now = new Date().toISOString();
  assert.deepEqual(directoryFor({ snapshot: snap(), index: [{ id: "bunge-ladoga-email", health: "live", status: "ok", checkedAt: now, pricedAt: now }] }),
    [["bunge-ladoga-email", "read"]], "it replaces the grey pin");
  const old = "2026-01-01T00:00:00Z";
  assert.deepEqual(directoryFor({ snapshot: snap(), index: [{ id: "bunge-ladoga-email", health: "refused", status: "refused", checkedAt: old, pricedAt: old }] }),
    [["bunge-ladoga-email", "down"]], "a snapshot that went stale is reported, like any board");
});

test("the workflow warns, on the run and in its summary, when the mailbox secrets are empty", async () => {
  const { readFileSync } = await import("node:fs");
  const y = readFileSync(new URL("../.github/workflows/email-bids.yml", import.meta.url), "utf8");
  const step = y.slice(y.indexOf("Say so when the mailbox is not set up"), y.indexOf("- name: Read the mailbox"));
  assert.ok(step.length > 100, "the warning step is there, before the read");
  assert.match(step, /::warning title=email bids not set up::/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  assert.match(step, /-z "\$BIDS_IMAP_USER"/);
  assert.match(step, /-z "\$BIDS_IMAP_PASSWORD"/);
  assert.doesNotMatch(step, /echo[^\n]*\$BIDS_IMAP_(USER|PASSWORD)[^\n]*(?<!")$/m, "no value is printed");
});

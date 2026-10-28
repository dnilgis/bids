/* THE BIDS#15 FOLLOW-UPS (2026-10-28, fx/readers1028), each from a real capture.
 *
 *   - Peterson Farms posts two yards in one board section, told apart only by
 *     commodity name ("Corn -Danville", "Corn- Loretto"): Danville is its own
 *     source and Loretto keeps only its own rows.
 *   - Central Commodities (Stanberry, St. Joseph MO) run the vendor's older
 *     table template, which now reads with its location id and commodities.
 *   - A board section carries its own "Cash bids for <day>" line; a section
 *     dated more than seven days before today is withheld (Scoular's page:
 *     AGP - Manning October 5, Levant October 23, the rest October 27).
 *   - The Andersons' own location pages, one adapter, every location their
 *     page serves bids on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFile, boardDateAgeDays, BOARD_DATE_MAX_D, Refused } from "../lib/board.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { extractBids, extractCaptionBids, filterLocation, sectionDate } from "../lib/parse.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const man = (id) => JSON.parse(rd(`sources/${id}.json`));
const build = (fixture, m, now) =>
  buildFile(rd(fixture), { now, sourceUrl: m.url, source: toConfig(m), extract: adapterFor(m.platform) });
const rows = (b) => b.file.bids.map((x) => [x.commodity, x.delivery, x.cash, x.basisCents]);

const PF = "fixtures/cashbidssingle-petersonfarms-2026-10-28.html";
const CC = "fixtures/cashbidssingle-cencommodities-2026-10-28.html";
const SC = "fixtures/cashbidssingle-scoularview-2026-10-28.html";
const PF_NOW = new Date("2026-10-28T13:30:00Z");

/* ---------------- the board's own date ---------------- */

test("sectionDate reads the board's own sentence and nothing else", () => {
  assert.equal(sectionDate("Cash bids for Friday, October 23, 2026"), "2026-10-23");
  assert.equal(sectionDate("Cash bids for Monday, October 05, 2026"), "2026-10-05");
  assert.equal(sectionDate("  Cash bids for Tuesday, October 27, 2026 "), "2026-10-27");
  assert.equal(sectionDate("Cash bids for Wednesday,October 14 2026"), "2026-10-14");
  assert.equal(sectionDate("Cash bids for Friday, February 30, 2026"), null, "not a calendar day");
  assert.equal(sectionDate("LOCATIONS TO DISPLAY"), null);
  assert.equal(sectionDate("NEARBY NETWORK LOCATIONS"), null);
  assert.equal(sectionDate(""), null);
});

test("the age of a board's date is counted in Chicago calendar days", () => {
  /* 03:30 UTC on Oct 28 is still Oct 27 in Chicago */
  assert.equal(boardDateAgeDays("2026-10-27", "2026-10-28T03:30:00Z"), 0);
  assert.equal(boardDateAgeDays("2026-10-23", "2026-10-28T13:30:00Z"), 5);
  assert.equal(boardDateAgeDays("2026-10-05", "2026-10-28T13:30:00Z"), 23);
  assert.equal(boardDateAgeDays(null, "2026-10-28T13:30:00Z"), -Infinity, "an undated row is never judged by a date");
  assert.equal(BOARD_DATE_MAX_D, 7);
});

test("Scoular's page: every section's own date is read, and two of them are old", () => {
  const all = extractBids(rd(SC), "https://scoularview.com/cashbidssingle-");
  const byLoc = new Map();
  for (const b of all) byLoc.set(b.locationId, b.boardDate);
  assert.equal(byLoc.get("3508"), "2026-10-05", "AGP - Manning");
  assert.equal(byLoc.get("3685"), "2026-10-23", "Levant");
  const others = [...byLoc].filter(([id]) => id !== "3508" && id !== "3685");
  assert.equal(others.length, 35);
  assert.ok(others.every(([, d]) => d === "2026-10-27"), "the other 35 sections are dated October 27");
});

test("AGP - Manning, dated October 5 on Scoular's page, is withheld as a stale section", () => {
  /* Not a manifest here (AGP Manning is read from its own board, nexus-agpmanningia);
     the Levant manifest pointed at its section is the real reader asking for it. */
  const m = { ...man("scoularview-levant"), locationId: "3508", location: "AGP - Manning" };
  assert.throws(() => build(SC, m, new Date("2026-10-28T13:30:00Z")),
    (e) => e instanceof Refused && /STALE: the board's own date for AGP - Manning is 2026-10-05, 23 days/.test(e.message));
});

test("Levant (scoularview-levant, dated October 23) publishes at five days old and is withheld past seven", () => {
  const m = man("scoularview-levant");
  const fresh = build(SC, m, new Date("2026-10-28T13:30:00Z"));
  assert.equal(fresh.file.count, 5);
  assert.equal(fresh.boardDate, "2026-10-23");
  assert.equal((fresh.withheld ?? []).length, 0);
  /* Oct 30 is day seven: still in. Oct 31 is day eight: out. */
  assert.equal(build(SC, m, new Date("2026-10-30T20:00:00Z")).file.count, 5);
  assert.throws(() => build(SC, m, new Date("2026-10-31T20:00:00Z")),
    (e) => e instanceof Refused && /STALE: the board's own date for Levant is 2026-10-23, 8 days/.test(e.message));
});

test("a fresh Scoular section is untouched by the date rule", () => {
  const b = build(SC, man("scoularview-adrian"), new Date("2026-10-28T13:30:00Z"));
  assert.equal(b.file.count, 4);
  assert.equal(b.boardDate, "2026-10-27");
});

/* ---------------- Peterson Farms ---------------- */

test("Peterson Farms: one section, two yards, and no row on both", () => {
  const all = extractBids(rd(PF), "https://peterson-farms.com/cash-bids");
  const { kept } = filterLocation(all, "2120");
  assert.deepEqual([...new Set(kept.map((b) => b.commodity))], ["Corn -Danville", "Corn- Loretto", "Gmo Beans"]);
  assert.ok(kept.every((b) => b.boardDate === "2026-10-27"), "the section is dated Tuesday, October 27, 2026");

  const dv = man("petersonfarms-danville"), lo = man("petersonfarms-petersonfarms");
  for (const m of [dv, lo]) assert.deepEqual(validateSource(m), [], m.id);
  assert.equal(dv.locationId, lo.locationId);
  assert.equal(dv.url, lo.url);
  const d = build(PF, dv, PF_NOW), l = build(PF, lo, PF_NOW);
  assert.deepEqual(rows(d), [["Corn -Danville", "Fall", 4.12, -40], ["Corn -Danville", "January", 4.25, -40]]);
  assert.deepEqual(rows(l), [["Corn- Loretto", "Fall", 3.87, -65], ["Corn- Loretto", "January", 4, -65],
                             ["Gmo Beans", "Fall", 10.92, -140], ["Gmo Beans", "Jan", 11.55, -90]]);
  assert.equal(d.verified, 2);
  assert.equal(l.verified, 4);
  /* every row on the section lands on exactly one of the two */
  assert.equal(d.file.count + l.file.count, kept.length);
  /* Danville takes no Loretto coordinate, address or phone */
  assert.equal(dv.lat, null);
  assert.equal(dv.phone, null);
  assert.match(dv.note, /capture\.yml run 40694257375/);
  assert.match(dv.note, /PLACE: /);
});

test("a commodity pattern that leaves a yard nothing refuses, and a bad pattern is a load error", () => {
  const dv = { ...man("petersonfarms-danville"), commodityMatch: "lebanon" };
  assert.throws(() => build(PF, dv, PF_NOW), (e) => e instanceof Refused && /none of their commodities/.test(e.message));
  assert.ok(validateSource({ ...dv, commodityMatch: "(" }).some((x) => /commodityMatch is not a valid pattern/.test(x)));
  assert.ok(validateSource({ ...dv, commodityExclude: "" }).some((x) => /commodityExclude must be/.test(x)));
});

/* ---------------- Central Commodities ---------------- */

test("Central Commodities' older table template reads with its location ids and commodities", () => {
  const html = rd(CC);
  const cap = extractCaptionBids(html, "u");
  assert.equal(cap.length, 17);
  assert.deepEqual([...new Set(cap.map((b) => `${b.locationId} ${b.location}`))], ["2861 Stanberry, MO", "2862 St Joe, MO"]);
  assert.deepEqual([...new Set(cap.map((b) => b.commodity))], ["Corn", "Soybeans"]);
  assert.ok(cap.every((b) => b.boardDate === "2026-10-26"), "both blocks are dated Monday, October 26, 2026");
  /* the generic table reader is not asked a second time on this page */
  assert.equal(extractBids(html, "u").length, 17);
});

for (const [id, n, label] of [["centralcommodities-stanberry", 10, "Stanberry, MO"], ["centralcommodities-stjoseph", 7, "St Joe, MO"]]) {
  test(`${id}: on its captured board under its own label, and publishes with nothing withheld`, () => {
    const m = man(id);
    assert.deepEqual(validateSource(m), []);
    assert.match(m.note, /capture\.yml run 40694257375/);
    assert.match(m.note, /PLACE: /);
    const { kept } = filterLocation(adapterFor(m.platform)(rd(CC), m.url), m.locationId);
    assert.equal(kept.length, n);
    assert.ok(kept.every((b) => b.location === label));
    const b = build(CC, m, PF_NOW);
    assert.equal(b.file.status, "ok");
    assert.equal(b.file.count, n);
    assert.equal(b.verified, n, "every row balances cash - basis = futures");
    assert.equal((b.withheld ?? []).length, 0);
    assert.equal(b.boardDate, "2026-10-26");
    for (const x of b.file.bids) assert.ok(x.commodity && x.delivery && Number.isFinite(x.cash) && Number.isFinite(x.basisCents));
  });
}

test("Stanberry's first rows are the price and basis the capture shows", () => {
  const b = build(CC, man("centralcommodities-stanberry"), PF_NOW);
  assert.deepEqual(rows(b).slice(0, 2), [["Corn", "Spot", 3.82, -70], ["Corn", "Nov", 3.82, -70]]);
  const j = build(CC, man("centralcommodities-stjoseph"), PF_NOW);
  assert.deepEqual(rows(j)[0], ["Corn", "Dec", 4.39, -13]);
});

/* WHICH PERIOD IS THIS BID FOR — AND HOW SURE ARE WE.
 *
 * These run against test/fixtures/delivery-labels.json: all 429 distinct delivery
 * strings the scraped boards send, plus every Barchart deliveryMonth label paired
 * with the contract month Barchart itself reports. Captured from the committed
 * feeds. A period parser tested on strings I made up would tell me about my
 * imagination.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { delivery } from "../lib/delivery.mjs";

const F = JSON.parse(readFileSync(new URL("./fixtures/delivery-labels.json", import.meta.url), "utf8"));
const ASOF = F.scrapedAsOf;

/* ── THE INDEPENDENT CHECK ───────────────────────────────────────────────────
   Barchart is a paid commercial feed that states the contract month for every
   row. Parsing its LABEL and comparing to the month it reports is a check this
   repository cannot mark its own homework on. It was 440 of 440 when written. */
test("the parser agrees with Barchart's own contract month, every row", () => {
  for (const { label, barchartMonth } of F.barchart) {
    const got = delivery(label, F.barchartAsOf);
    assert.equal(got.key, barchartMonth,
      `"${label}": parser says ${got.key}, Barchart says ${barchartMonth}`);
  }
});

/* ── COVERAGE, AND THE FLOOR BENEATH IT ─────────────────────────────────────
   3,395 of 3,431 scraped rows resolve — 98.95%. The remaining 36 are refused on
   purpose and counted; see the list at the bottom of this file. A parser that
   answered 100% would be guessing at "J/J27". The floor is set just under the
   measured figure, not at the round number above it. */
test("at least 98.9% of scraped rows resolve to a period", () => {
  let rows = 0, ok = 0;
  for (const { label, rows: n } of F.scraped) {
    rows += n;
    if (delivery(label, ASOF).key) ok += n;
  }
  const pct = 100 * ok / rows;
  assert.ok(pct >= 98.9, `only ${pct.toFixed(2)}% of ${rows} rows resolved`);
  assert.equal(ok, 3395, `${ok} rows resolved, not the 3,395 measured — re-measure before moving this`);
});

test("every answer carries provenance, and every refusal carries a reason", () => {
  const VIA = new Set(["explicit-range", "iso-date", "month-pair", "month-pair-inferred-year",
    "contract-pair", "quarter", "season", "month-year", "month-inferred-year", "spot-word",
    "unreadable", "unreadable-season-no-year", "unreadable-month-no-year"]);
  for (const { label } of F.scraped) {
    const r = delivery(label, ASOF);
    assert.ok(VIA.has(r.via), `"${label}" -> unknown via "${r.via}"`);
    if (r.key === null) assert.ok(r.via.startsWith("unreadable"), `"${label}" refused but via is "${r.via}"`);
    else assert.ok(!r.via.startsWith("unreadable"), `"${label}" answered ${r.key} with via "${r.via}"`);
    assert.equal(r.label, label, "the board's own words must survive verbatim");
  }
});

/* ── THE SHAPES, ONE REAL EXAMPLE EACH ──────────────────────────────────────
   Every left-hand string below appears in the fixture. */
test("each shape the boards actually use is read correctly", () => {
  const cases = [
    ["SEP 2026",                              "2026-09", "month-year"],
    ["Sep 26",                                "2026-09", "month-year"],
    ["Sep26",                                 "2026-09", "month-year"],
    ["AUG '26",                               "2026-08", "month-year"],
    ["OCT-26",                                "2026-10", "month-year"],
    ["20260930",                              "2026-09", "iso-date"],
    ["01 Aug 2026 to 31 Aug 2026",            "2026-08", "explicit-range"],
    ["Oct/Nov 26",                    "2026-10/2026-11", "month-pair"],
    ["JAN-MAR 2027",                  "2027-01/2027-03", "month-pair"],
    ["O/N26",                         "2026-10/2026-11", "contract-pair"],
    ["JFM 2027",                      "2027-01/2027-03", "quarter"],
    ["New Crop 2026",                     "newcrop-2026", "season"],
    ["NC 26",                             "newcrop-2026", "season"],
    ["HARVEST 2026",                      "newcrop-2026", "season"],
    ["Cash",                                      "spot", "spot-word"],
    ["In Store",                                  "spot", "spot-word"],
    ["Open Storage",                              "spot", "spot-word"],
  ];
  for (const [label, key, via] of cases) {
    const r = delivery(label, ASOF);
    assert.equal(r.key, key, `"${label}" -> ${r.key}, expected ${key}`);
    assert.equal(r.via, via, `"${label}" via ${r.via}, expected ${via}`);
  }
});

/* ── THE PRECEDENCE RULES, EACH WITH THE ROW THAT FORCED IT ─────────────────*/

/* Six elevators write "New Crop 2026" and mean six different date ranges:
   Oct 1-31, Nov 2-Dec 1, Sep 15-Oct 31, Oct 1-Nov 30, Sep 1-30, Sep 15-Nov 30.
   That is measured, from the fixture. It is why a bare season is never resolved
   to months — and why an elevator that DOES give dates gets read on its dates. */
test("dates on the line beat the prose in front of them", () => {
  assert.equal(delivery("New Crop 2026 (01 Oct 2026 to 31 Oct 2026)", ASOF).key, "2026-10");
  assert.equal(delivery("New Crop 2026 (15 Sep 2026 to 31 Oct 2026)", ASOF).key, "2026-09/2026-10");
  assert.equal(delivery("Cash Bid (01 Jul 2026 to 21 Aug 2026)", ASOF).via, "explicit-range",
    "a dated range labelled Cash is a dated range");
  /* and a board whose prose contradicts its own dates is read on the dates */
  assert.equal(delivery("Mar 2026 (01 Jul 2026 to 31 Jul 2026)", ASOF).key, "2026-07");
});

test("a named month beats the season that introduces it", () => {
  assert.equal(delivery("New Crop July 2027", ASOF).key, "2027-07");
  assert.equal(delivery("New Crop July 2027", ASOF).via, "month-year");
  /* but a season with no month stays a season */
  assert.equal(delivery("New Crop 27", ASOF).key, "newcrop-2027");
  assert.equal(delivery("Fall Corn 2026", ASOF).key, "newcrop-2026");
});

test("old crop and new crop are different buckets", () => {
  assert.equal(delivery("Old Crop 2026", ASOF).key, "oldcrop-2026");
  assert.equal(delivery("New Crop 2026", ASOF).key, "newcrop-2026");
  assert.notEqual(delivery("Old Crop 2026", ASOF).key, delivery("New Crop 2026", ASOF).key);
});

test("a season never collides with a month", () => {
  const keys = new Set(F.scraped.map((x) => delivery(x.label, ASOF).key).filter(Boolean));
  for (const k of keys) {
    if (k.startsWith("newcrop") || k.startsWith("oldcrop")) {
      assert.ok(!/^\d{4}-\d{2}/.test(k), `"${k}" looks like both a season and a month`);
    }
  }
});

/* December/January and November/December roll the year; the second month is not
   in the same calendar year as the first. */
test("a month pair that crosses new year rolls the year", () => {
  assert.equal(delivery("DEC/JAN 2027", ASOF).key, "2027-12/2028-01");
  assert.equal(delivery("D/J26", ASOF).key, "2026-12/2027-01");
});

/* ── THE INFERENCE, AND ITS LIMIT ───────────────────────────────────────────*/
test("a month with no year is the next one coming, and says so", () => {
  const r = delivery("Dec", "2026-09-01T00:00:00Z");
  assert.equal(r.key, "2026-12");
  assert.equal(r.via, "month-inferred-year", "an inferred year must be labelled as one");
  /* March, read in September, is next March */
  assert.equal(delivery("Mar", "2026-09-01T00:00:00Z").key, "2027-03");
  /* the current month counts as present, not a year away */
  assert.equal(delivery("Sep", "2026-09-01T00:00:00Z").key, "2026-09");
});

test("with nothing to reckon from, a bare month is refused rather than dated today", () => {
  const r = delivery("Dec", undefined);
  assert.equal(r.key, null);
  assert.equal(r.via, "unreadable-month-no-year");
});

/* ── WHAT IS REFUSED, ON PURPOSE ────────────────────────────────────────────
   36 rows across 21 labels. "J/J" is June/July or July/June and nothing on the
   line says which; "New Crop" with no year means this autumn in September and
   next autumn in March. Both are guesses and both are refused. */
test("genuinely ambiguous strings are refused, not guessed", () => {
  for (const l of ["J/J27", "J/F/M", "NC YC", "New Crop", "Harvest Delivery", "Fall"]) {
    assert.equal(delivery(l, ASOF).key, null, `"${l}" was answered; nothing on that line says which period`);
  }
});

test("empty and rubbish input is refused without throwing", () => {
  for (const v of [null, undefined, "", "   ", 0, {}, []]) {
    const r = delivery(v, ASOF);
    assert.equal(r.key, null);
    assert.ok(r.via.startsWith("unreadable"));
  }
});

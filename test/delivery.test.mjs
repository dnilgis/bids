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
   8,014 of 8,045 scraped rows resolve — 99.61%. The remaining 31 are refused on
   purpose and counted; see the list at the bottom of this file. A parser that
   answered 100% would be guessing at "J/J27". The floor is set just under the
   measured figure, not at the round number above it.

   RE-CAPTURED 2026-09-06, AND THAT IS THE POINT. The 2026-09-01 fixture held
   3,431 rows and read 98.95% of them, and it was green every day while 4,226
   LIVE ROWS — more than the whole feed published — were being dropped at the
   merge guard for a shape it had never seen: "09/01/2026", which every
   AgriCharts mobile board writes and which arrived with the sweep after the
   capture. A fixture that stops being a copy of the corpus stops being
   evidence, and this one said 98.95% about a world that no longer existed.
   Re-capture it when the corpus grows, not only when this goes red. */
test("at least 98.9% of scraped rows resolve to a period", () => {
  let rows = 0, ok = 0;
  for (const { label, rows: n } of F.scraped) {
    rows += n;
    if (delivery(label, ASOF).key) ok += n;
  }
  const pct = 100 * ok / rows;
  assert.ok(pct >= 98.9, `only ${pct.toFixed(2)}% of ${rows} rows resolved`);
  assert.equal(ok, 8014, `${ok} rows resolved, not the 8,014 measured — re-measure before moving this`);
});

test("every answer carries provenance, and every refusal carries a reason", () => {
  const VIA = new Set(["explicit-range", "iso-date", "month-day-year", "day-range-inferred-year",
    "deadline-inferred-year", "us-date", "month-pair", "month-pair-inferred-year",
    "contract-pair", "quarter", "season", "month-year", "month-inferred-year", "spot-word",
    "unreadable", "unreadable-season-no-year", "unreadable-month-no-year",
    "unreadable-day-range-no-year", "unreadable-deadline-no-year",
    "unreadable-numeric-date-month-out-of-range"]);
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

/* ── "Sep 01, 2026": THE DAY WAS BEING READ AS THE YEAR ─────────────────────
   CDR Farms LLC of Bloomer, Wisconsin posts every row as a calendar date. The
   plain-month rule takes the FIRST number after the month name, so the day 01
   became the year, and four rows were filed under SEPTEMBER, NOVEMBER, MARCH
   and OCTOBER 2001 — twenty-five years in the past.

   It refused nothing and warned nobody: `via` said "month-year" and the keys
   looked like any other keys. It surfaced only sideways, on 2026-09-05, when
   that elevator would not appear under any delivery filter on agsist.com —
   sixteen miles from the reader who asked where his neighbours had gone. A
   wrong answer that looks like a right one is worse than a refusal, which is
   why `via` is asserted here and not only the key. */
test("a calendar date is the month it names, not the day read as a year", () => {
  for (const [label, key, start] of [
    ["Sep 01, 2026",     "2026-09", "2026-09-01"],
    ["Nov 01, 2026",     "2026-11", "2026-11-01"],
    ["Mar 01, 2027",     "2027-03", "2027-03-01"],
    ["Oct 01, 2026",     "2026-10", "2026-10-01"],
    ["October 15, 2026", "2026-10", "2026-10-15"],
    ["Sept. 3, 2026",    "2026-09", "2026-09-03"],
  ]) {
    const r = delivery(label, ASOF);
    assert.equal(r.key, key, `"${label}" is ${key}`);
    assert.equal(r.via, "month-day-year", `"${label}" must say HOW it was read`);
    assert.equal(r.start, start, "the day is on the row, so the day is kept");
    assert.equal(r.end, start);
  }
});

test("and the calendar-date rule does not swallow a two-digit year", () => {
  /* "Sept 26 Corn" is September 2026 — month and a TWO-digit year with a word
     after it, which the plain-month rule already read correctly. Requiring a
     four-digit year above is what keeps these two apart. */
  for (const [label, key, via] of [
    ["Sept 26 Corn", "2026-09", "month-year"],
    ["Sep26",        "2026-09", "month-year"],
    ["OCT-26",       "2026-10", "month-year"],
    ["Fall 26",      "newcrop-2026", "season"],
  ]) {
    const r = delivery(label, ASOF);
    assert.equal(r.key, key, label);
    assert.equal(r.via, via, `"${label}" must still be read the way it was`);
  }
});

/* ── A DAY IS NOT A YEAR ────────────────────────────────────────────────────
   Rule 5 takes the first number after the month name and calls it the year.
   Measured 2026-09-05 across the 334 places in the merged feed: TEN carried a
   delivery period outside 2026-2030, and all ten are the same mistake.

       Sept 11-20   -> 2011-09    CHS Illinois, Annawan and Rochelle
       Sept 21-30   -> 2021-09
       Sep 16-30    -> 2016-09    CHS Illinois, Morris and Seneca
       SEPT 10-20   -> 2010-09    CHS River Terminals, Mankato
       by Sept 11   -> 2011-09    Inco Grain; Southwest Iowa Renewable Energy
       by Sept 15th.-> 2015-09    Farmers Cooperative Society, Sioux Center
       By Nov 15th  -> 2015-11    Ag Partners Cooperative, Red Wing
       Sep 01, 2026 -> 2001-09    CDR Farms LLC, Bloomer (all four rows)

   None of it refused. `via` said "month-year" and every key looked ordinary,
   so nothing on any board, in any check, or on the site said a word — until an
   elevator sixteen miles from a reader would not appear under any delivery
   filter and he asked why. Sorting by year is what finds these, not reading. */
test("a day inside a month is never read as the year", () => {
  for (const [label, key, start, end, via] of [
    ["Sept 11-20",  "2026-09", "2026-09-11", "2026-09-20", "day-range-inferred-year"],
    ["Sept 21-30",  "2026-09", "2026-09-21", "2026-09-30", "day-range-inferred-year"],
    ["Sep 16-30",   "2026-09", "2026-09-16", "2026-09-30", "day-range-inferred-year"],
    ["Oct 11-20",   "2026-10", "2026-10-11", "2026-10-20", "day-range-inferred-year"],
    ["Oct 21-31",   "2026-10", "2026-10-21", "2026-10-31", "day-range-inferred-year"],
    ["Nov 21-30",   "2026-11", "2026-11-21", "2026-11-30", "day-range-inferred-year"],
    ["SEPT 10-20",  "2026-09", "2026-09-10", "2026-09-20", "day-range-inferred-year"],
    ["by Sept 11",  "2026-09", null,         "2026-09-11", "deadline-inferred-year"],
    ["BY Sept 11",  "2026-09", null,         "2026-09-11", "deadline-inferred-year"],
    ["by Sept 15th.","2026-09", null,        "2026-09-15", "deadline-inferred-year"],
    ["By Nov 15th", "2026-11", null,         "2026-11-15", "deadline-inferred-year"],
  ]) {
    const r = delivery(label, ASOF);
    assert.equal(r.key, key, `"${label}"`);
    assert.equal(r.via, via, `"${label}" must say the year was inferred, not read`);
    assert.equal(r.start, start, `"${label}" start`);
    assert.equal(r.end, end, `"${label}" end`);
  }
});

test("no delivery period in the fixture lands outside the years a board could mean", () => {
  /* THE CHECK THAT WOULD HAVE FOUND ALL OF IT IN ONE LINE. Sorting the answers
     by year is not the same as reading them, and none of the shape-by-shape
     tests above was ever going to notice a key in 2011. */
  const asOfYear = new Date(ASOF).getUTCFullYear();
  const bad = [];
  for (const { label } of F.scraped) {
    const r = delivery(label, ASOF);
    for (const y of String(r.key || "").match(/\b(\d{4})-\d{2}\b/g) || []) {
      const yr = Number(y.slice(0, 4));
      if (yr < asOfYear || yr > asOfYear + 5) bad.push(`${label} -> ${r.key} (${r.via})`);
    }
  }
  assert.deepEqual([...new Set(bad)], [],
    "a delivery in the past or more than five years out is a misread number, not a bid");
});

/* ── "09/01/2026": 4,226 ROWS NOTHING COULD READ ────────────────────────────
   Every AgriCharts mobile board writes its delivery as a US numeric date, and
   this parser had never been shown one. They arrived with the sweep, after the
   2026-09-01 fixture was captured, so nothing went red — the rows were dropped
   at the merge guard as "delivery unreadable" and counted in a log line nobody
   was reading. 4,226 of them, against 3,539 bids the whole feed published.

   WHICH FIELD IS THE MONTH WAS COUNTED, NOT ASSUMED. Across those rows the
   first field takes all twelve values 01..12 and never more; the second takes
   01 on 4,090 of them and also 03, 05, 07, 09, 15, 16 and 31. A field reaching
   31 is not a month; a field that never passes 12 in four thousand rows is not
   a day. MM/DD/YYYY. A first field above 12 is refused rather than swapped. */
test("a US numeric date is read month-first, and only where that is proved", () => {
  for (const [label, key, day] of [
    ["09/01/2026", "2026-09", "2026-09-01"],
    ["10/16/2026", "2026-10", "2026-10-16"],
    ["12/31/2026", "2026-12", "2026-12-31"],
    ["01/01/2027", "2027-01", "2027-01-01"],
    ["1/1/2027",   "2027-01", "2027-01-01"],
  ]) {
    const r = delivery(label, ASOF);
    assert.equal(r.key, key, label);
    assert.equal(r.via, "us-date", `"${label}" must say how it was read`);
    assert.equal(r.start, day, "the day is printed on the row, so the day is kept");
    assert.equal(r.end, day);
  }
  /* THE CONTRACT CODE IS NOT THE DELIVERY MONTH, which is why it is not
     consulted: "01/01/2027" arrives beside ZCH27 — a January delivery priced
     off the March contract. Ordinary, and it would have broken any rule that
     took the code as the answer. */
  assert.equal(delivery("01/01/2027", ASOF).key, "2027-01");
  /* A month above 12 would mean a board writing day-first. None does, so it is
     refused: swapping on the strength of one row is the guess this avoids. */
  const bad = delivery("13/01/2026", ASOF);
  assert.equal(bad.key, null);
  assert.equal(bad.via, "unreadable-numeric-date-month-out-of-range");
});

test("the fixture actually contains the shape that broke, so this cannot go stale again", () => {
  const us = F.scraped.filter((x) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(x.label));
  const rows = us.reduce((n, x) => n + x.rows, 0);
  assert.ok(rows > 4000,
    `only ${rows} US-date rows in the fixture — the 2026-09-01 capture had ZERO of them `
    + `while 4,226 were live, and that is how they were dropped in silence`);
  for (const x of us) assert.ok(delivery(x.label, ASOF).key, `"${x.label}" still unreadable`);
});

test("a letter pair is the same pair however it is punctuated", () => {
  /* "O-N 2026" and "O-N 2027" sat unreadable for a hyphen where the table had a
     slash. Widened only because PAIR is a closed list: "J/J" is June/July or
     July/June, is not in it, and is still refused however it is written. */
  assert.equal(delivery("O-N 2026", ASOF).key, "2026-10/2026-11");
  assert.equal(delivery("O/N 26", ASOF).key,   "2026-10/2026-11");
  assert.equal(delivery("J-J 27", ASOF).key,   null);
  assert.equal(delivery("Jan-Mar 27", ASOF).via, "month-pair", "a spelled-out pair is unchanged");
  assert.equal(delivery("OCT-26", ASOF).via, "month-year", "and a hyphenated year is still a year");
});

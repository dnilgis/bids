/* ONE CLASSIFIER, BECAUSE THERE USED TO BE TWO.
 *
 * lib/crop.mjs replaces AGSIST's classify()/ppu()/PPU_BAND, which lived in
 * cash-bids.html while this repo read the same fields its own way, and which
 * scripts/fetch_bids.py was under written orders to "stay in lockstep with".
 *
 * These tests run against test/fixtures/commodity-labels.json — every distinct
 * commodity string the scraped boards and the Barchart response actually send,
 * captured, not typed from memory. A classifier tested on invented labels tells
 * you about the labels you imagined.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crop, CROPS, ppu, plausible, PPU_BAND, basisCents, basisDollars } from "../lib/crop.mjs";

const LABELS = JSON.parse(readFileSync(new URL("./fixtures/commodity-labels.json", import.meta.url), "utf8"));

/* The classifier AGSIST shipped, kept here verbatim so the comparison is with
   the real thing rather than my memory of it. */
const old = (name) => {
  const n = (name || "").toLowerCase();
  if (/\b(meal|hull|pellet|oil|flour|ddg|distillers|gluten)\b/.test(n)) return "other";
  if (n.indexOf("corn") >= 0) return "corn";
  if (n.indexOf("soy") >= 0 || n.indexOf("bean") >= 0) return "soybeans";
  if (n.indexOf("wheat") >= 0 || n.indexOf("hrw") >= 0 || n.indexOf("srw") >= 0 || n.indexOf("hrs") >= 0) return "wheat";
  return "other";
};

test("every label lands in a declared bucket", () => {
  for (const l of [...LABELS.scraped, ...LABELS.barchart]) {
    assert.ok(CROPS.includes(crop(l)), `"${l}" -> "${crop(l)}", which is not a declared crop`);
  }
});

/* THE ONE THAT MATTERS MOST.
   Barchart returns commodity "Soybean Meal" with category "soybeans". Meal is a
   processing byproduct sold by the ton. Carried into the soybeans bucket it
   competes for "highest soybean bid" against per-bushel prices — the FJ Krob
   failure with a bigger number behind it. Barchart's own category is therefore
   never trusted; every row is re-classified here. */
test("a byproduct never reaches a grain bucket, whatever the feed calls it", () => {
  assert.equal(crop("Soybean Meal"), "other");
  assert.equal(crop("Corn Gluten Feed"), "other");
  assert.equal(crop("Soybean Hulls"), "other");
  assert.equal(crop("DDGs"), "other");
  assert.equal(crop("Corn Oil"), "other");
  /* and the byproduct test must run BEFORE the grain test, not after */
  assert.notEqual(crop("Soybean Meal"), "soybeans", "the meal guard runs too late to help");
});

/* The 11 labels the old classifier put in "other" that are not other. Each is a
   real string from a real board; the row counts are what they were worth on the
   day this was measured. */
const RECOVERED = [
  ["Milo", "sorghum", 129], ["MILO", "sorghum", 6], ["Sorghum", "sorghum", 2],
  ["Soft Red Winter", "wheat", 6], ["Hard Red Winter", "wheat", 3],
  ["Spring Wht", "wheat", 2], ["Soft White Winter", "wheat", 2],
  ["DNS 14% Delivered TCG", "wheat", 5], ["SWW MAX 10.5%  Delivered TCG", "wheat", 5],
  ["#2YC", "corn", 4], ["YC Delivered TCG", "corn", 1],
];

test("the 165 rows the old classifier lost are recovered", () => {
  let rows = 0;
  for (const [label, want, n] of RECOVERED) {
    assert.equal(old(label), "other", `"${label}" was not actually mislaid by the old classifier`);
    assert.equal(crop(label), want, `"${label}" should be ${want}`);
    rows += n;
  }
  assert.equal(rows, 165, "the recovered row count moved; re-measure before changing it");
});

test("nothing the old classifier got right is moved", () => {
  for (const l of [...LABELS.scraped, ...LABELS.barchart]) {
    const o = old(l), w = crop(l);
    if (o !== "other") assert.equal(w, o, `"${l}" was ${o} and is now ${w} — a regression, not a recovery`);
  }
});

/* WHAT STAYS "OTHER", AND WHY THAT IS A DECISION AND NOT AN OVERSIGHT.
   Canola, durum and yellow peas are real grains. They stay out because this site
   carries no futures page for them and, in durum's case, because there is no US
   durum contract at all — so its basis is not against anything. Putting durum in
   the wheat bucket would let a $9 durum bid win "best wheat" against $6 spring
   wheat for a grower who does not grow durum. If durum volume grows it earns its
   own bucket; it does not get to borrow one. */
test("the remaining others are genuinely other", () => {
  const others = [...LABELS.scraped, ...LABELS.barchart].filter((l) => crop(l) === "other");
  const uniq = [...new Set(others)].sort();
  assert.deepEqual(uniq, [
    "15 - #2 O/B Whole Yellow Peas", "Canola", "Durum", "Durum Choice Milling", "Soybean Meal",
  ], `the "other" bucket changed: ${JSON.stringify(uniq)}`);
});

test("an empty or missing label is other, not a crash", () => {
  for (const v of [null, undefined, "", "   "]) assert.equal(crop(v), "other");
});

/* ── PRICE UNITS ────────────────────────────────────────────────────────────
   FJ Krob of Walker, Iowa posted SOYBEANS at 120.083 — a per-ton row. ppu()
   rescaled it to $1.20, the page called it soybeans and ranked it first, then
   sorted on the raw 120.083 while printing $1.20.

   NOTE WHICH END OF THE BAND CATCHES IT. Not the ceiling — the rescale already
   pushed it below the floor. $1.20 is not a soybean price, and that is the whole
   tell: a per-ton number run through a per-bushel rescale comes out absurdly
   CHEAP. Widening the ceiling would not let it back in; lowering the floor
   would. Both ends are load-bearing and the test below checks both. */
test("a per-ton row is withheld, not rescaled into looking sensible", () => {
  assert.equal(ppu(120.083).toFixed(2), "1.20", "the rescale itself is unchanged");
  assert.equal(plausible(120.083, "soybeans"), false, "FJ Krob's per-ton row must be withheld");
  assert.equal(plausible(120.083, "soybeans"), false, "and it is the FLOOR that refuses it");
  assert.equal(plausible(11.42, "soybeans"), true, "an ordinary bean bid passes");
  assert.equal(plausible(1142, "soybeans"), true, "a cents-quoted bean bid rescales and passes");
});

test("every banded crop has a band, and no band admits an absurd price", () => {
  for (const c of CROPS) {
    if (c === "other") { assert.equal(PPU_BAND[c], undefined, "other must not be banded"); continue; }
    const b = PPU_BAND[c];
    assert.ok(Array.isArray(b) && b[0] < b[1], `${c} has no usable band`);
    assert.equal(plausible(0, c), false, `${c} accepts a zero price`);
    assert.equal(plausible(b[1] * 3, c), false, `${c} accepts triple its ceiling`);
  }
});

test("an unbanded crop is not our call and passes", () => {
  assert.equal(plausible(43.5, "other"), true);
});

/* ── BASIS ─────────────────────────────────────────────────────────────────
   This repo's rows carry basis in dollars AND cents; Barchart carries dollars.
   One conversion, used by both, so a merged row cannot disagree with itself. */
test("basis converts both ways and agrees with itself", () => {
  assert.equal(basisCents(-0.60), -60);
  assert.equal(basisCents(-60), -60);
  assert.equal(basisDollars(-0.60), -0.60);
  assert.equal(basisDollars(-60), -0.60);
  assert.equal(basisCents(0), 0);
  assert.equal(basisCents(null), null);
  assert.equal(basisCents(undefined), null);
  assert.equal(basisCents(NaN), null);
  /* The discriminator is |b| < 5. Both readings of a 4-cent basis round to the
     same place, which is why the ambiguity is harmless where it exists. */
  assert.equal(basisCents(0.04), 4);
  assert.equal(basisCents(6), 6);
});

test("a scraped row's own two basis fields survive the round trip", () => {
  /* flashgrain-thorp, corn, Fall 26: basisDollars -0.6, basisCents -60 */
  assert.equal(basisCents(-0.6), -60);
  assert.equal(basisDollars(-60), -0.6);
});

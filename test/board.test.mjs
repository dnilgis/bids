/* buildFile against the REAL captured page.
 *
 * fixtures/bigriver-2121.html is a real capture. An earlier session in this
 * project reconstructed a fixture from assumptions and 54 tests passed against
 * a fiction. Never test this parser against a page you wrote yourself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused, priceChanged, serialise, CONFIG } from "../lib/board.mjs";

const html = readFileSync(new URL("../fixtures/bigriver-2121.html", import.meta.url), "utf8");
const NOW = "2026-08-17T16:32:26.765Z";
const URL_ = "https://bigriverbids.com/cashbidssingle-2121";
const build = (h = html) => buildFile(h, { now: NOW, sourceUrl: URL_ });

test("the real page yields the seven Boyceville corn rows", () => {
  const { file, dropped } = build();
  assert.equal(file.count, 7);
  assert.equal(file.bids.length, 7);
  assert.ok(dropped > 0, "the page carries other locations and they must be dropped");
  assert.equal(file.source.locationId, "2121");
});

test("cash minus basis equals the quoted futures on every row", () => {
  /* The identity check is the only guard that proves a number came out of the
     right COLUMN rather than merely being plausible. Asserted again here on
     the built file, because a bug in the mapping between parse and file would
     slip past a check that only ran inside the parser. */
  const { file } = build();
  for (const b of file.bids) {
    const derived = Math.round((b.cash - b.basisDollars) * 10000) / 10000;
    assert.equal(derived, b.futuresPriceCents / 100,
      `${b.delivery}: ${b.cash} - (${b.basisDollars}) != ${b.futuresPriceCents}c`);
  }
});

test("bids are in page order, nearest delivery first, not alphabetical", () => {
  /* Boyceville writes deliveries as month names. Sorted alphabetically, April
     comes first and a consumer taking bids[0] prices the wrong month in ten
     months of the year. It happens to be right in April and August, so a test
     written in August against an alphabetical sort would have passed. */
  const { file } = build();
  assert.deepEqual(file.bids.map((b) => b.seq), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(file.bids[0].delivery, "August");
  const names = file.bids.map((b) => b.delivery);
  assert.notDeepEqual(names, [...names].sort(),
    "if these are equal the fixture cannot distinguish page order from alphabetical");
});

test("both unit forms are published and the unit is in the field name", () => {
  const b = build().file.bids[0];
  assert.equal(b.basisDollars, -0.52);
  assert.equal(b.basisCents, -52);
  assert.equal(b.futuresPriceCents, 459.5);
  assert.ok(!("basis" in b), "an unlabelled `basis` is exactly the ambiguity to avoid");
});

test("the two clocks are both stamped and both equal now on a fresh build", () => {
  const { file } = build();
  assert.equal(file.checkedAt, NOW);
  assert.equal(file.pricedAt, NOW);
});

test("diagnostics stay OUT of the committed file", () => {
  /* The Worker's builder used to emit `dropped` and the Action's did not, so
     the same board read by the two readers produced two different files and
     git recorded a change in the reader as if it were a change in the price. */
  const { file, dropped, locations } = build();
  assert.equal("dropped" in file, false);
  assert.equal("locations" in file, false);
  assert.equal(typeof dropped, "number");
  assert.ok(Array.isArray(locations));
});

test("the committed shape matches what is already in data/boyceville.json", () => {
  const live = JSON.parse(readFileSync(new URL("../data/boyceville.json", import.meta.url), "utf8"));
  const { file } = build();
  assert.deepEqual(Object.keys(file).sort(), Object.keys(live).sort(),
    "a new or missing top-level key churns the file on the next poll");
  assert.deepEqual(Object.keys(file.bids[0]).sort(), Object.keys(live.bids[0]).sort());
});

test("serialisation is stable, so neither reader churns the other's file", () => {
  const a = serialise(build().file);
  const b = serialise(build().file);
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
});

test("an empty page is refused, not published", () => {
  assert.throws(() => build("<html><body><p>nothing here at all</p></body></html>"),
    (e) => e instanceof Refused && /0 bids parsed/.test(e.message));
});

test("a page with no Boyceville rows is refused and names what was there", () => {
  const other = html.replace(/2121/g, "2162");
  assert.throws(() => build(other),
    (e) => e instanceof Refused && /none for location 2121/.test(e.message));
});

test("a decimal point in the wrong place is refused", () => {
  const silly = html.replace(">4.0750<", ">40.750<");
  assert.throws(() => build(silly), (e) => e instanceof Refused);
});

test("a reordered column fails the identity check even with plausible values", () => {
  /* The scenario the sanity band cannot catch: every number still looks like a
     price, but cash and basis have swapped places. */
  const swapped = html.replace("<li class='c2'>4.0750</li><li class='c3'>-0.5200</li>",
                               "<li class='c2'>4.5950</li><li class='c3'>-0.0100</li>");
  assert.notEqual(swapped, html, "the fixture changed shape; this test needs updating");
  assert.throws(() => build(swapped),
    (e) => e instanceof Refused && /cash - basis = futures/.test(e.message));
});

test("priceChanged ignores the clocks and notices the price", () => {
  const { file } = build();
  const later = { ...file, checkedAt: "2026-08-17T22:00:00.000Z" };
  assert.equal(priceChanged(file, later), false, "a new checkedAt is not news");

  const moved = { ...file, bids: [{ ...file.bids[0], cash: 4.2 }, ...file.bids.slice(1)] };
  assert.equal(priceChanged(file, moved), true);
  assert.equal(priceChanged(null, file), true, "no previous file is always news");
});

test("the sanity band is a band, not a forecast", () => {
  assert.ok(CONFIG.floor < 3 && CONFIG.ceiling > 10,
    "narrowing this to the current market turns a decimal-point check into a price opinion");
});

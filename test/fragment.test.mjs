/* The server-rendered fragment adapter — Farmers Cooperative Society.
 *
 * This one is easy to read and therefore easy to read WRONG: it is a plain
 * table, so a template that gains a column, or a heading that drops its town,
 * fails silently rather than loudly. Every test here is one of those. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract, splitHeading, headerMap, tabCommodities, FragmentRefused } from "../lib/adapters/fragment.mjs";

const FIXTURE = readFileSync(new URL("../fixtures/fcs-cashbids-2026-08-19.html", import.meta.url), "utf8");
const URL_ = "https://www.farmerscoopsociety.com/ajax/homepage/dtn-cash-bids";

test("the live fragment yields eleven rows and every one balances", () => {
  const rows = extract(FIXTURE, URL_);
  assert.equal(rows.length, 11);
  assert.deepEqual([...new Set(rows.map((r) => r.commodity))], ["Corn", "Soybean"]);
  assert.deepEqual([...new Set(rows.map((r) => r.location))], ["Sioux Center"]);
  for (const r of rows) {
    const gap = Math.abs((r.cash - r.basis) * 100 - r.futuresPrice);
    assert.ok(gap <= 0.5, `${r.commodity} ${r.delivery}: ${r.cash} − ${r.basis} vs ${r.futuresPrice} is ${gap}¢ out`);
  }
  const corn = rows.find((r) => r.commodity === "Corn" && r.delivery === "Aug '26");
  assert.equal(corn.cash, 4.58);
  assert.equal(corn.basis, -0.15);
  assert.equal(corn.futures, "@C6U");
  assert.equal(corn.futuresPrice, 472.75);   // 472'6, apostrophe arrives as &#039;
});

test("the town is inherited only because one town is named", () => {
  /* "Sioux Center Corn Bids" then plain "Soybean Bids". */
  assert.deepEqual(tabCommodities(FIXTURE), ["Corn", "Soybean"]);
  assert.deepEqual(splitHeading("Sioux Center Corn Bids", ["Corn", "Soybean"]),
    { location: "Sioux Center", commodity: "Corn" });
  assert.equal(splitHeading("Soybean Bids", ["Corn", "Soybean"]), null);
  assert.ok(extract(FIXTURE, URL_).some((r) => r.commodity === "Soybean" && r.location === "Sioux Center"));
});

test("a fragment naming TWO towns refuses to guess for a headless heading", () => {
  /* The inheritance above is safe for one town and silently wrong for two:
     it would file Hull's beans under Sioux Center. */
  const two = FIXTURE.replace("Sioux Center Corn Bids", "Hull Corn Bids")
                     .replace("<h1", "<h1 data-x", 1);
  const twoTowns = two.replace(/Soybean Bids/, "Soybean Bids")   // second heading still headless
                      .replace("Hull Corn Bids", "Hull Corn Bids");
  /* Add a third panel for a different town so two distinct towns are named. */
  const mixed = twoTowns.replace("<h1", `<h1 class="x">Rock Valley Corn Bids</h1><table><thead><tr><th>delivery date</th><th>cash-price</th><th>basis</th><th>basis-month</th><th>futures-price</th></tr></thead><tbody><tr><td>Aug</td><td>4.50</td><td>-0.20</td><td>@C6U</td><td>470'0</td></tr></tbody></table><h1`, 1);
  assert.throws(() => extract(mixed, URL_), (e) => {
    assert.ok(e instanceof FragmentRefused);
    assert.match(e.message, /2 towns/);
    return true;
  });
});

test("columns are read from their labels, not from their positions", () => {
  /* THE FAILURE THIS PREVENTS: their template gains or reorders a column and
     every row publishes basis as cash, with no guard able to see it because
     the numbers are all still plausible. */
  const swapped = FIXTURE
    .replace(/cash-price\s*<\/th>([\s\S]*?)basis\s*<\/th>/, "basis</th>$1cash-price</th>");
  const before = extract(FIXTURE, URL_);
  const after = extract(swapped, URL_);
  assert.equal(after.length, before.length);
  /* The header now says the second column is basis and the third is cash, so
     the adapter must return them the other way round -- proving it followed
     the labels rather than the order. */
  assert.equal(after[0].cash, before[0].basis);
  assert.equal(after[0].basis, before[0].cash);
});

test("a header missing a column we need is refused by name", () => {
  const gutted = FIXTURE.replace(/basis-month\s*<\/th>/, "sausages</th>");
  assert.throws(() => extract(gutted, URL_), (e) => {
    assert.match(e.message, /missing futuresMonth/);
    return true;
  });
});

test("an incomplete row is skipped, never coerced to zero", () => {
  /* An empty cash cell must drop the row. Number("") is 0, and a zero cash
     price is a free bushel. */
  const blanked = FIXTURE.replace(/>(\s*)4\.58(\s*)</, ">$1$2<");
  assert.ok(blanked !== FIXTURE, "the fixture no longer contains the cell this test blanks");
  const rows = extract(blanked, URL_);
  assert.equal(rows.length, 10, "the blanked row should be gone, not zeroed");
  assert.ok(!rows.some((r) => r.cash === 0));
});

test("a tick-shaped futures price that will not parse drops its row", () => {
  /* 473' is not 473. The same truncation froze the Boyceville feed. */
  const torn = FIXTURE.replace("472&#039;6", "472&#039;");
  const rows = extract(torn, URL_);
  assert.equal(rows.length, 10);
});

test("headerMap normalises the labels this template actually uses", () => {
  const m = headerMap(`<table><thead><tr>
    <th>delivery date</th><th>cash-price</th><th>basis</th>
    <th>basis-month</th><th>futures-price</th><th>futures-change</th></tr></thead></table>`);
  assert.deepEqual(m, { delivery: 0, cash: 1, basis: 2, futuresMonth: 3, futuresPrice: 4, change: 5 });
});

test("a fragment with no panel at all refuses rather than returning nothing", () => {
  /* Returning [] would read downstream as "they have no bids today". */
  assert.throws(() => extract("<div>maintenance</div>", URL_), FragmentRefused);
});

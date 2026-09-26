/* THE SECOND AGHOST LAYOUT -- delivery down the rows.
 *
 * Six real pages captured by the 2026-09-26 board sweep, kept under new names so
 * these tests do not depend on fixtures/board-sweep/. Every one was refused by
 * the adapter as "no delivery columns in the DataGrid header" although the
 * figures, the offset and the header were all on the page.
 *
 * The adapter does not check cash - basis = futures (buildFile does). What is
 * pinned here is that it reads each column by its own label and refuses, not
 * guesses, when the labels are not ones it knows. The mutations swap columns
 * and each one must break something. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract, AghostRefused } from "../lib/adapters/aghost.mjs";
import { linkedBoards } from "../scripts/board-sweep.mjs";

const load = (f) => readFileSync(new URL("../fixtures/" + f, import.meta.url), "utf8");
const PAGES = {
  "aghost-rows-harmony.html":          { n: 6,  commodity: "CORN",           location: null,                  first: [4.51, -0.77, "Sep26"] },
  "aghost-rows-glaciallakes.html":     { n: 7,  commodity: "#2YC",           location: null,                  first: [4.59, -0.69, "Sept"] },
  "aghost-rows-poet-ashton.html":      { n: 11, commodity: "CORN",           location: null,                  first: [4.93, -0.35, "SEPT 26"] },
  "aghost-rows-poet-binghamlake.html": { n: 4,  commodity: "CORN",           location: null,                  first: [4.73, -0.55, "SEP 2026"] },
  "aghost-rows-cfs.html":              { n: 10, commodity: "CORN",           location: null,                  first: [4.70, -0.58, "Sep26"] },
  "aghost-rows-eenergyadams.html":     { n: 17, commodity: "#2 YELLOW CORN", location: "E Energy Adams, LLC", first: [4.90, -0.38, "Sept 2026"] },
};
/* Cash and basis are each shown to 2dp, so cash - basis is within a cent of the
   futures price; a swapped column is off by hundreds. */
const residual = (r) => Math.abs((r.cash - r.basis) * 100 - r.futuresPrice);

for (const [f, want] of Object.entries(PAGES)) {
  test(`${f}: ${want.n} rows, read by label, identity holds`, () => {
    const rows = extract(load(f), f);
    assert.equal(rows.length, want.n);
    for (const r of rows) {
      assert.ok(residual(r) <= 1, `${r.delivery}: cash ${r.cash} basis ${r.basis} futures ${r.futuresPrice}`);
      assert.equal(r.commodity, want.commodity);
      assert.equal(r.location, want.location);
      assert.equal(r.locationId, want.location);
      assert.equal(r.futuresFlag, "s");
      assert.match(r.futures, /^@C\d[A-Z]$/);
    }
    assert.deepEqual([rows[0].cash, rows[0].basis, rows[0].delivery], want.first);
  });
}

/* ── mutations: each must fail ──────────────────────────────────────────── */

/** Swap two header labels (the leaf header only: the first occurrence pair). */
const swapLabels = (html, a, b) =>
  html.replace(new RegExp(`(<th[^>]*>)${a}(</th>)`), "$1@@$2")
      .replace(new RegExp(`(<th[^>]*>)${b}(</th>)`), `$1${a}$2`)
      .replace("@@", b);

test("MUTATION: Cash Price and Basis labels swapped -> identity is off by hundreds", () => {
  for (const f of ["aghost-rows-harmony.html", "aghost-rows-poet-ashton.html", "aghost-rows-glaciallakes.html"]) {
    const html = load(f);
    const swapped = swapLabels(html, "Cash Price", "Basis");
    assert.notEqual(swapped, html, `${f}: the mutation did not apply`);
    const rows = extract(swapped, f);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => residual(r) > 100), `${f}: a swapped column still balanced`);
  }
});

test("MUTATION: Futures Month and Futures Price swapped -> nothing is read", () => {
  const html = load("aghost-rows-harmony.html");
  const swapped = swapLabels(html, "Futures Month", "Futures Price");
  assert.notEqual(swapped, html);
  assert.equal(extract(swapped, "x").length, 0, "a month read as a price must not produce rows");
});

test("MUTATION: Central Farm Service's Cash and Basis labels swapped -> identity fails", () => {
  const html = load("aghost-rows-cfs.html");
  const swapped = swapLabels(html, "Cash", "Basis");
  assert.notEqual(swapped, html);
  assert.ok(extract(swapped, "x").every((r) => residual(r) > 100));
});

test("MUTATION: an unknown column label is refused, not guessed", () => {
  const html = load("aghost-rows-harmony.html").replace(">Basis</th>", ">Spread</th>");
  assert.throws(() => extract(html, "x"), (e) => e instanceof AghostRefused && /no delivery columns/.test(e.message));
});

test("MUTATION: a repeated label is refused", () => {
  const html = load("aghost-rows-harmony.html").replace(">Futures Change</th>", ">Basis</th>");
  assert.throws(() => extract(html, "x"), AghostRefused);
});

test("MUTATION: the cash column loses its label -> a figure in an unlabelled column is refused", () => {
  const html = load("aghost-rows-harmony.html").replace(">Cash Price</th>", "></th>");
  assert.throws(() => extract(html, "x"), AghostRefused);
});

test("MUTATION: no commodity on the page -> refused, not invented", () => {
  const html = load("aghost-rows-harmony.html").replace('name="commodity-ldp"', 'name="something-else"');
  assert.throws(() => extract(html, "x"), (e) => e instanceof AghostRefused && /commodity is not invented/.test(e.message));
});

test("MUTATION: a row with the wrong cell count that carries figures is refused", () => {
  const html = load("aghost-rows-harmony.html")
    .replace(/(\n\s*Sep26\s*<\/td>)/, "$1<td>extra</td>");
  assert.throws(() => extract(html, "x"), (e) => e instanceof AghostRefused && /guess/.test(e.message));
});

test("MUTATION: a doctored offset comment still refuses (the existing guard is not bypassed)", () => {
  const html = load("aghost-rows-harmony.html").replace(/NoScrapeOffset:\s*-?[\d.]+/, "NoScrapeOffset: -60.707");
  assert.throws(() => extract(html, "x"), (e) => e instanceof AghostRefused && /does not negate/.test(e.message));
});

test("MUTATION: no displayNumber() definition -> refused before any figure is read", () => {
  const html = load("aghost-rows-harmony.html").replace(/function\s+displayNumber/g, "function somethingElse");
  assert.throws(() => extract(html, "x"), (e) => e instanceof AghostRefused && /could not derive the offset/.test(e.message));
});

/* ── what is still refused ──────────────────────────────────────────────── */

test("Topflight (locations across the columns, cash column unlabelled) is still refused", () => {
  assert.throws(() => extract(load("aghost-matrix-topflight.html"), "x"),
    (e) => e instanceof AghostRefused && /no delivery columns in the DataGrid header/.test(e.message));
});

test("Great Lakes Grain's page has no board in it, only an iframe to one", () => {
  const html = load("aghost-iframe-greatlakesgrain.html");
  assert.throws(() => extract(html, "x"), AghostRefused);
  assert.deepEqual(linkedBoards(html, "https://greatlakesgrain.com/cash-bids", "aghost"),
    ["https://cashbids.greatlakesgrain.com/index.cfm?show=11&mid=25"]);
});

test("Flash Grain's layout still reads through the original path", () => {
  const rows = extract(load("flashgrain-cashbids-2026-08-19.html"), "x");
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.location && r.locationId === r.location));
});

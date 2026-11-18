/* NEW COOPERATIVE'S BOARD AT NEWCOOP.COM, NO WWW (2026-11-18).
 * capture.yml run 44222177904 (02:18 UTC) loaded both addresses in the runner's
 * ordinary browser: www.newcoop.com/cash-bids gave Cloudflare's check page
 * (44,603 bytes), newcoop.com/cash-bids gave the board (650,790 bytes, 69
 * locations, 822 rows). The fixture is four tables cut byte for byte from that
 * page: Afton, Cainsville, Morton Mills and Mt. Ayr. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extract, sections, BOARD_URL } from "../lib/adapters/newcoop.mjs";
import { buildFile } from "../lib/board.mjs";
import { loadSources, toConfig, acceptOf } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { botCheckMarks, botCheckWaiting } from "../lib/breaker.mjs";

const ROOT = new URL("../", import.meta.url);
const PAGE = readFileSync(new URL("fixtures/newcoop-cashbids-2026-11-18-apex.html", ROOT), "utf8");
const src = (id) => JSON.parse(readFileSync(new URL(`sources/${id}.json`, ROOT), "utf8"));
const THREE = [["newcoop-mortonmills", "Morton Mills"], ["newcoop-cainsville", "Cainsville"], ["newcoop-mtayr", "Mt. Ayr"]];

test("the board is read at newcoop.com, without www", () => {
  assert.equal(BOARD_URL, "https://newcoop.com/cash-bids");
});

test("the Nov 18 page reads: four locations, every row a readable board row", () => {
  assert.deepEqual(sections(PAGE).map((s) => s.name), ["Afton", "Cainsville", "Morton Mills", "Mt. Ayr"]);
  const rows = extract(PAGE, BOARD_URL);
  assert.equal(rows.length, 48);
  for (const name of ["Afton", "Cainsville", "Morton Mills", "Mt. Ayr"])
    assert.equal(rows.filter((r) => r.locationId === name).length, 12, `${name} rows`);
  for (const r of rows) assert.equal(r.source, BOARD_URL);
});

test("Afton corn Nov 2026: $4.11, basis -35, futures 446-0", () => {
  const r = extract(PAGE, BOARD_URL).find((x) => x.locationId === "Afton" && x.commodity === "Corn"
    && x.delivery === "01 Nov 2026 to 30 Nov 2026");
  assert.ok(r, "Afton Nov corn row");
  assert.deepEqual([r.cash, r.basisCents, r.futuresPrice], [4.11, -35, 446]);
});

test("every row proves itself: cash = (futures + basis) / 100, to the cent the board rounds to", () => {
  const rows = extract(PAGE, BOARD_URL);
  for (const r of rows) {
    const cents = r.futuresPrice + r.basisCents;
    const c = Math.round(r.cash * 100);
    assert.ok(c === Math.floor(cents) || c === Math.ceil(cents), `${r.raw}: ${c} is not ${cents} rounded to a cent`);
  }
  assert.ok(rows.some((r) => r.cash * 100 === r.futuresPrice + r.basisCents));
});

test("the page is the board by the accept check; the www check page is not", () => {
  assert.equal(acceptOf("newcoop")(PAGE), true);
  assert.equal(acceptOf("newcoop")('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>'), false);
});

for (const [id, name] of THREE) {
  test(`${id}: its source reads newcoop.com and publishes every row of "${name}" from the Nov 18 page`, () => {
    const m = src(id);
    assert.equal(m.url, BOARD_URL);
    assert.equal(m.browserPage, BOARD_URL);
    const { sources } = loadSources([m]);
    assert.equal(sources.length, 1);
    const built = buildFile(PAGE, { now: "2026-11-18T02:18:25.842Z", sourceUrl: m.url, source: toConfig(sources[0]), extract: adapterFor("newcoop", null) });
    assert.equal(built.file.count, 12, `${id} rows`);
    assert.equal((built.file.withheld ?? []).length, 0, `${id} withheld rows`);
  });
}

test("every NEW Cooperative source reads the address without www", () => {
  const ids = readdirSync(new URL("sources/", ROOT)).filter((f) => /^newcoop-.*\.json$/.test(f));
  assert.equal(ids.length, 69);
  for (const f of ids) {
    const m = JSON.parse(readFileSync(new URL(`sources/${f}`, ROOT), "utf8"));
    assert.deepEqual([m.url, m.browserPage], [BOARD_URL, BOARD_URL], f);
  }
});

test("a bot check mark carried from the www address still holds the page at newcoop.com", () => {
  /* the marks ride on index rows by source id, so a check seen before the move holds the new page too */
  const key = (s) => `${s.browserPage ?? ""}|${s.url}`;
  const srcs = THREE.map(([id]) => src(id));
  const at = Date.parse("2026-11-18T01:00:00Z");
  const rows = new Map([[srcs[0].id, { botCheckAt: "2026-11-18T01:00:00Z" }]]);
  const marks = botCheckMarks(srcs, rows, key);
  assert.equal(marks.size, 1, "one page, however many sources sit on it");
  assert.equal(marks.get(key(srcs[1])), at);
  assert.equal(botCheckWaiting(marks, key(srcs[2]), at + 10 * 60_000, 3), true);
  assert.equal(botCheckWaiting(marks, key(srcs[2]), at + 3 * 3600_000, 3), false);
});

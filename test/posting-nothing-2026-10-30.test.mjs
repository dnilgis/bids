/* A YARD IN THE SELECTOR WITH NO BID UP IS POSTING NOTHING -- 2026-10-30.
 *
 * On 2026-10-30 (data/index.json, 40 passes from 2026-10-29 18:08Z) twenty-five
 * AgriCharts cashgrid sources were refused on every pass as "parsed N bids but
 * none for location X". Each X is in that page's own location_filter selector
 * and carries no writeBidCell at all: the operator keeps the yard on the
 * account and has no bid up there. StateLine's own bid page said the same on
 * 2026-10-18 (capture.yml run 39090126520, cashbids-js.php filter=all): Lone
 * Rock in the location list, not one row for it.
 *
 * That is the empty board poll.mjs already counts as "posting nothing". A
 * yard whose cells exist but were all refused is a board we could not read,
 * and stays an ordinary refusal. Every page below is a committed capture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildFile, Refused } from "../lib/board.mjs";
import { mergeQuotes } from "../lib/adapters/agricharts.mjs";
import { extract } from "../lib/adapters/agricharts-cashgrid.mjs";
import { toConfig, validateSource } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "fixtures");
const read = (f) => readFileSync(join(DIR, f), "utf8");
const manifest = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));
const CONTRACTS = mergeQuotes(readdirSync(DIR).filter((f) => /^agricharts-quotes-/.test(f)).map(read));
const NOW = new Date("2026-09-03T15:00:00Z");

const refusal = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof Refused, e.message); return e; }
  assert.fail("expected a refusal");
};
const build = (board, id, over = {}) => {
  const m = { ...manifest(id), ...over };
  return buildFile(read(`agricharts-cashgrid-${board}.html`), {
    now: NOW, sourceUrl: m.url, source: toConfig(m),
    extract: (html, url) => extract(html, url, { contracts: CONTRACTS }),
  });
};

/* The real refused sources whose board is a committed capture, and the
   capture shows the same thing the live pages did on 2026-10-30. */
const EMPTY = [
  ["innovativeag", "innovativeag-altavista"],
  ["innovativeag", "innovativeag-austinvill"],
  ["fsgrain", "fsgrain-exlinestorage"],
  ["fsgrain", "fsgrain-lisboncenterstorage"],
  ["fsgrain", "fsgrain-sycamore"],
  ["fsgrain", "fsgrain-odell"],
  ["linncoop", "linncoop-springvilleelevator"],
  ["ridgevilleelevator", "ridgevilleelevator-malinta"],
];

for (const [board, id] of EMPTY) {
  test(`${id}: in the selector, no price cell, so the board is posting nothing`, () => {
    const m = manifest(id);
    assert.deepEqual(validateSource(m, new Set()), []);
    const e = refusal(() => build(board, id));
    assert.equal(e.empty, true, e.message);
    assert.match(e.message, new RegExp(`location ${m.locationId} is in the feed and posts no current bid`));
  });
}

test("the adapter names only selector yards with no cell, never one with cells", () => {
  const rows = extract(read("agricharts-cashgrid-innovativeag.html"), "https://x/", { contracts: CONTRACTS });
  assert.ok(rows.present instanceof Set);
  assert.ok(rows.present.has("4641") && rows.present.has("4626"));
  const withRows = new Set(rows.map((r) => r.locationId));
  for (const id of rows.present) assert.equal(withRows.has(id), false, `${id} has rows and is called empty`);
  /* Alden (4625) has bids on this capture. */
  assert.equal(rows.present.has("4625"), false);
  assert.equal(Object.keys(rows).includes("present"), false, "present must not be enumerable");
});

test("a yard that has cells still publishes, and one not on the page at all still refuses plainly", () => {
  /* Alden posts on the Innovative Ag capture: same manifest, its id. */
  const built = build("innovativeag", "innovativeag-altavista", { locationId: "4625", location: "Alden" });
  assert.ok(built.file.count > 0);
  /* An id the page does not list anywhere is a lost location, not an empty one. */
  const e = refusal(() => build("innovativeag", "innovativeag-altavista", { locationId: "999999" }));
  assert.notEqual(e.empty, true);
  assert.match(e.message, /parsed \d+ bids but none for location 999999/);
});

test("a yard whose cells were all refused is not called empty", () => {
  /* NOT A CAPTURE: the Innovative Ag capture with Alden's (4625) cells pointed
     at a contract no quote page carries. The cells are still there, only
     unreadable; every other yard reads as before. */
  const html = read("agricharts-cashgrid-innovativeag.html")
    .replace(/(l=4625&[^)]*quotes\[')Z[CS][A-Z]\d{2}('\])/g, "$1ZCZ99$2");
  assert.notEqual(html, read("agricharts-cashgrid-innovativeag.html"));
  const rows = extract(html, "https://x/", { contracts: CONTRACTS });
  assert.equal(rows.some((r) => r.locationId === "4625"), false);
  assert.equal(rows.present.has("4625"), false, "a yard with cells is never in present, read or not");
  const m = { ...manifest("innovativeag-altavista"), locationId: "4625", location: "Alden" };
  const e = refusal(() => buildFile(html, { now: NOW, sourceUrl: m.url, source: toConfig(m),
    extract: (h, u) => extract(h, u, { contracts: CONTRACTS }) }));
  assert.notEqual(e.empty, true, e.message);
});

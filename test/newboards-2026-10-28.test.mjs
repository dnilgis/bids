/* THE OCT 28 CANDIDATE BOARDS (OH, MO). A research list named public cash-bid
 * pages, unverified. capture.yml run 40626357705 loaded each one; the
 * locations an existing adapter reads that this repository did not already
 * read were written as manifests, and their bytes are the fixtures here. Each
 * manifest must name a location that is really on its board, carry that
 * board's own date, and publish from the capture through every guard with
 * nothing withheld. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFile } from "../lib/board.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { filterLocation } from "../lib/parse.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const NOW = new Date("2026-10-28T03:30:00Z");
const SF = "fixtures/cashbidssingle-smithfieldgrain-cashbids-2026-10-28.html";
const TR = "fixtures/cashbidssingle-smithfieldgrain-1960-2026-10-28.html";
const SC = "fixtures/cashbidssingle-scoularview-2026-10-28.html";

/* id -> [fixture, rows the capture carried for that location, the board's own label] */
const BOARDS = {
  "smithfieldgrain-harpster": [SF, 1, "Harpster"],
  "smithfieldgrain-morral": [SF, 1, "Morral, OH"],
  "smithfieldgrain-bethanyeast": [SF, 2, "Bethany East, MO"],
  "smithfieldgrain-bethanywest": [SF, 2, "Bethany West, MO"],
  "smithfieldgrain-blueridge": [SF, 2, "Blue Ridge, MO"],
  "smithfieldgrain-coffey": [SF, 2, "Coffey, MO"],
  "smithfieldgrain-gilmancity": [SF, 2, "Gilman City, MO"],
  "smithfieldgrain-laclede": [SF, 2, "Laclede, MO"],
  "smithfieldgrain-nevada": [SF, 1, "Nevada, MO"],
  "smithfieldgrain-trenton": [TR, 2, "Trenton, MO"],
  "scoularview-adrian": [SC, 4, "Scoular Adrian Cash Bids"],
};

const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

for (const [id, [fixture, rows, label]] of Object.entries(BOARDS)) {
  test(`${id}: on its captured board, dated by the board, and publishes from it with nothing withheld`, () => {
    const m = JSON.parse(rd(`sources/${id}.json`));
    assert.deepEqual(validateSource(m), [], id);
    assert.equal(m.enabled, true);
    assert.match(m.note, /capture\.yml run 40626357705/, "the note names the capture it was written from");
    assert.match(m.note, /PLACE: /, "the note says how the town was decided");
    const body = rd(fixture);
    const all = adapterFor(m.platform)(body, m.url);
    const { kept } = filterLocation(all, m.locationId);
    assert.equal(kept.length, rows, `${id}: rows for location ${m.locationId}`);
    assert.ok(kept.every((r) => r.location === label), `${id}: every row sits under the board's own label`);
    /* The board's own date: the section header for this location, then its own "Cash bids for" line. */
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const date = new RegExp(`${esc} (?:(?!Cash bids for).){0,300}Cash bids for ([A-Za-z]+, [A-Za-z]+ \\d{2}, \\d{4})`).exec(text(body));
    assert.ok(date, `${id}: section ${label} is on the page with its own date`);
    assert.equal(date[1], "Tuesday, October 27, 2026", `${id}: the board's own date`);
    const b = buildFile(body, { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: adapterFor(m.platform) });
    assert.equal(b.file.status, "ok");
    assert.equal(b.file.count, rows);
    assert.equal((b.file.withheld ?? []).length, 0, `${id} withheld rows`);
    for (const x of b.file.bids) {
      assert.ok(x.commodity && x.delivery, `${id}: commodity and delivery read`);
      assert.ok(Number.isFinite(x.cash) && Number.isFinite(x.basisCents), `${id}: cash and basis read`);
    }
    /* No coordinate is invented here: geocode fill adds one and says how. */
    assert.equal(m.lat, null);
    assert.equal(m.lon, null);
  });
}

test("Harpster: the board's one corn row is the price and basis the capture shows", () => {
  const m = JSON.parse(rd("sources/smithfieldgrain-harpster.json"));
  const b = buildFile(rd(SF), { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: adapterFor(m.platform) });
  assert.deepEqual(b.file.bids.map((x) => [x.commodity, x.delivery, x.cash, x.basisCents]), [["Corn", "October", 4.39, -10]]);
});

test("Lucerne is already read from this company and is not written twice", () => {
  const ids = Object.keys(BOARDS);
  const lucerne = JSON.parse(rd("sources/smithfieldgrainobushelsites-lucerne.json"));
  assert.equal(lucerne.locationId, "1699");
  assert.ok(!ids.some((id) => JSON.parse(rd(`sources/${id}.json`)).locationId === "1699"));
  /* and Adrian is not one of the Scoular yards already read from the same page */
  for (const id of ["scoularview-harrisonville", "scoularview-butterfield", "scoularview-covington"]) {
    assert.notEqual(JSON.parse(rd(`sources/${id}.json`)).locationId, "1926");
  }
});

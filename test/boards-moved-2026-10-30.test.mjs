/* BOARDS WHOSE PAGE CHANGED OR MOVED -- 2026-10-30.
 *
 * Every source here was broken or refused on all 40 passes from 2026-10-29
 * 18:08Z to 2026-10-30 00:24Z. Each was traced to its
 * operator's own page in the runner's browser (capture.yml runs 40981238561
 * and 40981969844, branch caps-bidslive), and the response that page read is
 * in test/fixtures/bidslive-2026-10-30/.
 *
 *   Southeast Farmers (4)   layout: cells now name quotes['zcz6'], not 'ZCZ26'
 *   Ag Plus (6)             mobile board answers 500; their cashgrid has them
 *   Siouxland Energy        the same
 *   Farmers Coop Society    their fragment is 404; their page reads DTN E0014201
 *   VERBIO Nevada           their site moved its bids to Grain Discovery
 *   Cooperative Elevator    grower.coopelev.com "has moved"; www has the board
 *
 * Every board below publishes through the real buildFile with the committed
 * manifest. No guard moves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildFile } from "../lib/board.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { mergeQuotes } from "../lib/adapters/agricharts.mjs";
import { extract as cashgrid, parseCells, longSymbol } from "../lib/adapters/agricharts-cashgrid.mjs";
import { toConfig, validateSource } from "../lib/sources.mjs";
import { filterLocation } from "../lib/parse.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CAP = join(ROOT, "test", "fixtures", "bidslive-2026-10-30");
const cap = (f) => readFileSync(join(CAP, f), "utf8");
const manifest = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));
const FIX = join(ROOT, "fixtures");
const CONTRACTS = mergeQuotes(readdirSync(FIX).filter((f) => /^agricharts-quotes-/.test(f))
  .map((f) => readFileSync(join(FIX, f), "utf8")));
const NOW = new Date("2026-10-30T01:00:00Z");

const extractFor = (platform) => (html, url) => adapterFor(platform)(html, url, { contracts: CONTRACTS });
const publish = (id, file) => {
  const m = manifest(id);
  assert.deepEqual(validateSource(m, new Set()), [], id);
  return buildFile(cap(file), { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: extractFor(m.platform) });
};

/* ── Southeast Farmers: the short contract form ─────────────────────────── */

test("longSymbol: the year digit comes back from the cell's own delivery code", () => {
  assert.equal(longSymbol("zcz6", "V26"), "ZCZ26");
  assert.equal(longSymbol("zch7", "H27"), "ZCH27");
  assert.equal(longSymbol("zsf7", "X26"), "ZSF27", "a contract is never earlier than the month it prices");
  assert.equal(longSymbol("zcz9", "Z29"), "ZCZ29");
  assert.equal(longSymbol("zch0", "Z29"), "ZCH30", "across a decade");
  assert.equal(longSymbol("ZCZ26", "V26"), "ZCZ26", "the long form is untouched");
  assert.equal(longSymbol("kez6", "V26"), "KEZ26");
  assert.equal(longSymbol(null, "V26"), null);
  assert.equal(longSymbol("zcz6", "bad"), "ZCZ6", "no delivery code, no guess: written as is, and check 1 refuses it");
});

test("Southeast Farmers: the 2026-10-30 board parses, every cell named against a long symbol", () => {
  const html = cap("cashgrid-sfccbjsi.html");
  assert.match(html, /quotes\['zcz6'\]/, "the capture is the short-form board");
  const { cells } = parseCells(html);
  assert.equal(cells.length, 72);
  for (const c of cells) assert.match(c.symbol, /^Z[CS][FHKNUXZ]\d{2}$/, c.symbol);
  const rows = cashgrid(html, "https://x/", { contracts: CONTRACTS });
  const per = {};
  for (const r of rows) per[r.locationId] = (per[r.locationId] ?? 0) + 1;
  assert.deepEqual(per, { 76143: 18, 29212: 18, 29213: 18, 86966: 18 });
});

for (const id of ["sfccbjsi-beresford", "sfccbjsi-centerville", "sfccbjsi-meckling", "sfccbjsi-terminal"]) {
  test(`${id}: publishes from the short-form board`, () => {
    const b = publish(id, "cashgrid-sfccbjsi.html");
    assert.equal(b.file.count, 18);
  });
}

/* ── Ag Plus and Siouxland Energy: mobile board gone, cashgrid has them ─── */

const MOVED_TO_CASHGRID = [
  ["agplusinc-garrett", "cashgrid-agplusinc.html", 8],
  ["agplusinc-southwhitley", "cashgrid-agplusinc.html", 8],
  ["agplusinc-edgerton", "cashgrid-agplusinc.html", 8],
  ["agplusinc-monroeville", "cashgrid-agplusinc.html", 8],
  ["agplusinc-raber", "cashgrid-agplusinc.html", 8],
  ["agplusinc-churubusco", "cashgrid-agplusinc.html", 8],
  ["siouxlandenergy-siouxlandenergy", "cashgrid-siouxlandenergy.html", 11],
];
for (const [id, file, n] of MOVED_TO_CASHGRID) {
  test(`${id}: on its operator's cashgrid, and publishes from it`, () => {
    const m = manifest(id);
    assert.equal(m.platform, "agricharts-cashgrid");
    assert.equal(m.identityAlternative, "agricharts-cashgrid:contract-named+heading-agrees");
    assert.match(m.note, /capture\.yml run 4098(1238561|1969844)/);
    assert.doesNotMatch(m.url, /\/\/mobile\./);
    const b = publish(id, file);
    assert.equal(b.file.count, n);
  });
}

/* ── Farmers Cooperative Society: their page reads DTN now ──────────────── */

test("farmerscoop-siouxcenter: the DTN site their page reads, location 3523, 12 rows", () => {
  const m = manifest("farmerscoop-siouxcenter");
  assert.equal(m.platform, "dtn-cs");
  assert.equal(m.browserPage, "https://www.farmerscoopsociety.com/cash-bids");
  assert.equal(m.siteId, "E0014201");
  assert.ok(m.url.includes(`/sites/${m.siteId}/`));
  assert.equal(m.cashRounding, "round-cent");
  const all = adapterFor("dtn-cs")(cap("dtncs-farmerscoopsociety.json"), m.url);
  assert.equal(filterLocation(all, m.locationId).kept.length, 12);
  const b = publish("farmerscoop-siouxcenter", "dtncs-farmerscoopsociety.json");
  assert.equal(b.file.count, 12);
  assert.ok(b.file.bids.every((r) => /^(Corn|Soybeans)/.test(r.commodity)), "only the banded crops publish");
});

/* ── VERBIO Nevada: Grain Discovery, the same feed South Bend reads ──────── */

test("verbionorthamericallc-nevada: Grain Discovery destination Nevada, 6 rows, exact", () => {
  const m = manifest("verbionorthamericallc-nevada");
  assert.equal(m.platform, "graindesk");
  assert.equal(m.locationId, "Nevada");
  assert.equal(m.url, manifest("southbendethanol-southbend").url, "one feed, two destinations");
  assert.equal("browserPage" in m, false);
  assert.equal("cashRounding" in m, false, "measured exact; nothing to declare");
  const b = publish("verbionorthamericallc-nevada", "graindesk-verbio.json");
  assert.equal(b.file.count, 6);
  /* And South Bend still reads its own six from the same body. */
  assert.equal(publish("southbendethanol-southbend", "graindesk-verbio.json").file.count, 6);
});

/* ── Cooperative Elevator: their own cash bid page ──────────────────────── */

test("coopelev-coopelev: their own board, location 3628, publishes", () => {
  const m = manifest("coopelev-coopelev");
  assert.equal(m.platform, "cashbidssingle");
  assert.equal(m.url, "https://www.coopelev.com/cashbidssingle-");
  assert.equal(m.futuresUnits, "dollars");
  assert.equal("browserPage" in m, false);
  /* NOT THE WHOLE PAGE: the capture's bid section (scripts, styles and the
     960 KB of site navigation cut away). It parses to the same 12 rows the
     full 1.3 MB capture did. */
  const all = adapterFor("cashbidssingle")(cap("cashbidssingle-coopelev.html"), m.url);
  assert.equal(all.length, 12);
  const b = publish("coopelev-coopelev", "cashbidssingle-coopelev.html");
  assert.ok(b.file.count >= 8, `${b.file.count} published`);
});

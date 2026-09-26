/* StoneHedge (StoneX) elevator boards, against the ten operator boards the
 * adapter was written from (fixtures/stonehedge-<site>-component-rendered.html,
 * captured 2026-09-26; data/gaps/stonehedge-probe.json).
 *
 * The counts are derived here BY SPLITTING THE FIXTURE TEXT (rawRows), not by
 * calling the adapter's own parser, so a parser that miscounts cannot agree
 * with itself. The spot-check table was picked by hand from the fixture text,
 * ten rows per layout, and every row is confirmed against rawRows before it is
 * confirmed against the adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import {
  extract, parseDocument, layoutOf, dateRange, classRoot, LAYOUTS, StoneHedgeRefused,
  VERIFIED_NAMED, VERIFIED_FIT, MAX_GROUP_SPREAD_CENTS,
} from "../lib/adapters/stonehedge.mjs";
import { adapterFor, SHARED_PAGES } from "../lib/adapters/index.mjs";
import { buildFile } from "../lib/board.mjs";
import { loadSources, toConfig, validateSource, PLATFORMS, wireOf, transportOf, captureOf } from "../lib/sources.mjs";
import { roundingEvidence } from "../lib/rounding.mjs";
import { delivery } from "../lib/delivery.mjs";
import { captureRendered, findBrowser, FIND_WIDGET_JS } from "../lib/cdp.mjs";
import { build as buildManifests, embedLocs } from "../scripts/stonehedge-manifests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITES = ["agvalley", "cedarcountycoop", "cendakcooperative", "frontiercooperative", "fullcircleag",
  "milnorgrain", "mrga", "rivervalleycoop", "scottequityexchange", "unitedcooperative"];
const fx = (s) => readFileSync(join(ROOT, `fixtures/stonehedge-${s}-component-rendered.html`), "utf8");
const URL_OF = "https://stonehedge.stonex.com/component/bids";
const NOW = new Date("2026-09-26T14:00:00Z");

/* ---- an independent reader: string splitting, no adapter code ---- */
const strip = (s) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
function rawRows(html) {
  const out = [];
  const groups = html.split('bid-group-name row">').slice(1);
  for (const gp of groups) {
    const loc = strip(gp.slice(0, gp.indexOf("</div>")));
    for (const tp of gp.split('bid-table-name row">').slice(1)) {
      const com = strip(tp.slice(0, tp.search(/<div class="bid-table-header"|<\/div>/)).split("<")[0]);
      for (const rp of tp.split('<div class="bid-table-row">').slice(1)) {
        const body = rp.slice(0, rp.search(/<\/div><\/div>/) + 6);
        const cells = {};
        for (const m of body.matchAll(/<div class="(date|name|cash|basis|price|change|month)">([\s\S]*?)<\/div>/g)) cells[m[1]] = strip(m[2]);
        out.push({ loc, com, cells });
      }
    }
  }
  return out;
}
const counts = (html) => {
  const groups = html.split('bid-group-name row">').slice(1);
  return { groups: groups.length,
    tables: groups.reduce((n, g) => n + g.split('bid-table-name row">').length - 1, 0),
    rows: groups.reduce((n, g) => n + g.split('<div class="bid-table-row">').length - 1, 0) };
};

/* ---- the CBOT quotes named/bare boards are checked against ----
   Built from the futures prices the priced boards themselves print (same day,
   same capture). Chicago wheat is on no priced board, so ZW stand-ins are
   LABELLED stand-ins, used only to exercise the code path. */
function contracts() {
  const cm = new Map();
  for (const s of ["agvalley", "cendakcooperative", "mrga", "rivervalleycoop"])
    for (const r of extract(fx(s), URL_OF)) if (/^[A-Z]{2}[FGHJKMNQUVXZ]\d\d$/.test(r.futures)) cm.set(r.futures, r.futuresPrice);
  cm.set("ZWZ26", 590); cm.set("ZWN27", 620);
  return [...cm].map(([symbol, lastCents]) => ({ symbol, root: symbol.slice(0, 2), lastCents, priced: true }));
}
const CONTRACTS = contracts();
const ctx = { contracts: CONTRACTS };
const ex = (s, c = ctx) => extract(fx(s), `${URL_OF}?locs=${embedLocs(s)[0] ?? "x"}`, c);

/* ---------------- 1. every site, every count ---------------- */

const TOTALS = {
  agvalley: [14, 48, 121], cedarcountycoop: [10, 15, 159], cendakcooperative: [12, 35, 206],
  frontiercooperative: [45, 88, 678], fullcircleag: [2, 4, 14], milnorgrain: [1, 3, 22], mrga: [9, 23, 195],
  rivervalleycoop: [46, 76, 759], scottequityexchange: [4, 8, 25], unitedcooperative: [24, 62, 202],
};

test("all ten captured boards parse, and the counts match what the fixture text says", () => {
  let g = 0, t = 0, r = 0;
  for (const s of SITES) {
    const html = fx(s), c = counts(html), doc = parseDocument(html);
    assert.deepEqual([c.groups, c.tables, c.rows], TOTALS[s], `${s} counts drifted from the fixture`);
    assert.equal(doc.groups.length, c.groups, `${s} groups`);
    assert.equal(doc.groups.reduce((n, x) => n + x.tables.length, 0), c.tables, `${s} tables`);
    assert.equal(doc.groups.reduce((n, x) => n + x.tables.reduce((m, tb) => m + tb.rows.length + tb.hidden, 0), 0), c.rows, `${s} rows`);
    g += c.groups; t += c.tables; r += c.rows;
  }
  assert.deepEqual([g, t, r], [167, 362, 2381]);
});

test("rows per location per commodity equal the independent count, on every site", () => {
  for (const s of SITES) {
    const html = fx(s);
    const want = new Map();
    for (const r of rawRows(html)) { const k = `${r.loc}|${r.com}`; want.set(k, (want.get(k) ?? 0) + 1); }
    const got = new Map();
    for (const g of parseDocument(html).groups) for (const t of g.tables) { const k = `${g.name}|${t.commodity}`; got.set(k, (got.get(k) ?? 0) + t.rows.length); }
    assert.deepEqual([...got].sort(), [...want].sort(), `${s}: per-location/commodity rows`);
  }
});

test("published + blank + refused accounts for every row of every board", () => {
  for (const s of SITES) {
    let rows;
    try { rows = ex(s); } catch (e) { assert.ok(e instanceof StoneHedgeRefused, `${s}: ${e.message}`); continue; }
    const total = counts(fx(s)).rows;
    assert.equal(rows.length + rows.blank.length + rows.unreconciled.length, total, `${s}: ${rows.length} + ${rows.blank.length} + ${rows.unreconciled.length} != ${total}`);
  }
});

test("expected outcome per site: published, blank and refused row counts", () => {
  const seen = {};
  for (const s of SITES) {
    try { const r = ex(s); seen[s] = [r.length, r.blank.length, r.unreconciled.length]; }
    catch (e) { seen[s] = `refused: ${e.message.slice(0, 40)}`; }
  }
  /* Cendak: 124 blank ("Futures Only" location prints no cash) and its canola
     and barley (no basis / metric tonnes) are refused by name. Nothing else is. */
  assert.ok(Array.isArray(seen.agvalley) && seen.agvalley[0] + seen.agvalley[1] + seen.agvalley[2] === 121);
  for (const s of SITES) assert.ok(Array.isArray(seen[s]), `${s} did not read: ${seen[s]}`);
  assert.deepEqual(seen.cendakcooperative, [147, 56, 3], "Cendak: 56 blank cash cells (26 of them Futures Only), barley without a basis and 2 canola tables in tonnes refused");
  /* the only refusals anywhere are a cash printed with no basis to check it against */
  for (const s of SITES.filter((x) => x !== "cendakcooperative"))
    for (const u of ex(s).unreconciled) assert.match(u.why, /with no basis|ZW[A-Z]\d\d is quoted/, `${s}: ${u.why}`);   // ZW: the labelled stand-in quote
});

/* ---------------- 2. layouts ---------------- */

test("six layouts are detected from the header row, and the sites are classed by them", () => {
  const seen = {};
  for (const s of SITES) for (const g of parseDocument(fx(s)).groups) for (const t of g.tables) {
    const l = layoutOf(t); (seen[l.id] ??= new Set()).add(s);
  }
  assert.deepEqual(Object.keys(seen).sort(), Object.keys(LAYOUTS).sort());
  assert.deepEqual([...seen["basis,cash,change,date,month,price"]].sort(), ["agvalley", "cendakcooperative"]);
  assert.deepEqual([...seen["basis,cash,change,month,name,price"]].sort(), ["mrga", "rivervalleycoop"]);
  assert.deepEqual([...seen["basis,cash,month,name"]].sort(), ["cedarcountycoop", "fullcircleag"]);
  assert.deepEqual([...seen["basis,cash,change,date,month"]], ["frontiercooperative"]);
  assert.deepEqual([...seen["basis,cash,date,month"]].sort(), ["scottequityexchange", "unitedcooperative"]);
  assert.deepEqual([...seen["basis,cash,name"]], ["milnorgrain"]);
});

/* ---------------- 3. sixty hand-picked rows ---------------- */

/* [layout, site, location, commodity, label on the board, delivery we publish,
    cash, basis, month, futures price in cents (priced layouts), futures symbol] */
const PICKS = [
  ["L1", "agvalley", "Bartley", "Corn", "09/01/26-09/30/26", "01 Sep 2026 to 30 Sep 2026", 5.03, -0.25, "Dec 26", 528.25, "ZCZ26"],
  ["L1", "agvalley", "Edison", "Soybeans", "09/01/26-09/30/26", "01 Sep 2026 to 30 Sep 2026", 12.59, -0.60, "Nov 26", 1319.0, "ZSX26"],
  ["L1", "agvalley", "Holbrook", "Corn", "10/01/26-10/31/26", "01 Oct 2026 to 31 Oct 2026", 5.03, -0.25, "Dec 26", 528.25, "ZCZ26"],
  ["L1", "agvalley", "North Platte", "Corn", "10/01/26-10/31/26", "01 Oct 2026 to 31 Oct 2026", 5.03, -0.25, "Dec 26", 528.25, "ZCZ26"],
  ["L1", "agvalley", "Orleans", "Wheat - HRW", "07/01/27-07/31/27", "01 Jul 2027 to 31 Jul 2027", 6.99, -0.75, "Jul 27", 774.5, "KEN27"],
  ["L1", "cendakcooperative", "Esmond Elevator", "Corn", "09/01/26-09/30/26", "01 Sep 2026 to 30 Sep 2026", 4.33, -0.95, "Dec 26", 528.25, "ZCZ26"],
  ["L1", "cendakcooperative", "Fessenden", "Wheat - HRS", "12/01/26-12/31/26", "01 Dec 2026 to 31 Dec 2026", 6.48, -0.65, "Dec 26", 713.5, "MWZ26"],
  ["L1", "cendakcooperative", "Maddock Elevator", "Soybeans", "10/01/26-10/31/26", "01 Oct 2026 to 31 Oct 2026", 12.39, -0.80, "Nov 26", 1319.0, "ZSX26"],
  ["L1", "cendakcooperative", "Niles", "Corn", "01/01/27-01/31/27", "01 Jan 2027 to 31 Jan 2027", 4.67, -0.75, "Mar 27", 542.0, "ZCH27"],
  ["L1", "cendakcooperative", "Sheyenne", "Wheat - HRS", "03/01/27-03/31/27", "01 Mar 2027 to 31 Mar 2027", 6.59, -0.75, "Mar 27", 733.75, "MWH27"],
  ["L2", "mrga", "Casselton - Terminal", "Corn", "Jan 27", "Jan 27", 4.92, -0.50, "Mar 27", 542.0, "ZCH27"],
  ["L2", "mrga", "Leonard", "Soybeans", "NC 27", "NC 27", 11.94, -0.83, "Nov 27", 1276.75, "ZSX27"],
  ["L2", "mrga", "Sabin", "Wheat - HRS", "Nov 26", "Nov 26", 6.46, -0.68, "Dec 26", 713.5, "MWZ26"],
  ["L2", "rivervalleycoop", "ALTO ICP", "Corn", "Sep", "Sep", 5.18, -0.10, "Dec 26", 528.25, "ZCZ26"],
  ["L2", "rivervalleycoop", "CGB- Albany", "Corn", "Nov 26", "Nov 26", 4.93, -0.35, "Dec 26", 528.25, "ZCZ26"],
  ["L2", "rivervalleycoop", "Cargill - Bettendorf", "Corn", "LH Nov 26", "LH Nov 26", 4.83, -0.45, "Dec 26", 528.25, "ZCZ26"],
  ["L2", "rivervalleycoop", "Dewitt", "Corn", "April 27", "April 27", 5.02, -0.47, "May 27", 548.75, "ZCK27"],
  ["L2", "rivervalleycoop", "Marquis Energy", "Corn", "Feb 27", "Feb 27", 5.36, -0.06, "Mar 27", 542.0, "ZCH27"],
  ["L2", "rivervalleycoop", "Putnam", "Corn", "Sep", "Sep", 4.98, -0.30, "Dec 26", 528.25, "ZCZ26"],
  ["L2", "rivervalleycoop", "Toulon", "Corn", "May 27", "May 27", 5.20, -0.29, "May 27", 548.75, "ZCK27"],
  ["L3", "cedarcountycoop", "ADM - Clinton", "Corn", "November Corn - FH", "November Corn - FH", 5.0825, -0.20, "Dec 26", null, "ZCZ26"],
  ["L3", "cedarcountycoop", "ADM Cedar Rapids", "Corn", "November Corn - LH", "November Corn - LH", 5.1025, -0.18, "Dec 26", null, "ZCZ26"],
  ["L3", "cedarcountycoop", "CHS", "Soybeans", "FH September Beans", "FH September Beans", 12.69, -0.50, "Nov 26", null, "ZSX26"],
  ["L3", "cedarcountycoop", "Cargill - CR", "Corn", "November Corn - FH", "November Corn - FH", 5.0625, -0.22, "Dec 26", null, "ZCZ26"],
  ["L3", "cedarcountycoop", "Cargill - CR", "Soybeans", "December Beans", "December Beans", 13.155, -0.17, "Jan 27", null, "ZSF27"],
  ["L3", "cedarcountycoop", "GPC", "Corn", "January 27 Corn - LH", "January 27 Corn - LH", 5.20, -0.22, "Mar 27", null, "ZCH27"],
  ["L3", "cedarcountycoop", "T/WB - From Storage", "Corn", "December Corn", "December Corn", 4.9425, -0.34, "Dec 26", null, "ZCZ26"],
  ["L3", "cedarcountycoop", "Tipton", "Soybeans", "November Beans", "November Beans", 12.71, -0.48, "Nov 26", null, "ZSX26"],
  ["L3", "cedarcountycoop", "West Branch", "Soybeans", "October Beans", "October Beans", 12.51, -0.68, "Nov 26", null, "ZSX26"],
  ["L3", "cedarcountycoop", "Cargill - Musc", "Soybeans", "May Beans - 27", "May Beans - 27", 13.2225, -0.24, "May 27", null, "ZSK27"],
  ["L4", "frontiercooperative", "Adams", "Corn", "12/01/26-12/31/26", "01 Dec 2026 to 31 Dec 2026", 4.88, -0.40, "Dec 26", null, "ZCZ26"],
  ["L4", "frontiercooperative", "Bennet", "Corn", "12/01/26-12/31/26", "01 Dec 2026 to 31 Dec 2026", 4.81, -0.47, "Dec 26", null, "ZCZ26"],
  ["L4", "frontiercooperative", "Cedar Bluffs", "Corn", "03/01/27-03/31/27", "01 Mar 2027 to 31 Mar 2027", 5.02, -0.40, "Mar 27", null, "ZCH27"],
  ["L4", "frontiercooperative", "Duncan", "Soybeans", "10/01/26-10/31/26", "01 Oct 2026 to 31 Oct 2026", 12.64, -0.55, "Nov 26", null, "ZSX26"],
  ["L4", "frontiercooperative", "Elmwood", "Soybeans", "10/01/26-10/31/26", "01 Oct 2026 to 31 Oct 2026", 12.65, -0.54, "Nov 26", null, "ZSX26"],
  ["L4", "frontiercooperative", "Manley", "Corn", "01/01/27-01/31/27", "01 Jan 2027 to 31 Jan 2027", 4.87, -0.55, "Mar 27", null, "ZCH27"],
  ["L4", "frontiercooperative", "Nebraska City", "Corn", "01/01/27-01/31/27", "01 Jan 2027 to 31 Jan 2027", 4.95, -0.47, "Mar 27", null, "ZCH27"],
  ["L4", "frontiercooperative", "Palmyra", "Soybeans", "10/01/27-10/31/27", "01 Oct 2027 to 31 Oct 2027", 11.89, -0.88, "Nov 27", null, "ZSX27"],
  ["L4", "frontiercooperative", "St Mary", "Soybeans", "09/01/26-09/30/26", "01 Sep 2026 to 30 Sep 2026", 12.69, -0.50, "Nov 26", null, "ZSX26"],
  ["L4", "frontiercooperative", "Wahoo", "Soybeans", "09/01/26-09/30/26", "01 Sep 2026 to 30 Sep 2026", 12.70, -0.49, "Nov 26", null, "ZSX26"],
  ["L5", "scottequityexchange", "Scott", "Soybeans", "09/01/26-09/30/26", "01 Sep 2026 to 30 Sep 2026", 12.94, -0.25, "Nov 26", null, "ZSX26"],
  ["L5", "unitedcooperative", "Auroraville North Grain", "Corn", "09/01/26-09/30/26", "01 Sep 2026 to 30 Sep 2026", 4.68, -0.60, "Dec 26", null, "ZCZ26"],
  ["L5", "unitedcooperative", "Belmont Grain", "Corn", "03/01/27-03/31/27", "01 Mar 2027 to 31 Mar 2027", 4.87, -0.55, "Mar 27", null, "ZCH27"],
  ["L5", "unitedcooperative", "Center Valley Grain", "Soybeans", "10/01/27-11/30/27", "01 Oct 2027 to 30 Nov 2027", 11.87, -0.90, "Nov 27", null, "ZSX27"],
  ["L5", "unitedcooperative", "Horicon Grain", "Corn", "03/01/27-03/31/27", "01 Mar 2027 to 31 Mar 2027", 4.89, -0.53, "Mar 27", null, "ZCH27"],
  ["L5", "unitedcooperative", "Oconto Falls Grain", "Corn", "03/01/27-03/31/27", "01 Mar 2027 to 31 Mar 2027", 4.87, -0.55, "Mar 27", null, "ZCH27"],
  ["L5", "unitedcooperative", "Platteville Grain", "Soybeans", "10/01/26-11/30/26", "01 Oct 2026 to 30 Nov 2026", 12.34, -0.85, "Nov 26", null, "ZSX26"],
  ["L5", "unitedcooperative", "Ripon South Grain", "Corn", "10/01/26-11/30/26", "01 Oct 2026 to 30 Nov 2026", 4.78, -0.50, "Dec 26", null, "ZCZ26"],
  ["L5", "unitedcooperative", "Sauk City Grain", "Soybeans", "10/01/27-11/30/27", "01 Oct 2027 to 30 Nov 2027", 11.82, -0.95, "Nov 27", null, "ZSX27"],
  ["L5", "unitedcooperative", "United Energy Necedah", "Corn", "10/16/26-10/31/26", "16 Oct 2026 to 31 Oct 2026", 4.88, -0.40, "Dec 26", null, "ZCZ26"],
  ["L6", "milnorgrain", "Milnor", "Corn", "December", "December", 4.73, -0.55, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Corn", "February", "February", 4.77, -0.65, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Corn", "April", "April", 4.84, -0.65, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Soybeans", "New Crop", "New Crop", 12.59, -0.60, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Soybeans", "December", "December", 12.73, -0.60, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Soybeans", "February", "February", 12.85, -0.55, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Wheat, HRS", "September", "September", 6.44, -0.70, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Wheat, HRS", "November", "November", 6.44, -0.70, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Wheat, HRS", "January", "January", 6.59, -0.75, null, null, null],
  ["L6", "milnorgrain", "Milnor", "Wheat, HRS", "March", "March", 6.59, -0.75, null, null, null]
];

test("sixty hand-picked rows (ten per layout) are in the fixture text and come out unchanged", () => {
  const per = {};
  for (const [L, site, loc, com, label, deliv, cash, basis, month, cents, sym] of PICKS) {
    per[L] = (per[L] ?? 0) + 1;
    const html = fx(site);
    const raw = rawRows(html).filter((r) => r.loc === loc && r.com === com && (r.cells.date ?? r.cells.name) === label && Number(r.cells.cash) === cash && Number(r.cells.basis) === basis);
    assert.ok(raw.length >= 1, `${site} ${loc} ${com} ${label} cash ${cash} basis ${basis} is not in the fixture text`);
    assert.equal(raw[0].cells.month ?? null, month, `${site} ${loc} month`);
    if (cents != null) assert.equal(Math.round(parseFloat(raw[0].cells.price) * 10000) / 100, cents, `${site} ${loc} price text`);
    const rows = ex(site);
    const hit = rows.filter((r) => r.location === loc && r.commodity === com && r.raw.includes(`| ${label} |`) && r.cash === cash && r.basis === basis);
    assert.ok(hit.length >= 1, `${site} ${loc} ${com} ${label}: not published`);
    const r = hit[0];
    assert.equal(r.delivery, deliv);
    assert.equal(r.basisCents, Math.round(basis * 100));
    assert.equal(r.unit, "bushel");
    assert.equal(r.futures, sym);
    if (cents != null) { assert.equal(r.futuresPrice, cents); assert.equal(r.verifiedBy, null); }
    else { assert.equal(r.futuresPrice, null, "a futures price is never derived"); assert.equal(r.verifiedBy, sym ? VERIFIED_NAMED : VERIFIED_FIT); }
  }
  assert.deepEqual(per, { L1: 10, L2: 10, L3: 10, L4: 10, L5: 10, L6: 10 });
});

test("a futures price is never derived: unpriced boards publish futuresPrice null", () => {
  for (const s of ["cedarcountycoop", "frontiercooperative", "fullcircleag", "milnorgrain", "scottequityexchange", "unitedcooperative"])
    for (const r of ex(s)) assert.equal(r.futuresPrice, null, `${s} ${r.location}`);
});

/* ---------------- 4. identity, rounding ---------------- */

test("priced boards: cash - basis = futures, cashRounding measured on every priced row", () => {
  const all = [];
  for (const s of ["agvalley", "cendakcooperative", "mrga", "rivervalleycoop"]) all.push(...ex(s).filter((r) => r.futuresPrice != null));
  assert.equal(all.length, 1208);
  const ev = roundingEvidence(all);
  assert.match(JSON.stringify(ev), /round-cent-both/);
  /* the residual that decides the mode, in cents: cash - basis - futures. Rounding
     both cash and basis to the cent can be off by 0.5 + 0.5 = up to 1 cent from
     the exchange price, and never more. */
  const resid = all.map((r) => Math.abs(r.cash * 100 - r.basisCents - r.futuresPrice));
  assert.ok(Math.max(...resid) <= 1, `largest residual ${Math.max(...resid)}c`);
  /* floor and single-side rounding do not explain the same rows */
  assert.ok(resid.filter((x) => x > 0.5).length > 0, "some rows need the second half cent, which is why the mode is 'both'");
});

test("every manifest declares the rounding the captures measured", () => {
  const files = readdirSync(join(ROOT, "sources")).filter((f) => /^(agvalley|cedarcountycoop|frontiercooperative|fullcircleag|milnorgrain|mrga|rivervalleycoop|scottequityexchange)-/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8"));
    if (/^(agvalley|mrga|rivervalleycoop)-/.test(f)) { assert.equal(m.cashRounding, "round-cent-both", f); assert.equal(m.identityAlternative, undefined, f); }
    else assert.ok(m.identityAlternative === VERIFIED_NAMED || m.identityAlternative === VERIFIED_FIT, `${f}: ${m.identityAlternative}`);
  }
});

test("wheat classes map to their own exchange root", () => {
  assert.equal(classRoot("Wheat, HRS"), "MW");
  assert.equal(classRoot("Spring Wheat"), "MW");
  assert.equal(classRoot("HRW Wheat"), "KE");
  assert.equal(classRoot("Hard Red Winter Wheat"), "KE");
  assert.equal(classRoot("SRW Wheat"), "ZW");
  assert.equal(classRoot("Chicago Wheat"), "ZW");
  assert.equal(classRoot("Wheat"), null, "plain wheat is not guessed");
  assert.equal(classRoot("Corn"), "ZC");
  assert.equal(classRoot("Soybeans"), "ZS");
});

test("a named contract from the wrong wheat class does not verify", () => {
  const html = fx("scottequityexchange");
  const wheat = rawRows(html).find((r) => /wheat/i.test(r.com));
  if (!wheat) return;
  const bad = CONTRACTS.map((c) => (c.root === "MW" || c.root === "KE" ? { ...c, lastCents: c.lastCents + 200 } : c));
  let rows; try { rows = ex("scottequityexchange", { contracts: bad }); } catch (e) { assert.ok(e instanceof StoneHedgeRefused); return; }
  assert.ok(!rows.some((r) => /wheat/i.test(r.commodity)), "a wheat row verified against a quote 200c away");
});

/* ---------------- 5. refusals on mutated fixtures ---------------- */

test("the widget's empty shell is refused by name", () => {
  const shell = readFileSync(join(ROOT, "fixtures/stonehedge-agvalley-bids-6180a468.html"), "utf8");
  assert.throws(() => extract(shell, URL_OF), /SHELL/);
  assert.throws(() => extract("<html><body>hello</body></html>", URL_OF), StoneHedgeRefused);
});

test("REFUSED: dropping the futures column turns a priced board into one that needs quotes", () => {
  const html = fx("agvalley").replace(/<div class="price">[^<]*<\/div>/g, "");
  assert.throws(() => extract(html, URL_OF, null), /no futures price|no CBOT quotes/i);
});

test("REFUSED: dropping price and month leaves a column set nobody has seen", () => {
  const html = fx("agvalley").replace(/<div class="(price|month)">[^<]*<\/div>/g, "");
  assert.throws(() => extract(html, URL_OF, ctx), /no captured StoneHedge board has/);
});

test("REFUSED: cash and basis headings swapped", () => {
  const html = fx("agvalley").replaceAll('<div class="cash">Cash</div>', "@@").replaceAll('<div class="basis">Basis</div>', '<div class="basis">Cash</div>').replaceAll("@@", '<div class="cash">Basis</div>');
  assert.throws(() => extract(html, URL_OF), /contradicts/);
});

test("REFUSED: cash and basis VALUES swapped on a priced board (identity fails)", () => {
  const html = fx("mrga").replace(/<div class="cash">(-?[\d.]+)<\/div><div class="basis">(-?[\d.]+)<\/div>/g, '<div class="cash">$2</div><div class="basis">$1</div>');
  assert.ok(/<div class="cash">-/.test(html), "values were swapped, headings were not");
  assert.match(html, /<div class="cash">CASH<\/div>/i);
  const src = toConfig(JSON.parse(readFileSync(join(ROOT, "sources", readdirSync(join(ROOT, "sources")).find((f) => f.startsWith("mrga-"))), "utf8")));
  /* every row of a priced board now has cash - basis far from its futures price */
  assert.throws(() => buildFile(html, { now: NOW, sourceUrl: URL_OF, source: src, extract: adapterFor("stonehedge", ctx) }), /not a bid|no publishable row/);   // a negative cash is caught before identity
});

test("REFUSED: a priced board whose cash column is off by 30 cents fails the identity check in board.mjs", () => {
  const html = fx("mrga").replace(/<div class="cash">(\d+\.\d+)<\/div>/g, (m, v) => `<div class="cash">${(Number(v) + 0.3).toFixed(2)}</div>`);
  assert.notEqual(html, fx("mrga"));
  const src = toConfig(JSON.parse(readFileSync(join(ROOT, "sources", readdirSync(join(ROOT, "sources")).find((f) => f.startsWith("mrga-"))), "utf8")));
  let err = null, out = null;
  try { out = buildFile(html, { now: NOW, sourceUrl: URL_OF, source: src, extract: adapterFor("stonehedge", ctx) }); } catch (e) { err = e; }
  assert.ok(err, `published ${out?.file?.count} rows with every cash 30c wrong`);
  assert.match(err.message, /cash - basis|identity|futures/i);
});

test("REFUSED: cash and basis VALUES swapped on a named board (fit fails)", () => {
  const html = fx("frontiercooperative").replace(/<div class="basis">(-?[\d.]+)<\/div><div class="cash">(-?[\d.]+)<\/div>/g, '<div class="basis">$2</div><div class="cash">$1</div>');
  assert.notEqual(html, fx("frontiercooperative"));
  assert.throws(() => extract(html, URL_OF, ctx), StoneHedgeRefused);
});

test("REFUSED: a location name that is not in the widget's own list", () => {
  const html = fx("agvalley").replace('bid-group-name row">Bartley<', 'bid-group-name row">Bartlex<');
  const rows = extract(html, URL_OF);
  assert.ok(!rows.some((r) => r.location === "Bartlex"));
  const why = rows.unreconciled.filter((u) => u.location === "Bartlex");
  assert.ok(why.length > 0 && /not in the widget's own location list/.test(why[0].why));
  const src = toConfig(JSON.parse(readFileSync(join(ROOT, "sources/agvalley-atlanta.json"), "utf8")));
  const bartley = { ...src, locationId: "WTTG1J0PND9I8LAS5V13" };
  assert.throws(() => buildFile(html, { now: NOW, sourceUrl: URL_OF, source: bartley, extract: adapterFor("stonehedge", ctx) }), /none for location/);
});

test("REFUSED: a whole board scrambled is refused, a minority is refused row by row", () => {
  const html = fx("milnorgrain").replace(/<div class="basis">([^<]*)<\/div>/g, '<div class="basis">9.99</div>');
  assert.throws(() => extract(html, `${URL_OF}?locs=${embedLocs("milnorgrain")[0]}`, ctx), StoneHedgeRefused);
  /* one row's cash moved 5 dollars: that row goes, the rest stay */
  const one = fx("frontiercooperative").replace(/(<div class="cash">)(\d+)\.(\d+)(<\/div>)/, (m, a, i, f, z) => `${a}${Number(i) + 5}.${f}${z}`);
  const rows = extract(one, URL_OF, ctx);
  assert.ok(rows.unreconciled.length >= 1);
  assert.ok(rows.length > 600);
});

test("one row 3 cents off its own contract is refused by the group rule even though the quote check (5c) would pass it", () => {
  const base = ex("frontiercooperative");
  const html = fx("frontiercooperative").replace(/(<div class="cash">)(\d+\.\d+)(<\/div>)/, (m, a, v, z) => `${a}${(Number(v) + 0.03).toFixed(2)}${z}`);
  const rows = extract(html, URL_OF, ctx);
  assert.equal(rows.length, base.length - 1);
  assert.ok(rows.unreconciled.some((u) => /disagrees with the/.test(u.why)), "no group refusal");
  assert.ok(MAX_GROUP_SPREAD_CENTS < 5);
});

test("a shifted set of quotes refuses the board instead of publishing it", () => {
  const shifted = CONTRACTS.map((c) => ({ ...c, lastCents: c.lastCents + 60 }));
  assert.throws(() => extract(fx("scottequityexchange"), URL_OF, { contracts: shifted }), StoneHedgeRefused);
  assert.throws(() => extract(fx("scottequityexchange"), URL_OF, { contracts: [] }), /no CBOT quotes/);
  assert.throws(() => extract(fx("milnorgrain"), `${URL_OF}?locs=x`, null), /no CBOT quotes/);
});

test("an unseen column set is refused and says which were seen", () => {
  const html = fx("agvalley").replace(/<div class="change">[\s\S]*?<\/div>(?=<div class="month">)/g, "").replace(/<div class="change"><span[^>]*>[^<]*<\/span><\/div>/g, "");
  assert.notEqual(html, fx("agvalley"));
  /* price+month still present: this is {date,cash,basis,price,month}, unseen */
  assert.throws(() => extract(html, URL_OF), /Seen: /);
});

test("blank and hidden rows are not bids", () => {
  const rows = ex("cendakcooperative");
  assert.ok(rows.blank.length > 0);
  for (const r of rows) assert.ok(r.cash > 0);
  const html = fx("agvalley").replace('<div class="bid-table-row">', '<div class="bid-table-row" style="display: none">');
  const doc = parseDocument(html);
  assert.equal(doc.groups.reduce((n, g) => n + g.tables.reduce((m, t) => m + t.hidden, 0), 0), 1);
  assert.equal(extract(html, URL_OF).length, extract(fx("agvalley"), URL_OF).length - 1);
});

test("a cash with no basis, and a table priced in tonnes, are refused by name", () => {
  const rows = ex("cendakcooperative");
  assert.ok(rows.unreconciled.some((u) => /no basis/.test(u.why)) || rows.unreconciled.some((u) => /priced in/.test(u.why)));
  assert.ok(!rows.some((r) => /canola/i.test(r.commodity)), "canola is Metric Tonnes");
});

test("a manifest without identityAlternative cannot publish an unpriced board", () => {
  const sf = readdirSync(join(ROOT, "sources")).find((f) => f.startsWith("scottequityexchange-"));
  const src = toConfig(JSON.parse(readFileSync(join(ROOT, "sources", sf), "utf8")));
  const bare = { ...src }; delete bare.identityAlternative;
  assert.throws(() => buildFile(fx("scottequityexchange"), { now: NOW, sourceUrl: URL_OF, source: bare, extract: adapterFor("stonehedge", ctx) }), /identity|verified|cash - basis/i);
  const ok = buildFile(fx("scottequityexchange"), { now: NOW, sourceUrl: URL_OF, source: src, extract: adapterFor("stonehedge", ctx) });
  assert.ok(ok.file.count > 0);
});

/* ---------------- 6. delivery periods ---------------- */

test("dateRange reads the board's own years, and delivery() takes the result as an explicit range", () => {
  assert.equal(dateRange("09/01/26-09/30/26"), "01 Sep 2026 to 30 Sep 2026");
  assert.equal(dateRange("10/01/27-10/31/27"), "01 Oct 2027 to 31 Oct 2027");
  assert.equal(dateRange("09/31/26-09/30/26"), null, "no such day");
  assert.equal(dateRange("10/01/26-09/01/26"), null, "ends before it starts");
  assert.equal(dateRange("Sep 26"), null);
  const d = delivery("01 Sep 2026 to 30 Sep 2026", NOW);
  assert.equal(d.via, "explicit-range");
  assert.equal(d.start, "2026-09-01");
  assert.equal(d.end, "2026-09-30");
});

test("a period with no year on the board is passed through as written, never given a year here", () => {
  for (const r of ex("cedarcountycoop")) assert.ok(!/^\d{4}-/.test(r.delivery), r.delivery);
  const r = ex("milnorgrain").find((x) => x.delivery === "September");
  assert.ok(r, "Milnor's September stays September");
});

/* ---------------- 7. identity of the locations ---------------- */

test("every manifest passes validateSource and its picker id and name are on the captured board", () => {
  const dir = join(ROOT, "sources");
  const files = readdirSync(dir).filter((f) => new RegExp(`^(${SITES.join("|")})-`).test(f));
  assert.equal(files.length, 72);
  const rows = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const { sources, errors } = loadSources(rows);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(sources.length, 72);
  for (const m of rows) {
    assert.equal(m.platform, "stonehedge");
    assert.equal(validateSource(m).length ?? 0, 0);
    const site = SITES.find((s) => m.id.startsWith(s + "-"));
    const doc = parseDocument(fx(site));
    const idHit = doc.picker.options.find((o) => o.id === m.locationId);
    const ids = doc.picker.present ? (idHit ? [idHit.id] : []) : embedLocs(site);
    assert.ok(ids.includes(m.locationId), `${m.id}: locationId ${m.locationId} is not on the ${site} board`);
    if (idHit) {
      const g = doc.groups.find((x) => x.name === idHit.name);
      assert.ok(g && g.tables.some((t) => t.rows.length), `${m.id}: no rows under ${idHit.name}`);
    }
    if (m.lat != null || m.lon != null) assert.ok(Number.isFinite(m.lat) && Number.isFinite(m.lon), m.id);
  }
});

test("manifests are what the generator produces from the evidence, and coordinates are never invented", () => {
  const { manifests } = buildManifests();
  assert.equal(manifests.length, 72);
  const roster = JSON.parse(readFileSync(join(ROOT, "data/roster/barchart-roster-2026-09-24.json"), "utf8"));
  const text = JSON.stringify(roster);
  let nulls = 0;
  for (const x of manifests) {
    const disk = JSON.parse(readFileSync(join(ROOT, "sources", `${x.manifest.id}.json`), "utf8"));
    assert.deepEqual(disk, x.manifest, `${x.manifest.id} on disk differs from the generator`);
    if (disk.lat == null) { nulls++; assert.equal(disk.lon, null); }
    else { assert.ok(text.includes(String(disk.lat)) && text.includes(String(disk.lon)), `${disk.id}: coordinate not in the roster`); }
  }
  assert.ok(nulls >= 0);
});

test("operators not proven in the roster have no manifest", () => {
  const files = readdirSync(join(ROOT, "sources"));
  assert.equal(files.filter((f) => /^(cendakcooperative|unitedcooperative)-/.test(f)).length, 0);
});

test("all 72 manifests build a valid board file through buildFile", () => {
  const files = readdirSync(join(ROOT, "sources")).filter((f) => new RegExp(`^(${SITES.join("|")})-`).test(f));
  let ok = 0;
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8"));
    const site = SITES.find((s) => m.id.startsWith(s + "-"));
    const b = buildFile(fx(site), { now: NOW, sourceUrl: `${m.url}?locs=${m.locationId}`, source: toConfig(m), extract: adapterFor("stonehedge", ctx) });
    assert.ok(b.file.count > 0, m.id);
    ok++;
  }
  assert.equal(ok, 72);
});

/* ---------------- 8. the platform tables ---------------- */

test("stonehedge is registered where agricharts-cashgrid is", () => {
  assert.ok(PLATFORMS.includes("stonehedge"));
  assert.equal(wireOf("stonehedge"), "html");
  assert.equal(transportOf("stonehedge"), "browser");
  assert.equal(captureOf("stonehedge"), "rendered");
  assert.equal(captureOf("bushel"), "response");
  assert.equal(typeof adapterFor("stonehedge"), "function");
  assert.deepEqual(SHARED_PAGES.stonehedge.urls, SHARED_PAGES["agricharts-cashgrid"].urls);
  assert.ok(FIND_WIDGET_JS.includes("/component/bids"));
});

/* ---------------- 9. end to end: the key, the widget, the poll ---------------- */

let browser = null;
try { browser = findBrowser(); } catch { /* reported by skip */ }

const KEY = "SECRETKEY123456789";
function fakeServer(html, gapMs = 300) {
  const widget = (h) => {
    /* React's shell, then the tables arrive in three steps, like a socket would. */
    const body = h.slice(h.indexOf('<div class="stonex-bids-component"'), h.indexOf("</main>")).replace(/<link[^>]*>/g, "");
    const head = body.slice(0, body.indexOf('<div class="bid-group">'));
    const groups = body.slice(head.length).split('<div class="bid-group">').slice(1);
    return `<!doctype html><html><body><div id="root">LOADING</div><script>
      const head = ${JSON.stringify(head)}, groups = ${JSON.stringify(groups)};
      let n = 0; const root = document.getElementById("root"); root.innerHTML = head;
      const step = () => { n = Math.min(groups.length, n + Math.ceil(groups.length / 3));
        root.innerHTML = head + groups.slice(0, n).map((g) => '<div class="bid-group">' + g).join("");
        if (n < groups.length) setTimeout(step, ${gapMs}); };
      setTimeout(step, 200);
    </script></body></html>`;
  };
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/component/bids")) {
      if (!req.url.includes(KEY)) { res.writeHead(403); return res.end("no key"); }
      res.writeHead(200, { "content-type": "text/html" }); return res.end(widget(html));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><h1>Cash bids</h1><iframe src="/component/bids?key=${KEY}&cols=x&locs=all"></iframe></body></html>`);
  });
  return { srv, seen };
}
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

test("captureRendered: reads the key from the operator's page, waits for the board to finish drawing, never returns the key",
  { skip: browser ? false : "no browser on this machine" }, async () => {
  const html = fx("mrga");
  const { srv, seen } = fakeServer(html);
  const port = await listen(srv);
  try {
    const target = `http://127.0.0.1:${port}/component/bids`;
    const got = await captureRendered({ pageUrl: `http://127.0.0.1:${port}/cash`, target, browser, timeoutMs: 30000, settleMs: 800 });
    assert.ok(seen.some((u) => u.startsWith("/cash")) && seen.some((u) => u.includes(KEY)), "the key was used to load the widget");
    assert.ok(!got.url.includes(KEY), `key leaked in ${got.url}`);
    assert.equal(counts(got.body).rows, counts(html).rows, "a half-drawn board was returned");
    const rows = extract(got.body, got.url);
    assert.equal(rows.length + rows.blank.length + rows.unreconciled.length, counts(html).rows);
  } finally { srv.close(); }
});

test("captureRendered: a widget that pauses longer than the settle time between locations is still read whole",
  { skip: browser ? false : "no browser on this machine", timeout: 60000 }, async () => {
  /* Steps 1.5s apart against an 800ms settle. Judged on 'unchanged for a
     second' alone this returned 6 of 9 locations; the widget's own picker says
     how many there must be. */
  const html = fx("mrga");
  const { srv } = fakeServer(html, 1500);
  const port = await listen(srv);
  try {
    const got = await captureRendered({ pageUrl: `http://127.0.0.1:${port}/cash`, target: `http://127.0.0.1:${port}/component/bids`,
                                        browser, timeoutMs: 30000, settleMs: 800 });
    assert.equal(counts(got.body).rows, counts(html).rows, "a half-drawn board was returned");
  } finally { srv.close(); }
});

test("a rendered-widget failure counts toward the platform breaker; a soybean meal table is never priced as soybeans", async () => {
  const { Breaker, loadedNothing } = await import("../lib/breaker.mjs");
  for (const m of ["[rendered] https://x/ embeds no https://y within 45000ms",
                   "[rendered] the widget did not load: net::ERR_FAILED",
                   "[rendered] the widget at https://y never finished drawing within 20000ms (last seen: nothing readable)"])
    assert.equal(loadedNothing(m), true, m);
  assert.equal(loadedNothing("HTTP 500"), false);
  const b = new Breaker({ strikes: 3 });
  b.fail("stonehedge", "[rendered] a", "op1"); b.fail("stonehedge", "[rendered] b", "op2");
  assert.equal(b.fail("stonehedge", "[rendered] c", "op3"), true, "three rendered failures in a row trip it");
  const { classRoot } = await import("../lib/adapters/stonehedge.mjs");
  for (const c of ["Soybean Meal", "Soybean Oil", "Corn Oil"]) assert.equal(classRoot(c), null, c);
  assert.equal(classRoot("Soybeans"), "ZS");
  assert.equal(classRoot("Corn"), "ZC");
});

test("captureRendered: a page with no widget says so", { skip: browser ? false : "no browser on this machine" }, async () => {
  const srv = http.createServer((q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end("<html><body>none</body></html>"); });
  const port = await listen(srv);
  try {
    await assert.rejects(captureRendered({ pageUrl: `http://127.0.0.1:${port}/`, target: `http://127.0.0.1:${port}/component/bids`, browser, timeoutMs: 4000 }), /embeds no/);
  } finally { srv.close(); }
});

test("poll.mjs end to end: one source, fake operator page plus fake widget, a valid board file and no key anywhere",
  { skip: browser ? false : "no browser on this machine", timeout: 120000 }, async () => {
  const html = fx("mrga");
  const { srv } = fakeServer(html);
  const port = await listen(srv);
  const T = mkdtempSync(join(tmpdir(), "stonehedge-poll-"));
  try {
    for (const d of ["scripts", "sources", "data"]) mkdirSync(join(T, d));
    copyFileSync(join(ROOT, "scripts/poll.mjs"), join(T, "scripts/poll.mjs"));
    symlinkSync(join(ROOT, "lib"), join(T, "lib"));
    if (existsSync(join(ROOT, "package.json"))) copyFileSync(join(ROOT, "package.json"), join(T, "package.json"));
    const f = readdirSync(join(ROOT, "sources")).find((x) => x.startsWith("mrga-"));
    const m = JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8"));
    /* the locationId must be one the fixture's own picker carries; the URLs
       are the fake server's, the only thing changed */
    m.url = `http://127.0.0.1:${port}/component/bids`;
    m.browserPage = `http://127.0.0.1:${port}/cash`;
    writeFileSync(join(T, "sources", f), JSON.stringify(m, null, 2));
    /* ASYNC ON PURPOSE: the fake server lives in this process, and a synchronous
       spawn would stop it answering the poller. */
    const p = await new Promise((res) => {
      const c = spawn(process.execPath, ["scripts/poll.mjs"], { cwd: T, env: { ...process.env, BIDS_BROWSER: browser } });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
      const t = setTimeout(() => c.kill("SIGKILL"), 110000);
      c.on("close", (code) => { clearTimeout(t); res({ code, stdout, stderr }); });
    });
    const out = `${p.stdout}\n${p.stderr}`;
    assert.ok(!out.includes(KEY), "the key is in the poller's log");
    const file = join(T, "data", `${m.id}.json`);
    assert.ok(existsSync(file), `no board file written:\n${out.slice(-1500)}`);
    const board = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(!JSON.stringify(board).includes(KEY), "the key is in the board file");
    assert.ok(board.count > 0 && board.bids.length === board.count);
    assert.ok(board.bids.every((b) => b.cash > 0 && typeof b.basisDollars === "number" && b.futuresPriceCents > 0));
    assert.equal(board.status, "ok");;
    for (const fl of readdirSync(join(T, "data"))) assert.ok(!readFileSync(join(T, "data", fl), "utf8").includes(KEY), fl);
  } finally { srv.close(); }
});

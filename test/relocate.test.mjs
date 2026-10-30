/* RELOCATING A CHANGED TABLE (lib/relocate.mjs) AND THE FRONTIER CASE.
 *
 * The real case: on 2026-10-15 Frontier Cooperative's StoneHedge embed changed
 * its columns from [date, month, change, basis, cash] to [name, basis, cash,
 * change] (hyst16/grain-bids-tv, MIT, scraper.js notes the same day), and all
 * 42 Frontier sources have been refused since with
 *   the "Corn" table has the column set [name, basis, cash, change], which no
 *   captured StoneHedge board has.
 * (data/index.json, 2026-10-27T01:10Z, 1,119 consecutive fails on Wahoo.)
 *
 * The sandbox cannot reach frontiercooperative.com or stonex.com, so the new
 * layout is built here FROM the 2026-09-26 capture: the same rows, with the
 * delivery cell replaced by the name of the widget's own delivery period whose
 * start and end are that row's dates (fixtures/stonehedge-frontiercooperative-
 * delivery-periods-65bec9a9.json, captured with it). The builder refuses to
 * guess: a row whose dates match no single period throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import http from "node:http";
import { similarity, kindOf, relocate, MIN_SIMILARITY, GUARD_RANK } from "../lib/relocate.mjs";
import { extract, layoutOf, lastGoodFor, contractFromPeriods, StoneHedgeRefused, VERIFIED_NAMED, LAYOUTS } from "../lib/adapters/stonehedge.mjs";
import { adapterFor, withPageContext, deliveryPeriodsOf } from "../lib/adapters/index.mjs";
import { buildFile } from "../lib/board.mjs";
import { toConfig, keepOf } from "../lib/sources.mjs";
import { captureRendered, findBrowser } from "../lib/cdp.mjs";
import { embedLocs } from "../scripts/stonehedge-manifests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fx = (s) => readFileSync(join(ROOT, `fixtures/stonehedge-${s}-component-rendered.html`), "utf8");
const PERIODS_FILE = readdirSync(join(ROOT, "fixtures")).find((f) => f.startsWith("stonehedge-frontiercooperative-delivery-periods-"));
const PERIODS = JSON.parse(readFileSync(join(ROOT, "fixtures", PERIODS_FILE), "utf8")).deliveryPeriods;
const URL_OF = "https://stonehedge.stonex.com/component/bids";
const NOW = new Date("2026-09-26T14:00:00Z");

/* The CBOT quotes, built exactly as test/stonehedge.test.mjs builds them: from
   the futures prices the priced boards of the same capture print. */
function contracts() {
  const cm = new Map();
  for (const s of ["agvalley", "cendakcooperative", "mrga", "rivervalleycoop"])
    for (const r of extract(fx(s), URL_OF)) if (/^[A-Z]{2}[FGHJKMNQUVXZ]\d\d$/.test(r.futures)) cm.set(r.futures, r.futuresPrice);
  cm.set("ZWZ26", 590); cm.set("ZWN27", 620);
  return [...cm].map(([symbol, lastCents]) => ({ symbol, root: symbol.slice(0, 2), lastCents, priced: true }));
}
const CONTRACTS = contracts();

/* ---- the Oct 15 layout, built from the Sep 26 capture ---- */
const iso = (mmddyy) => { const [m, d, y] = mmddyy.split("/"); return `20${y}-${m}-${d}T00:00:00Z`; };
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
function frontierOct15(html = fx("frontiercooperative"), periods = PERIODS) {
  let commodity = null, n = 0;
  const out = html.replace(
    /<div class="ml-0 bid-table-name row">([^<]*)|<div class="bid-table-header"><div class="date">Delivery Dates<\/div><div class="month">Basis Month<\/div><div class="change">([^<]*)<\/div><div class="basis">([^<]*)<\/div><div class="cash">([^<]*)<\/div><\/div>|<div class="bid-table-row"><div class="date">([^<]*)<\/div><div class="month">[^<]*<\/div><div class="change">(<span[^>]*>[^<]*<\/span>)<\/div><div class="basis">([^<]*)<\/div><div class="cash">([^<]*)<\/div><\/div>/g,
    (m, name, chgL, basisL, cashL, date, chg, basis, cash) => {
      if (name !== undefined) { commodity = name.trim(); return m; }
      if (chgL !== undefined)
        return `<div class="bid-table-header"><div class="name">Delivery</div><div class="basis">${basisL}</div><div class="cash">${cashL}</div><div class="change">${chgL}</div></div>`;
      const [a, z] = date.split("-");
      const hit = periods.filter((p) => norm(p.commodity.name) === norm(commodity) && p.start === iso(a) && p.end === iso(z));
      if (hit.length !== 1) throw new Error(`${commodity} ${date}: ${hit.length} periods have these dates`);
      n++;
      return `<div class="bid-table-row"><div class="name">${hit[0].name}</div><div class="basis">${basis}</div><div class="cash">${cash}</div><div class="change">${chg}</div></div>`;
    });
  assert.equal(n, 678, "every Frontier row of the capture was rebuilt");
  assert.ok(!/class="(date|month)"/.test(out), "no date or month column is left");
  return out;
}
const OCT15 = frontierOct15();
const ctx = (extra = {}) => ({ contracts: CONTRACTS, operatorKey: "frontiercooperative", deliveryPeriods: PERIODS, ...extra });
const comparable = (rows) => rows.map(({ seq, raw, ...r }) => r);

/* ---------------- 1. the similarity rules ---------------- */

test("similarity is by the job a column does; Frontier's move scores 0.8 and keeps its delivery column", () => {
  const before = ["date", "month", "change", "basis", "cash"], after = ["name", "basis", "cash", "change"];
  assert.equal(similarity(before, after), 0.8);
  assert.equal(kindOf(before), "named");
  assert.equal(kindOf(after), "bare");
  assert.equal(kindOf(["date", "cash", "basis", "price", "month"]), "priced");
  assert.ok(GUARD_RANK.priced > GUARD_RANK.named && GUARD_RANK.named > GUARD_RANK.bare);
  const r = relocate(after, { keys: before });
  assert.deepEqual([r.ok, r.kind, r.needsContract], [true, "named", true]);
});

test("REFUSED: a weaker check is never substituted, an unknown column is never skipped, a different table is not the same", () => {
  const priced = { keys: ["date", "cash", "basis", "price", "month", "change"] };
  assert.match(relocate(["date", "cash", "basis", "month"], priced).why, /supported a priced check .* only a named check/);
  assert.match(relocate(["date", "cash", "basis", "price", "change"], priced).why, /priced check .* only a bare check; a weaker check is not substituted/);
  assert.match(relocate(["date", "cash", "basis", "premium"], priced).why, /premium.*nobody has identified/);
  assert.match(relocate(["date", "basis", "price", "month"], priced).why, /no cash column/);
  assert.match(relocate(["cash", "basis", "month"], priced).why, /no delivery column/);
  assert.match(relocate(["name", "cash", "basis"], { keys: ["date", "cash", "basis", "price", "month", "change"] }).why, /weaker|under the/);
  assert.match(relocate(["name", "cash", "basis"], null).why, /no last good layout/);
  /* under the threshold: shares 3 of 6 jobs */
  const low = relocate(["name", "cash", "basis"], { keys: ["date", "cash", "basis", "change", "month"], kind: "bare" });
  assert.equal(similarity(["name", "cash", "basis"], ["date", "cash", "basis", "change", "month"]), 0.6);
  assert.equal(low.ok, MIN_SIMILARITY <= 0.6);
  assert.match(relocate(["name", "cash", "basis"], { keys: ["date", "cash", "basis", "change", "month", "price"], kind: "bare" }).why, /under the 0.6/);
});

test("the last good layout comes from the captured LAYOUTS, by operator", () => {
  assert.deepEqual(lastGoodFor("frontiercooperative"), { keys: ["basis", "cash", "change", "date", "month"], kind: "named" });
  assert.deepEqual(lastGoodFor("mrga").kind, "priced");
  assert.equal(lastGoodFor("nobody"), null);
  assert.equal(lastGoodFor(null), null);
  for (const [id, l] of Object.entries(LAYOUTS)) for (const op of l.seenAt.split(/,\s*/)) assert.equal(lastGoodFor(op).keys.join(","), id);
});

/* ---------------- 2. Frontier, the real case ---------------- */

test("REGRESSION: without a last good layout the Oct 15 Frontier table is refused exactly as data/index.json says", () => {
  assert.throws(() => extract(OCT15, URL_OF, { contracts: CONTRACTS }),
    /the "Corn" table has the column set \[name, basis, cash, change\], which no captured StoneHedge board has/);
});

test("REFUSED: relocated but without the widget's delivery periods, the named check cannot run, so nothing publishes", () => {
  assert.throws(() => extract(OCT15, URL_OF, ctx({ deliveryPeriods: null })), /dropped its contract month column.*weaker check is not substituted/);
});

test("relocated with the widget's own delivery periods, Frontier publishes the very rows the Sep 26 layout gave", () => {
  const before = extract(fx("frontiercooperative"), URL_OF, { contracts: CONTRACTS });
  const after = extract(OCT15, URL_OF, ctx());
  assert.equal(after.length, before.length);
  assert.equal(after.length, 678 - after.unreconciled.length - after.blank.length);
  assert.deepEqual(comparable(after), comparable(before));
  assert.ok(after.every((r) => r.verifiedBy === VERIFIED_NAMED && r.futuresPrice === null));
  assert.ok(after.every((r) => /from the widget's delivery period "[^"]+", [A-Z]+\d\d\)/.test(r.raw)));
});

test("every Frontier manifest builds a valid board from the relocated table, under the identity it already declares", () => {
  const files = readdirSync(join(ROOT, "sources")).filter((f) => f.startsWith("frontiercooperative-"));
  assert.ok(files.length >= 40);
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8"));
    assert.equal(m.identityAlternative, VERIFIED_NAMED, `${m.id} declares the named check; relocation must not change that`);
    const shared = withPageContext({ contracts: CONTRACTS }, m, { kept: [{ url: "x", body: JSON.stringify({ deliveryPeriods: PERIODS }) }] });
    const b = buildFile(OCT15, { now: NOW, sourceUrl: `${m.url}?locs=${m.locationId}`, source: toConfig(m), extract: adapterFor("stonehedge", shared) });
    const old = buildFile(fx("frontiercooperative"), { now: NOW, sourceUrl: `${m.url}?locs=${m.locationId}`, source: toConfig(m), extract: adapterFor("stonehedge", { contracts: CONTRACTS }) });
    assert.ok(b.file.count > 0, m.id);
    assert.deepEqual(b.file.bids.map((x) => [x.cash, x.basisDollars, x.futures]), old.file.bids.map((x) => [x.cash, x.basisDollars, x.futures]), m.id);
  }
});

/* ---------------- 3. the guards still bite on a relocated table ---------------- */

test("REFUSED: a period whose cash differs from the board's by one cent does not lend its contract", () => {
  const p = structuredClone(PERIODS);
  const corn = p.find((x) => x.commodity.name === "Corn" && x.name === "Dec 26");
  const adams = corn.bids.find((b) => b.location.name === "Adams");
  adams.cash = Math.round((adams.cash + 0.01) * 100) / 100;
  const rows = extract(OCT15, URL_OF, ctx({ deliveryPeriods: p }));
  const u = rows.unreconciled.filter((x) => /posts cash/.test(x.why));
  assert.equal(u.length, 1);
  assert.equal(u[0].location, "Adams");
  assert.ok(!rows.some((r) => r.location === "Adams" && r.commodity === "Corn" && r.delivery.startsWith("01 Dec 2026")));
});

test("REFUSED: a period naming another crop's contract, or two periods with one name, are refused by name", () => {
  const p = structuredClone(PERIODS);
  p.find((x) => x.commodity.name === "Corn" && x.name === "Dec 26").contract.symbol = "SX26";
  let rows = extract(OCT15, URL_OF, ctx({ deliveryPeriods: p }));
  assert.ok(rows.unreconciled.some((x) => /names SX26, which is not a ZC contract/.test(x.why)));
  const q = structuredClone(PERIODS);
  q.push(structuredClone(q.find((x) => x.commodity.name === "Corn" && x.name === "Nov")));
  rows = extract(OCT15, URL_OF, ctx({ deliveryPeriods: q }));
  assert.ok(rows.unreconciled.some((x) => /more than one delivery period of "Corn" called "Nov"/.test(x.why)));
});

test("REFUSED: every corn period pointed one contract later fails the CBOT quote check and the board is refused whole", () => {
  /* corn is over half the board's rows, so a wrong contract on all of them is
     a bad parse, not bad rows: the adapter's majority rule refuses the board */
  const p = structuredClone(PERIODS);
  const later = { CZ26: ["CH27", 3, 2027], CH27: ["CK27", 5, 2027], CZ27: ["CH28", 3, 2028], CZ28: ["CH29", 3, 2029], CH28: ["CK28", 5, 2028] };
  for (const x of p) if (x.commodity.name === "Corn" && later[x.contract.symbol]) {
    const [s, mo, y] = later[x.contract.symbol]; x.contract.symbol = s; x.contract.maturityMonth = mo; x.contract.maturityYear = y;
  }
  assert.throws(() => extract(OCT15, URL_OF, ctx({ deliveryPeriods: p })), /do not fit the CBOT quotes.*is quoted at.*refusing the board/);
});

test("REFUSED: cash and basis values swapped on the relocated board", () => {
  const html = OCT15.replace(/<div class="basis">(-?[\d.]+)<\/div><div class="cash">(-?[\d.]+)<\/div>/g, '<div class="basis">$2</div><div class="cash">$1</div>');
  assert.notEqual(html, OCT15);
  assert.throws(() => extract(html, URL_OF, ctx()), StoneHedgeRefused);
});

test("REFUSED: a relocated table whose headings contradict its columns", () => {
  const html = OCT15.replaceAll('<div class="name">Delivery</div>', '<div class="name">Cash</div>');
  assert.throws(() => extract(html, URL_OF, ctx()), /contradicts/);
});

test("a known layout is unaffected: every captured board reads the same with and without the relocation context", () => {
  for (const s of ["agvalley", "cedarcountycoop", "milnorgrain", "mrga", "scottequityexchange", "unitedcooperative"]) {
    const u = `${URL_OF}?locs=${embedLocs(s)[0] ?? "x"}`;
    const a = extract(fx(s), u, { contracts: CONTRACTS });
    const b = extract(fx(s), u, { contracts: CONTRACTS, operatorKey: s, deliveryPeriods: PERIODS });
    assert.deepEqual(comparable(b), comparable(a), s);
  }
  assert.equal(layoutOf({ commodity: "Corn", columns: [{ key: "date", label: "Date" }, { key: "cash", label: "Cash" }, { key: "basis", label: "Basis" }, { key: "month", label: "Month" }] }).relocated, undefined);
});

test("a priced board that only lost its change column relocates and still runs cash - basis = futures", () => {
  const html = fx("agvalley").replace(/<div class="change">(?:<span[^>]*>[^<]*<\/span>|[^<]*)<\/div>/g, "");
  assert.notEqual(html, fx("agvalley"));
  assert.throws(() => extract(html, URL_OF), /Seen: /, "with no last good layout it is refused, as before");
  const rows = extract(html, URL_OF, { operatorKey: "agvalley" });
  const base = extract(fx("agvalley"), URL_OF);
  assert.deepEqual(rows.map((r) => [r.cash, r.basis, r.futuresPrice]), base.map((r) => [r.cash, r.basis, r.futuresPrice]));
  /* and the identity check in board.mjs still fails a cash off by 30 cents */
  const m = JSON.parse(readFileSync(join(ROOT, "sources", readdirSync(join(ROOT, "sources")).find((f) => f.startsWith("agvalley-"))), "utf8"));
  const bad = html.replace(/(<div class="cash">)(\d+\.\d+)(<\/div>)/g, (x, a, v, z) => `${a}${(Number(v) + 0.3).toFixed(2)}${z}`);
  assert.throws(() => buildFile(bad, { now: NOW, sourceUrl: `${m.url}?locs=${m.locationId}`, source: toConfig(m), extract: adapterFor("stonehedge", { operatorKey: "agvalley" }) }));
});

/* ---------------- 4. the wiring ---------------- */

test("contractFromPeriods reads the board's own period, dates and contract, and nothing else", () => {
  const adams = PERIODS.find((x) => x.commodity.name === "Corn" && x.name === "Dec 26").bids.find((b) => b.location.name === "Adams");
  const got = contractFromPeriods(PERIODS, { commodity: "Corn", name: "Dec 26", locationId: adams.location.id, cash: adams.cash, basis: adams.basis });
  assert.deepEqual([got.ok, got.month, got.symbol, got.date], [true, "Dec 26", "CZ26", "12/01/26-12/31/26"]);
  assert.match(contractFromPeriods(null, {}).why, /not captured/);
  assert.match(contractFromPeriods(PERIODS, { commodity: "Corn", name: "Dec 26", locationId: "NOPE", cash: 1, basis: 0 }).why, /no delivery period/);
});

test("withPageContext gives StoneHedge its operator and the kept delivery periods; a bad body is dropped; other platforms untouched", () => {
  const s = { id: "frontiercooperative-wahoo", platform: "stonehedge" };
  const c = withPageContext({ contracts: [1] }, s, { kept: [{ url: "u", body: "not json" }, { url: "u", body: JSON.stringify({ deliveryPeriods: PERIODS.slice(0, 2) }) }] });
  assert.deepEqual([c.contracts, c.operatorKey, c.deliveryPeriods.length], [[1], "frontiercooperative", 2]);
  assert.equal(withPageContext({ contracts: [1] }, s, {}).deliveryPeriods, null);
  assert.equal(deliveryPeriodsOf([{ body: "{}" }]), null);
  const twice = JSON.stringify({ deliveryPeriods: PERIODS });
  assert.equal(deliveryPeriodsOf([{ body: twice }, { body: twice }]).length, PERIODS.length, "a period fetched twice is one period");
  /* and the doubled capture still relocates Frontier (two copies would otherwise read as two periods of one name) */
  const rows = extract(OCT15, URL_OF, ctx({ deliveryPeriods: deliveryPeriodsOf([{ body: twice }, { body: twice }]) }));
  assert.equal(rows.length, extract(fx("frontiercooperative"), URL_OF, { contracts: CONTRACTS }).length);
  const other = { a: 1 };
  assert.equal(withPageContext(other, { id: "x-y", platform: "bushel" }, {}), other);
  assert.equal(withPageContext(undefined, { id: "x-y", platform: "bushel" }, {}), undefined);
  assert.ok(keepOf("stonehedge").test("https://api.stonehedge.stonex.com/settings/v2/delivery-periods?locationIds=A,B"));
  assert.equal(keepOf("bushel"), null);
});

let browser = null;
try { browser = findBrowser(); } catch { browser = null; }

test("captureRendered keeps the delivery periods the widget itself fetched, and asks for nothing more",
  { skip: browser ? false : "no browser on this machine", timeout: 60000 }, async () => {
  const seen = [];
  const body = JSON.stringify({ deliveryPeriods: PERIODS.slice(0, 3) });
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/settings/v2/delivery-periods")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(body); }
    if (req.url.startsWith("/component/bids")) {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      return res.end(`<!doctype html><html><body><div id="root"></div><script>
        fetch("/settings/v2/delivery-periods?locationIds=A").then(() => {
          document.getElementById("root").innerHTML = '<div class="stonex-bids-component">Updated <span title="10/26/26 08:09 PM">x</span>'
            + '<div class="bid-group"><div class="ml-0 bid-group-name row">Adams</div><div class="bid-table"><div class="ml-0 bid-table-name row">Corn</div>'
            + '<div class="bid-table-row"><div class="name">Dec 26</div><div class="cash">4.06</div></div></div></div></div>';
        });</script></body></html>`);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><iframe src="/component/bids?key=K&locs=A"></iframe></body></html>`);
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  try {
    const got = await captureRendered({ pageUrl: `http://127.0.0.1:${port}/cash`, target: `http://127.0.0.1:${port}/component/bids`,
      browser, timeoutMs: 30000, settleMs: 500, keep: keepOf("stonehedge") });
    /* the widget loads twice (inside the page, then on its own), and asks each time.
       The count is taken once the server has been quiet for a moment: captureRendered
       returns on the document it settled on, and under load the other load's
       delivery-periods request can still be on its way (seen 1 of 2, 2026-10-30). */
    for (let last = -1, quiet = 0; quiet < 6; await new Promise((r) => setTimeout(r, 100)))
      if (seen.length === last) quiet++; else { last = seen.length; quiet = 0; }
    assert.ok(got.kept.length >= 1);
    assert.equal(deliveryPeriodsOf(got.kept).length, 3, "the same periods twice are one set");
    assert.equal(seen.filter((u) => u.startsWith("/settings/")).length, seen.filter((u) => u.startsWith("/component/bids")).length,
      "one delivery-periods request per widget load: " + JSON.stringify(seen));
    seen.length = 0;
    const plain = await captureRendered({ pageUrl: `http://127.0.0.1:${port}/cash`, target: `http://127.0.0.1:${port}/component/bids`, browser, timeoutMs: 30000, settleMs: 500 });
    assert.equal(plain.kept, undefined);
  } finally { srv.close(); }
});

/* ADAPTER: Five Star Cooperative (New Hampton, Iowa), their own cash-bid table.
 *
 *   https://www.fivestarcoop.com/grain-elevators-and-services/five-star-cash-bids/
 *
 * FOUND 2026-10-02. The DTN script on that page draws only the futures ticker;
 * the cash bids are a wpDataTables table (#table_1) their server renders from a
 * CSV, 288 rows over 22 locations in the capture (capture.yml run 36956170275):
 *
 *   Location | Commodity | Delivery Periods | Bids | Basis | Change | LocationID | ...
 *   Ionia    | Corn      | By Oct 2         | 4.53 | -0.49 | 1.5    | 7TZJ7E2012ZHMUBKRLVJ
 *
 * Cash and basis in dollars. NO CONTRACT IS NAMED AND NO FUTURES PRICE IS
 * PRINTED, so cash - basis = futures would check our own subtraction against
 * itself. This board therefore publishes the way AgriCharts' mobile boards do
 * (lib/adapters/agricharts.mjs), with the same two checks and the same
 * thresholds, imported rather than copied:
 *
 *   1. THE BOARD AGAINST ITSELF. Every location prices off the same future, so
 *      within one commodity and delivery period cash - basis must land on the
 *      same figure (MAX_IMPLIED_SPREAD_CENTS). Measured on the capture: 0.00c
 *      spread in every group (corn "By Oct 2" 502c at all 19 locations).
 *   2. THE BOARD AGAINST THE QUOTES. Each row's implied futures must sit within
 *      MAX_FIT_CENTS of a real quoted CBOT contract of its grain.
 *
 * A minority of failing rows is refused row by row; a majority refuses the
 * board. Surviving rows carry VERIFIED_BY, which the manifest declares.
 * futuresPrice is null: there is no quote of theirs to republish.
 *
 * locationId is their own LocationID column. */
import { fitToContracts, rootsFor, MAX_IMPLIED_SPREAD_CENTS } from "./agricharts.mjs";

export class FiveStarRefused extends Error {}
export const BOARD_URL = "https://www.fivestarcoop.com/grain-elevators-and-services/five-star-cash-bids/";
export const VERIFIED_BY = "fivestar:board-agrees+quotes-agree";

const decode = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"');
const text = (h) => decode(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const money = (s) => { const t = String(s ?? "").replace(/[$,\s]/g, ""); return /^-?\d*\.?\d+$/.test(t) ? Number(t) : null; };

/** Every row of their table, unchecked. */
export function parseTable(html) {
  const s = String(html);
  const i = s.indexOf('id="table_1"');
  if (i < 0) throw new FiveStarRefused(`no #table_1 in ${s.length} bytes: not Five Star's bid table, or the page moved`);
  const t = s.slice(i, s.indexOf("</table>", i));
  const head = [...t.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).toLowerCase());
  const col = (name) => head.indexOf(name);
  const need = ["location", "commodity", "delivery periods", "bids", "basis", "locationid"];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) throw new FiveStarRefused(`the table has no ${missing.join(", ")} column; headers were: ${head.join(" | ")}`);
  const out = [];
  for (const tr of t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    if (tds.length < head.length) continue;
    /* The table repeats its header row in a footer; that row is not a location. */
    if (!tds[col("locationid")] || tds[col("location")].toLowerCase() === "location") continue;
    out.push({ location: tds[col("location")], locationId: tds[col("locationid")], commodity: tds[col("commodity")],
      delivery: tds[col("delivery periods")], cash: money(tds[col("bids")]), basis: money(tds[col("basis")]),
      change: col("change") >= 0 ? money(tds[col("change")]) : null, at: col("tradedatetime") >= 0 ? tds[col("tradedatetime")] : null,
      raw: tds.slice(0, 6).join(" | ") });
  }
  if (!out.length) throw new FiveStarRefused("the table has headers and no rows");
  return out;
}

export function extract(html, sourceUrl = "", shared = null) {
  const all = parseTable(html).filter((r) => r.locationId && r.cash != null && r.basis != null && r.delivery);
  const contracts = shared?.contracts ?? null;
  if (!contracts?.length)
    throw new FiveStarRefused(`read ${all.length} row(s) and no CBOT quotes were supplied. This board names no contract `
      + `and prints no futures price, so its rows can only publish once they are checked against the quotes.`);
  const rows = all.map((r, seq) => ({
    seq, location: r.location, locationId: r.locationId, commodity: r.commodity, delivery: r.delivery,
    deliveryCode: r.delivery, cash: r.cash, basis: r.basis, basisCents: Math.round(r.basis * 100),
    impliedFuturesCents: Math.round((r.cash - r.basis) * 100 * 10000) / 10000,
    futures: null, futuresPrice: null, futuresAt: r.at, futuresFlag: null, futuresChange: null,
    unit: "bushel", source: sourceUrl, raw: r.raw,
  }));

  const bad = new Set(), unreconciled = [];
  const refuse = (r, why) => { if (!bad.has(r)) { bad.add(r); unreconciled.push({ location: r.location, commodity: r.commodity, delivery: r.delivery, why }); } };
  for (const r of rows) if (!(r.cash > 0)) refuse(r, `cash ${r.cash} is not a bid`);
  for (const r of rows) if (!rootsFor(r.commodity)) refuse(r, `no futures contract is quoted for "${r.commodity}"`);
  const live = rows.filter((r) => !bad.has(r));

  /* 1. the board against itself */
  const groups = new Map();
  for (const r of live) { const k = `${r.commodity.toLowerCase()}␟${r.delivery}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  const wide = [...groups.values()].filter((rs) => { const v = rs.map((r) => r.impliedFuturesCents); return Math.max(...v) - Math.min(...v) > MAX_IMPLIED_SPREAD_CENTS; });
  if (groups.size && wide.length * 2 >= groups.size)
    throw new FiveStarRefused(`the board disagrees with itself on ${wide.length} of ${groups.size} commodity/delivery group(s): `
      + `every location prices off one future, so cash minus basis must agree within a group, and on most it does not`);
  for (const rs of wide) {
    const v = rs.map((r) => r.impliedFuturesCents).sort((a, b) => a - b), mid = v[Math.floor(v.length / 2)];
    for (const r of rs) if (Math.abs(r.impliedFuturesCents - mid) > MAX_IMPLIED_SPREAD_CENTS)
      refuse(r, `cash minus basis implies ${r.impliedFuturesCents}c while the other ${r.commodity} rows for "${r.delivery}" imply ${mid}c`);
  }

  /* 2. the board against the quotes */
  const cand = rows.filter((r) => !bad.has(r));
  const fit = fitToContracts(cand, contracts);
  if (!fit.ok && (fit.checked === 0 || fit.misses.length * 2 >= fit.checked))
    throw new FiveStarRefused(`${fit.misses.length} of ${fit.checked} checkable row(s) sit on no quoted contract. ${fit.why}`);
  for (const m of fit.misses)
    refuse(m.row, `cash minus basis implies ${m.row.impliedFuturesCents}c and the nearest quoted ${m.contract.grain} contract, ${m.contract.symbol}, is ${m.contract.lastCents}c, ${m.d.toFixed(2)}c away`);

  const kept = rows.filter((r) => !bad.has(r));
  if (!kept.length) throw new FiveStarRefused(`not one of ${rows.length} row(s) survived: ${unreconciled.slice(0, 3).map((u) => u.why).join(" | ")}`);
  for (const r of kept) r.verifiedBy = VERIFIED_BY;
  Object.defineProperty(kept, "unreconciled", { value: unreconciled, enumerable: false });
  return kept;
}

export default extract;

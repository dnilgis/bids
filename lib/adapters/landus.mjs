/* ADAPTER: Landus Cooperative's own bids, www.landus.ag/api/cash-bids?location=<n>.
 *
 * FOUND 2026-10-01. The Barchart roster lists 31 Landus elevators and none was
 * read here; discover filed landus.ag "no-platform". Their grain-bids page is a
 * Next.js app that asks its own server two things (capture.yml run 36956170275):
 *
 *   /api/locations            [{ locationName: "Adair", locationNumber: "109", state: "IA" }, ... 51 of them]
 *   /api/cash-bids?location=109
 *     { asOfDateTime: "10/01/2026 09:22 PM",
 *       cashBids: [{ commodity: "Corn", bids: [{ basisPrice: -0.45, basisMonth: "Dec 2026",
 *                                               currentBid: 4.54, bidChange: -0.03,
 *                                               deliveryDate: "By 10/15/26" }, ...] }, ...] }
 *
 * Cash and basis are dollars. The CONTRACT is named ("Dec 2026") and its PRICE
 * is not, so cash - basis = futures would check our own subtraction against
 * itself. Like StoneHedge's named boards and Heartland, a row publishes only
 * when cash - basis lands within MAX_FIT_CENTS of the quote for the contract it
 * names, read from the shared CBOT quote pages the poller fetches once per pass.
 * Every such row is stamped VERIFIED_BY, which the manifest declares.
 *
 * locationId is the location number in the request; the payload does not repeat it. */
import { rootsFor, MAX_FIT_CENTS } from "./agricharts.mjs";
import { classRoot } from "./stonehedge.mjs";

export class LandusRefused extends Error {}

export const VERIFIED_BY = "landus:contract-named+quotes-agree";
export const API = "https://www.landus.ag/api";
export const bidsUrl = (n) => {
  if (!/^\d+$/.test(String(n ?? ""))) throw new LandusRefused(`a Landus location number is digits, not "${n}"`);
  return `${API}/cash-bids?location=${n}`;
};
export const locationOf = (url) => { const m = /[?&]location=(\d+)/.exec(String(url ?? "")); return m ? m[1] : null; };

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CODE = { 1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M", 7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z" };
export function contractMonth(v) {
  const m = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/.exec(String(v ?? "").trim());
  if (!m || !MON3[m[1].toLowerCase()]) return null;
  return { code: CODE[MON3[m[1].toLowerCase()]], year: Number(m[2]), label: String(v).trim() };
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (v != null && /^-?\d*\.?\d+$/.test(String(v)) ? Number(v) : null));

export function extract(body, sourceUrl = "", shared = null) {
  let d;
  try { d = JSON.parse(String(body)); } catch (e) { throw new LandusRefused(`not JSON (${e.message}): ${String(body).slice(0, 120)}`); }
  if (!d || !Array.isArray(d.cashBids)) throw new LandusRefused(`no cashBids array; keys ${JSON.stringify(Object.keys(d ?? {}))}`);
  const locationId = locationOf(sourceUrl);
  if (!locationId) throw new LandusRefused(`the request ${sourceUrl} names no location number, and the payload does not carry one`);
  const contracts = shared?.contracts;
  if (!Array.isArray(contracts) || !contracts.length)
    throw new LandusRefused("this board names its contract and prints no price, and no CBOT quotes were supplied; "
      + "a price derived from cash and basis would pass cash - basis = futures by construction");
  const bySymbol = new Map(contracts.filter((c) => c.priced && c.symbol).map((c) => [c.symbol, c]));

  const rows = [], unreconciled = [];
  let seq = 0, read = 0;
  for (const g of d.cashBids) {
    const commodity = String(g?.commodity ?? "").trim();
    for (const b of g?.bids ?? []) {
      read++;
      const cash = num(b?.currentBid), basis = num(b?.basisPrice);
      const month = contractMonth(b?.basisMonth);
      const delivery = String(b?.deliveryDate ?? "").trim();
      const why = (w) => unreconciled.push({ commodity, delivery, why: w });
      if (!commodity || !delivery || cash == null || basis == null) { why("a row without a commodity, delivery, cash and basis"); continue; }
      if (!(cash > 0)) { why(`cash ${cash} is not a bid`); continue; }
      if (!month) { why(`basis month "${b?.basisMonth}" is not a month and a year`); continue; }
      const root = classRoot(commodity);
      const roots = root ? [root] : (rootsFor(commodity) ?? []);
      if (!roots.length) { why(`no exchange root is known for "${commodity}"`); continue; }
      const implied = Math.round((cash - basis) * 100 * 10000) / 10000;
      const found = roots.map((x) => bySymbol.get(`${x}${month.code}${String(month.year).slice(2)}`)).filter(Boolean);
      if (!found.length) { why(`the board names ${month.label}, which our quote pages do not carry for ${roots.join("/")}`); continue; }
      const near = found.reduce((a, c) => (!a || Math.abs(c.lastCents - implied) < Math.abs(a.lastCents - implied) ? c : a), null);
      const off = Math.abs(near.lastCents - implied);
      if (off > MAX_FIT_CENTS) { why(`cash ${cash} - basis ${basis} implies ${implied}c and ${near.symbol} is quoted at ${near.lastCents}c, ${off.toFixed(2)}c away (limit ${MAX_FIT_CENTS}c)`); continue; }
      rows.push({
        seq: seq++, location: `location ${locationId}`, locationId, commodity, delivery,
        cash, basis, basisCents: Math.round(basis * 100),
        impliedFuturesCents: implied, futures: near.symbol, futuresPrice: null,
        futuresAt: d.asOfDateTime ?? null, futuresFlag: null, futuresChange: null,
        unit: "bushel", source: sourceUrl, verifiedBy: VERIFIED_BY,
        raw: `${commodity} | ${delivery} | ${cash} | ${basis} | ${b?.basisMonth}`,
      });
    }
  }
  /* A MINORITY OF BAD ROWS IS BAD ROWS; A MAJORITY IS A BAD PARSE. */
  if (read && unreconciled.length * 2 >= read)
    throw new LandusRefused(`${unreconciled.length} of ${read} row(s) do not fit: ${unreconciled.slice(0, 3).map((u) => u.why).join("; ")}`);
  if (!rows.length) throw new LandusRefused(`no publishable row (${read} read)`);
  Object.defineProperty(rows, "unreconciled", { value: unreconciled, enumerable: false });
  return rows;
}

export default extract;

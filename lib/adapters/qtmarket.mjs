/* ADAPTER: QT Market Center cash bids, fj.qtmarketcenter.com/js/cashbids.php?loc=<n>.
 *
 * FOUND 2026-10-02 on two Kentucky elevators filed "no-platform": Christian
 * County Grain (loc=441) and Hudson Grain Company (loc=438), WordPress sites
 * running the qtwebhost_quotes plugin (capture.yml run 37051659428). The
 * script answers with document.write() calls holding one table:
 *
 *   Commodity | Delivery | Cash Price (BU) | Basis | Futures Month
 *   Wheat     | September 2026 | $6.18 | -0.65 | Dec 26
 *             | January 2027   | $6.72 | -0.25 | Mar 27     (blank commodity = the one above)
 *   ...  "Last Updated: 10/02/2026 01:55pm"
 *
 * Cash and basis in dollars. THE CONTRACT IS NAMED AND NOT PRICED, so
 * cash - basis = futures would check our own subtraction. Like Landus, a row
 * publishes only when cash - basis lands within MAX_FIT_CENTS of the quote for
 * the contract it names, read from the shared CBOT quote pages; a majority of
 * rows failing refuses the board. Surviving rows carry VERIFIED_BY.
 *
 * One loc is one location; locationId is the loc number in the request. */
import { rootsFor, MAX_FIT_CENTS } from "./agricharts.mjs";
import { classRoot } from "./stonehedge.mjs";

export class QtRefused extends Error {}
/* "Call in for Cash Bids." in a cb_empty table: the yard posts nothing online
 * (Premier Grain Leesburg, loc 444, 2026-10-02). Refused, and empty, so the poll
 * counts it with the other boards posting nothing. isRefusal() reads the name. */
export class QtEmptyRefused extends QtRefused { get empty() { return true; } }
export const VERIFIED_BY = "qtmarket:contract-named+quotes-agree";
export const scriptUrl = (loc) => {
  /* Mostly numbers; Central Missouri AgriService's is "cmas001" (2026-10-02). */
  if (!/^[A-Za-z0-9]+$/.test(String(loc ?? ""))) throw new QtRefused(`a QT location id is letters and digits, not "${loc}"`);
  return `https://fj.qtmarketcenter.com/js/cashbids.php?loc=${loc}`;
};
export const locOf = (url) => { const m = /[?&]loc=([A-Za-z0-9]+)/.exec(String(url ?? "")); return m ? m[1] : null; };

const MON = { jan: "F", feb: "G", mar: "H", apr: "J", may: "K", jun: "M", jul: "N", aug: "Q", sep: "U", oct: "V", nov: "X", dec: "Z" };
/** "Dec 26" -> { code: "Z", yy: "26" } */
export function contractOf(v) {
  const m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+'?(\d{2})$/.exec(String(v ?? "").trim());
  return m && MON[m[1].toLowerCase()] ? { code: MON[m[1].toLowerCase()], yy: m[2], label: String(v).trim() } : null;
}
const text = (h) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const money = (s) => { const t = String(s ?? "").replace(/[$,\s]/g, ""); return /^-?\d*\.?\d+$/.test(t) ? Number(t) : null; };

export function extract(body, sourceUrl = "", shared = null) {
  /* The body is JavaScript; the table is inside its string literals. */
  const s = String(body).replace(/\\'/g, "'").replace(/\\\//g, "/");
  const t = /<table[^>]*class="cb_table"[^>]*>([\s\S]*?)<\/table>/i.exec(s);
  if (!t && /class="cb_empty"/.test(s)) {
    const said = text((/class="cb_empty"[^>]*>([\s\S]*?)<\/table>/.exec(s) ?? [])[1]);
    throw new QtEmptyRefused(`the board posts no bids: "${said}"`);
  }
  if (!t) throw new QtRefused(`no cb_table in ${s.length} bytes: not a QT Market Center cash-bid script`);
  const head = [...t[1].matchAll(/<td[^>]*class="cb_thead_td[^"]*"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]).toLowerCase());
  const want = ["commodity", "delivery", "cash price (bu)", "basis", "futures month"];
  if (want.some((c, i) => head[i] !== c)) throw new QtRefused(`the table's columns are ${head.join(" | ")}, not ${want.join(" | ")}`);
  const loc = locOf(sourceUrl);
  if (!loc) throw new QtRefused(`the request ${sourceUrl} names no loc, and the script does not carry one`);
  const contracts = shared?.contracts;
  if (!Array.isArray(contracts) || !contracts.length)
    throw new QtRefused("this board names its contract and prints no price, and no CBOT quotes were supplied");
  const bySymbol = new Map(contracts.filter((c) => c.priced && c.symbol).map((c) => [c.symbol, c]));
  const stamp = (/Last Updated:\s*([^<]+)/i.exec(s) ?? [])[1]?.trim() ?? null;

  const rows = [], unreconciled = [];
  let commodity = "", seq = 0, read = 0;
  for (const tr of t[1].matchAll(/<tr class="(?:odd|even)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    if (tds.length < 5) continue;
    if (tds[0]) commodity = tds[0];
    read++;
    const [, delivery, cashRaw, basisRaw, monthRaw] = tds;
    const cash = money(cashRaw), basis = money(basisRaw), k = contractOf(monthRaw);
    const why = (w) => unreconciled.push({ commodity, delivery, why: w });
    if (!commodity || !delivery || cash == null || basis == null) { why("a row without a commodity, delivery, cash and basis"); continue; }
    if (!(cash > 0)) { why(`cash ${cash} is not a bid`); continue; }
    if (!k) { why(`futures month "${monthRaw}" is not a month and a year`); continue; }
    const root = classRoot(commodity);
    const roots = root ? [root] : (rootsFor(commodity) ?? []);
    if (!roots.length) { why(`no exchange root is known for "${commodity}"`); continue; }
    const implied = Math.round((cash - basis) * 100 * 10000) / 10000;
    const found = roots.map((x) => bySymbol.get(`${x}${k.code}${k.yy}`)).filter(Boolean);
    if (!found.length) { why(`the board names ${k.label}, which our quote pages do not carry for ${roots.join("/")}`); continue; }
    const near = found.reduce((a, c) => (!a || Math.abs(c.lastCents - implied) < Math.abs(a.lastCents - implied) ? c : a), null);
    const off = Math.abs(near.lastCents - implied);
    if (off > MAX_FIT_CENTS) { why(`cash ${cash} - basis ${basis} implies ${implied}c and ${near.symbol} is quoted at ${near.lastCents}c, ${off.toFixed(2)}c away`); continue; }
    rows.push({ seq: seq++, location: `loc ${loc}`, locationId: loc, commodity, delivery, cash, basis,
      basisCents: Math.round(basis * 100), impliedFuturesCents: implied, futures: near.symbol, futuresPrice: null,
      futuresAt: stamp, futuresFlag: null, futuresChange: null, unit: "bushel", source: sourceUrl,
      verifiedBy: VERIFIED_BY, raw: `${commodity} | ${tds.slice(1).join(" | ")}` });
  }
  if (read && unreconciled.length * 2 >= read)
    throw new QtRefused(`${unreconciled.length} of ${read} row(s) do not fit: ${unreconciled.slice(0, 3).map((u) => u.why).join("; ")}`);
  if (!rows.length) throw new QtRefused(`no publishable row (${read} read)`);
  Object.defineProperty(rows, "unreconciled", { value: unreconciled, enumerable: false });
  return rows;
}

export default extract;

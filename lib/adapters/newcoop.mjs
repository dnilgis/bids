/* ADAPTER: NEW Cooperative's own cash-bid page, www.newcoop.com/cash-bids.
 *
 * FOUND 2026-10-01. The Barchart roster lists 27 NEW Cooperative elevators
 * and none was read here; discover had filed newcoop.com "no-platform",
 * because there is no vendor: their own server renders the board. The page
 * (capture.yml run 36956170275, 649,151 bytes) carries every location in one
 * document, inside <turbo-frame id="cashbids">:
 *
 *   <h1 class="text-4xl ...">Afton</h1>
 *   <table> COMMODITY | DELIVERY | CASH PRICE | BASIS | FUTURE PRICE | FUTURE CHANGE
 *     Corn | 10/1/2026 - 10/31/2026 | $4.64 | -35 | 499-0 | -3-2
 *
 * 69 locations, 822 rows on the capture. BASIS is in CENTS. FUTURE PRICE is in
 * cents and eighths, the CBOT tick convention: "499-0" is 499.00c, "513-4" is
 * 513.50c, "-3-2" is -3.25c. So every row proves itself, cash = (futures +
 * basis) / 100, with no contract name needed: 499.00 - 35 = 464 = $4.64.
 *
 * The board does not name the futures contract, so `futures` is null and only
 * the price is carried. locationId is the location's heading, exactly as the
 * board prints it ("Creston 1" and "Creston 2" are two yards and stay two). */

export class NewCoopRefused extends Error {}

export const BOARD_URL = "https://www.newcoop.com/cash-bids";

const decode = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (h) => decode(String(h ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** "499-0" -> 499, "513-4" -> 513.5, "-3-2" -> -3.25. null when blank, undefined when unreadable. */
export function ticks(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "-") return null;
  const m = /^(-?)(\d+)-([0-7])$/.exec(s);
  if (!m) return undefined;
  const val = Number(m[2]) + Number(m[3]) / 8;
  return m[1] ? -val : val;
}

/** A dollar or plain number; null for blank; undefined when unreadable. */
export function money(v) {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  return /^-?\d*\.?\d+$/.test(s) ? Number(s) : undefined;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "10/1/2026 - 10/31/2026" -> "01 Oct 2026 to 31 Oct 2026", the explicit range lib/delivery.mjs reads. */
export function dateRange(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const one = (mo, d, y) => (Number(mo) >= 1 && Number(mo) <= 12) ? `${String(d).padStart(2, "0")} ${MON[Number(mo) - 1]} ${y}` : null;
  const a = one(m[1], m[2], m[3]), b = one(m[4], m[5], m[6]);
  return a && b ? `${a} to ${b}` : null;
}

/** Every location section: { name, html }. */
export function sections(html) {
  const s = String(html);
  const start = s.indexOf('<turbo-frame id="cashbids"');
  const body = start >= 0 ? s.slice(start) : s;
  const re = /<h1\s+class="text-4xl[^"]*"\s*>([\s\S]*?)<\/h1>/g;
  const hits = [...body.matchAll(re)];
  return hits.map((m, i) => ({ name: text(m[1]), html: body.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : undefined) }));
}

export function extract(html, sourceUrl = "") {
  const secs = sections(html);
  if (!secs.length) throw new NewCoopRefused(`no location heading in ${String(html).length} bytes: this is not NEW Cooperative's board, or the page moved`);
  const want = ["commodity", "delivery", "cash price", "basis", "future price", "future change"];
  const out = [];
  let seq = 0, layoutsRefused = 0;
  for (const sec of secs) {
    const head = [...sec.html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).toLowerCase());
    if (want.some((c, i) => head[i] !== c)) { layoutsRefused++; continue; }
    for (const tr of sec.html.matchAll(/<tr>\s*([\s\S]*?)<\/tr>/g)) {
      const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
      if (tds.length < 6) continue;
      const [commodity, deliveryRaw, cashRaw, basisRaw, futRaw, chgRaw] = tds;
      const cash = money(cashRaw), basisC = money(basisRaw), fut = ticks(futRaw), chg = ticks(chgRaw);
      const delivery = dateRange(deliveryRaw);
      if (!commodity || !delivery || cash == null || basisC == null || fut == null) continue;
      if (cash === undefined || basisC === undefined || fut === undefined || !(cash > 0)) continue;
      out.push({
        seq: seq++, location: sec.name, locationId: sec.name, commodity, delivery,
        cash, basis: Math.round(basisC) / 100, basisCents: Math.round(basisC),
        futures: null, futuresPrice: fut, futuresAt: null, futuresFlag: null,
        futuresChange: chg === undefined ? null : chg,
        unit: "bushel", source: sourceUrl,
        raw: `${sec.name} | ${tds.join(" | ")}`,
      });
    }
  }
  if (!out.length) throw new NewCoopRefused(`${secs.length} location heading(s) and no readable row`
    + (layoutsRefused ? `; ${layoutsRefused} table(s) had a header this adapter has not seen` : ""));
  return out;
}

export default extract;

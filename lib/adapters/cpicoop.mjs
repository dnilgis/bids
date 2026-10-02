/* ADAPTER: Cooperative Producers, Inc. (Hastings, Nebraska), www.cpicoop.com/grain/bids-futures.
 *
 * FOUND 2026-10-02. The directory holds 25 CPI elevators and none was read;
 * discover filed cpicoop.com "no-platform" because the board is rendered by
 * their own server. The capture (capture.yml run 36967113079, 212,523 bytes)
 * holds 27 locations:
 *
 *   <section class="bids__group" data-bids-group="axtell">
 *     <h3 class="bids__group-name">Axtell</h3>
 *     <table> Commodity | Delivery | Basis month | Basis | Futures | Change | Cash price
 *       Corn (#2 Yellow) | Oct 2026 | Dec 2026 | -32 | 498-6 | -3-4 | $4.67
 *
 * Basis in cents; Futures in CBOT cents-and-eighths; so every row proves itself
 * with cash - basis = futures (498.75 - 32 = 466.75, posted $4.67). locationId
 * is the section's own data-bids-group slug. */
import { classRoot } from "./stonehedge.mjs";
import { ticks, money } from "./newcoop.mjs";
import { contractMonth } from "./nexus.mjs";

export class CpiRefused extends Error {}

export const BOARD_URL = "https://www.cpicoop.com/grain/bids-futures";

const decode = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
const text = (h) => decode(String(h ?? "").replace(/<span class="sr-only">[\s\S]*?<\/span>/g, "").replace(/<span aria-hidden="true">[\s\S]*?<\/span>/g, "")
  .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function extract(html, sourceUrl = "") {
  const s = String(html);
  const re = /<section class="bids__group[^"]*"\s+data-bids-group="([^"]+)">\s*<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)<\/section>/g;
  const secs = [...s.matchAll(re)];
  if (!secs.length) throw new CpiRefused(`no bids__group section in ${s.length} bytes: not CPI's board, or the page moved`);
  const want = ["commodity", "delivery", "basis month", "basis", "futures", "change", "cash price"];
  const out = [];
  let seq = 0;
  for (const [, slug, nameHtml, body] of secs) {
    const name = text(nameHtml);
    const head = [...body.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).toLowerCase());
    if (want.some((c, i) => head[i] !== c)) continue;
    for (const tr of body.matchAll(/<tr class="border-b[^"]*">([\s\S]*?)<\/tr>/g)) {
      const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
      if (tds.length < 7) continue;
      const [commodity, delivery, monthRaw, basisRaw, futRaw, chgRaw, cashRaw] = tds;
      const month = contractMonth(monthRaw);
      const basisC = money(basisRaw), fut = ticks(futRaw), cash = money(cashRaw), chg = ticks(chgRaw);
      if (!commodity || !delivery || !month || basisC == null || fut == null || cash == null) continue;
      if (basisC === undefined || fut === undefined || cash === undefined || !(cash > 0)) continue;
      const root = classRoot(commodity);
      out.push({
        seq: seq++, location: name, locationId: slug, commodity, delivery,
        cash, basis: Math.round(basisC) / 100, basisCents: Math.round(basisC),
        futures: root ? `${root}${month.code}${String(month.year).slice(2)}` : month.label,
        futuresPrice: fut, futuresAt: null, futuresFlag: null, futuresChange: chg === undefined ? null : chg,
        unit: "bushel", source: sourceUrl, raw: `${name} | ${tds.join(" | ")}`,
      });
    }
  }
  if (!out.length) throw new CpiRefused(`${secs.length} section(s) and no readable row`);
  return out;
}

export default extract;

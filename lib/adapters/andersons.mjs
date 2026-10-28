/* ADAPTER: The Andersons' own location pages (andersonsgrain.com).
 *
 *   https://www.andersonsgrain.com/locations/oh/maumee/
 *
 * FOUND 2026-10-28 (fx/readers1028). Each grain location has its own page, and
 * the page's server renders the cash bids into it: one <table> per commodity,
 * the commodity in the table's caption, every cell tagged with its column:
 *
 *   <div class="CashBids" data-ui="cash-bids">
 *     <table class="styled-table">
 *       <caption><div class="nameContainer"><div class="name">Corn</div></div></caption>
 *       <tr><td data-col="delivery">ON 26</td><td data-col="bid">4.2450</td>
 *           <td data-col="basis">-0.25</td><td data-col="futures">4.4950</td>
 *           <td data-col="change">+0.75</td><td data-col="month">CZ26</td>
 *           <td data-col="last">11:13 PM</td></tr>
 *
 * Cash, basis and the futures quote are all in dollars, so cash - basis =
 * futures is checked on every row (futuresUnits "dollars" on the manifest).
 * The location's name is the page's own <h1>. The board prints no posting date
 * of its own ("Basis values are updated daily at 5:10pm EST" is the only line
 * about time), so these rows carry no boardDate and are aged by our own clocks.
 *
 * The JSON beside the page (/locations/<st>/<town>//json/?id=N) is the
 * location's notes, contacts and discount sheets, not its bids, and the
 * company's /locations/data feed lists every facility with its page and
 * coordinate; neither carries a price. */
import { stripTags, parseNum, basisToCents, parseTicks } from "../parse.mjs";

export class AndersonsRefused extends Error {}

const cellsOf = (tr) => {
  const out = {};
  for (const m of tr.matchAll(/<td\b[^>]*data-col=["']([a-z]+)["'][^>]*>([\s\S]*?)<\/td>/gi))
    out[m[1].toLowerCase()] = stripTags(m[2]).replace(/\s+/g, " ").trim();
  return out;
};

export function extract(html, source = "") {
  const s = String(html ?? "");
  const box = s.search(/<div\b[^>]*data-ui=["']cash-bids["']/i);
  if (box < 0) throw new AndersonsRefused(`no cash-bids block in ${s.length} bytes: not one of their location pages, or the page moved`);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
  const location = h1 ? stripTags(h1[1]).replace(/\s+/g, " ").trim() : "";
  if (!location) throw new AndersonsRefused("the page has no <h1> naming the location");
  const out = [];
  let seq = 0;
  for (const t of s.slice(box).matchAll(/<table\b[^>]*class=["'][^"']*styled-table[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi)) {
    const cap = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(t[1]);
    const commodity = cap ? stripTags(cap[1]).replace(/\s+/g, " ").trim() : "";
    if (!commodity) continue;
    for (const tr of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const c = cellsOf(tr[1]);
      if (!("bid" in c) && !("basis" in c)) continue;
      const cash = parseNum(c.bid ?? "");
      const basis = parseNum(c.basis ?? "");
      if (cash === null && basis === null) continue;
      out.push({
        seq: seq++, source, locationId: null, location, section: null, commodity,
        delivery: c.delivery || "spot",
        cash, basis, basisCents: basisToCents(basis, c.basis ?? ""),
        futures: c.month || null,
        futuresPrice: parseTicks(c.futures ?? ""),
        futuresAt: c.last || null,
        futuresFlag: null,
        change: parseNum(c.change ?? ""),
        boardDate: null,
        raw: [c.delivery, c.bid, c.basis, c.futures, c.change, c.month, c.last].filter(Boolean).join(" | "),
      });
    }
  }
  if (!out.length) throw new AndersonsRefused(`the cash-bids block at ${location} has no priced rows`);
  return out;
}

/* ADAPTER — Bushel's cash-bid board, the `GetBidsList` aggregator.
 *
 * TEN OPERATORS BEHIND ONE SHAPE, AND SEVEN OF THEM ARE CHS REGIONS.
 * Found 2026-08-21 by scripts/discover.mjs across ten Bushel customers:
 *
 *     GET https://api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList
 *
 * IT TOOK FOUR RUNS TO SEE IT, AND THE REASON IS WORTH KEEPING. The signature
 * matched Bushel by HOSTNAME and its `id()` returned {}, so every Bushel
 * response on a page collapsed into one in discover's dedupe -- which keys on
 * the platform plus its identifying facts. All ten pages reported a single
 * "feed": an 899-byte GetMarketsConfig carrying a CME logo and the sentence
 * "Quotes delayed a minimum of ten minutes". The board -- eighty kilobytes of
 * it from CHS Illinois -- was a sibling response that deduped away in silence.
 * Recognising the wrong thing is worse than recognising nothing, because it
 * suppresses the evidence.
 *
 * THE SHAPE — three levels, and the unit lives on the middle one:
 *
 *   { type, meta: { lastUpdated },
 *     locations: [ { id, name,
 *       groups: [ { id, displayName, bidPriceUoM, bidPriceCurrency,
 *         bids: [ { id, bidType, description, bidPrice, basisPrice,
 *                   futuresPrice, futuresSymbol, futuresChange,
 *                   futuresChangeSign, operations } ] } ] } ] }
 *
 * EVERY PRICE IS A STRING. "4.31", "-0.45", "4.7625". They are parsed here and
 * nowhere else.
 *
 * FUTURES ARE CARRIED IN CENTS, because that is what board.mjs's identity
 * check expects: cash(cents) === basis(cents) + futuresPrice. Bushel quotes
 * dollars, so it is multiplied here, once.
 *
 * THEIR CASH IS FLOORED TO THE CENT, MEASURED NOT ASSUMED. Across the 24 rows
 * of CHS Farmers Alliance captured live on 2026-08-21:
 *
 *     cash == basis + futures exactly    12 of 24
 *     cash == ROUND(basis + futures)     18 of 24
 *     cash == FLOOR(basis + futures)     24 of 24
 *
 * residuals {0, 0.25, 0.5, 0.75} -- the eighths remainder and nothing else,
 * the same signature Ag Partners shows. A source on this platform may declare
 * "cashRounding": "floor-cent". ONE BOARD IS NOT EVERY BOARD: measure each
 * operator, and confirm on a second day's prices before enabling. Four Country
 * Partners locations read round-cent at 20:59 and floor-cent at 21:21 on
 * 2026-08-20 from identical row counts.
 *
 * A SECOND, OLDER GENERATION EXISTS AND IS NOT HANDLED HERE.
 * futures.bushelops.com/api/v1/cash-bids serves the same board in snake_case
 * -- current_bid, basis_price, futures_price, symbol, plus real delivery_start
 * and delivery_end dates. Two of the ten use it. No body of it has been
 * captured, so no code is written for it: an adapter for a shape nobody has
 * read is a guess with tests around it.
 */

import { BushelRefused } from "./bushel-refused.mjs";

const describe = (body) => {
  const s = String(body ?? "").trim();
  return `Body was ${s.length} character(s) starting: ${JSON.stringify(s.slice(0, 200))}`;
};

/* A price is a STRING on this board and an empty one is not zero. */
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const BUSHELS = "bu";

export function extract(body, sourceUrl) {
  let data;
  try { data = JSON.parse(String(body)); }
  catch (e) { throw new BushelRefused(`the response is not JSON (${e.message}). ${describe(body)}`); }

  const locations = data?.locations;
  if (!Array.isArray(locations))
    throw new BushelRefused(
      `expected a "locations" array. This is the GetBidsList shape; the older ` +
      `bushelops cash-bids shape nests under "data" and is not handled. ${describe(body)}`);
  if (!locations.length)
    throw new BushelRefused(`"locations" is empty — this customer returned no board at all. ${describe(body)}`);

  const out = [];
  let seq = 0, skipped = 0;

  for (const loc of locations) {
    const location = String(loc?.name ?? "").trim();
    const locationId = loc?.id;
    for (const g of loc?.groups ?? []) {
      const commodity = String(g?.displayName ?? "").trim();
      const unit = String(g?.bidPriceUoM ?? "").trim();
      /* A row that is not per-bushel must not be able to match a per-bushel
         band by accident. Same rule as dtn-cs: fold the unit into the name so
         DEFAULT_BANDS cannot match it and board.mjs withholds it by name. */
      const perBushel = unit.toLowerCase() === BUSHELS;

      for (const b of g?.bids ?? []) {
        const cash = num(b?.bidPrice);
        const basis = num(b?.basisPrice);
        const fut = num(b?.futuresPrice);
        const delivery = String(b?.description ?? "").trim();
        if (cash == null || basis == null || fut == null || !delivery || !location || !commodity) {
          skipped++;
          continue;
        }
        out.push({
          seq: seq++,
          location,
          locationId: locationId == null ? null : String(locationId),
          commodity: perBushel ? commodity : `${commodity} (${unit || "unit unstated"})`,
          delivery,
          cash: Math.round(cash * 10000) / 10000,
          basis: Math.round(basis * 10000) / 10000,
          basisCents: Math.round(basis * 100),
          /* Their CME-style symbol is the only contract identifier the payload
             carries, and it is theirs, not ours. */
          futures: String(b?.futuresSymbol ?? "").trim() || null,
          /* CENTS. board.mjs checks cash === basis + futuresPrice in cents. */
          futuresPrice: Math.round(fut * 100 * 10000) / 10000,
          futuresAt: typeof data?.meta?.lastUpdated === "string" ? data.meta.lastUpdated : null,
          futuresFlag: null,
          change: num(b?.futuresChange) == null ? null
                : Math.round(num(b.futuresChange) * 100 * 10000) / 10000,
          source: sourceUrl,
          raw: `${location} ${commodity} ${delivery} ${b?.futuresSymbol ?? ""}`,
        });
      }
    }
  }

  if (!out.length)
    throw new BushelRefused(
      `${locations.length} location(s) came back but no row carried a location, a commodity, ` +
      `a delivery description, a bid price, a basis and a futures price together ` +
      `(${skipped} incomplete). ${describe(body)}`);
  void skipped;
  return out;
}

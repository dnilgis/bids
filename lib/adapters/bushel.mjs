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
 *
 * IT IS HANDLED NOW — 2026-08-29, run 90133552278, and only because a WHOLE
 * body was read first. Run 90064858519 got 200 characters of Riceland: one
 * location's opening brace, no `crops`, nothing to write code from. With the
 * dump turned up to 6000, Inco Grain came back COMPLETE at 2951 characters,
 * closing `"meta":{"last_updated":"2026-08-29T14:50:40Z"}` and all. That whole
 * document is fixtures/bushel-incograin-gen2.json and every field name below
 * was read off it. Nothing here is inferred from a field name.
 *
 * THE SECOND SHAPE — nests under `data`, and it is snake_case throughout:
 *
 *   { data: [ { location_id, bushel_location_id, location_name,
 *               sales_series_id,
 *       crops: [ { id, name, market_tick_size,
 *         bids: [ { id, description, symbol, client_group_id,
 *                   delivery_start, delivery_end, expiration_date,
 *                   current_bid, basis_price, futures_price,
 *                   futures_change, futures_change_sign,
 *                   unit_of_measure, futures_unit_of_measure,
 *                   unit_conversion_factor, currency_conversion_rate,
 *                   basis_unit_of_measure, currency, basis_currency,
 *                   futures_currency, premium_percent,
 *                   make_offer_enabled } ] } ] } ],
 *     meta: { last_updated } }
 *
 * `bushel_location_id` IS THE ONE A MANIFEST CARRIES, not `location_id`. Both
 * are in the payload -- 755bf688-2cbd-4824-954b-1f078bd23e35 and 590558 -- and
 * the UUID is the one that matches what the first generation emits and what
 * filterLocation compares against. Read what consumes the value (rule 17).
 *
 * IT CARRIES A FUTURES UNIT, WHICH THE FIRST GENERATION DOES NOT, and that
 * turns out to matter more than anything else here -- see IDENTITY below.
 *
 * MEASURED, NOT ASSUMED: Inco Grain's four rows floor to the cent. Residuals
 * -0.5c, -0.5c, 0c, 0c. Prices are strings in this shape too, and futures are
 * quoted in DOLLARS ("5.3650"), the same as the first generation, so they are
 * multiplied to cents here and nowhere else.
 */

import { BushelRefused } from "./bushel-refused.mjs";

/* HOW MUCH OF THE BODY TO SHOW. 200 characters is the right default for a
   refusal in a poll log -- enough to recognise what came back, small enough
   that a broken feed cannot bury a run. It is NOT enough to write an adapter
   from, which is what the second generation now needs, so the probe workflow
   can turn it up for one run. The default is unchanged, so nothing that reads
   these messages today reads anything different. */
const DESCRIBE_CHARS = (() => {
  const n = Number(process.env.BUSHEL_DESCRIBE_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200000) : 200;
})();

const describe = (body) => {
  const s = String(body ?? "").trim();
  return `Body was ${s.length} character(s) starting: ${JSON.stringify(s.slice(0, DESCRIBE_CHARS))}`;
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

/* TWO SHAPES, ONE ADAPTER, AND THE CHOICE IS MADE BY WHAT IS THERE.
   Not by the URL: `futures.bushelops.com/api/v1/cash-bids` is where the second
   generation was measured, but the probe reaches both addresses on every page
   and a customer can move between them without telling anybody. The body says
   which it is. */
export function extract(body, sourceUrl) {
  let data;
  try { data = JSON.parse(String(body)); }
  catch (e) { throw new BushelRefused(`the response is not JSON (${e.message}). ${describe(body)}`); }

  if (Array.isArray(data?.locations)) return fromGetBidsList(data, body, sourceUrl);
  if (Array.isArray(data?.data)) return fromBushelOps(data, body, sourceUrl);

  throw new BushelRefused(
    `neither Bushel shape: no "locations" array (GetBidsList) and no "data" ` +
    `array (the bushelops cash-bids shape). ${describe(body)}`);
}

/* ---- generation one: api.bushelpowered.com .../GetBidsList --------------- */

function fromGetBidsList(data, body, sourceUrl) {
  const locations = data.locations;
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
          perBushel,
          /* THIS SHAPE CARRIES NO FUTURES UNIT, so the only thing that can be
             said is whether the CASH cell is per bushel. See IDENTITY in the
             second generation below for why the distinction matters. */
          identityCheckable: perBushel,
          source: sourceUrl,
          raw: `${location} ${commodity} ${delivery} ${b?.futuresSymbol ?? ""}`,
        });
      }
    }
  }

  return finish(out, locations.length, skipped, body);
}

/* ---- generation two: futures.bushelops.com/api/v1/cash-bids -------------- */

function fromBushelOps(data, body, sourceUrl) {
  const locations = data.data;
  if (!locations.length)
    throw new BushelRefused(`"data" is empty — this customer returned no board at all. ${describe(body)}`);

  const out = [];
  let seq = 0, skipped = 0;
  const lastUpdated = typeof data?.meta?.last_updated === "string" ? data.meta.last_updated : null;

  for (const loc of locations) {
    const location = String(loc?.location_name ?? "").trim();
    /* THE UUID, NOT THE INTEGER. Both are here; the UUID is what the other
       generation emits and what a manifest is compared against. */
    const locationId = loc?.bushel_location_id;

    for (const c of loc?.crops ?? []) {
      const commodity = String(c?.name ?? "").trim();
      /* `bids: []` is the normal state of a crop that is not being bid on --
         Riceland carries fifteen such crops per location, back to 2022. Not a
         fault and not worth counting as a skip. */
      for (const b of c?.bids ?? []) {
        const cash = num(b?.current_bid);
        const basis = num(b?.basis_price);
        const fut = num(b?.futures_price);
        const delivery = String(b?.description ?? "").trim();
        if (cash == null || basis == null || fut == null || !delivery || !location || !commodity) {
          skipped++;
          continue;
        }

        const unit = String(b?.unit_of_measure ?? "").trim();
        const futUnit = String(b?.futures_unit_of_measure ?? "").trim();
        const perBushel = unit.toLowerCase() === BUSHELS;

        /* IDENTITY — the thing this generation can say and the other cannot.
           `cash === basis + futures` only holds when the two sides are quoted
           in the SAME unit. Riceland's rice is bid per bushel against a futures
           contract quoted per CWT, with unit_conversion_factor 0.450000:
           15.5450 x 0.45 = 6.995, and 5.98 - (-1.02) = 7.00. The identity is
           fine; it just is not an identity between the two printed numbers.
           NO CONVERSION IS APPLIED HERE. One example is not a rule, and a
           conversion invented from a single row would be a guess with a source
           file built on top of it. The row is marked instead, so board.mjs
           withholds it and the probe leaves it out of the rounding evidence
           rather than reporting a 695-dollar residual. */
        const identityCheckable = perBushel && futUnit.toLowerCase() === BUSHELS;

        /* The sign is its own field in this shape. Applied here because it is
           in the payload -- not inferred.
           WORTH A LOOK ONE DAY: generation one has a futuresChangeSign too and
           fromGetBidsList above ignores it. Nobody has captured a DOWN day on
           either shape, so there is nothing to measure yet and nothing is being
           changed on the strength of a hunch. */
        const chg = num(b?.futures_change);
        const sign = Number(b?.futures_change_sign);
        const change = chg == null ? null
          : Math.round(chg * (Number.isFinite(sign) && sign < 0 ? -1 : 1) * 100 * 10000) / 10000;

        out.push({
          seq: seq++,
          location,
          locationId: locationId == null ? null : String(locationId),
          commodity: perBushel ? commodity : `${commodity} (${unit || "unit unstated"})`,
          delivery,
          cash: Math.round(cash * 10000) / 10000,
          basis: Math.round(basis * 10000) / 10000,
          basisCents: Math.round(basis * 100),
          futures: String(b?.symbol ?? "").trim() || null,
          futuresPrice: Math.round(fut * 100 * 10000) / 10000,
          futuresAt: lastUpdated,
          futuresFlag: null,
          change,
          perBushel,
          identityCheckable,
          source: sourceUrl,
          raw: `${location} ${commodity} ${delivery} ${b?.symbol ?? ""}`,
        });
      }
    }
  }

  return finish(out, locations.length, skipped, body);
}

function finish(out, locationCount, skipped, body) {
  if (!out.length)
    throw new BushelRefused(
      `${locationCount} location(s) came back but no row carried a location, a commodity, ` +
      `a delivery description, a bid price, a basis and a futures price together ` +
      `(${skipped} incomplete). ${describe(body)}`);
  return out;
}

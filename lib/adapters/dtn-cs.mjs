/* ADAPTER — DTN Content Services, the `cash-bids-table-widget`.
 *
 * A DIFFERENT DTN PRODUCT FROM GRAIN DESK, WITH A DIFFERENT DOOR.
 *
 * Grain Desk (lib/adapters/graindesk.mjs) is keyed by a company slug and needs
 * no credential. This one is keyed by an E-number site id and an API key, both
 * of which the customer's own page carries in the clear because the widget runs
 * in the visitor's browser:
 *
 *     GET https://api.dtn.com/markets/sites/<siteId>/cash-bids?apikey=<key>&units=us
 *
 * Found 2026-08-20 from Sig's DevTools network capture on agpartners.net, then
 * confirmed against DTN's own OpenAPI document, which lists the path and gives
 * the auth scheme as a parameter named `apikey` accepted as a header or a query
 * parameter:
 *
 *     https://cp-docs.dtn.com/content-packages/api-specs/markets-api/markets-api-1.0.json
 *
 * TWO GUESSES THAT WERE WRONG, RECORDED SO NOBODY REPEATS THEM: the path is not
 * under `content-services.dtn.com`, and there is no `siteId` query parameter --
 * the site id is a path segment. Probing could not have found this: on
 * api.dtn.com every path under /markets/ answers 403 to a non-browser client
 * whether or not it exists, so a 403 there carries no information.
 *
 * THE SHAPE — a flat array, one object per bid, no grouping:
 *
 *   [ { location: {id, name}, commodityDisplayName, commodityId,
 *       contractDeliveryLabel, contractMonthCode, deliveryPeriod {start, end},
 *       cashPrice, basisPrice, primaryPrice {cashPrice, basisPrice,
 *       unitOfMeasure, currency}, futuresQuote, futuresChange, settlePrice,
 *       symbol, unitOfMeasure, currency, conversionUsed, convertedPrice,
 *       realTime, allowTransactions, id }, … ]
 *
 * UNITS, WHICH ARE THE WHOLE JOB:
 *   - cashPrice and basisPrice are DOLLARS, rounded to the cent.
 *   - futuresQuote is a STRING in eighths with an APOSTROPHE: "478'6" is
 *     478 and 6/8 CENTS. parseTicks handles the apostrophe as of 2026-08-20;
 *     before that it returned 478 and threw the eighths away silently.
 *   - There is no futures-month name. `symbol` ("@C6U") is the only contract
 *     identifier the payload carries, so that is what `futures` holds.
 *
 * THEIR CASH IS FLOORED TO THE CENT, AND THAT IS MEASURABLE RATHER THAN
 * ASSUMED. Across 25 records captured live at Ag Partners:
 *
 *     cash == basis + futures exactly      4 of 25
 *     cash == ROUND(basis + futures)      11 of 25
 *     cash == FLOOR(basis + futures)      25 of 25
 *
 * and the only residuals seen are 0, 0.25 and 0.75 cents — the eighths
 * remainder, never anything else. So a source on this platform declares
 * `"cashRounding": "floor-cent"` and the identity guard stays EXACT rather than
 * being handed a blunt three-quarter-cent tolerance. See board.mjs.
 */

import { parseTicks } from "../parse.mjs";

export class DtnCsRefused extends Error {}

const describe = (body) => {
  const s = String(body ?? "").trim();
  return `Body was ${s.length} character(s) starting: ${JSON.stringify(s.slice(0, 200))}`;
};

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* A row whose price is not a per-bushel figure must not be able to match a
   per-bushel band by accident. Rather than drop it -- absent is not empty --
   the unit is folded into the commodity name, so DEFAULT_BANDS cannot match it,
   board.mjs withholds it, and it appears in `withheld` with its own name. */
const BUSHELS = "bushels";

export function extract(body, sourceUrl) {
  let data;
  try { data = JSON.parse(String(body)); }
  catch (e) {
    throw new DtnCsRefused(`the response is not JSON (${e.message}). ${describe(body)}`);
  }
  /* Some DTN endpoints wrap the list; accept either and say which we got. */
  const list = Array.isArray(data) ? data
             : Array.isArray(data?.cashBids) ? data.cashBids
             : null;
  if (!list) throw new DtnCsRefused(`expected an array of cash bids. ${describe(body)}`);
  if (!list.length) throw new DtnCsRefused(
    `the array is empty — this site id returned no cash bids at all. ${describe(body)}`);

  const out = [];
  let seq = 0;
  let skipped = 0;
  for (const b of list) {
    const location = String(b?.location?.name ?? "").trim();
    const locationId = b?.location?.id;
    const commodity = String(b?.commodityDisplayName ?? "").trim();
    const delivery = String(b?.contractDeliveryLabel ?? "").trim();
    const cash = num(b?.cashPrice);
    const basis = num(b?.basisPrice);
    const futuresPrice = parseTicks(b?.futuresQuote);

    if (!location || locationId === undefined || locationId === null ||
        !commodity || !delivery || cash == null || basis == null || futuresPrice == null) {
      skipped++;
      continue;
    }

    /* THE PAYLOAD CARRIES THE SAME PRICE TWICE AND THEY MUST AGREE.
     *
     * `primaryPrice` is the figure in the elevator's own unit; the top-level
     * cashPrice/basisPrice are what the widget renders after any unit
     * conversion the `units` query parameter asked for. On every row seen they
     * are identical and `conversionUsed` is "0". If they ever diverge, the
     * top-level pair is a converted number and publishing it beside an
     * unconverted basis would be a units error the identity check cannot see,
     * because both halves would have been converted together. */
    const pCash = num(b?.primaryPrice?.cashPrice);
    const pBasis = num(b?.primaryPrice?.basisPrice);
    if ((pCash != null && Math.abs(pCash - cash) > 1e-9) ||
        (pBasis != null && Math.abs(pBasis - basis) > 1e-9))
      throw new DtnCsRefused(
        `${location} ${commodity} ${delivery}: cashPrice ${cash}/basisPrice ${basis} do not ` +
        `match primaryPrice ${pCash}/${pBasis}. That means a unit conversion was applied to ` +
        `one and not the other, and no guard downstream can see it.`);

    const unit = String(b?.unitOfMeasure ?? b?.primaryPrice?.unitOfMeasure ?? "").trim();
    const converted = b?.convertedPrice != null ||
                      (b?.conversionUsed != null && Number(b.conversionUsed) !== 0);
    const perBushel = unit.toLowerCase() === BUSHELS && !converted;

    out.push({
      seq: seq++,
      location,
      locationId: String(locationId),
      /* Only a genuinely per-bushel row keeps a bare commodity name. */
      commodity: perBushel ? commodity
               : `${commodity} (${unit || "unit unstated"}${converted ? ", converted" : ""})`,
      delivery,
      cash: Math.round(cash * 10000) / 10000,
      basis: Math.round(basis * 10000) / 10000,
      basisCents: Math.round(basis * 100),
      /* No month name exists in this payload. The CME-style symbol is the only
         contract identifier there is, and it is theirs, not ours. */
      futures: String(b?.symbol ?? "").trim() || null,
      futuresPrice,
      /* Their settle quote and their real-time flag. Diagnostic only, never
         published — the same reason Big River's Last Trade column is not. */
      futuresAt: null,
      futuresFlag: b?.realTime === false ? "delayed" : null,
      change: parseTicks(b?.futuresChange),
      source: sourceUrl,
      raw: `${location} (${locationId}) ${commodity} ${delivery} ${b?.symbol ?? ""}`,
    });
  }

  if (!out.length)
    throw new DtnCsRefused(
      `${list.length} record(s) came back but none carried a location, a commodity, a ` +
      `delivery label, a cash price, a basis and a readable futures quote together. ` +
      `${describe(body)}`);
  /* `skipped` is deliberately not reported upward. On an HTML board a row that
     will not parse is a parser failure; on a JSON feed a record with no
     cashPrice is a contract they are simply not bidding on today, which is a
     fact about their business and not about our reader. It is counted here so
     the next person can see the distinction was considered rather than missed. */
  void skipped;
  return out;
}

/* WHICH MONEY THE NUMBER IS IN.
 *
 * Found 2026-09-06. Wanstead Farmers Cooperative in Ontario has been publishing
 * on this network since 2026-08-29. Its corn cash reads 6.92 with a basis of
 * +1.55; the median US corn cash on the same day is 4.99 with a basis of -0.45.
 * The ratio of the two medians is 1.387. That is not a market. It is the
 * Canadian dollar, sitting in the same `cash` field, in the same shard format,
 * with nothing anywhere in the schema to say so.
 *
 * Every guard passed. The bands guard passed because 6.92 is inside corn's
 * [2, 12]. The identity guard passed because cash - basis = futures holds when
 * the board quotes a CAD basis over a USD futures price, which is exactly how
 * an Ontario board is built. `foreignQuote` did not fire because it is aimed at
 * ONE ROW in another currency sitting beside domestic ones -- CHS Ag Services
 * posting ICE canola in CAD per tonne -- and here the whole board is foreign
 * and internally consistent.
 *
 * THE FIX IS NOT A HEURISTIC. The DTN payload states the currency on every
 * record, and the Bushel payload states it three times over (bid, basis and
 * futures). We were discarding it. A currency that is READ is a fact; a
 * currency that is INFERRED from a price looking large is a guess, and this
 * project does not publish guesses. So:
 *
 *   payload    the feed said so, per row, and every row agreed   -- a fact
 *   declared   the manifest says so, and a human wrote down why  -- evidence
 *   province   the location is in a Canadian province            -- evidence
 *   (none)     nothing publishes
 *
 * `currencyVia` travels with the currency all the way to the merged row so a
 * consumer can tell which of those it is holding.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not convert. There is no FX rate
 * in this repository, no timestamp for one, and a converted price is a number
 * the elevator never posted. A Canadian bid publishes in Canadian dollars,
 * says so, and it is the consumer's job to render it as such.
 */

/** The provinces and territories, so a two-letter code can be placed. */
export const PROVINCES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

/* The fifty states plus DC and the territories that grow grain. Written out
   rather than derived, because "not a province" is not the same as "a state"
   and a typo must land in neither. */
export const STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR",
]);

export const CURRENCY_OF_COUNTRY = { US: "USD", CA: "CAD" };
export const COUNTRIES = Object.keys(CURRENCY_OF_COUNTRY);
export const CURRENCIES = Object.values(CURRENCY_OF_COUNTRY);

/** "ON" -> "CA", "KS" -> "US", anything else -> null. */
export function countryOfState(state) {
  const s = String(state || "").trim().toUpperCase();
  if (!s) return null;
  if (PROVINCES.has(s)) return "CA";
  if (STATES.has(s)) return "US";
  return null;
}

/* THE PAYLOAD'S OWN WORD, NORMALISED NO FURTHER THAN CASE.
   DTN writes "USD"; Bushel writes "USD" and "CAD". An unrecognised code is
   returned as-is rather than dropped: a board quoting in euros must be able to
   refuse loudly, not fall through to the default. */
const code = (v) => {
  const s = String(v ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
};

/** Every distinct currency the rows state, in order of first appearance. */
export function statedCurrencies(rows) {
  const seen = [];
  for (const r of rows || []) {
    const c = code(r?.currency);
    if (c && !seen.includes(c)) seen.push(c);
  }
  return seen;
}

export class CurrencyRefused extends Error {}

/* THE ROWS OUTRANK THE MANIFEST, AND THAT IS THE POINT.
 *
 * A manifest is something a person typed. A payload field is something the
 * elevator's own feed said. When they disagree the manifest is what is wrong,
 * and saying so out loud is how a mis-stamped source gets found instead of
 * quietly publishing in the wrong money.
 */
export function resolveCurrency(source, rows) {
  const stated = statedCurrencies(rows);

  if (stated.length > 1)
    throw new CurrencyRefused(
      `rows at ${source?.location ?? source?.id ?? "this source"} state more than one ` +
      `currency (${stated.join(", ")}). Cash figures in two currencies cannot share ` +
      `one board file, and picking one of them would publish the other as if it were ` +
      `that one. Split the source, or declare the odd rows in foreignQuote.`);

  if (stated.length === 1) {
    const declared = code(source?.currency);
    if (declared && declared !== stated[0])
      throw new CurrencyRefused(
        `the manifest declares ${declared} and the feed states ${stated[0]} on every row. ` +
        `The feed is the elevator's own word and the manifest is ours, so ours is the one ` +
        `that is wrong. Fix currency in sources/${source?.id ?? "?"}.json.`);
    return { currency: stated[0], currencyVia: "payload" };
  }

  const declared = code(source?.currency);
  if (declared) return { currency: declared, currencyVia: "declared" };

  const country = countryOfState(source?.state);
  if (country) return { currency: CURRENCY_OF_COUNTRY[country], currencyVia: "province" };

  /* NOTHING ESTABLISHES IT, AND THAT IS RECORDED RATHER THAN GUESSED.
   *
   * This returned a throw for about an hour. It was wrong, and the test suite
   * said so: 34 tests build a synthetic board with no state and no manifest
   * currency, and every one of them refused. In production the same throw
   * would have taken down all 605 HTML-board sources on the day the manifests
   * were stamped and before the first poll rewrote their files.
   *
   * The refusal belongs where the danger is, and the danger is not in reading
   * one board. It is in the MERGE, where prices from 824 places are put in one
   * list and sorted by distance. So a board file may honestly say "we do not
   * know", and merge_bids.mjs withholds those rows and COUNTS them. A number
   * in the run log is a thing that gets fixed; 605 sources vanishing is an
   * outage. */
  return { currency: null, currencyVia: null };
}

/** The country implied by a resolved currency, for the shard's own field. */
export function countryOfCurrency(currency) {
  for (const [k, v] of Object.entries(CURRENCY_OF_COUNTRY)) if (v === currency) return k;
  return null;
}

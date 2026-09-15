/* ADAPTER — Gradable, which is POET and ADM.
 *
 * FOUND 2026-09-07, discover run 92318597788, and read from real bytes in runs
 * 92448519432 and 92448826700. Ten poetgrain.com sites had sat in the ledger as
 * "no known platform" since 2026-08-29; every one of them calls
 * poet.gradable.com, and adm.gradable.com answers the identical shape.
 *
 * THE BOARD
 *
 *   GET https://<partner>.gradable.com/api/commodities/v2/merchandising/
 *       instruments/market/<marketId>?offer_type=public
 *
 *   { "crops": [ { commodity, crm_display_name, crop_id, units } ],
 *     "instruments": [ {
 *        basis_bid: -0.7,                 dollars
 *        cash_bid:  4.66,                 dollars
 *        futures_bid: 5.3675,             DOLLARS, not cents
 *        cash_bid_rounding_mode: "always_down",
 *        cash_bid_rounding_offset: -0.0075,
 *        ext_commodity_id: "CN",
 *        display_name: "Sept 26",
 *        contract_month: "2026-12-01",
 *        delivery_period_start / _end:    epoch seconds
 *        display_futures_bid: "536'6",
 *        futures: { symbols: { cme_globex: "ZCZ6", barchart: "ZCZ26", ... },
 *                   pricing: { delayed: { price, display, last_updated } } },
 *        market_id, id, deleted, offer_type
 *     } ] }
 *
 * IT DECLARES ITS OWN ROUNDING, which no other platform in this repository
 * does. `cash_bid_rounding_mode: "always_down"` is floor-cent, and
 * `cash_bid_rounding_offset` is the residual itself, in dollars, signed the
 * other way. Measured on all five Big Stone City rows:
 *
 *     5.3675 + (-0.7) + (-0.0075) = 4.66   exactly, and 4.66 is what they post
 *
 * so the identity holds to the last digit once their own offset is used, and
 * the residual checkIdentity sees is +0.75c and +0.25c — floor, nothing else.
 * A manifest on this platform declares `cashRounding: "floor-cent"` because the
 * board said so, not because somebody counted.
 *
 * THE OFFSET IS NOT APPLIED HERE, DELIBERATELY. cash, basis and futures are
 * published as they were published; correcting them would mean the guard checks
 * our arithmetic instead of theirs, which is the one thing it exists not to do.
 *
 * WHAT THIS ADAPTER CANNOT DO, STATED RATHER THAN PAPERED OVER
 *
 *   The market NAME is not in this payload — only `market_id`. The name, the
 *   street address and a real coordinate are in the sibling `bootstrap` call
 *   (see scripts/gradable-markets.mjs), so the manifest carries `location` and
 *   this sets `locationId` from `market_id`.
 *
 *   Big Stone City's market record says `num_public_instruments: 60` and this
 *   call returned FIVE, all Corn. The page asks per crop and the parameter that
 *   widens it has not been established. So a source on this platform publishes
 *   the crop its URL asks for and no more, and saying "5 of 60" out loud is the
 *   point: nobody should read a short board here as a short board.
 */

import { readFileSync } from "node:fs";
import { CURRENCIES } from "../currency.mjs";

export class GradableRefused extends Error {}

/* THEIR OWN DICTIONARY, READ RATHER THAN COPIED — REWRITTEN 2026-09-15.
 *
 * WHAT THE COPY COST. The instruments payload names the commodity only by a
 * code, and a code matches no band in lib/board.mjs, so every row carrying one
 * is withheld — the fault Scoular's "Yc" caused on 2026-09-04. The table below
 * used to BE the dictionary: four entries transcribed by hand out of POET's
 * bootstrap, with a comment saying an unknown code would be "passed through
 * unchanged rather than guessed at".
 *
 * That promise was kept and it was still a disaster, because POET's four codes
 * are not the alphabet. The first ADM board run, 2026-09-15, read 122 boards
 * and every single row came back as a code:
 *
 *     94 markets "01"   86 "02"   44 "11"   14 "16"   10 "37"   9 "73"
 *      5 "MW"    4 "31"  4 "12"   4 "28"    4 "49"    4 "U9"
 *      3 "59"    3 "R5"  1 "1B"   1 "PB"
 *
 * Sixteen codes, none of them in this table, so NOT ONE ADM ROW COULD EVER HAVE
 * PUBLISHED. The copy was not wrong about POET; it was four entries of a
 * forty-two entry dictionary that was sitting in the payload the whole time.
 *
 * ADM's own bootstrap resolves all sixteen and 21 of the 22 codes seen anywhere
 * band correctly on their own names — the one that does not is "Soybean Meal",
 * which lib/board.mjs lists in KNOWN_UNBANDED because it is priced per ton.
 *
 * SO THE NAMES COME FROM THE PARTNER'S OWN COMMITTED BOOTSTRAP, per partner,
 * never merged. POET's four codes and ADM's forty-two share no key today —
 * measured — but a merged table is one collision away from naming one
 * operator's crop with another's word for it, and the partner is right there in
 * the board URL.
 *
 * NOTHING PUBLISHED MOVES. POET's live rows are "Corn" (195) and "Soybeans"
 * (15), and POET's own dictionary says exactly those two strings for CN and SB.
 * The two entries this table had reworded — "Wheat, HRW" and "Wheat, SRW" —
 * have never appeared on a POET board and now read as POET writes them.
 *
 * THIS TABLE IS NOW THE FALLBACK, not the dictionary: it answers for a partner
 * whose bootstrap is not committed. A code no dictionary names is still passed
 * through unchanged, still matches no band, and is still withheld loudly. */
export const COMMODITY_NAMES = {
  CN: "Corn",
  SB: "Soybeans",
  HRWWHEAT: "Wheat, HRW",
  WHEAT: "Wheat, SRW",
};

/** Their code-to-name dictionary, out of a bootstrap body. Reads, decides nothing. */
export function commoditiesFrom(bootstrapBody) {
  let d;
  try { d = parseBody(bootstrapBody); } catch { return {}; }
  const out = {};
  for (const [code, v] of Object.entries(d?.bids_offers_ext_commodities ?? {})) {
    const n = v?.instrument_display_name;
    if (typeof n === "string" && n.trim()) out[String(code)] = n.trim();
  }
  return out;
}

/* WHICH PARTNER A BOARD BELONGS TO, FROM ITS OWN URL. Exact host match on a
   single label under gradable.com: "adm.gradable.com.evil.example" and
   "evil.example/?x=adm.gradable.com" are not ADM, and a dictionary chosen by a
   look-alike host would name one operator's crops with another's words. */
export function partnerFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const m = /^([a-z0-9-]+)\.gradable\.com$/.exec(u.hostname);
  return m && m[1] !== "www" ? m[1] : null;
}

/* THE COMMITTED BOOTSTRAP IS THE SOURCE, READ ONCE PER PROCESS.
 *
 * Lazy, so a pass with no gradable source never parses 783 KB, and cached, so a
 * pass with 152 of them parses it once. A missing or unreadable fixture caches
 * an empty dictionary and NEVER THROWS: a partner whose bootstrap has not been
 * captured must fall back to the table above and refuse row by row, not take
 * down the pass for every other platform. */
const NAME_CACHE = new Map();

export const bootstrapFixtureFor = (partner) =>
  new URL(`../../fixtures/gradable-${partner}-bootstrap.json`, import.meta.url);

export function namesFor(partner, read = null) {
  if (!partner) return COMMODITY_NAMES;
  if (NAME_CACHE.has(partner)) return NAME_CACHE.get(partner);
  let names = {};
  try {
    const body = read ? read(partner) : readFileSync(bootstrapFixtureFor(partner), "utf8");
    names = commoditiesFrom(body);
  } catch { names = {}; }
  /* An empty dictionary is not an answer, so it does not shadow the fallback. */
  const table = Object.keys(names).length ? names : COMMODITY_NAMES;
  NAME_CACHE.set(partner, table);
  return table;
}

/** Only for tests: forget what has been read. */
export const forgetNames = () => NAME_CACHE.clear();

/* SOME OF THEIR BODIES CARRY A JSON-HIJACKING PREFIX AND SOME DO NOT.
 * `/api/commodities/merchandising/bootstrap` begins `while(1);` and the
 * instruments call does not — measured on the same page load, same host, same
 * minute. Stripping it unconditionally costs nothing and not stripping it turns
 * a good board into "the response is not JSON". */
export const HIJACK_PREFIX = /^\s*(while\s*\(\s*1\s*\)\s*;|\)\]\}',?)\s*/;

/** A finite number, or null. "" and null are null, never zero. */
export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export function parseBody(body) {
  const s = String(body ?? "").replace(HIJACK_PREFIX, "");
  return JSON.parse(s);
}

export function describe(body) {
  const s = String(body ?? "");
  let d;
  try { d = parseBody(s); }
  catch { return `${s.length} bytes, not JSON, starts: ${JSON.stringify(s.slice(0, 120))}`; }
  if (!d || typeof d !== "object" || Array.isArray(d))
    return `${s.length} bytes of JSON, but a ${Array.isArray(d) ? "array" : typeof d}, not the expected object. Keys: ${JSON.stringify(Object.keys(d ?? {}).slice(0, 12))}`;
  const ins = Array.isArray(d.instruments) ? d.instruments : null;
  if (!ins) return `${s.length} bytes of JSON with no instruments array. Keys: ${JSON.stringify(Object.keys(d).slice(0, 12))}`;
  const crops = [...new Set(ins.map((r) => r?.ext_commodity_id).filter(Boolean))];
  const markets = [...new Set(ins.map((r) => r?.market_id).filter((v) => v != null))];
  return `${s.length} bytes · ${ins.length} instrument(s) · crops ${JSON.stringify(crops)} · market(s) ${JSON.stringify(markets)}`;
}

/* THE MODE IS PER MARKET, AND THERE ARE THREE OF THEM — 2026-09-07.
 *
 * POET's bootstrap carries `commodity_settings` on every market, and across
 * their 35 live plants it says:
 *
 *     always_down  17      half_down  10      half_up  6      absent  2
 *
 * So a mode read from one board is a fact about that board and nothing else.
 *
 * WHAT EACH ONE PRODUCES, DERIVED. Their cash cell is basis + futures rounded
 * to the cent, and a futures quote lives on an eighth-cent grid, so the
 * residual checkIdentity computes — `futures - (cash - basis) * 100` — can only
 * be 0, 0.25, 0.5 or 0.75 away from a whole cent:
 *
 *   always_down  truncate      frac 0 -> 0, .25 -> +.25, .5 -> +.5, .75 -> +.75
 *                              => [0, 1)                 = floor-cent
 *   half_up      .5 goes up    frac 0 -> 0, .25 -> +.25, .5 -> -.5, .75 -> -.25
 *                              => [-0.5, 0.5)            = round-cent
 *   half_down    .5 goes down  frac 0 -> 0, .25 -> +.25, .5 -> +.5, .75 -> -.25
 *                              => [-0.5, 0.5]            = round-cent-either
 *
 * ONLY `always_down` HAS BEEN SEEN ON A BOARD. Big Stone City declares it and
 * its five rows carry +0.75c and +0.25c and nothing else, measured. The other
 * two above are arithmetic about a rule they state, not a measurement, and the
 * manifests written from them are held disabled until a board proves each one.
 * `round-cent` is the mode board.mjs already keeps open at the top for exactly
 * the half-up asymmetry, and `round-cent-either` is the one closed at both ends
 * for a platform that produces +0.5 — which is what half-down does.
 *
 * A mode NOT in this table returns null and the manifest gets no cashRounding,
 * so the identity guard stays exact and the board refuses loudly rather than
 * publishing under a rule nobody established. */
export const DECLARED_ROUNDING = {
  always_down: "floor-cent",       // seen: Big Stone City, 5 of 5 rows
  half_up: "round-cent",           // derived, unconfirmed
  half_down: "round-cent-either",  // derived, unconfirmed
};

/** The rounding mode their board declares, in this repository's vocabulary. */
export function roundingFor(mode) {
  return DECLARED_ROUNDING[mode] ?? null;
}

/** What one market's bootstrap record says about how its cash cell rounds. */
export function declaredModeOf(market, cropId = 1) {
  const cs = market?.commodity_settings ?? market?.commoditySettings ?? {};
  return cs?.[String(cropId)]?.cash_rounding_mode ?? null;
}

/* `shared` is the third argument lib/adapters/index.mjs hands every adapter.
   Gradable does not use it for a fetched page; it is the door a caller uses to
   supply its own dictionary — the boards reader passes the bootstrap it already
   has open rather than making this re-read the same file. */
/* WHICH MONEY, AND HOW MUCH GRAIN — READ, NEVER INFERRED. 2026-09-15.
 *
 * lib/currency.mjs was written on 2026-09-06 about Wanstead Farmers in Ontario,
 * whose corn cash read 6.92 against a US median of 4.99. Every guard passed:
 * 6.92 is inside corn's [2, 12], and cash - basis = futures holds when a board
 * quotes a CAD basis over a USD futures price, which is exactly how an Ontario
 * board is built. That file's own conclusion:
 *
 *     "The DTN payload states the currency on every record, and the Bushel
 *      payload states it three times over. We were discarding it."
 *
 * Gradable was still discarding it. Every row of their board carries
 * `currency`, and `futures.currency` beside it, and this adapter read neither —
 * so resolveCurrency fell through `payload` to `province`, which is the
 * weakest tier it will publish on. ADM runs THIRTEEN Canadian markets, in AB,
 * SK, MB and ON.
 *
 * THE UNIT IS THE SAME PROBLEM IN THE OTHER COLUMN. `quantity_unit` is
 * "bushels" on all five rows of the committed POET board. It will not be on all
 * of them at Vanscoy SK, which posts Desi Chickpeas and Red Lentils, or at
 * North Battleford, which posts Yellow and Green Peas — those trade per tonne.
 * A per-tonne cash price checked against a per-bushel futures quote is the
 * Border Ag "Price X2 for CWT" failure, which reported a board out by 82,486
 * cents; a per-tonne price inside a per-bushel band is the other half of it.
 *
 * ONLY "bushels" IS TREATED AS BUSHELS. A unit this has never seen is not
 * guessed at — the row is carried, marked not identity-checkable, and the unit
 * is reported verbatim so the next person reads THEIR word for it rather than
 * ours. */
export const BUSHELS = "bushels";

/** Their word for the money, as one of this repository's codes, or null. */
export function currencyOf(raw) {
  const c = String(raw ?? "").trim().toUpperCase();
  return CURRENCIES.includes(c) ? c : null;
}

export const isBushels = (u) => String(u ?? "").trim().toLowerCase() === BUSHELS;

export function extract(body, sourceUrl = "", shared = undefined) {
  /* THE PARTNER'S OWN WORDS, OR NOTHING INVENTED. */
  const names = shared?.names ?? namesFor(partnerFromUrl(sourceUrl));
  let data;
  try { data = parseBody(body); }
  catch (e) {
    /* An HTML error page parses as "not JSON", and saying so beats saying
       "0 bids", which reads downstream as "they are not bidding today". */
    throw new GradableRefused(`the response is not JSON (${e.message}). ${describe(body)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new GradableRefused(`expected an object with an instruments array. ${describe(body)}`);
  if (!Array.isArray(data.instruments))
    throw new GradableRefused(`no instruments array. ${describe(body)}`);
  if (!data.instruments.length)
    throw new GradableRefused(`the instruments array is empty — this market returned no public bids at all. ${describe(body)}`);

  const out = [];
  let seq = 0, skippedDeleted = 0, skippedPrivate = 0, incomplete = 0;
  for (const r of data.instruments) {
    if (r?.deleted === true) { skippedDeleted++; continue; }
    /* offer_type is "public" on everything this URL returns, and the URL asks
       for it. Checked anyway: a private offer is somebody's contract, not a
       posted bid, and must never reach a public feed. */
    if (r?.offer_type != null && r.offer_type !== "public") { skippedPrivate++; continue; }

    const cash = num(r?.cash_bid);
    const basis = num(r?.basis_bid);
    /* DOLLARS HERE, CENTS DOWNSTREAM. `futures_bid` is 5.3675 and every guard
       in this repository reads futuresPrice in cents. Getting this backwards
       is a hundredfold error that still looks like a price. */
    const futuresDollars = num(r?.futures_bid);
    const label = String(r?.display_name ?? "").trim();
    const code = String(r?.ext_commodity_id ?? "").trim();
    const marketId = r?.market_id;

    /* Absent is not empty. A row missing any of these is skipped, never
       defaulted — the guards downstream must see real numbers or nothing. */
    if (!label || !code || marketId == null ||
        cash == null || basis == null || futuresDollars == null) { incomplete++; continue; }

    const sym = r?.futures?.symbols ?? {};
    const at = r?.futures?.pricing?.delayed?.last_updated ?? null;

    /* THEIR OWN WORD FOR THE MONEY AND THE UNIT, on this row. */
    const cashUnit = r?.quantity_unit ?? null;
    const futUnit = r?.futures?.quantity_unit ?? null;
    const cashCur = currencyOf(r?.currency);
    const futCur = currencyOf(r?.futures?.currency);
    /* ONE MONEY, OR NONE STATED. A cash cell in one currency beside a futures
       quote in another is exactly the Ontario board lib/currency.mjs describes,
       and naming either one as "the" currency would publish the other as if it
       were that one. resolveCurrency then falls through to the manifest or the
       province, both of which say so in currencyVia. */
    const currency = cashCur && futCur && cashCur !== futCur ? null : cashCur;

    out.push({
      seq: seq++,
      location: null,                       // the manifest's, not this payload's
      locationId: String(marketId),
      commodity: names[code] ?? COMMODITY_NAMES[code] ?? code,
      /* THE CODE THEY SENT, KEPT. lib/board.mjs builds a published row from a
         fixed whitelist, so this never reaches data/<id>.json — it is here so a
         code that falls out of their dictionary is visible as a code in a
         report and a log, rather than as a commodity nobody can look up. */
      commodityCode: code,
      /* Their own label, with the contract month beside it. Big Stone City
         posts "Oct '26" and "Nov '26" against the same ZCZ6 at the same cash;
         keyed on the month alone those two rows collapse into one. */
      delivery: r?.contract_month ? `${label} (${String(r.contract_month).slice(0, 7)})` : label,
      cash: Math.round(cash * 10000) / 10000,
      basis: Math.round(basis * 10000) / 10000,
      basisCents: Math.round(basis * 100),
      /* THE CONTRACT, NAMED BY THEM. Their globex symbol, so board.mjs bands
         the row off the row's own statement of what it is rather than off a
         commodity string. `display` is what their page shows a farmer. */
      futures: String(sym.cme_globex ?? sym.display ?? sym.barchart ?? "").trim() || null,
      futuresPrice: Math.round(futuresDollars * 100 * 10000) / 10000,
      futuresAt: at,
      futuresFlag: null,
      /* WHAT THEIR BOARD SAYS ABOUT ITS OWN ROUNDING. Carried so a manifest can
         be written from the board instead of from a count, and so a board that
         CHANGES its mode is visible rather than silently refused. */
      cashRoundingDeclared: r?.cash_bid_rounding_mode ?? null,
      cashRoundingOffset: num(r?.cash_bid_rounding_offset),
      /* resolveCurrency's strongest tier: "the feed said so, per row, and every
         row agreed". Null here is not USD, it is "nobody said". */
      currency,
      /* Carried verbatim, both of them, so a unit nobody has seen reads as
         THEIR word in a report rather than as a silence. */
      quantityUnit: cashUnit,
      futuresUnit: futUnit,
      /* cash - basis = futures compares two numbers that must be in the same
         unit. Per tonne against per bushel is not a disagreement about price. */
      identityCheckable: isBushels(cashUnit) && isBushels(futUnit),
      source: sourceUrl,
      raw: `${marketId} ${code} ${label}${r?.display_futures_bid ? ` fut ${r.display_futures_bid}` : ""}`,
    });
  }

  if (!out.length) {
    const why = [];
    if (skippedDeleted) why.push(`${skippedDeleted} deleted`);
    if (skippedPrivate) why.push(`${skippedPrivate} not public`);
    if (incomplete) why.push(`${incomplete} missing a cash, a basis, a futures price or a label`);
    throw new GradableRefused(
      `no instrument survived: ${why.join(", ") || "none matched"}. ${describe(body)}`);
  }
  return out;
}

/** The board URL for one market. `partner` is the subdomain: poet, adm. */
export function boardUrl(marketId, partner = "poet") {
  if (marketId == null || String(marketId) === "")
    throw new GradableRefused("a market id is required");
  return `https://${encodeURIComponent(partner)}.gradable.com/api/commodities/v2/` +
         `merchandising/instruments/market/${encodeURIComponent(String(marketId))}?offer_type=public`;
}

/** Every market a partner's bootstrap names. Reads, decides nothing. */
export function marketsFrom(bootstrapBody) {
  const d = parseBody(bootstrapBody);
  const out = [];
  for (const m of d?.markets ?? []) {
    const a = m?.address ?? {};
    const n = a.fbn_normalized ?? {};
    /* FOUR PLACES HOLD THE ADDRESS AND ONLY ONE OF THEM IS ALWAYS THERE.
     *
     * Until 2026-09-15 `state`, `zip` and `address` read fbn_normalized and
     * stopped. That was correct-looking for a year because POET carries
     * fbn_normalized on 36 of 36 markets, so no POET manifest ever came out
     * short and no test ever had a reason to notice.
     *
     * ADM's bootstrap, captured whole the same day, carries it on 23 of 152.
     * Measured on that committed fixture, before this change:
     *
     *     state   null on 129 of 152
     *     zip     null on 129 of 152
     *     address null on 130 of 152
     *
     * and the skeleton builder writes `state: "SET THIS"` for every one. The
     * printed state list was SEVENTEEN codes and ADM operates in twenty-six:
     * Iowa, Ohio, Alberta, Arkansas, Georgia, Louisiana, Pennsylvania,
     * Saskatchewan and Washington were all invisible, because the markets in
     * them happen to be the ones without an fbn_normalized block.
     *
     * The other three sources were in the same object the whole time. Measured
     * presence across ADM's 152:
     *
     *     google_normalized.administrative_area_level_1_short   152
     *     input_postal_code                                     152
     *     input_address_line_1                                  152
     *     google_normalized.postal_code_long                    151
     *     smartystreets_normalized_addresses.state_abbreviation  55
     *
     * ORDER IS NOT ARBITRARY. fbn_normalized first because it is theirs and
     * already shipped in 35 POET manifests, and moving those bytes now would
     * rewrite files a person has read. Then Google's, which is the two-letter
     * code the manifests want — `input_administrative_area_level_1` says
     * "Kansas" where the manifest wants "KS", so it is not a state source at
     * all. The street line prefers `input_address_line_1`, ADM's own string
     * ("210 NE 3rd St"), over reassembling Google's parts into "210 Northeast
     * 3rd Street": a copied string is a reading, a rebuilt one is an edit.
     *
     * NOTHING IS INVENTED HERE. Every fallback is a field in their payload,
     * and a market that carries none of them still comes out null. */
    const gn = a.google_normalized ?? {};
    const ss = a.smartystreets_normalized_addresses ?? {};
    const g = a.geocode ?? {};
    out.push({
      marketId: m?.id ?? null,
      extId: m?.ext_id ?? null,
      displayName: m?.display_name ?? null,
      company: m?.company ?? null,
      city: n.city ?? a.input_locality ?? gn.locality_long ?? null,
      state: n.country_subdivision ?? gn.administrative_area_level_1_short
             ?? ss.state_abbreviation ?? null,
      zip: n.postal_code ?? a.input_postal_code ?? gn.postal_code_long ?? null,
      address: n.line_1 ?? a.input_address_line_1 ?? null,
      /* THEIRS, AND THEREFORE A MEASUREMENT. Every DTN manifest in this
         repository carries `lat: null, lon: null` with "nobody has derived a
         coordinate for this location and none will be invented" beside it.
         This payload hands one over, per facility, from Google. */
      lat: num(g.lat), lon: num(g.lng),
      urlPath: (m?.url_paths ?? []).find((u) => u?.is_current)?.url_path ?? null,
      /* THEIR OWN STATEMENT OF HOW THIS MARKET ROUNDS. Per market, not per
         platform: 17 of POET's 35 say always_down and 18 say something else. */
      declaredRounding: declaredModeOf(m),
      cashRounding: roundingFor(declaredModeOf(m)),
      /* THEIR OWN COUNTRY, NOT ONE INFERRED FROM THE STATE CODE. `country_code`
         is on the address of all 152 — 139 "USA" and 13 "CAN" — and it agrees
         with what the two-letter state implies on every one of them, measured.
         Reading it means a market in a province this repository has not
         enumerated still lands in the right country. */
      countryCode: { USA: "US", CAN: "CA" }[String(m?.address?.country_code ?? "").toUpperCase()] ?? null,
      publicInstruments: m?.num_public_instruments ?? null,
      publicSite: m?.enable_gradable_public_site === true,
      /* A DEMO MARKET IS NOT AN ELEVATOR. POET's bootstrap carries one —
         Glenville, MN — flagged in the payload. Publishing a demo board as a
         real bid is exactly the kind of wrong number this project refuses. */
      demo: m?.demo_market === true,
    });
  }
  return out;
}

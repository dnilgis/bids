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

export class GradableRefused extends Error {}

/* THEIR OWN DICTIONARY, COPIED — not a guess about what CN means.
 *
 * The instruments payload names the commodity only by code ("CN"), and a code
 * matches no band in lib/board.mjs, so every row would be withheld — the same
 * fault Scoular's "Yc" caused on 2026-09-04. The names below are transcribed
 * verbatim from `bids_offers_ext_commodities` in the bootstrap body captured in
 * run 92448826700:
 *
 *   "CN":       { crop_id: 1, instrument_display_name: "Corn" }
 *   "SB":       { crop_id: 2, instrument_display_name: "Soybeans" }
 *   "HRWWHEAT": { crop_id: 4, instrument_display_name: "Wheat (Hard Red Winter)" }
 *   "WHEAT":    { crop_id: 5, instrument_display_name: "Wheat (Soft Red Winter)" }
 *
 * A code that is not here is passed through UNCHANGED rather than guessed at.
 * It will match no band, board.mjs will withhold the row and say so, and the
 * next person gets the code in a log instead of a wrong commodity on a map. */
export const COMMODITY_NAMES = {
  CN: "Corn",
  SB: "Soybeans",
  HRWWHEAT: "Wheat, HRW",
  WHEAT: "Wheat, SRW",
};

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

export function extract(body, sourceUrl = "") {
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

    out.push({
      seq: seq++,
      location: null,                       // the manifest's, not this payload's
      locationId: String(marketId),
      commodity: COMMODITY_NAMES[code] ?? code,
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
    const g = a.geocode ?? {};
    out.push({
      marketId: m?.id ?? null,
      extId: m?.ext_id ?? null,
      displayName: m?.display_name ?? null,
      company: m?.company ?? null,
      city: n.city ?? a.input_locality ?? null,
      state: n.country_subdivision ?? null,
      zip: n.postal_code ?? null,
      address: n.line_1 ?? null,
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

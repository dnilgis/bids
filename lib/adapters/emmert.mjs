/* ADAPTER — a published emmert-cash-bids feed.
 *
 * Badger Grain Supply (Wheeler, WI) and Midwest Commodity Service (Baldwin,
 * WI) publish their own posted bids as JSON beside their index.html:
 *
 *     https://badgergrain.com/bids.json
 *     https://midwestcommodity.com/bids.json
 *
 *     { "schema": "emmert-cash-bids/2",
 *       "observed": "...", "pricedAt": "...", "status": "ok",
 *       "terms": { "licence": "CC0-1.0", ... },
 *       "bids": [ { "commodity": "Corn", "delivery": "September",
 *                   "basis": -0.65, "cashPrice": 4.63 }, ... ] }
 *
 * READ THE FEED, NOT THE PAGE. Their own tooling builds that file and the HTML
 * table from the same numbers in the same run, so the table is a rendering of
 * this and parsing it instead would be re-deriving what is already published
 * exactly. Their terms put the bids and the basis under CC0.
 *
 * WHAT THIS ADAPTER CANNOT DO, AND SAYS SO
 *
 * There is no futures column. Their feed carries cash and basis and, by their
 * own note, "No exchange-licensed futures prices are included" — so
 * cash - basis = futures can never run here, exactly as on an AgriCharts board.
 * lib/board.mjs refuses such a source unless the manifest DECLARES what it
 * publishes on instead and every row carries that same stamp from the adapter.
 * The stamp is applied once, at the end, after the checks below have passed on
 * the whole board:
 *
 *   the feed says status "ok"     — they withdraw their own price by saying so,
 *                                   and a withdrawn feed must not publish here
 *   `observed` is fresh           — their stamp is when THEY last read the
 *                                   board behind their price. Our own checkedAt
 *                                   only says when we read THEM, so a page that
 *                                   stopped rebuilding would look current
 *                                   forever without this
 *   cash - basis lands in band    — the one structural check available. Swap
 *                                   the two columns and the implied futures
 *                                   goes negative or absurd; a decimal in the
 *                                   wrong place lands outside the band
 *
 * The implied futures is checked and then DROPPED. It is their supplier's
 * exchange-licensed quote arrived at by subtraction, and republishing it is
 * precisely what their terms decline to do.
 */

import { WITHDRAW_H } from "../freshness.mjs";

export class EmmertRefused extends Error {}

export const VERIFIED_BY = "emmert:status-ok+observed-fresh+implied-futures-in-band";

const round2 = (n) => Math.round(n * 100) / 100;

/* The band the implied futures has to land in, per commodity, in dollars a
   bushel. NOT the source's own `bands`: those police the CASH price, and this
   is a different number being checked for a different reason. Wide on purpose
   — this catches a swapped column or a misplaced decimal, and the cash band in
   the manifest is what polices the price itself. */
const FUTURES_BAND = {
  corn: [2, 12],
  soybean: [5, 32],
  soybeans: [5, 32],
  wheat: [3, 20],
};

const bandFor = (commodity) => {
  const c = String(commodity ?? "").toLowerCase().trim();
  for (const [name, band] of Object.entries(FUTURES_BAND))
    if (c.includes(name)) return { name, band };
  return null;
};

/**
 * @param {string} body      the bids.json they publish
 * @param {string} sourceUrl the url it came from
 * @param {object} [opts]    { now } for tests
 * @returns rows in the shape lib/board.mjs guards
 */
export function extract(body, sourceUrl, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();

  let feed;
  try { feed = JSON.parse(body); }
  catch { throw new EmmertRefused("that url did not answer with JSON at all"); }

  if (!feed || typeof feed !== "object")
    throw new EmmertRefused("the feed is not an object");

  /* THE SCHEMA, BY NAME AND BY MAJOR VERSION. /1 called the stamp `observed`
     and meant something else by it; /2 splits `observed` (last check) from
     `pricedAt` (last move), which is the split this adapter's freshness check
     depends on. A /3 that moves them again must stop here rather than be read
     with /2's assumptions. */
  const schema = String(feed.schema ?? "");
  if (!/^emmert-cash-bids\/2(\.|$)/.test(schema))
    throw new EmmertRefused(
      `this feed says schema "${schema || "(none)"}"; this adapter reads ` +
      `emmert-cash-bids/2. A new major version has to be read deliberately.`);

  /* THEIR OWN WITHDRAWAL. When the board behind their price goes stale their
     tooling publishes a status other than "ok" and their page prints "Call for
     today's price". Republishing the last figures under a status that says not
     to is the worst thing this adapter could do. */
  if (String(feed.status ?? "") !== "ok")
    throw new EmmertRefused(
      `their feed says status "${feed.status ?? "(none)"}" — they have withdrawn ` +
      `this price themselves. Nothing is published while that stands.`);

  /* FRESH BY THEIR CLOCK, NOT OURS. `checkedAt` on the file we write says when
     we read THEM. If their site stopped rebuilding, that stamp would keep
     advancing over a price frozen in August. `observed` is when they last read
     the board behind it, and it is the only stamp that can say so. Held to the
     same 14 hours the rest of this repository withdraws on — one policy, in
     lib/freshness.mjs, not a number invented here. */
  const seen = Date.parse(feed.observed ?? "");
  if (!Number.isFinite(seen))
    throw new EmmertRefused("the feed carries no readable `observed` stamp, so its age cannot be known");
  const ageH = (now.getTime() - seen) / 3600e3;
  if (ageH > WITHDRAW_H)
    throw new EmmertRefused(
      `their own last check was ${ageH.toFixed(1)}h ago, past the ${WITHDRAW_H}h ` +
      `withdrawal line. Their page is still serving a price; it is not a current one.`);
  /* A stamp in the future is a broken clock, not a fresh read. */
  if (ageH < -0.25)
    throw new EmmertRefused(`their \`observed\` stamp is ${Math.abs(ageH).toFixed(1)}h in the FUTURE`);

  const bids = Array.isArray(feed.bids) ? feed.bids : [];
  if (!bids.length)
    throw new EmmertRefused("the feed parsed but carries no bids");

  const rows = [];
  const refused = [];
  let seq = 0;
  for (const b of bids) {
    const commodity = b && b.commodity != null ? String(b.commodity).trim() : "";
    const delivery = b && b.delivery != null ? String(b.delivery).trim() : "";
    const cash = Number(b?.cashPrice);
    const basis = Number(b?.basis);
    const where = `${commodity || "?"} ${delivery || "?"}`;

    if (!commodity || !delivery) { refused.push(`${where}: no commodity or no delivery`); continue; }
    if (!Number.isFinite(cash) || cash <= 0) { refused.push(`${where}: cash is ${b?.cashPrice}`); continue; }
    if (!Number.isFinite(basis)) { refused.push(`${where}: basis is ${b?.basis}`); continue; }

    const band = bandFor(commodity);
    if (!band) { refused.push(`${where}: no futures band for "${commodity}"`); continue; }

    /* THE ONE STRUCTURAL CHECK THIS FEED ALLOWS. cash - basis is the quote they
       priced against. It is not republished — see the header — but it is the
       number that proves the two columns are the two columns: swapped, it goes
       negative; a decimal out of place, and it leaves the band by miles. */
    const implied = round2(cash - basis);
    const [lo, hi] = band.band;
    if (!(implied >= lo && implied <= hi)) {
      refused.push(`${where}: cash ${cash} - basis ${basis} implies ${implied}, ` +
                   `outside ${band.name} ${lo}-${hi}`);
      continue;
    }

    rows.push({
      seq: seq++,
      location: null,
      locationId: null,
      commodity,
      delivery,
      cash: round2(cash),
      basis: round2(basis),
      basisCents: Math.round(basis * 100),
      /* NOTHING ABOUT THE CONTRACT IS PUBLISHED. The implied quote did its job
         above and stops there; their terms say no exchange-licensed futures
         price is in this feed, and a subtraction does not change that. */
      impliedFuturesCents: null,
      futures: null,
      futuresPrice: null,
      futuresAt: null,
      futuresFlag: null,
      futuresChange: null,
      commodityId: null,
      deliveryCode: null,
      unit: null,
      source: sourceUrl,
      raw: `${commodity} ${delivery} cash ${cash} basis ${basis}`,
      verifiedBy: VERIFIED_BY,
    });
  }

  if (!rows.length)
    throw new EmmertRefused(
      `all ${bids.length} row(s) in their feed were refused: ` +
      refused.slice(0, 3).join("; "));

  Object.defineProperty(rows, "unreconciled", { value: refused, enumerable: false });
  return rows;
}

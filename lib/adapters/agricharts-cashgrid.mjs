/* AGRICHARTS CASHGRID — the board most AgriCharts operators actually publish.
 *
 * WHY THIS EXISTS. lib/adapters/agricharts.mjs reads the MOBILE board at
 * <sub>.mobile.agricharts.com/cash/prices.php. Measured 2026-09-03 across the
 * 211 sites data/platforms.json calls agricharts: our 84 sources come from
 * SIXTEEN distinct mobile boards, and only 18 of the 211 have one we read. The
 * mobile route converts about 8.5% of the platform.
 *
 * Run 91611899805 asked 61 uncovered operators for both shapes:
 *
 *     47  served prices in a table we cannot parse yet
 *     10  answered 500          (no mobile board for that customer)
 *      2  answered 403
 *
 * and run 91617768662 brought the bytes back. Those 47 captures carry
 * 6,349 price cells across 505 distinct locations.
 *
 * THE PAGE DOES THE ARITHMETIC IN THE BROWSER, AND SHOWS ITS WORKING:
 *
 *     writeBidCell(-34, false, 0, false, 56, 'c=4843&l=12579&d=U26', false,
 *                  quotes['ZCZ26']);
 *      |            |     |   |     |    |                            |
 *      basis¢    manual   |  incwt weight chart params            THE CONTRACT
 *                     rounding
 *
 * and the function it feeds, verbatim from the page:
 *
 *     var rounded = (typeof(quote) == "undefined")
 *                 ? parseInt(basis.toString().replace('.', ''))   // a flat price
 *                 : basis;
 *     if (!manual && quote.symbol) {
 *       var price = quote.rawLast * unitvalue;
 *       if (quote.symbol.substring(0,2) == 'MW' || ... == 'ZR')
 *            rounded = parseFloat(price) + (basis/100);           // dollar quotes
 *       else rounded = parseFloat(price) + basis;                 // cent quotes
 *     }
 *     if (incwt) rounded = rounded * (100 / weight);
 *
 * THIS IS BETTER EVIDENCE THAN THE MOBILE BOARD GIVES US. The mobile board
 * prints cash and basis and leaves us to work out WHICH contract by fitting the
 * difference against every candidate inside MAX_FIT_CENTS. Here the board names
 * the contract. There is nothing to infer and no tolerance to pick.
 *
 * WHICH MEANS cash - basis = futures IS TRUE BY CONSTRUCTION AND GUARDS
 * NOTHING. We compute cash from basis and the quote, so checking that the
 * difference is the quote checks our own arithmetic against itself. The checks
 * here are the ones that can actually fail:
 *
 *   1. the named contract must be one our quote pages price      (else refuse)
 *   2. the contract's root must match the board's own commodity  (else refuse)
 *      heading -- a Corn heading feeding a ZS contract is a parse error, and
 *      it is the failure a positional parser makes
 *   3. every delivery code in a table must appear in that table's own column
 *      headers                                                   (else refuse)
 *
 * Check 2 is why rootsFor() is imported rather than reimplemented: Milo prices
 * off corn, and every wheat class prices off one of three exchanges. That map
 * was measured the hard way on 2026-09-02 when Cornerstone Ag's WHITE WHEAT
 * turned out to be Kansas City.
 */
import { cellText, locationNames, GRAIN_ROOTS, rootsFor } from "./agricharts.mjs";

export const COLUMNS = ["Location"];
export const VERIFIED_BY = "agricharts-cashgrid:contract-named+heading-agrees";

/* THE MONTH CODES ARE THE EXCHANGE'S, NOT OURS, and they are not sequential
   letters -- I is skipped everywhere because it reads as a 1. */
export const MONTH_CODES = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
                             N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };

/* Every argument, in order, and the delivery code out of the chart params.
 * The eighth argument is ABSENT on a flat posted price, which is a different
 * kind of row and not a parse failure -- Agtegra posts sunflowers that way.
 * `rounding` is a float on plenty of boards (0.5, 0.75) and -1 where the
 * operator has turned rounding off; matching it as an integer missed 2,037 of
 * 6,349 cells on the first pass. */
export const CELL = new RegExp(
  "writeBidCell\\(\\s*(-?[\\d.]+)\\s*,\\s*(true|false)\\s*,\\s*(-?[\\d.]+)\\s*,"
  + "\\s*(true|false)\\s*,\\s*(\\d+)\\s*,\\s*'c=(\\d+)&(?:amp;)?l=(\\d+)&(?:amp;)?d=([A-Za-z]\\d{2})'"
  + "\\s*,\\s*(true|false)\\s*(?:,\\s*quotes\\['([A-Z0-9]+)'\\]\\s*)?\\)", "g");

const GRID = /<table[^>]*class="[^"]*(?:cashbid_grid|table-condensed)[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
const HEADING = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;

/** "U26" -> "09/01/2026". The board posts a delivery MONTH, so the first of it
 *  is the only honest day to put on it -- the same convention the mobile
 *  adapter's own boards use when they print one. */
export function deliveryFromCode(code) {
  const m = /^([A-Za-z])(\d{2})$/.exec(String(code ?? ""));
  if (!m) return null;
  const mo = MONTH_CODES[m[1].toUpperCase()];
  if (!mo) return null;
  return `${String(mo).padStart(2, "0")}/01/20${m[2]}`;
}

/** The commodity heading in scope at each byte offset, nearest preceding wins. */
export function headingsBefore(html) {
  const out = [];
  for (const m of String(html).matchAll(HEADING)) {
    const t = cellText(m[1]);
    if (t) out.push({ at: m.index, text: t });
  }
  return out;
}

function headingAt(headings, offset) {
  let best = null;
  for (const h of headings) { if (h.at < offset) best = h; else break; }
  return best ? best.text : null;
}

/** The delivery codes a table's own column headers offer, as a Set of codes.
 *  "Sep '26" -> U26. Used only to check the cells against the page's own
 *  headings, never to decide what a cell means. */
export function headerCodes(tableHtml) {
  const out = new Set();
  const NAMES = { jan: "F", feb: "G", mar: "H", apr: "J", may: "K", jun: "M",
                  jul: "N", aug: "Q", sep: "U", oct: "V", nov: "X", dec: "Z" };
  for (const th of String(tableHtml).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)) {
    const t = cellText(th[1]).toLowerCase();
    const m = /([a-z]{3})[a-z]*\s*'?(\d{2})/.exec(t);
    if (m && NAMES[m[1]]) out.add(`${NAMES[m[1]]}${m[2]}`);
  }
  return out;
}

/** The place names the GRID ROWS carry, from their own links:
 *
 *     <a href="/markets/cash.php?location_filter=12579">Hull Feed &amp; Produce</a>
 *
 *  The <select name="location_filter"> is still the better source and still
 *  wins — it is the page's own canonical list. But measured across the 47
 *  captures, six boards name 21 locations only in the row link and not in the
 *  selector, and a row with no place name cannot become a manifest: the sweep
 *  refuses it for want of a town. 124 rows, and they are somebody's elevator.
 */
export function linkNames(html) {
  const out = new Map();
  for (const m of String(html).matchAll(
    /<a[^>]*href="[^"]*location_filter=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = cellText(m[2]);
    if (name && !out.has(m[1])) out.set(m[1], name);
  }
  return out;
}

/** Every price cell on the page, with the commodity heading and table it came
 *  from. No prices are computed here: this is what the document says. */
export function parseCells(html) {
  const s = String(html);
  const headings = headingsBefore(s);
  const cells = [];
  const tables = [];
  for (const t of s.matchAll(GRID)) {
    const codes = headerCodes(t[1]);
    const commodity = headingAt(headings, t.index);
    const table = { commodity, codes, cells: [] };
    const R = new RegExp(CELL.source, "g");
    let m;
    while ((m = R.exec(t[1]))) {
      const cell = {
        basis: Number(m[1]), manual: m[2] === "true", rounding: Number(m[3]),
        incwt: m[4] === "true", weight: Number(m[5]),
        commodityId: m[6], locationId: m[7],
        deliveryCode: m[8].toUpperCase(), currConv: m[9] === "true",
        symbol: m[10] ?? null, commodity, table,
      };
      cells.push(cell); table.cells.push(cell);
    }
    if (table.cells.length) tables.push(table);
  }
  return { cells, tables };
}

/** The page's own arithmetic, in the page's own order.
 *  Returns dollars, or null when the contract is not one we price. */
export function cashFor(cell, contract) {
  if (cell.manual || !contract) {
    /* parseInt(basis.toString().replace('.','')) -- "24.5" becomes 245, which
       is the board saying $2.45 and not $24.50. Their notation, not ours. */
    const flat = parseInt(String(cell.basis).replace(".", ""), 10);
    if (!Number.isFinite(flat)) return null;
    return round2(applyWeight(flat / 100, cell));
  }
  if (!Number.isFinite(contract.lastCents)) return null;

  /* ONE FORMULA, AND THE PAGE'S TWO ARE THE REASON WHY.
   *
   * The page branches on the symbol, because ITS quote object holds the
   * exchange's raw number and the exchanges disagree with each other:
   *
   *     if (quote.symbol.substring(0,2) == 'MW' || == 'ZR')
   *          rounded = parseFloat(price) + (basis/100);   // rawLast 7.5975
   *     else rounded = parseFloat(price) + basis;         // rawLast 754.75
   *
   * ...and then prints the first WITHOUT dividing by a hundred and the second
   * with. Two branches that cancel out to the same answer.
   *
   * OUR contract does not hold the raw number. mergeQuotes() already
   * normalises every root to cents — measured: MW comes in as "7.5975s" and
   * comes out as lastCents 759.75, ZR as "15.235s" and 1523.5 — so copying the
   * page's branch here subtracts 0.85 where it should subtract 85, and prices
   * Minneapolis spring wheat 84 cents too high. I wrote that branch, with a
   * comment warning about the factor of a hundred, and it was wrong in exactly
   * the way the comment described.
   *
   *     MWZ26 759.75c, basis -85  ->  674.75c  ->  $6.75   correct
   *                                   758.90c  ->  $7.59   the branch
   *
   * The unit is a property of OUR contract record, not of the vendor's page.
   */
  const cents = contract.lastCents + cell.basis;
  return round2(applyWeight(cents / 100, cell));
}

function applyWeight(dollars, cell) {
  /* incwt turns a per-bushel price into a per-hundredweight one at the test
     weight the board carries. Sunflowers at 24 come out of here. */
  if (!cell.incwt || !cell.weight) return dollars;
  return dollars * (100 / cell.weight);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * html -> rows, or throw.
 *
 * REFUSES THE WHOLE BOARD when it cannot be read at all, and refuses
 * INDIVIDUAL ROWS onto `unreconciled` when the board disagrees with itself.
 * Same doctrine as lib/adapters/agricharts.mjs and for the same reason: a
 * board nobody can check does not get published, and a row that fails a check
 * the rest of the board passes is a row, not a verdict on the board.
 */
export function extract(html, sourceUrl, shared) {
  const contracts = shared?.contracts;
  if (!Array.isArray(contracts) || !contracts.length)
    throw new Error("no CBOT quotes were handed to the cashgrid adapter, and this board "
      + "publishes a basis and the NAME of its contract — without the quote there is no "
      + "cash price to publish, only arithmetic we did not do");

  const bySymbol = new Map(contracts.filter((c) => c.priced && c.symbol).map((c) => [c.symbol, c]));
  const { cells, tables } = parseCells(html);
  if (!cells.length)
    throw new Error("no writeBidCell calls on this page: it is not an AgriCharts cashgrid board");

  /* The selector is the canonical list and wins; the row links fill the gaps. */
  const names = locationNames(html);
  const fromLinks = linkNames(html);
  const unreconciled = [];
  const refuse = (c, why) => unreconciled.push({
    location: names.get(c.locationId) ?? fromLinks.get(c.locationId) ?? c.locationId, commodity: c.commodity,
    delivery: deliveryFromCode(c.deliveryCode), why });

  /* CHECK 3, ONCE PER TABLE. A delivery code with no column header above it
     means the cells and the headings came from different documents -- which is
     what a regex over the whole page does when a table is nested inside
     another one. */
  for (const t of tables) {
    if (!t.codes.size) continue;            // no headers to check against
    const stray = [...new Set(t.cells.map((c) => c.deliveryCode))].filter((c) => !t.codes.has(c));
    if (stray.length)
      throw new Error(`the "${t.commodity ?? "?"}" table carries delivery code(s) `
        + `${stray.join(", ")} that its own column headers do not offer `
        + `(${[...t.codes].join(", ") || "none"}) — the cells and the headers are not from `
        + `the same table`);
  }

  const rows = [];
  let seq = 0;
  for (const c of cells) {
    const delivery = deliveryFromCode(c.deliveryCode);
    if (!delivery) { refuse(c, `delivery code "${c.deliveryCode}" is not a month`); continue; }

    let contract = null;
    if (c.symbol && !c.manual) {
      contract = bySymbol.get(c.symbol);
      /* CHECK 1. Not an error in the board: a contract we do not fetch is a
         gap in OUR quote pages, and the row says so rather than vanishing. */
      if (!contract) { refuse(c, `the board prices this against ${c.symbol}, which our quote `
        + `pages do not carry`); continue; }

      /* CHECK 2. The heading is the operator's word for the commodity and the
         symbol is the exchange's. They have to agree. */
      const allowed = rootsFor(c.commodity);
      if (!allowed) { refuse(c, `no commodity heading above this table, so "${c.symbol}" `
        + `cannot be checked against anything`); continue; }
      if (!allowed.includes(contract.root))
        { refuse(c, `heading says "${c.commodity}" (${allowed.join("/")}) but the board `
          + `prices it against ${c.symbol} (${contract.root})`); continue; }
    }

    const cash = cashFor(c, contract);
    if (cash == null || !Number.isFinite(cash)) { refuse(c, "no price could be computed"); continue; }

    /* A ZERO IS NOT A BID. Measured across the 47 captures: eighteen flat rows
       under an "Oats" heading come out at $0.00, which is an operator saying
       "we are not buying oats" in the only field the form gives them. The
       mobile adapter drops these for the same reason and has since the day a
       single $0.00 row dragged a group five hundred cents wide and got a whole
       board refused for it. A price of nothing publishes as nothing. */
    if (cash <= 0) { refuse(c, `the board posts ${cash.toFixed(2)}, which is not a bid`); continue; }

    const basisDollars = contract ? round2(c.basis / 100) : null;
    rows.push({
      seq: seq++,
      location: names.get(c.locationId) ?? fromLinks.get(c.locationId) ?? null,
      locationId: c.locationId,
      commodity: c.commodity,
      delivery,
      cash,
      basis: basisDollars,
      basisCents: contract ? c.basis : null,
      /* NAMED, NOT IMPLIED. The mobile adapter fills impliedFuturesCents by
         subtraction and then fits it to a contract; here the board said which,
         so the fields that describe the contract are filled and the implied
         one stays null rather than restating our own subtraction as evidence. */
      impliedFuturesCents: null,
      futures: contract ? contract.symbol : null,
      futuresPrice: contract ? contract.lastCents : null,
      futuresAt: contract ? contract.at ?? null : null,
      futuresFlag: contract ? contract.flag ?? null : null,
      futuresChange: null,
      commodityId: c.commodityId,
      deliveryCode: c.deliveryCode,
      unit: contract ? (GRAIN_ROOTS[contract.root]?.unit ?? null)
                     : (c.incwt ? "hundredweight" : null),
      source: sourceUrl,
      raw: `${c.commodity ?? "?"} ${delivery} l=${c.locationId}`,
      verifiedBy: contract ? VERIFIED_BY : "agricharts-cashgrid:posted-flat",
    });
  }

  if (!rows.length)
    throw new Error(`all ${cells.length} price cell(s) on this board were refused: `
      + unreconciled.slice(0, 3).map((u) => u.why).join("; "));

  Object.defineProperty(rows, "unreconciled", { value: unreconciled, enumerable: false });
  return rows;
}

export default extract;

/* ADAPTER — AgriCharts, read through the mobile board.
 *
 * 211 sites and roughly 945 locations behind one shape. The desktop board at
 * /markets/* is robots-disallowed on essentially every AgriCharts site; the
 * mobile one is not, and serves every location and every price as plain HTML
 * with no browser and no JavaScript:
 *
 *     https://<sub>.mobile.agricharts.com/cash/prices.php
 *     https://mobile.<vanity-domain>/cash/prices.php
 *
 * Written against seven boards captured from the runner on 2026-09-02 and
 * committed verbatim as fixtures/agricharts-*.html — 309 rows, 35 tables,
 * 24 location ids. Not against a description of them.
 *
 * WHAT THE BOARD CARRIES, AND THE ONE THING IT DOES NOT
 *
 *     Commodity | Delivery | Basis | Cash Price | Futures Chg
 *
 * Cash in dollars, basis in whole cents, and a futures CHANGE. There is no
 * futures PRICE anywhere on the page, which is the fact that governs this
 * whole file: lib/board.mjs refuses any source where not one row carries a
 * quoted future, because a structural check whose absence looks identical to
 * its success is not a check. That guard is right and nothing here works
 * around it.
 *
 * SO WHY NOT SET futuresPrice = cash - basis?
 *
 * Because `cash - basis = futures` is the check. A futures price derived from
 * cash and basis satisfies it by construction, on every row, for ever — it
 * would turn the one structural guard in this system into a tautology and
 * publish with every signal green. The derived figure is recorded as
 * `impliedFuturesCents` under a name that says what it is, and `futuresPrice`
 * stays null, which refuses. Wiring a source up needs the real quote, and
 * fixtures/agricharts-quotes-*.html is where that lives — see parseQuotes.
 *
 * WHAT REPLACES IT WHILE IT IS MISSING
 *
 * The board checks itself, and this is not a consolation prize. Every location
 * on one board prices off the same futures, so cash*100 - basis must land on
 * the same integer for every row sharing a commodity and a delivery code.
 * Measured across all seven captures: 85 of 87 groups agree exactly, and the
 * other two are one cent apart — Legacy Farmers' corn, where Dec settled at
 * 543-4 and ten locations rounded the half-cent both ways.
 *
 * That invariant catches what checkIdentity catches. Swap basis and change,
 * flip a sign, misalign a row, read cents as dollars: cash and basis stop
 * agreeing across locations and the spread blows out. It is a relationship
 * between the two columns, tested across independent rows, and it is why this
 * adapter can refuse a misread board rather than publish one.
 */

/* ---------- small readers ---------- */

const stripTags = (h) => String(h).replace(/<[^>]*>/g, " ");
const unent = (s) => String(s)
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'");
export const cellText = (h) => unent(stripTags(h)).replace(/\s+/g, " ").trim();

export class AgriChartsRefused extends Error {}

/** What we are looking at, for a refusal message that saves a round trip. */
export function describe(body) {
  const s = String(body ?? "");
  if (!s.length) return "0 bytes";
  const title = s.match(/<title>([\s\S]*?)<\/title>/i);
  const boards = (s.match(/<table class="cashprices"/g) || []).length;
  const quotes = (s.match(/class="quoteboard"/g) || []).length;
  return `${s.length} bytes`
    + (title ? ` · title ${JSON.stringify(cellText(title[1]).slice(0, 80))}` : " · no <title>")
    + ` · ${boards} cash table(s), ${quotes} quote table(s)`
    + (boards || quotes ? "" : ` · starts ${JSON.stringify(cellText(s).slice(0, 120))}`);
}

/* ---------- the cash board ---------- */

/* THE HEADER ROW IS THE STRUCTURAL GUARD AND IT IS FREE.
 * All 35 tables across the seven captures carry exactly these five labels in
 * exactly this order. A board that renames or reorders one is a board this
 * parser is no longer reading correctly, and that has to be a refusal rather
 * than a column read from the wrong place. */
export const COLUMNS = ["Commodity", "Delivery", "Basis", "Cash Price", "Futures Chg"];

const TABLE = /<table class="cashprices"[\s\S]*?<\/table>/g;
const SECTION = /<tr class="section">\s*<td[^>]*>([\s\S]*?)<\/td>/;
const BODY_ROW = /<tr class="(?:odd|even)">([\s\S]*?)<\/tr>/g;
const CELL = /<td[^>]*>([\s\S]*?)<\/td>/g;
/* c = commodity id, l = LOCATION id, d = the DELIVERY month code.
 * d is NOT the futures month: corn on these boards carries d=X26, F27, G27,
 * J27 and M27, and CBOT corn has no contract in November, January, February,
 * April or June. probe-lists/agricharts-mobile.txt said otherwise until
 * 2026-09-02 and the captures disproved it. */
const CHART = /chart\.php\?c=(\d+)&(?:amp;)?l=(\d+)&(?:amp;)?d=([A-Za-z]\d{2})/;

const cellsOf = (rowHtml) => [...String(rowHtml).matchAll(CELL)].map((m) => m[1]);

/** "$5.29" -> 5.29 ; "$1,102.50" -> 1102.5 ; anything else -> null. */
export function parseCash(text) {
  const t = cellText(text).replace(/[$,]/g, "");
  return /^\d+(\.\d{1,4})?$/.test(t) ? parseFloat(t) : null;
}

/** "-67" -> -67 cents ; "9" -> 9 ; "-67.5" -> -67.5 ; anything else -> null. */
export function parseBasisCents(text) {
  const t = cellText(text).replace(/[+,]/g, "");
  return /^-?\d+(\.\d{1,2})?$/.test(t) ? parseFloat(t) : null;
}

/* A SECTION HEADING IS A LOCATION OR A COMMODITY, AND THE ROWS SAY WHICH.
 *
 * Both shapes are in the captures. Kokomo Grain, Legacy Farmers, Wheatfield
 * Grain and The Farmers Elevator head each table with a LOCATION; Aurora
 * Elevator, Keller Grain and Offerle head each table with a COMMODITY and name
 * no location anywhere on the page.
 *
 * The test is the rows underneath: a commodity heading is one that every row in
 * its own table repeats in its Commodity cell. It costs nothing, it needs no
 * list of known towns, and it was checked against all 35 tables. `l` from the
 * chart link is what the source actually keys on either way — a location id is
 * on every row of every capture — so this only decides what the row is LABELLED
 * with, and a wrong label cannot put one town's price on another town's board. */
export function sectionIsCommodity(heading, rowCommodities) {
  const h = String(heading).trim().toLowerCase();
  if (!h || !rowCommodities.length) return false;
  return rowCommodities.every((c) => String(c).trim().toLowerCase() === h);
}

/* The widest disagreement seen between two locations on one board, over all
   seven captures, is ONE cent, and it happens on 2 of 87 groups. Three is
   three times the worst thing ever measured; anything at or under it is
   somebody's rounding, anything past it is not. */
export const MAX_IMPLIED_SPREAD_CENTS = 3;

export function parseBoard(body, sourceUrl = "") {
  const html = String(body ?? "");
  const tables = html.match(TABLE) ?? [];
  if (!tables.length)
    throw new AgriChartsRefused(`no cash board on this page. ${describe(html)}`);

  const names = locationNames(html);
  const out = [];
  let seq = 0, skipped = 0, noBasis = 0;
  const skips = [];

  for (const [i, t] of tables.entries()) {
    const heading = cellText((t.match(SECTION) ?? [, ""])[1]);

    /* THE HEADER ROW IS FOUND, NOT COUNTED TO.
     *
     * It used to be "the row immediately after the section row", which is true
     * of all 35 tables in the seven captures and false elsewhere: on the
     * national sweep of 2026-09-03, SIX boards carry a cashprices table with no
     * `<tr class="section">` at all. `t.search(SECTION)` returns -1 on those,
     * the slice took the last character of the table, and every one of them
     * refused with `found []` -- a message that says the columns moved when the
     * columns were exactly where they should be.
     *
     * So the header is the first row whose cells ARE the labels. A section row
     * is one cell of colspan; a price row is five cells of numbers; neither can
     * be mistaken for this, and a table whose header really has been renamed
     * still refuses -- with the rows it did see, which is what the old message
     * was pretending to give. */
    const labels = COLUMNS.join("|").toLowerCase();
    let headers = null;
    for (const m of t.matchAll(/<tr(?![^>]*class="(?:odd|even|section)")[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = cellsOf(m[1]).map(cellText);
      if (cells.join("|").toLowerCase() === labels) { headers = cells; break; }
    }
    if (!headers) {
      const seen = [...t.matchAll(/<tr(?![^>]*class="(?:odd|even)")[^>]*>([\s\S]*?)<\/tr>/g)]
        .map((m) => cellsOf(m[1]).map(cellText)).filter((c) => c.length).slice(0, 3);
      throw new AgriChartsRefused(
        `table ${i + 1} of ${tables.length} ("${heading || "unnamed"}") does not carry the `
        + `columns this adapter reads. Expected ${JSON.stringify(COLUMNS)}; the non-price rows `
        + `on it are ${JSON.stringify(seen)}. Refusing rather than reading a column from the `
        + `wrong place. ${describe(html)}`);
    }

    const rows = [...t.matchAll(BODY_ROW)].map((m) => m[1]);
    const parsed = [];
    for (const r of rows) {
      const cells = cellsOf(r);
      if (cells.length !== COLUMNS.length)
        throw new AgriChartsRefused(
          `a row under "${heading || "unnamed"}" has ${cells.length} cell(s), not `
          + `${COLUMNS.length}. All 309 rows of the seven captures have five. This is a shape `
          + `change, not a missing price. Row text: ${JSON.stringify(cellText(r).slice(0, 160))}`);

      const link = r.match(CHART);
      const commodity = cellText(cells[0]);
      const delivery = cellText(cells[1]);
      const basisCents = parseBasisCents(cells[2]);
      const cash = parseCash(cells[3]);
      const change = cellText(cells[4]);

      /* Absent is not empty, and a row that cannot produce all of these is
         dropped rather than defaulted -- the guards downstream are there to see
         real numbers or nothing. Every drop is counted and named, because "0
         bids" and "0 rows we could read" are different sentences. */
      if (!link || !commodity || !delivery || cash == null || basisCents == null) {
        skipped++;
        /* AN EMPTY BASIS CELL IS NOT AN UNREADABLE ONE. Butterfield Grain and
           Westco publish cash with the Basis and Futures Chg columns blank on
           every row -- a cash-only board. Calling that "basis unreadable" sent
           me looking for a parse bug in a page that is exactly what it looks
           like. It is still unpublishable here, because a cash figure with no
           basis has nothing to check it against, but the refusal has to say
           which of the two it is. */
        if (link && commodity && cash != null && basisCents == null
            && !cellText(cells[2])) noBasis++;
        if (skips.length < 6) skips.push(`${heading || "?"} / ${commodity || "?"} ${delivery || "?"}`
          + ` (${!link ? "no chart link" : cash == null ? "cash unreadable"
              : basisCents == null ? (cellText(cells[2]) ? "basis unreadable" : "basis cell empty")
              : "incomplete"})`);
        continue;
      }
      parsed.push({ commodity, delivery, basisCents, cash, change,
                    commodityId: link[1], locationId: link[2], deliveryCode: link[3].toUpperCase() });
    }

    const isCommodityHeading = sectionIsCommodity(heading, parsed.map((p) => p.commodity));
    /* THE HEADING AND THE SELECTOR MUST NOT DISAGREE. They agreed at all 47
       places both existed across the captures. If they ever stop, one of the
       two has stopped meaning what it meant, and guessing which would put one
       town's name on another town's price. */
    if (!isCommodityHeading && heading) {
      for (const p of parsed) {
        const byId = names.get(p.locationId);
        if (byId && byId.toLowerCase() !== heading.toLowerCase())
          throw new AgriChartsRefused(
            `this board's table heading and its own location filter disagree about location `
            + `${p.locationId}: the table says "${heading}" and the filter says "${byId}". One of `
            + `them has stopped meaning what it meant, and there is no way to tell which. `
            + `${describe(html)}`);
      }
    }
    for (const p of parsed) {
      out.push({
        seq: seq++,
        /* The selector is keyed by the same id the row carries, so it wins; the
           heading is only used where the page offers no selector. */
        location: names.get(p.locationId) ?? (isCommodityHeading ? null : (heading || null)),
        locationId: p.locationId,
        commodity: p.commodity,
        delivery: p.delivery,
        cash: Math.round(p.cash * 10000) / 10000,
        basis: Math.round((p.basisCents / 100) * 10000) / 10000,
        basisCents: p.basisCents,
        /* NAMED FOR WHAT IT IS. This is cash minus basis and nothing else — it
           is not a quote, it must never be copied into futuresPrice, and the
           name is the guard against somebody doing that in a hurry. */
        impliedFuturesCents: Number((p.cash * 100 - p.basisCents).toFixed(4)),
        futures: null,
        /* THE BOARD PUBLISHES NO FUTURES PRICE. Leaving this null is what makes
           lib/board.mjs refuse, and that refusal is correct until a real quote
           is joined on. See the note at the top of this file. */
        futuresPrice: null,
        futuresAt: null,
        futuresFlag: null,
        futuresChange: p.change || null,
        commodityId: p.commodityId,
        deliveryCode: p.deliveryCode,
        source: sourceUrl,
        raw: `${heading || "?"} ${p.commodity} ${p.delivery}`,
      });
    }
  }

  if (!out.length) {
    if (noBasis && noBasis === skipped)
      throw new AgriChartsRefused(
        `this is a cash-only board: all ${skipped} row(s) carry a price and an EMPTY basis cell. `
        + `Nothing is wrong with the page and nothing is wrong with the parse — but a cash figure `
        + `with no basis beside it cannot be checked against a futures quote, and this system does `
        + `not publish a number it cannot check. ${describe(html)}`);
    throw new AgriChartsRefused(
      `${tables.length} cash table(s) on the page and no row survived`
      + (skipped ? `: ${skipped} row(s) dropped — ${skips.join("; ")}` : " — the tables are empty")
      + `. ${describe(html)}`);
  }

  /* THE SELF-AGREEMENT CHECK LIVES IN extract(), NOT HERE. It used to throw
     from this function, which made parseBoard both a parser and a judge and
     cost two whole boards on the national sweep: Balk Grain has ONE soybean
     group 6c wide out of dozens, and Lang Farms carries stale target rows
     dated 2023 and 2024. Neither is a misread and both were refused entirely.
     The rule is right; where it applied was not. See extract(). */
  return out;
}

/* WHERE THE LOCATION NAMES ARE ON A BOARD THAT NAMES NONE.
 *
 * Farmers Cooperative Dorchester posts 1,096 rows across 49 locations and heads
 * every table "CORN". The location is in the chart link's l= and nowhere else
 * in the tables -- but the page carries a filter above them:
 *
 *     <select name="location_filter">
 *       <option value="28468">BEATRICE</option>
 *
 * That is id to name for every location on the board, in the operator's own
 * spelling. Measured across the 23 captures: every board carrying a selector
 * names 100% of the locations its tables use, and at the 47 places where a
 * section heading ALSO names the location the two agree exactly, every time.
 *
 * So the selector is what a row is labelled from, and the heading becomes a
 * cross-check rather than the source. */
export function locationNames(html) {
  const sel = String(html).match(/<select[^>]*name=["']location_filter["'][^>]*>([\s\S]*?)<\/select>/i);
  const out = new Map();
  if (!sel) return out;
  for (const o of sel[1].matchAll(/<option[^>]*value=["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    const name = cellText(o[2]);
    if (name && !/^all locations$/i.test(name)) out.set(o[1], name);
  }
  return out;
}

/** The worst (commodity, delivery-code) group whose implied futures disagree, or null. */
export function impliedSpread(rows, max = MAX_IMPLIED_SPREAD_CENTS) {
  const groups = new Map();
  for (const r of rows) {
    if (r.impliedFuturesCents == null || !r.deliveryCode) continue;
    const k = `${String(r.commodity).toLowerCase()}␟${r.deliveryCode}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  let worst = null;
  for (const [, rs] of groups) {
    const vals = rs.map((r) => r.impliedFuturesCents);
    const spread = Number((Math.max(...vals) - Math.min(...vals)).toFixed(4));
    if (spread > max && (!worst || spread > worst.spread))
      worst = { commodity: rs[0].commodity, deliveryCode: rs[0].deliveryCode,
                spread, n: rs.length, values: [...new Set(vals)].sort((a, b) => a - b) };
  }
  return worst;
}

/** "Last Update: 23:09:43 CST" -> "23:09:43 CST". Their stamp, verbatim, or null. */
export function boardStamp(body) {
  const m = String(body ?? "").match(/Last Update:\s*([0-9:]+\s*[A-Z]{2,4})/);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/* ---------- the futures quotes ---------- */

/* WHERE THE MISSING NUMBER LIVES.
 *
 * Same host, and it is CBOT's number rather than the operator's, so one host
 * answers for all 211 sites:
 *
 *     /markets/futures.php?category=Grains&overview=1   two contracts each
 *     /markets/futures.php?category=Grains&root=ZC      the whole strip
 *
 * The symbol cell links to /markets/quote.php?symbols=ZCZ26, so the contract
 * is named by the page and never inferred: root, month letter and year come
 * off the symbol itself.
 *
 * TWO NOTATIONS, ON THE SAME PAGE FAMILY. Corn, soybeans, both winter wheats
 * and oats quote in eighths ("542-2", "754-6s"); Minneapolis spring wheat and
 * rough rice quote in dollars ("7.8000", "15.235s"). The shape of the cell
 * decides which, per cell, rather than a list of roots that would go stale the
 * day they add one. Both end in cents, because that is what futuresPrice is.
 *
 * The trailing "s" is the settle flag — the same one that cost eleven hours on
 * 2026-08-19 when a "513-6s" parsed as 513. It is carried, not discarded.
 */
const QUOTE_ROW = /<tr>\s*<td[^>]*class="quotefield_symbol"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class="quotefield_last"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class="quotefield_change[^"]*"[^>]*>([\s\S]*?)<\/td>(?:\s*<td[^>]*class="quotefield_timestamp"[^>]*>([\s\S]*?)<\/td>)?/g;

/* THE UNIT IS A PROPERTY OF THE CONTRACT, NOT OF THE CELL.
 *
 * The overview page carries soybean MEAL and soybean OIL beside the grains, and
 * the first cut of this file quietly mis-parsed both. Meal quotes "339.5" —
 * dollars per SHORT TON — and oil quotes "70.50" — CENTS PER POUND. Read as a
 * bushel price and multiplied by a hundred, those become 33,950c and 7,050c:
 * numbers with the right shape, the right sign and no possible correct use.
 *
 * Counting decimal places cannot tell them apart from Minneapolis wheat's
 * "7.8000" or rice's "15.650", because the difference is not in the text. The
 * root is. So the roots this system prices are named, with their unit, and
 * everything else is kept in the list with lastCents NULL and priced:false —
 * present, honest, and impossible to publish by accident.
 *
 * Rough rice is per hundredweight rather than per bushel, and that is recorded
 * rather than flattened, because Riceland's boards are cwt boards. */
export const GRAIN_ROOTS = {
  ZC: { name: "Corn", unit: "bushel" },
  ZS: { name: "Soybeans", unit: "bushel" },
  ZW: { name: "Wheat, Chicago SRW", unit: "bushel" },
  KE: { name: "Wheat, KC HRW", unit: "bushel" },
  MW: { name: "Wheat, Minneapolis HRS", unit: "bushel" },
  ZO: { name: "Oats", unit: "bushel" },
  ZR: { name: "Rough rice", unit: "hundredweight" },
};

/** "542-2" -> 542.25 cents. "7.8000" -> 780 cents. Shape only; see GRAIN_ROOTS. */
export function quoteToCents(text) {
  const t = cellText(text);
  const m = t.match(/^([+-]?)(\d+)-(\d)([a-zA-Z]?)$/);
  if (m) {
    const eighths = Number(m[3]);
    if (eighths > 7) return null;            // not eighths; guessing publishes a wrong number
    const v = Number(m[2]) + eighths / 8;
    return { cents: m[1] === "-" ? -v : v, flag: m[4] ? m[4].toLowerCase() : null, notation: "eighths" };
  }
  const d = t.match(/^([+-]?)(\d+\.\d{1,4})([a-zA-Z]?)$/);
  if (d) {
    const v = Number(d[2]) * 100;
    return { cents: d[1] === "-" ? -v : v, flag: d[3] ? d[3].toLowerCase() : null, notation: "dollars" };
  }
  /* Tick-shaped and unparsed must refuse rather than fall back to the leading
     integer — that is exactly how "513-6s" became 513. */
  return null;
}

export function parseQuotes(body) {
  const html = String(body ?? "");
  if (!/class="quoteboard"/.test(html))
    throw new AgriChartsRefused(`no futures quote table on this page. ${describe(html)}`);
  const heads = [...html.matchAll(/<th class="quotefield_(\w+)">([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  for (const want of ["symbol", "last", "change"])
    if (!heads.includes(want))
      throw new AgriChartsRefused(
        `the quote table has no "${want}" column. Found ${JSON.stringify(heads)}. ${describe(html)}`);

  const out = [];
  let unreadable = 0;
  const bad = [];
  for (const m of html.matchAll(QUOTE_ROW)) {
    const symbol = (m[1].match(/symbols=([A-Z0-9]+)/) ?? [])[1] ?? null;
    const title = (m[1].match(/title="([^"]+)"/) ?? [])[1] ?? null;
    const name = cellText(m[1].replace(/<img[^>]*>/g, ""));
    const last = quoteToCents(m[2]);
    const chgText = cellText(m[3]);
    const change = /^unch/i.test(chgText) ? { cents: 0, flag: null } : quoteToCents(m[3]);
    if (!symbol || !last) {
      unreadable++;
      if (bad.length < 5) bad.push(`${symbol ?? name ?? "?"} last=${JSON.stringify(cellText(m[2]))}`);
      continue;
    }
    const sm = symbol.match(/^([A-Z]{1,3})([FGHJKMNQUVXZ])(\d{2})$/);
    const root = sm ? sm[1] : null;
    const grain = root ? GRAIN_ROOTS[root] : null;
    out.push({
      symbol,
      root,
      monthCode: sm ? sm[2] : null,
      year: sm ? 2000 + Number(sm[3]) : null,
      name, title,
      /* NULL FOR A CONTRACT WE DO NOT PRICE. Soy meal is dollars per short ton
         and soy oil is cents per pound; both sit on the overview page and
         neither converts to a bushel price by any arithmetic. */
      lastCents: grain ? last.cents : null,
      lastRaw: cellText(m[2]),
      priced: !!grain,
      unit: grain ? grain.unit : null,
      grain: grain ? grain.name : null,
      notation: last.notation,
      settled: last.flag === "s",
      flag: last.flag,
      changeCents: grain && change ? change.cents : null,
      at: cellText(m[4] ?? "") || null,
    });
  }
  if (!out.some((q) => q.priced))
    throw new AgriChartsRefused(
      `the quote table carries no contract this system prices `
      + `(${JSON.stringify(Object.keys(GRAIN_ROOTS))}); it has `
      + `${JSON.stringify([...new Set(out.map((q) => q.root))])}. ${describe(html)}`);
  if (!out.length)
    throw new AgriChartsRefused(
      `the quote table has no readable row`
      + (unreadable ? `: ${unreadable} row(s) would not parse — ${bad.join("; ")}` : "")
      + `. ${describe(html)}`);
  return out;
}

/* ---------- the two boards, checked against each other ---------- */

/* WHICH CONTRACTS A CASH COMMODITY COULD BE PRICED OFF.
 * Deliberately loose: the point is not to name the contract — deferred months
 * cluster within a quarter of a cent of each other and naming one would be a
 * coin toss — it is to prove the cash and basis columns were read correctly.
 * Sorghum has no futures contract of its own and is priced off corn, which is
 * the trade's own convention and not an assumption made here. */
/* ORDER MATTERS: the first key contained in the cell wins, so a wheat CLASS is
   listed before plain wheat. "SRW Wheat" and "HRS Wheat - Protein Premium Not
   Included" both contain "wheat"; the class is the more specific answer and
   narrows three boards to one. The abbreviations are the ones DEFAULT_BANDS
   already carries plus DNS -- Dark Northern Spring -- which Horse Heaven Grain
   writes on every row of its board, and which refused that whole board on the
   national sweep for want of three letters. */
/* WHEAT IS WHEAT, WHATEVER CLASS THEY WRITE ON IT.
 *
 * The first cut of this narrowed each class to its own exchange -- HRW to
 * Kansas City, spring to Minneapolis, white to Chicago -- which is what the
 * classes mean and is not what every co-op does. Cornerstone Ag posts WHITE
 * WHEAT implying 834c, and 834-0 is KEZ26: they price their white wheat off
 * KANSAS CITY. Narrowed to Chicago it missed by 33 cents and the row was
 * refused for being exactly right.
 *
 * The check this feeds proves the COLUMNS were read, not which exchange a
 * co-op hedges on. So every wheat string gets all three wheat boards, and the
 * abbreviations exist only so a cell that never spells "wheat" -- Horse Heaven
 * Grain writes DNS and HRW and nothing else -- still finds them. */
const WHEATS = ["ZW", "KE", "MW"];
export const CASH_TO_ROOTS = {
  hrw: WHEATS, hrs: WHEATS, dns: WHEATS, srw: WHEATS, sww: WHEATS, hrww: WHEATS,
  "dark northern": WHEATS, "hard red": WHEATS, "soft red": WHEATS, "soft white": WHEATS,
  corn: ["ZC"], milo: ["ZC"], sorghum: ["ZC"], waxy: ["ZC"],
  bean: ["ZS"], soybean: ["ZS"],
  wheat: WHEATS, oat: ["ZO"], rice: ["ZR"],
};

/* MATCHED AS A SUBSTRING, THE SAME WAY bandFor DOES IT, AND FOR THE SAME
 * REASON. An exact lookup on the whole cell worked on four boards and failed on
 * the national sweep the first time a co-op wrote its own name for a grain:
 *
 *     "CORN - CASH"  "BEANS - Elevator"  "Corn - Off Farm"
 *     "Hard Red Winter Wheat"  "Spring Wheat"  "WHITE WHEAT"
 *
 * Three boards refused entirely -- one of them 53 rows -- with "no quoted
 * contract to check against", which reads as a gap in the quote pages and was
 * nothing of the kind. Every one of those strings contains the grain's name.
 *
 * The map is deliberately loose about WHICH wheat: the check it feeds proves
 * the columns were read, not which contract they price against, and deferred
 * wheat contracts sit within a quarter of a cent of each other anyway. */
export function rootsFor(commodity) {
  const c = String(commodity ?? "").toLowerCase();
  for (const [k, v] of Object.entries(CASH_TO_ROOTS)) if (c.includes(k)) return v;
  return null;
}

/* HOW FAR A HEALTHY ROW SITS FROM A REAL CONTRACT, AND WHY FIVE.
 *
 * Measured over all 309 rows of the seven captures against the 87 priced
 * contracts, with the boards read seven minutes before the quotes:
 *
 *     min 0    median 0.25    p90 0.75    p99 1.25    MAX 1.5 cents
 *
 * Five is more than three times the worst of that, and it is not chosen by
 * padding the observed maximum. It is chosen by asking what the failure this
 * check exists for looks like: read the basis as DOLLARS instead of cents and
 * a $5.28 corn row implies 528c instead of 543c, which is TEN cents from the
 * nearest corn contract. A threshold of fifteen would wave that through. Five
 * catches it and still leaves room for a board an hour behind the market.
 *
 * This is a STRUCTURAL check, not a price check. It never supplies a number —
 * see the note at the top of this file about why a derived futures price would
 * make cash - basis = futures a tautology. */
export const MAX_FIT_CENTS = 5;

/** Every row's distance to the nearest quoted contract of a plausible root. */
export function fitToContracts(rows, contracts, max = MAX_FIT_CENTS) {
  const priced = (contracts ?? []).filter((c) => c.priced && c.lastCents != null);
  if (!priced.length)
    return { ok: false, why: "no priced contract was supplied to check against", checked: 0 };
  let checked = 0, worst = null, noRoot = new Set();
  const misses = [];
  for (const r of rows) {
    const roots = rootsFor(r.commodity);
    /* A commodity nobody quotes -- a local speciality, a seed contract -- is
       not a failure and is not silently counted as a pass either. */
    if (!roots) { noRoot.add(r.commodity); continue; }
    const near = priced.filter((c) => roots.includes(c.root))
      .reduce((best, c) => {
        const d = Math.abs(c.lastCents - r.impliedFuturesCents);
        return !best || d < best.d ? { d, c } : best;
      }, null);
    if (!near) { noRoot.add(r.commodity); continue; }
    checked++;
    if (near.d > max) {
      misses.push({ row: r, contract: near.c, d: near.d });
      if (!worst || near.d > worst.d) worst = { row: r, ...near };
    }
  }
  if (worst)
    return { ok: false, checked, unquoted: [...noRoot], misses,
      why: `${worst.row.commodity} ${worst.row.delivery} at ${worst.row.location ?? worst.row.locationId}`
        + ` implies ${worst.row.impliedFuturesCents}c from cash ${worst.row.cash} and basis `
        + `${worst.row.basisCents}c, and the nearest quoted ${worst.c.grain} contract is `
        + `${worst.c.symbol} at ${worst.c.lastCents}c — ${worst.d.toFixed(2)}c away. The widest `
        + `measured on a healthy board is 1.5c. A basis read in the wrong units lands about `
        + `ten cents out and looks exactly like this.` };
  return { ok: true, checked, unquoted: [...noRoot], misses,
    why: checked ? null : "no row carried a commodity with a quoted contract" };
}

/* ---------- what a source is allowed to publish on ---------- */

/* THE STAMP, AND WHY IT IS A STRING AND NOT A BOOLEAN.
 *
 * lib/board.mjs refuses a source where not one row carries a quoted future.
 * That rule is right, and this platform can never satisfy it — so a source may
 * instead DECLARE in its manifest which alternative it is publishing on, by
 * this exact name, and board.mjs then requires that every published row carry
 * the matching stamp. A manifest that declares nothing still refuses; a board
 * where one row went unchecked still refuses, because the stamp is per row.
 *
 * The stamp is applied in exactly one place — the bottom of extract() — and
 * only after BOTH checks have passed on the whole board. It is not something a
 * manifest can assert about itself. */
export const VERIFIED_BY = "agricharts:board-agrees+quotes-agree";

/* The quote pages, absolute. These are CBOT's numbers rather than any one
   co-op's, so one host answers for all 211 sites and the poller fetches them
   once per pass rather than once per source. Kept beside the parser so the
   list and the thing that reads it cannot drift. */
export const QUOTE_HOST = "https://legacyfarmers.mobile.agricharts.com";
export const QUOTE_PATHS = [
  "/markets/futures.php?category=Grains&root=ZC",
  "/markets/futures.php?category=Grains&root=ZS",
  "/markets/futures.php?category=Grains&root=ZW",
  "/markets/futures.php?category=Grains&root=KE",
  "/markets/futures.php?category=Grains&root=MW",
  "/markets/futures.php?category=Grains&root=ZO",
  "/markets/futures.php?category=Grains&root=ZR",
];
export const quoteUrls = (host = QUOTE_HOST) => QUOTE_PATHS.map((p) => host.replace(/\/+$/, "") + p);

/** Every contract from every quote page, one entry per symbol. */
export function mergeQuotes(bodies) {
  const bySymbol = new Map();
  for (const b of bodies) for (const q of parseQuotes(b)) if (!bySymbol.has(q.symbol)) bySymbol.set(q.symbol, q);
  return [...bySymbol.values()];
}

/* THE ADAPTER PROPER. Third argument is the per-pass context lib/adapters/
   index.mjs assembles; without the quotes in it this refuses, because the two
   checks below are the entire reason this platform is allowed to publish. */
export function extract(html, sourceUrl = "", shared = null) {
  const rows = parseBoard(html, sourceUrl);      // refuses on shape, and on a board that disagrees with itself
  const contracts = shared?.contracts ?? null;
  if (!contracts?.length)
    throw new AgriChartsRefused(
      `read ${rows.length} row(s), and no futures quotes were supplied to check them against. `
      + `This board publishes no futures price of its own, so cash - basis = futures cannot run `
      + `on it and these rows have nothing proving their columns were read correctly. `
      + `The poller fetches ${QUOTE_PATHS.length} quote page(s) once per pass; if that failed, `
      + `this source waits rather than publishing unchecked.`);

  /* ── A MINORITY IS A BAD ROW; A MAJORITY IS A BAD PARSE ──────────────────
   *
   * Both checks below used to refuse the whole board on one failing row, and
   * the national sweep showed what that costs:
   *
   *   Beardsley Farmers Elevator  ONE wheat row priced $2.33 against $7.23 and
   *                               $7.43 on the same board. Their bad number,
   *                               not our misread — and it cost eleven rows.
   *   Balk Grain                  ONE soybean group 6c wide out of dozens.
   *   Lang Farms                  stale target rows still on the board, dated
   *                               2023 and 2024, priced off contracts long gone.
   *
   * lib/board.mjs settled this doctrine for the identity check months ago and
   * it applies unchanged here: a MOVED COLUMN BREAKS EVERY ROW. If a minority
   * fail, the columns are proven by the rest and the failures are refused
   * individually; if half or more fail, nothing is proven and the board is
   * refused. classifyIdentity's own comment: "no row exact at all -> refuse,
   * nothing is proven."
   *
   * A refused row is never published and never silent -- it travels out on
   * `unreconciled`, which poll.mjs prints every pass.
   */
  const bad = new Set();
  const unreconciled = [];
  const refuse = (r, why) => { if (!bad.has(r)) { bad.add(r); unreconciled.push({
    location: r.location ?? r.locationId, commodity: r.commodity, delivery: r.delivery, why }); } };

  /* 0. THE ROWS THAT ARE NOT PRICES AT ALL COME OUT FIRST.
   *
   * A $0.00 is not a bid -- Westco posts one against Pinto Beans and Great
   * Northern Beans -- and a commodity with no futures behind it cannot be
   * checked whatever else is true of it. Both were originally removed AFTER the
   * two checks below, and a single zero row then dragged its whole
   * commodity/delivery group 500 cents wide and refused the board for
   * "disagreeing with itself". A row that is not a price must not get a vote on
   * whether the prices agree. */
  for (const r of rows) if (r.cash === 0) refuse(r, "the board posts $0.00, which is not a bid");
  for (const r of rows)
    if (!rootsFor(r.commodity))
      refuse(r, `no futures contract is quoted for "${r.commodity}", so cash minus basis could `
        + `not be checked against anything. If it prices off a board we already fetch, add it to `
        + `CASH_TO_ROOTS in lib/adapters/agricharts.mjs.`);
  const candidates = rows.filter((r) => !bad.has(r));

  /* 1. THE BOARD AGAINST ITSELF. */
  const groups = new Map();
  for (const r of candidates) {
    if (r.impliedFuturesCents == null || !r.deliveryCode) continue;
    const k = `${String(r.commodity).toLowerCase()}\u241f${r.deliveryCode}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  const wide = [...groups.values()].filter((rs) => {
    const v = rs.map((r) => r.impliedFuturesCents);
    return Number((Math.max(...v) - Math.min(...v)).toFixed(4)) > MAX_IMPLIED_SPREAD_CENTS;
  });
  if (groups.size && wide.length * 2 >= groups.size)
    throw new AgriChartsRefused(
      `this board disagrees with itself on ${wide.length} of ${groups.size} commodity/delivery `
      + `group(s). Every location on one board prices off the same future, so cash minus basis `
      + `must land on the same figure within a group — and it does not, on most of them. A `
      + `swapped column, a flipped sign or a misaligned row all look like this. ${describe(html)}`);
  for (const rs of wide) {
    /* The rows AT the extremes are the ones in doubt; refusing the whole group
       is what the majority rule is for. */
    const v = rs.map((r) => r.impliedFuturesCents);
    const mid = v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
    for (const r of rs)
      if (Math.abs(r.impliedFuturesCents - mid) > MAX_IMPLIED_SPREAD_CENTS)
        refuse(r, `cash minus basis implies ${r.impliedFuturesCents}c while other ${r.commodity} `
          + `rows for delivery ${r.deliveryCode} on this board imply ${mid}c. One of them is not `
          + `the price it looks like.`);
  }

  /* 2. THE BOARD AGAINST THE QUOTES. */
  const fit = fitToContracts(candidates, contracts);
  const checkable = fit.checked;
  if (!fit.ok && (fit.misses.length * 2 >= checkable || checkable === 0))
    throw new AgriChartsRefused(
      `${fit.misses.length} of ${checkable} checkable row(s) do not sit on any quoted contract, `
      + `which is not a minority — so the rows that do fit prove nothing about the columns. `
      + `${fit.why}`);
  for (const m of fit.misses)
    refuse(m.row, `cash minus basis implies ${m.row.impliedFuturesCents}c and the nearest quoted `
      + `${m.contract.grain} contract, ${m.contract.symbol}, is ${m.contract.lastCents}c — `
      + `${m.d.toFixed(2)}c away. Nothing on this page explains that.`);


  /* A ROW NOTHING CAN CHECK IS REFUSED, AND THE BOARD IS NOT.
   *
   * This used to throw on the whole board the moment one row carried a
   * commodity with no futures contract behind it. dtn-cs made the same mistake
   * and corrected it on 2026-08-20: "one bad Oats line cannot cost ten towns of
   * corn." Same trade here, and it is only the right trade because the refusal
   * stays VISIBLE -- the rows travel out on `unreconciled`, poll.mjs prints
   * every one of them, and a board quietly losing a row every day therefore
   * looks different from a board that never had it.
   *
   * They are not published. Nothing unverifiable ever is. */
  const kept = rows.filter((r) => !bad.has(r));

  if (!kept.length)
    throw new AgriChartsRefused(
      `not one of ${rows.length} row(s) survived its checks. First few reasons: `
      + `${unreconciled.slice(0, 3).map((u) => `${u.commodity} ${u.delivery} — ${u.why}`).join(" | ")}`);

  for (const r of kept) r.verifiedBy = VERIFIED_BY;
  /* Non-enumerable so the array still behaves like a list of bids everywhere
     else, exactly as dtn-cs carries its own. */
  Object.defineProperty(kept, "unreconciled", { value: unreconciled, enumerable: false });
  return kept;
}

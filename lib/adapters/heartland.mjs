/* HEARTLAND CO-OP'S CLOSING BOARD - A MATRIX, NOT A LIST.
 *
 * WHY THIS EXISTS. data/known-elevators.json carries 48 Heartland Coop
 * facilities, every one of them sourced from Barchart and none of them read
 * from Heartland. They publish the whole co-op themselves, on one page, at
 * https://myaccount.heartlandcoop.com/bids.htm -- 48 of 48, plus six the
 * Barchart roster does not have. One request replaces 48 rows of a paid feed.
 *
 * WHY IT NEEDED A NEW ADAPTER. Every adapter in this directory reads a board
 * that prints ONE ROW PER (location, commodity, delivery). This one is a
 * matrix: the delivery periods are COLUMN HEADINGS and the locations are rows.
 *
 *   <thead><tr>
 *     <th class="header-column dest-name">CORN BIDS</th>
 *     <th ...><span class="dates-format" data-start="20260901"
 *                                        data-end="20260930"></span> / CZ26</th>
 *     ... four more ...
 *   </thead></tr>
 *   <tbody>
 *     <tr><td class="dest-name">ALLEMAN</td>
 *         <td class="basis-num"><span>4.81</span><span>-0.49</span></td>
 *         ... four more ...
 *
 * Four tables -- CORN, PROCESSOR CORN, SOYBEANS, PROCESSOR SOYBEANS -- 129
 * body rows, 645 cells of which 625 carry a price and 20 are an empty <td>.
 *
 * ---- WHAT PROVES THE READ ---------------------------------------------------
 *
 * The board carries cash AND basis and NO futures price. The contract is named
 * in the column heading and nowhere else. So two things are checked, and
 * neither of them is arithmetic we did ourselves:
 *
 *   COLUMNS AGREE. Within one column every row must imply the SAME futures
 *   price to the cent. Measured on the 2026-09-11 capture: 107 corn cells in
 *   the first column all imply 530, 104 imply 545, 53 imply 532; the soybean
 *   columns imply 1296, 1312, 1318, 1255. Not one cell disagreed anywhere on
 *   the board. A column read against the wrong header, or a row whose cells
 *   slid by one, breaks this immediately.
 *
 *   THE QUOTE IS IN RANGE. The implied price must sit within MAX_DRIFT_CENTS
 *   of the contract the heading names, quoted from the same CBOT pages
 *   lib/adapters/agricharts.mjs already fetches once a pass.
 *
 * ---- WHY THE SECOND CHECK IS A RANGE AND NOT AN IDENTITY --------------------
 *
 * This is a SETTLEMENT board. It says so: "Prices are as of close of open
 * outcry @ 1:15 PM", and its own header carries the date it settled -- 9/11/26
 * on the capture. The quote pages are live. Requiring the two to agree to
 * TORN_MAX_CENTS would refuse this board every minute of every session except
 * the few after a close, which is a guard that fires on the market rather than
 * on a misread.
 *
 * So the rows carry NO futuresPrice and the source declares
 * identityAlternative, exactly as an AgriCharts source does, and lib/board.mjs
 * enforces that every published row carries the stamp below.
 *
 * WHY 300 CENTS. The check has to let a settlement board be read hours or days
 * after the session it settled in -- a Sunday poll reads Friday's board -- and
 * it has to catch a misread. The nearest misread it must catch is a corn row
 * checked against the soybean quote: 530 against 1296, 766 cents. The two
 * spans read the wrong way round is further still -- 4.81 and -0.49 imply -530
 * instead of 530, 1060 cents. 300 sits between every plausible drift and the
 * closest of those, and it is NOT chosen by padding an observed maximum,
 * because no drift has been observed yet: the first live passes will print
 * one. Every row carries `driftCents`, so the number gets measured rather than
 * argued about, and this constant can then be tightened against it.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: WHICH month. CZ26 at 530 and CZ27 at
 * 532 are two cents apart and no range test can tell them apart. The column
 * heading is the only evidence of the month and it is taken at its word.
 */
import { GRAIN_ROOTS, rootsFor } from "./agricharts.mjs";

export const VERIFIED_BY = "heartland:columns-agree+quote-in-range";

/* See the header. Carried on every row as `driftCents` so it can be measured. */
export const MAX_DRIFT_CENTS = 300;

export class HeartlandRefused extends Error {}

/* THE CONTRACT LETTERS THE EXCHANGE USES. I is skipped everywhere because it
   reads as a 1 -- the same table lib/adapters/agricharts-cashgrid.mjs keeps. */
export const MONTH_CODES = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
                             N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };

/* THEIR ROOT LETTER -> THE EXCHANGE'S SYMBOL ROOT.
 *
 * ONLY WHAT THIS BOARD HAS ACTUALLY PRINTED. The 2026-09-11 capture carries C
 * and S and nothing else. A wheat table would be W or KW and an oats table O,
 * and neither is going in this table on the strength of knowing what the
 * letters usually mean: the whole point of the check below is that the heading
 * and the symbol have to agree, and a mapping nobody has seen on this board is
 * a guess feeding a check. A new letter refuses the board with a message
 * naming it -- loudly, once -- and then somebody adds a line here having
 * looked at the page. */
export const BOARD_ROOTS = { C: "ZC", S: "ZS" };

const CODE = /^([A-Z]+?)([FGHJKMNQUVXZ])(\d{2})$/;

/** "CZ26" -> { root: "ZC", symbol: "ZCZ26", month: 12, year: 2026 }, or null. */
export function contractOf(code) {
  const m = CODE.exec(String(code ?? "").trim().toUpperCase());
  if (!m) return null;
  const root = BOARD_ROOTS[m[1]];
  if (!root) return null;
  return { boardRoot: m[1], root, month: MONTH_CODES[m[2]],
           year: 2000 + Number(m[3]), symbol: `${root}${m[2]}${m[3]}` };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** THE PAGE'S OWN DATE FORMATTER, kept faithfully.
 *
 *  It ships in the page and runs in the reader's browser, so what a farmer
 *  reads is this function's output and not the data- attributes. Reproducing
 *  it rather than inventing a label means our delivery string is the one on
 *  their screen -- "Sep 26", "Oct-Nov 26", "Jan 27" -- and lib/delivery.mjs
 *  reads all three shapes already.
 */
export function deliveryLabel(start, end) {
  const s = String(start ?? ""), e = String(end ?? "");
  if (!/^\d{8}$/.test(s) || !/^\d{8}$/.test(e)) return null;
  const sy = s.slice(0, 4), ey = e.slice(0, 4);
  const sm = parseInt(s.slice(4, 6), 10) - 1, em = parseInt(e.slice(4, 6), 10) - 1;
  if (!MON[sm] || !MON[em]) return null;
  if (sy !== ey) return `${MON[sm]} ${sy.slice(2)}-${MON[em]} ${ey.slice(2)}`;
  if (sm === em) return `${MON[sm]} ${sy.slice(2)}`;
  return `${MON[sm]}-${MON[em]} ${sy.slice(2)}`;
}

const strip = (h) => String(h).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();

/** The board's own settlement date, from the header it prints: "91126" or
 *  "091126" -> "2026-09-11". Their script does the same slicing. Null when the
 *  header is not there or not that shape -- it is carried, never depended on. */
export function boardDate(html) {
  const m = /<div class="header"[^>]*>[\s\S]*?<span>\s*(\d{5,6})\s*<\/span>/i.exec(String(html));
  if (!m) return null;
  const t = m[1];
  const [mo, d, y] = t.length === 5
    ? [t.slice(0, 1), t.slice(1, 3), t.slice(3, 5)]
    : [t.slice(0, 2), t.slice(2, 4), t.slice(4, 6)];
  const mm = Number(mo), dd = Number(d);
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return null;
  return `20${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Every table on the page, as { commodity, columns[], rows[] }. Shape only --
 *  nothing here decides what a number means. */
export function parseTables(html) {
  const out = [];
  for (const t of String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const inner = t[1];
    const head = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(inner);
    const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(inner);
    if (!head || !body) continue;
    const ths = [...head[1].matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)];
    if (ths.length < 2) continue;
    const commodity = strip(ths[0][2]).replace(/\s*bids?\s*$/i, "").trim();
    const columns = ths.slice(1).map(([, , cell]) => {
      const d = /data-start="(\d+)"\s+data-end="(\d+)"/i.exec(cell);
      const code = (strip(cell).match(/\/\s*([A-Z]+\d{2})\s*$/) || [])[1] ?? null;
      return { code, start: d ? d[1] : null, end: d ? d[2] : null, raw: strip(cell) };
    });
    const rows = [];
    for (const tr of body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const tds = [...tr[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
      if (!tds.length) continue;
      rows.push({ location: strip(tds[0][2]), cells: tds.slice(1).map((m) => m[2]),
                  width: tds.length });
    }
    if (rows.length) out.push({ commodity, columns, rows, thCount: ths.length });
  }
  return out;
}

/** One price cell: either empty, or exactly two signed decimals in that order.
 *  Anything else is a shape nobody has seen and must not be guessed at. */
export function parseCell(cell) {
  const s = String(cell ?? "");
  if (!strip(s)) return { empty: true };
  const spans = [...s.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => strip(m[1]));
  if (spans.length !== 2) return { bad: `${spans.length} <span>(s), expected 2` };
  const nums = spans.map((v) => (/^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : null));
  if (nums.some((n) => n === null))
    return { bad: `${JSON.stringify(spans)} is not two numbers` };
  return { cash: nums[0], basis: nums[1] };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * html -> rows, or throw.
 *
 * REFUSES THE WHOLE BOARD on any shape failure and on either of the two checks
 * in the header. There is no per-row refusal here and that is deliberate: on a
 * matrix, a single bad cell is not "a bad row" -- a column heading or a row's
 * alignment is wrong for everybody, and publishing the rest would publish the
 * same mistake under 128 other names. The one thing dropped individually is a
 * cell the board itself leaves blank, which is an operator saying "not buying"
 * and not a failure at all.
 */
export function extract(html, sourceUrl = "", shared = null) {
  const tables = parseTables(html);
  if (!tables.length)
    throw new HeartlandRefused(
      `no <table> with both a <thead> and a <tbody> on this page (${String(html).length} bytes, ` +
      `${(String(html).match(/<table/gi) || []).length} table tag(s)). It is not the Heartland board.`);

  const contracts = shared?.contracts;
  if (!Array.isArray(contracts) || !contracts.length)
    throw new HeartlandRefused(
      `read ${tables.length} table(s) and no futures quotes were supplied to check them against. ` +
      `This board publishes cash and basis and no futures price, so the only external check on ` +
      `it is the contract its headings name. Without the quote pages these rows have nothing ` +
      `proving the columns were read correctly, and this source waits rather than publishing ` +
      `unchecked.`);
  const bySymbol = new Map(contracts.filter((c) => c.priced && c.lastCents != null && c.symbol)
    .map((c) => [c.symbol, c]));

  const settled = boardDate(html);
  const cooked = [];

  for (const t of tables) {
    /* SHAPE FIRST. Positional column indexing is only safe when every row has
       exactly as many cells as the header has columns. Twenty cells on the
       capture are an empty <td> -- WEVER posts corn in columns 1, 2 and 5 and
       nothing in 3 and 4 -- and a parser that collected only the priced cells
       would slide WEVER's fifth-column price into the third column and publish
       it under the wrong delivery month. */
    for (const r of t.rows)
      if (r.width !== t.thCount)
        throw new HeartlandRefused(
          `"${t.commodity}": the header has ${t.thCount} column(s) and the row for ` +
          `${JSON.stringify(r.location)} has ${r.width} cell(s). Their template has changed ` +
          `shape, and reading this table by column position would put one delivery month's ` +
          `price under another's name.`);

    for (const [i, col] of t.columns.entries()) {
      if (!col.code)
        throw new HeartlandRefused(
          `"${t.commodity}" column ${i + 1} names no contract (${JSON.stringify(col.raw)}). ` +
          `The contract is the only evidence of what a cell prices against.`);
      const c = contractOf(col.code);
      if (!c)
        throw new HeartlandRefused(
          `"${t.commodity}" column ${i + 1} is headed "${col.code}", which is not a root in ` +
          `BOARD_ROOTS (${Object.keys(BOARD_ROOTS).join(", ")}) followed by a month letter and ` +
          `a year. If this board has started posting a grain it did not post before, add the ` +
          `letter to BOARD_ROOTS having looked at the page -- do not guess it.`);
      /* THE HEADING IS THEIR WORD FOR THE GRAIN AND THE CODE IS THE
         EXCHANGE'S. They have to agree, or the cells and the headers came from
         different places. */
      const allowed = rootsFor(t.commodity);
      if (!allowed)
        throw new HeartlandRefused(
          `"${t.commodity}" is not a commodity this repository can map to a futures root, so ` +
          `"${col.code}" cannot be checked against anything.`);
      if (!allowed.includes(c.root))
        throw new HeartlandRefused(
          `the "${t.commodity}" table (${allowed.join("/")}) is headed "${col.code}", which is ` +
          `${c.root}. A heading and a contract that disagree is the failure a positional parser ` +
          `makes.`);
      col.contract = c;
      const label = deliveryLabel(col.start, col.end);
      if (!label)
        throw new HeartlandRefused(
          `"${t.commodity}" column ${i + 1} ("${col.code}") carries no readable delivery window ` +
          `(data-start ${JSON.stringify(col.start)}, data-end ${JSON.stringify(col.end)}). ` +
          `The month code alone is the CONTRACT, not the delivery period, and this board prices ` +
          `two different delivery periods against CZ26 on the same table.`);
      col.delivery = label;

      for (const r of t.rows) {
        const p = parseCell(r.cells[i]);
        if (p.empty) continue;
        if (p.bad)
          throw new HeartlandRefused(
            `${r.location} / "${t.commodity}" / ${col.delivery}: ${p.bad}. Every priced cell on ` +
            `this board is <span>cash</span><span>basis</span>.`);
        cooked.push({ t, col, location: r.location,
                      cash: p.cash, basis: p.basis,
                      impliedCents: Math.round((p.cash - p.basis) * 100) });
      }
    }
  }

  if (!cooked.length)
    throw new HeartlandRefused(
      `${tables.length} table(s) parsed and not one carried a price. Every cell on the board is ` +
      `empty, which is a page served without its data rather than a co-op that has stopped ` +
      `bidding on everything.`);

  /* CHECK 1 -- THE COLUMNS AGREE WITH THEMSELVES. */
  const byCol = new Map();
  for (const c of cooked) {
    const k = `${c.t.commodity} ${c.col.code} ${c.col.delivery}`;
    if (!byCol.has(k)) byCol.set(k, []);
    byCol.get(k).push(c);
  }
  for (const [, group] of byCol) {
    const counts = new Map();
    for (const c of group) counts.set(c.impliedCents, (counts.get(c.impliedCents) ?? 0) + 1);
    if (counts.size === 1) continue;
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const odd = group.filter((c) => c.impliedCents !== top[0]).slice(0, 4);
    throw new HeartlandRefused(
      `"${group[0].t.commodity}" ${group[0].col.delivery} (${group[0].col.code}): ` +
      `${group.length} cell(s) imply ${counts.size} different futures prices -- ` +
      `${[...counts.entries()].map(([v, n]) => `${v}c x${n}`).join(", ")}. Every cell in one ` +
      `column of this board prices off ONE contract, so cash minus basis is the same number for ` +
      `all of them. ` +
      odd.map((c) => `${c.location} ${c.cash}/${c.basis} implies ${c.impliedCents}c`).join("; ") +
      `. A cell read against the wrong column looks exactly like this.`);
  }

  /* CHECK 2 -- THE IMPLIED PRICE IS IN RANGE OF THE CONTRACT THE HEADING NAMES. */
  for (const [, group] of byCol) {
    const { col, t } = group[0];
    const q = bySymbol.get(col.contract.symbol);
    if (!q)
      throw new HeartlandRefused(
        `"${t.commodity}" ${col.delivery} is headed ${col.code} = ${col.contract.symbol}, and ` +
        `our quote pages do not price it (${bySymbol.size} contract(s) supplied). A column we ` +
        `cannot check is a column we do not publish.`);
    const drift = group[0].impliedCents - q.lastCents;
    if (Math.abs(drift) > MAX_DRIFT_CENTS)
      throw new HeartlandRefused(
        `"${t.commodity}" ${col.delivery} implies ${group[0].impliedCents}c from cash minus ` +
        `basis, and ${col.contract.symbol} is quoted at ${q.lastCents}c -- ` +
        `${Math.abs(drift).toFixed(2)}c away, past the ${MAX_DRIFT_CENTS}c this board is allowed ` +
        `to drift from a live quote` + (settled ? ` (the board settled ${settled})` : ``) +
        `. A cash and basis pair read the wrong way round lands about twice cash out, and a corn ` +
        `column checked against the soybean quote lands about 766c out.`);
    col.quote = q;
    col.driftCents = round2(drift);
  }

  /* BOTH CHECKS HAVE PASSED ON THE WHOLE BOARD, so the stamp goes on -- in one
     place, after the fact, the way lib/board.mjs's identityAlternative rule
     requires. A manifest cannot assert this about itself. */
  /* THERE IS NO "A ZERO IS NOT A BID" LINE HERE, AND THAT IS DELIBERATE.
   *
   * Every other adapter in this directory drops a 0.00 cell as an operator
   * saying "not buying" in the only field the form gives them. This board does
   * not say it that way: it says it with an EMPTY <td>, twenty of which are on
   * the capture, and those are dropped above where they are read.
   *
   * A 0.00 that did appear could not reach this loop. Its column would have to
   * imply the same futures price as every priced cell beside it -- check 1 --
   * and at 0.00 against a corn basis it implies 49c where its neighbours imply
   * 530. So it refuses the column, which is the right answer: a zero that
   * disagrees with 106 cells around it is not an operator standing aside, it
   * is a cell that did not arrive. Pinned by test.
   *
   * The line was written, and then deleted for being unreachable: a guard that
   * cannot fire reads like protection that is not there. */
  const rows = [];
  let seq = 0;
  for (const c of cooked) {
    rows.push({
      seq: seq++,
      location: c.location,
      locationId: c.location,
      commodity: c.t.commodity,
      delivery: c.col.delivery,
      deliveryStart: c.col.start,
      deliveryEnd: c.col.end,
      cash: round2(c.cash),
      basis: round2(c.basis),
      basisCents: Math.round(c.basis * 100),
      /* WHAT THE BOARD IMPLIES, AND NOT A FUTURES PRICE WE ARE PUBLISHING.
         futuresPrice stays null on purpose: this board carries no quote, and
         filling it from our own subtraction would make cash - basis = futures
         a tautology and switch lib/board.mjs's structural guard off while
         every signal stayed green. See the header. */
      impliedFuturesCents: c.impliedCents,
      futures: c.col.contract.symbol,
      futuresPrice: null,
      futuresAt: c.col.quote?.at ?? null,
      futuresFlag: null,
      futuresChange: null,
      driftCents: c.col.driftCents,
      boardDate: settled,
      unit: GRAIN_ROOTS[c.col.contract.root]?.unit ?? null,
      source: sourceUrl,
      raw: `${c.location} ${c.t.commodity} ${c.col.delivery} ${c.col.code}`,
      verifiedBy: VERIFIED_BY,
    });
  }
  return rows;
}

export function describe(html) {
  const h = String(html);
  const t = parseTables(h);
  return [
    `${h.length} bytes`,
    `${t.length} table(s)`,
    `dated ${boardDate(h) ?? "?"}`,
    ...t.map((x) => `${x.commodity}: ${x.rows.length} row(s) x ${x.columns.length} column(s)`),
  ].join(" · ");
}

export default extract;

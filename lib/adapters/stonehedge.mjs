/* STONEHEDGE (STONEX) — the cash-bid widget a co-op embeds as an <iframe>.
 *
 * Written against ten operator boards captured from the runner on 2026-09-26
 * (fixtures/stonehedge-<site>-*, data/gaps/stonehedge-probe.json): 167
 * locations, 362 tables, 2,381 rows. Not against a description of them.
 *
 * WHERE THE PRICES ARE. Not in any response. The widget's own document
 * (https://stonehedge.stonex.com/component/bids?key=...) is an empty React
 * shell -- fixtures/stonehedge-*-bids-*.html, 5,858 bytes, the same bytes for
 * every site -- and React draws the tables from a socket the probe never
 * recorded. The only place a price exists is the DOCUMENT AFTER IT RENDERED, so
 * that is what this reads (fixtures/stonehedge-*-component-rendered.html), and
 * lib/cdp.mjs captureRendered() is what obtains it at poll time.
 *
 * THE DOM, in the widget's own class names:
 *
 *   <div class="bid-group"><div class="ml-0 bid-group-name row">Kragnes</div>
 *     <div class="bid-table"><div class="ml-0 bid-table-name row">Corn</div>
 *       <div class="bid-table-header"><div class="name">DELIVERY PERIOD</div>
 *            <div class="cash">CASH</div> ...</div>
 *       <div class="bid-table-row"><div class="name">Sep 26</div>
 *            <div class="cash">4.68</div><div class="basis">-0.60</div> ...</div>
 *
 * THE COLUMNS ARE THE OPERATOR'S CHOICE, PER EMBED. The iframe URL carries
 * `cols=<ids>` and an optional `colNames=<id:label,...>`, and the cell's CSS
 * class is the id. Ten operators produced six different column sets:
 *
 *   date,cash,basis,price,change,month      Ag Valley, Cendak     (futures PRICE)
 *   name,cash,basis,change,price,month      Maple River, River Valley  (futures PRICE)
 *   name,cash,basis,month                   Cedar County, Full Circle  (month named, no price)
 *   date,month,change,basis,cash            Frontier              (month named, no price)
 *   date,month,basis,cash                   Scott Equity, United  (month named, no price)
 *   name,basis,cash                         Milnor                (no contract at all)
 *
 * THE LAYOUT IS DETECTED FROM THE HEADER ROW'S CLASSES, NEVER FROM A SITE NAME,
 * and a header whose label contradicts its class (a "Basis" heading over the
 * cash column) is a refusal. A column set nobody has captured is a refusal too.
 *
 * IDENTITY -- WHAT IS PROVED AND HOW.
 *
 *  PRICED (a futures price on the row). cash - basis = futures is the check
 *  lib/board.mjs runs and it CAN fail: the price is the exchange's number and
 *  the cash is the operator's. Measured over every priced row (see the test),
 *  with cashRounding "round-cent-both" declared in the manifests.
 *
 *  NAMED CONTRACT, NO PRICE (Frontier, Scott, United, Cedar County, Full
 *  Circle). The row names its month ("Dec 26") and prints no price. Deriving a
 *  price from cash and basis and calling it the futures makes the identity true
 *  by construction and guards nothing, so this is the agricharts doctrine: the
 *  source declares identityAlternative VERIFIED_NAMED, and the adapter stamps a
 *  row only after (1) the named contract is one the shared CBOT quote pages
 *  price, (2) its exchange root is the one the commodity's CLASS belongs to
 *  (HRS is Minneapolis, HRW is Kansas City, Chicago and SRW are Chicago) and
 *  (3) cash - basis lands within MAX_FIT_CENTS of that contract's quote.
 *  Rows of one contract on one board must also agree with each other.
 *
 *  BARE (Milnor). Cash and basis and no contract at all. VERIFIED_FIT: the
 *  implied futures must land within MAX_FIT_CENTS of SOME contract of the
 *  right root -- the agricharts mobile board's fit, and no stronger than it.
 *
 * WHAT IS NEVER DONE. No futures price is derived from cash and basis. A blank
 * cell ("--") is not a bid. A row with a cash and no basis (Cendak's canola and
 * barley) cannot be checked and is refused by name. A table priced in anything
 * but bushels (Cendak's canola is "Metric Tonnes") is refused by name. A delivery
 * period is passed on as the board wrote it; the two-digit years of a date range
 * are read as 20YY (parse.mjs's own rule), and a period with no year is left to
 * lib/delivery.mjs, which infers and SAYS it inferred.
 */
import { cellText, rootsFor, MAX_FIT_CENTS, fitToContracts } from "./agricharts.mjs";

export class StoneHedgeRefused extends Error {}

export const WIDGET_HOST = "stonehedge.stonex.com";
export const WIDGET_URL = `https://${WIDGET_HOST}/component/bids`;

export const VERIFIED_NAMED = "stonehedge:contract-named+quotes-agree";
export const VERIFIED_FIT = "stonehedge:basis-fits-quotes";

/* THE COLUMN SETS SEEN, as sorted class lists. Anything else refuses. */
export const LAYOUTS = {
  "basis,cash,change,date,month,price": { kind: "priced", seenAt: "agvalley, cendakcooperative" },
  "basis,cash,change,month,name,price": { kind: "priced", seenAt: "mrga, rivervalleycoop" },
  "basis,cash,month,name":              { kind: "named",  seenAt: "cedarcountycoop, fullcircleag" },
  "basis,cash,change,date,month":       { kind: "named",  seenAt: "frontiercooperative" },
  "basis,cash,date,month":              { kind: "named",  seenAt: "scottequityexchange, unitedcooperative" },
  "basis,cash,name":                    { kind: "bare",   seenAt: "milnorgrain" },
};

/* WHICH WORDS A HEADING MAY USE OVER WHICH COLUMN. Labels are the operator's
   (`colNames=`), so this only rules out the contradictions: a heading that
   names another column's job. "Basis Month" over the month column is real
   (Frontier). */
const LABEL = {
  cash:   (l) => /cash/.test(l) && !/basis/.test(l),
  basis:  (l) => /\bbasis\b/.test(l) && !/month|\bmo\b|fut/.test(l),
  price:  (l) => /futures|fut\b|price|symbol/.test(l) && !/cash|basis/.test(l),
  change: (l) => /chg|change/.test(l),
  month:  (l) => /month|\bmo\b|symbol|contract/.test(l),
  date:   (l) => /date|deliver|start|end|period/.test(l),
  name:   (l) => /deliver|period|name|date/.test(l),
};

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON_NAME = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_CODE = { 1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M", 7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z" };

/* ---------- the class's exchange root ---------- */

/** The ONE exchange root a commodity's class prices off, or null when the name
 *  does not say. Wheat is never "wheat": HRS/spring is Minneapolis, HRW is Kansas
 *  City, SRW/Chicago is Chicago. A plain "Wheat" is null, and then only the
 *  loose rootsFor() answer is available, which the named-contract check
 *  narrows by the quote itself. Always a member of rootsFor(commodity). */
export function classRoot(commodity) {
  const c = String(commodity ?? "").toLowerCase();
  if (/\b(hrs|dns|spring|northern)\b/.test(c)) return "MW";
  if (/\b(hrw|hrww|kc|kansas)\b|hard red winter/.test(c)) return "KE";
  if (/\b(srw|sww)\b|chicago|soft red|soft white/.test(c)) return "ZW";
  if (/wheat/.test(c)) return null;
  if (/\b(meal|oil|hulls?)\b/.test(c)) return null;
  if (/corn|milo|sorghum/.test(c)) return "ZC";
  if (/soy|bean/.test(c)) return "ZS";
  if (/\boats?\b/.test(c)) return "ZO";
  return null;
}

/* ---------- reading the rendered document ---------- */

const TAG = /<div\s+class="([^"]*)"([^>]*)>/g;
const CELL = /\s*<div\s+class="([\w-]+)"[^>]*>([\s\S]*?)<\/div>/y;

const has = (cls, token) => cls.split(/\s+/).includes(token);

/** The widget's own location list: name -> id. Empty when the embed shows one
 *  location and so draws no picker. */
export function locationPicker(html) {
  const sel = String(html).match(/<select[^>]*class="[^"]*\blocation-picker\b[^"]*"[^>]*>([\s\S]*?)<\/select>/i);
  const out = [];
  if (!sel) return { present: false, options: out };
  for (const o of sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    const name = cellText(o[2]);
    if (o[1] && name) out.push({ id: o[1], name });
  }
  return { present: true, options: out };
}

/** "Updated 09/25/26 10:12 PM", verbatim. The widget prints no time zone and
 *  neither does this. It is the BOARD's clock, kept for the log, and it is
 *  never converted or compared with ours. */
export function boardUpdated(html) {
  const m = String(html).match(/Updated\s*<span[^>]*title="([^"]+)"/i)
         ?? String(html).match(/Updated\s*(?:<[^>]*>\s*)*(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
  return m ? m[1].trim() : null;
}

/** html -> { updated, picker, groups:[{name, tables:[{commodity, unit, columns,
 *  rows:[{cells}], hidden}]}] }. What the document says and nothing computed. */
export function parseDocument(html) {
  const s = String(html ?? "");
  if (!/stonex-bids-component|bid-group-name/.test(s)) {
    const shell = /<main[^>]*id="root"[^>]*>\s*<noscript>/i.test(s);
    throw new StoneHedgeRefused(shell
      ? `this is the widget's SHELL, the document before React drew it (${s.length} bytes, an empty `
        + `<main id="root">). It carries no prices; they exist only in the rendered document`
      : `no StoneHedge bid tables on this page (no "bid-group-name" anywhere): it is not the rendered `
        + `widget document`);
  }
  const groups = [];
  let g = null, t = null;
  let m;
  const R = new RegExp(TAG.source, "g");
  while ((m = R.exec(s))) {
    const cls = m[1], attrs = m[2] ?? "";
    if (has(cls, "bid-group-name")) {
      const end = s.indexOf("</div>", R.lastIndex);
      g = { name: cellText(s.slice(R.lastIndex, end)), tables: [] };
      groups.push(g); t = null;
    } else if (has(cls, "bid-table-name")) {
      if (!g) continue;
      /* The name is the text before the first tag. Cendak's canola carries a
         unit dropdown INSIDE the name block ("Metric Tonnes"). */
      const nextTable = s.slice(R.lastIndex).search(/<div\s+class="bid-table-header"/);
      const block = s.slice(R.lastIndex, nextTable < 0 ? R.lastIndex + 1500 : R.lastIndex + nextTable);
      const lead = block.split("<")[0];
      const unit = (block.match(/id="uom-picker"[^>]*>([^<]*)</) ?? [])[1];
      t = { commodity: cellText(lead), unit: unit ? cellText(unit) : null, columns: null, rows: [], hidden: 0 };
      g.tables.push(t);
    } else if (has(cls, "bid-table-header")) {
      if (!t) continue;
      const cols = [];
      const C = new RegExp(CELL.source, "y");
      C.lastIndex = R.lastIndex;
      let c;
      while ((c = C.exec(s))) { cols.push({ key: c[1], label: cellText(c[2]) }); C.lastIndex = C.lastIndex; }
      t.columns = cols;
    } else if (has(cls, "bid-table-row")) {
      if (!t) continue;
      const hidden = /display\s*:\s*none|\bhidden\b/i.test(attrs) || has(cls, "d-none") || has(cls, "hidden");
      const cells = {};
      const C = new RegExp(CELL.source, "y");
      C.lastIndex = R.lastIndex;
      let c;
      while ((c = C.exec(s))) { cells[c[1]] = cellText(c[2]); }
      if (hidden) t.hidden++; else t.rows.push({ cells });
    }
  }
  if (!groups.length) throw new StoneHedgeRefused("the document names no location (no bid-group-name)");
  return { updated: boardUpdated(s), picker: locationPicker(s), groups };
}

/** A table's layout from its own header row, or a refusal. */
export function layoutOf(table) {
  const cols = table.columns;
  if (!cols?.length) throw new StoneHedgeRefused(`the "${table.commodity}" table has no header row`);
  const keys = cols.map((c) => c.key);
  if (new Set(keys).size !== keys.length)
    throw new StoneHedgeRefused(`the "${table.commodity}" header repeats a column (${keys.join(", ")})`);
  const id = [...keys].sort().join(",");
  const layout = LAYOUTS[id];
  if (!layout)
    throw new StoneHedgeRefused(`the "${table.commodity}" table has the column set [${keys.join(", ")}], `
      + `which no captured StoneHedge board has. Seen: ${Object.keys(LAYOUTS).map((k) => `[${k}]`).join(" ")}. `
      + `A layout nobody has looked at is refused, not guessed`);
  for (const c of cols) {
    const l = c.label.toLowerCase();
    if (!LABEL[c.key](l))
      throw new StoneHedgeRefused(`the "${table.commodity}" header labels the ${c.key} column "${c.label}", `
        + `which contradicts it. The class names the column and the heading disagrees: a swapped `
        + `or renamed column is not read`);
  }
  return { id, ...layout };
}

/* ---------- cells ---------- */

const BLANK = /^(?:--+|—|–|n\/a|)$/i;
const isBlank = (v) => v == null || BLANK.test(String(v).trim());
const NUM = /^([+-]?)(\d+(?:\.\d+)?)$/;
/** "-0.60" -> -0.6; null for a blank; undefined for something that is neither. */
function money(v) {
  if (isBlank(v)) return null;
  const m = NUM.exec(String(v).trim());
  return m ? Number((m[1] === "-" ? -1 : 1) * Number(m[2])) : undefined;
}
/** "5.2825 s" -> {dollars: 5.2825, flag: "s"}. */
function quote(v) {
  if (isBlank(v)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z])?$/i.exec(String(v).trim());
  return m ? { dollars: Number(m[1]), flag: m[2] ? m[2].toLowerCase() : null } : undefined;
}
/** "Dec 26" / "Dec 2026" -> {code:"Z", year:2026, label}. */
function contractMonth(v) {
  if (isBlank(v)) return null;
  const m = /^([A-Za-z]{3})[A-Za-z]*\.?\s*'?(\d{2}|\d{4})$/.exec(String(v).trim());
  if (!m || !MON3[m[1].toLowerCase()]) return undefined;
  const mo = MON3[m[1].toLowerCase()];
  return { code: MONTH_CODE[mo], month: mo, year: m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]), label: String(v).trim() };
}

/** "09/01/26-09/30/26" -> "01 Sep 2026 to 30 Sep 2026", the shape
 *  lib/delivery.mjs reads as an explicit range WITH its year. A year on the
 *  board is used; nothing is inferred. null when it is not a date range. */
export function dateRange(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const one = (mo, d, y) => {
    const yy = y.length === 2 ? 2000 + Number(y) : Number(y);
    const dt = new Date(Date.UTC(yy, Number(mo) - 1, Number(d)));
    if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) return null;
    return { t: dt.getTime(), text: `${String(Number(d)).padStart(2, "0")} ${MON_NAME[Number(mo)]} ${yy}` };
  };
  const a = one(m[1], m[2], m[3]), b = one(m[4], m[5], m[6]);
  if (!a || !b || b.t < a.t) return null;
  return `${a.text} to ${b.text}`;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/* Rows of one contract share one exchange price, so their implied futures may
   differ only by the two-decimal display of cash and of basis, which is under a
   cent (the open interval round-cent-both states). */
export const MAX_GROUP_SPREAD_CENTS = 1;

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/**
 * html -> rows, or throw. `shared.contracts` is the CBOT quote list
 * (agricharts.mergeQuotes), needed only by layouts that print no futures price.
 */
export function extract(html, sourceUrl = "", shared = null) {
  const doc = parseDocument(html);
  const contracts = shared?.contracts ?? null;
  const unreconciled = [];
  const blank = [];
  const rows = [];

  /* THE LOCATION LIST. The picker is the widget's own id-to-name map; a group
     whose name it does not carry cannot be tied to an id, so its rows are
     refused rather than filed under a guessed one. An embed for ONE location
     draws no picker, and then the id is the embed's own `locs=` value. */
  const norm = (n) => String(n ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const byName = new Map();
  for (const o of doc.picker.options) {
    const k = norm(o.name);
    byName.set(k, byName.has(k) ? null : o.id);       // null: two options share the name
  }
  let onlyLocs = null;
  try { const l = (new URL(sourceUrl).searchParams.get("locs") ?? "").split(",").filter(Boolean); if (l.length === 1) onlyLocs = l[0]; } catch { /* not a url */ }

  let seq = 0;
  for (const g of doc.groups) {
    let locationId = null, whyNoId = null;
    if (doc.picker.present) {
      if (!byName.has(norm(g.name))) whyNoId = `the location "${g.name}" is not in the widget's own location list`;
      else if (byName.get(norm(g.name)) === null) whyNoId = `two locations in the widget's list are called "${g.name}"`;
      else locationId = byName.get(norm(g.name));
    } else if (doc.groups.length === 1 && onlyLocs) locationId = onlyLocs;
    else whyNoId = `the widget drew no location list and the embed does not name exactly one location`;

    for (const t of g.tables) {
      const layout = layoutOf(t);
      const refuse = (r, why, delivery = null) => unreconciled.push({
        location: g.name, commodity: t.commodity, delivery: delivery ?? r.cells.date ?? r.cells.name ?? null, why });

      for (const r of t.rows) {
        const c = r.cells;
        const label = c.date ?? c.name;
        const cash = money(c.cash), basis = money(c.basis);

        /* A BLANK CASH IS NOT A BID. Cendak's "Futures Only" location prints a
           futures price on every row and no cash at all; it is counted, not
           refused, because nobody posted anything. */
        if (cash === null) { blank.push({ location: g.name, commodity: t.commodity, delivery: label }); continue; }
        if (whyNoId) { refuse(r, whyNoId); continue; }
        if (t.unit && !/bushel/i.test(t.unit)) { refuse(r, `the table is priced in "${t.unit}", and this adapter reads bushel boards`); continue; }
        if (cash === undefined || basis === undefined) { refuse(r, `cash "${c.cash}" or basis "${c.basis}" is not a number`); continue; }
        if (basis === null) { refuse(r, `a cash of ${cash} with no basis: nothing to check it against`); continue; }
        if (!(cash > 0)) { refuse(r, `the board posts ${cash}, which is not a bid`); continue; }

        let delivery = null;
        if ("date" in c) { delivery = dateRange(c.date); if (!delivery) { refuse(r, `"${c.date}" is not a date range`); continue; } }
        else { delivery = String(c.name ?? "").trim(); if (!delivery) { refuse(r, "no delivery period"); continue; } }

        const month = "month" in c ? contractMonth(c.month) : null;
        if ("month" in c && layout.kind !== "priced" && month == null) { refuse(r, `no contract month ("${c.month}") to check the price against`, label); continue; }
        if ("month" in c && month === undefined) { refuse(r, `contract month "${c.month}" is not a month and a year`, label); continue; }

        const root = classRoot(t.commodity);
        const row = {
          seq: seq++, location: g.name, locationId, commodity: t.commodity, delivery,
          cash, basis, basisCents: Math.round(basis * 100),
          impliedFuturesCents: null, futures: month ? (root ? `${root}${month.code}${String(month.year).slice(2)}` : month.label) : null,
          futuresPrice: null, futuresAt: doc.updated, futuresFlag: null, futuresChange: null,
          unit: "bushel", source: sourceUrl,
          raw: `${g.name} | ${t.commodity} | ${label} | cash ${c.cash} basis ${c.basis}${"price" in c ? ` price ${c.price}` : ""}${"month" in c ? ` month ${c.month}` : ""}`,
          verifiedBy: null, _month: month, _root: root,
        };

        if (layout.kind === "priced") {
          const q = quote(c.price);
          if (q === null) { refuse(r, `a cash of ${cash} and a basis of ${basis} with no futures price (${c.price}): cash - basis = futures cannot run`, label); continue; }
          if (q === undefined || !month) { refuse(r, `futures price "${c.price}" or month "${c.month}" unreadable`, label); continue; }
          row.futuresPrice = round4(q.dollars * 100);
          row.futuresFlag = q.flag;
          row.verifiedBy = null;                              // board.mjs's own identity check is the proof
        } else {
          row.impliedFuturesCents = round4((cash - basis) * 100);
        }
        rows.push(row);
      }
    }
  }

  /* ONE CONTRACT, ONE PRICE. Every row of a contract on this document was
     drawn from the same quote, so the priced ones must agree exactly and the
     implied ones to under a cent. A row that does not is refused; a group with
     no majority is refused whole. */
  const groupsOf = new Map();
  for (const r of rows) {
    if (!r._month) continue;
    const k = `${r._root ?? r.commodity}|${r._month.year}${r._month.code}`;
    if (!groupsOf.has(k)) groupsOf.set(k, []);
    groupsOf.get(k).push(r);
  }
  const drop = new Set();
  for (const [k, g] of groupsOf) {
    const val = (r) => (r.futuresPrice != null ? r.futuresPrice : r.impliedFuturesCents);
    const priced = g.every((r) => r.futuresPrice != null);
    const tol = priced ? 0 : MAX_GROUP_SPREAD_CENTS;
    const mid = median(g.map(val));
    for (const r of g) {
      const off = Math.abs(val(r) - mid);
      if (priced ? off > 0 : off >= tol) {
        drop.add(r);
        unreconciled.push({ location: r.location, commodity: r.commodity, delivery: r.delivery,
          why: `${priced ? "futures price" : "cash - basis"} ${val(r)}c disagrees with the ${g.length - 1} other row(s) of ${k} on this board (median ${mid}c)` });
      }
    }
  }
  let kept = rows.filter((r) => !drop.has(r));

  /* THE CHECK THAT CAN FAIL, for boards that print no price. */
  const kind = kept.length ? (kept.some((r) => r.futuresPrice != null) ? "priced" : (kept.every((r) => r._month) ? "named" : "bare")) : null;
  if (kind === "named" || kind === "bare") {
    if (!Array.isArray(contracts) || !contracts.length)
      throw new StoneHedgeRefused(`read ${kept.length} row(s) from a board that prints no futures price, and no CBOT quotes `
        + `were supplied. cash - basis = futures cannot run, and a price derived from cash and basis would `
        + `pass it by construction. The poller fetches the quote pages once per pass; without them this waits`);
    const bySymbol = new Map(contracts.filter((c) => c.priced && c.symbol).map((c) => [c.symbol, c]));
    const bad = new Set();
    if (kind === "named") {
      for (const r of kept) {
        const roots = r._root ? [r._root] : (rootsFor(r.commodity) ?? []);
        const found = roots.map((x) => bySymbol.get(`${x}${r._month.code}${String(r._month.year).slice(2)}`)).filter(Boolean);
        if (!roots.length) { bad.add(r); unreconciled.push({ location: r.location, commodity: r.commodity, delivery: r.delivery, why: `no exchange root is known for "${r.commodity}", so its contract cannot be checked` }); continue; }
        if (!found.length) { bad.add(r); unreconciled.push({ location: r.location, commodity: r.commodity, delivery: r.delivery, why: `the board names ${r._month.label}, which our quote pages do not carry for ${roots.join("/")}` }); continue; }
        const near = found.reduce((b, c) => (!b || Math.abs(c.lastCents - r.impliedFuturesCents) < Math.abs(b.lastCents - r.impliedFuturesCents) ? c : b), null);
        const d = Math.abs(near.lastCents - r.impliedFuturesCents);
        if (d > MAX_FIT_CENTS) { bad.add(r); unreconciled.push({ location: r.location, commodity: r.commodity, delivery: r.delivery, why: `cash ${r.cash} - basis ${r.basis} implies ${r.impliedFuturesCents}c and ${near.symbol} is quoted at ${near.lastCents}c, ${d.toFixed(2)}c away (limit ${MAX_FIT_CENTS}c)` }); continue; }
        if (r._root == null) r.futures = near.symbol;
      }
    } else {
      const fit = fitToContracts(kept, contracts);
      if (!fit.ok && !fit.misses) throw new StoneHedgeRefused(fit.why);
      for (const m of fit.misses ?? []) { bad.add(m.row); unreconciled.push({ location: m.row.location, commodity: m.row.commodity, delivery: m.row.delivery, why: `implies ${m.row.impliedFuturesCents}c; nearest ${m.contract.symbol} ${m.contract.lastCents}c is ${m.d.toFixed(2)}c away (limit ${MAX_FIT_CENTS}c)` }); }
      for (const r of kept) if (!rootsFor(r.commodity) && !bad.has(r)) { bad.add(r); unreconciled.push({ location: r.location, commodity: r.commodity, delivery: r.delivery, why: `"${r.commodity}" has no quoted contract, so nothing can check it` }); }
    }
    /* A MINORITY OF BAD ROWS IS BAD ROWS; A MAJORITY IS A BAD PARSE. */
    if (bad.size * 2 >= kept.length)
      throw new StoneHedgeRefused(`${bad.size} of ${kept.length} row(s) do not fit the CBOT quotes: `
        + unreconciled.slice(-3).map((u) => u.why).join("; ") + `. A moved column breaks every row; refusing the board`);
    kept = kept.filter((r) => !bad.has(r));
    for (const r of kept) r.verifiedBy = kind === "named" ? VERIFIED_NAMED : VERIFIED_FIT;
  }

  if (!kept.length)
    throw new StoneHedgeRefused(`no publishable row: ${rows.length} read, ${blank.length} blank, `
      + `${unreconciled.length} refused` + (unreconciled.length ? ` (${unreconciled.slice(0, 3).map((u) => u.why).join("; ")})` : ""));

  const out = kept.map(({ _month, _root, ...r }, i) => ({ ...r, seq: i }));
  Object.defineProperty(out, "unreconciled", { value: unreconciled, enumerable: false });
  Object.defineProperty(out, "blank", { value: blank, enumerable: false });
  Object.defineProperty(out, "updated", { value: doc.updated, enumerable: false });
  return out;
}

export default extract;


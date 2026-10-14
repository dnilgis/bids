/* ADAPTER: Bunge's morning "Cash Bids for <location>" email.
 *
 * FOUND 2026-10-14. Bunge at Ladoga, IN ("Haw Creek" in Bunge's own system)
 * posts no bids on its bungeag.com page (lib/adapters/bungeag.mjs refuses it),
 * but Bunge mails every customer who asks a notification each morning from
 * noreply@mobile.bunge.us. Sig receives it. The plain-text part reads:
 *
 *     Cash Bids for Haw Creek
 *     Cash bids for Wednesday,October 14 2026
 *     Hours: 08:00 - 16:30
 *     Phone: (765) 946-7000
 *     Yellow Corn
 *     Delivery	Bid	Basis	Futures
 *     Fall "26	4.36	-0.45	4.81
 *     December "26	4.61	-0.20	4.81
 *     ...
 *     Soybeans
 *     Delivery	Bid	Basis	Futures
 *     Fall "26	12.33	-0.55	12.88
 *     Dec "26	12.72	-0.32	13.04
 *     ...
 *     See Bid Details
 *
 * TWO HALVES, ONE FILE. scripts/email-bids.mjs reads the mailbox, runs
 * parseEmail() on the message and writes what it found to a snapshot in this
 * repository (data/email/<listing id>.json). extract() is the poller's adapter
 * and reads that snapshot. The email itself never reaches the poller, and
 * nothing in the snapshot is anything but the parsed bid rows and the
 * location's own heading lines (hours, the elevator's public phone).
 *
 * EVERY ROW PROVES ITSELF. Bid, basis and futures are all printed, in dollars,
 * so bid = futures + basis is checked here on every row before anything is
 * written (a row that does not balance refuses the whole email: that is a
 * column moved, not a price), and again by lib/board.mjs on every pass with
 * the futures price handed on in cents.
 *
 * THE CONTRACT IS NOT NAMED, so it is inferred and the inference is checked:
 *   1. the calendar: the first contract month of the grain's root on or after
 *      the start of the delivery period (Fall '26 corn -> ZCZ26, Jan '27 corn
 *      -> ZCH27, Dec '26 beans -> ZSF27);
 *   2. the email against itself: rows on one inferred contract must print one
 *      futures price, and two different inferred contracts must not print the
 *      same one;
 *   3. the email against the CBOT quotes the poller already reads each pass
 *      (the shared AgriCharts quote pages): the email's price minus the quote
 *      must be the same for every contract of a grain, within
 *      SPREAD_TOL_CENTS. The market moves between the email and the pass; the
 *      spread between two contracts barely does, so a contract read one month
 *      off shows up as a spread that does not match.
 * A grain that fails 2 or 3 keeps its rows and its printed futures price, with
 * no symbol (futures: null): the identity check needs the price, not the name.
 *
 * ONLY THE EMAIL'S OWN DAY. The snapshot carries the date Bunge printed ("Cash
 * bids for Wednesday,October 14 2026"). It is published while that is today or
 * the business day before (the morning before the next email lands, and the
 * weekend after Friday's). Older, it is refused as stale, so the board is held
 * and then withdrawn on the usual age rule rather than shown as today's.
 * pricedAt is when the email was sent (`postedAt` on every row). */
import { chicagoDay } from "./agsist-portal.mjs";

export class BungeEmailRefused extends Error {}

export const SCHEMA = "bunge-email/1";
export const SENDER = "noreply@mobile.bunge.us";
/* The snapshot lives in this repository; the poller reads it from the checkout
   (PLATFORM_LOCAL in lib/sources.mjs). The url is where the same file is
   published, so a source still names an absolute https address. */
export const RAW_BASE = "https://raw.githubusercontent.com/dnilgis/bids/main/";
export const SNAPSHOT_DIR = "data/email/";
export const snapshotPath = (listingId) => `${SNAPSHOT_DIR}${listingId}.json`;
export const snapshotUrl = (listingId) => `${RAW_BASE}${snapshotPath(listingId)}`;

/* Bunge's own name for a location -> the AGSIST listing it is. Only these are
   written; an email for a location not here is refused, not guessed at. */
export const LOCATIONS = {
  "haw creek": { listingId: "bunge-ladoga-in", town: "Ladoga", state: "IN" },
};

export const SPREAD_TOL_CENTS = 3;

/* ---------- the email body ---------- */

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#34": '"',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", "#8220": '"', "#8221": '"', "#8217": "'" };
const decode = (s) => String(s ?? "")
  .replace(/&([a-z]+|#\d+);/gi, (m, k) => ENTITIES[k.toLowerCase()] ?? (/^#\d+$/.test(k) ? String.fromCharCode(+k.slice(1)) : m));

/** An HTML body as the lines a reader sees: a table row is one line, cells split by tabs. */
export function htmlToText(html) {
  return decode(String(html ?? "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/\s+/g, " ")   // HTML's own whitespace rule: a source newline is a space
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<br\s*\/?>|<\/(tr|p|div|h\d|li|table|thead|tbody)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .split("\n").map((l) => l.replace(/[  ]+/g, " ").replace(/\s*\t\s*/g, "\t").replace(/^\t+|\t+$/g, "").trim())
    .join("\n");
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const monthOf = (w) => {
  const s = String(w ?? "").toLowerCase().replace(/\.$/, "");
  if (s.length < 3) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(s) || (s === "sept" && m === "september"));
  return i < 0 ? null : i + 1;
};

/** "Wednesday,October 14 2026" -> "2026-10-14", or null. The weekday must agree with the date. */
export function bidDate(s) {
  const m = /^(?:([A-Za-z]+),?\s*)?([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const mo = monthOf(m[2]), d = +m[3], y = +m[4];
  if (!mo || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  if (m[1] && WEEKDAYS[dt.getUTCDay()] !== m[1].toLowerCase()) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* WHICH GRAIN, AND WHICH CONTRACTS IT TRADES. A heading that is none of these
   is a layout change, not a commodity to skip: the email is refused. */
export const GRAINS = [
  { rx: /corn/i, root: "ZC", months: "HKNUZ" },
  { rx: /soy|bean/i, root: "ZS", months: "FHKNQUX" },
  { rx: /wheat/i, root: "ZW", months: "HKNUZ" },
];
const CODES = "FGHJKMNQUVXZ";
export const grainOf = (heading) => GRAINS.find((g) => g.rx.test(heading)) ?? null;

/* A delivery label: their words, with the year written out ('Fall "26' ->
   "Fall 2026"), and the month the period starts, for the contract. */
const SEASONS = { fall: 10, harvest: 10, "new crop": 10 };
export function readDelivery(raw) {
  const t = String(raw ?? "").replace(/[“”″]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const m = /^(.*?)\s*["']\s*(\d{2})$/.exec(t) ?? /^(.*?)\s+(?:20)?(\d{2})$/.exec(t);
  if (!m || !m[1]) return null;
  const words = m[1].trim();
  const year = 2000 + Number(m[2]);
  const label = `${words} ${year}`;
  const lw = words.toLowerCase();
  let start = null;
  if (SEASONS[lw]) start = SEASONS[lw];
  else {
    const first = lw.split(/[\s/-]+/)[0];
    start = monthOf(first);
  }
  return { label, words, year, startMonth: start };
}

/** The contract the calendar says: first month of the root on or after the period's start. */
export function calendarContract(grain, year, startMonth) {
  if (!grain || !startMonth) return null;
  for (let k = 0; k < 24; k++) {
    const mo = ((startMonth - 1 + k) % 12) + 1;
    const y = year + Math.floor((startMonth - 1 + k) / 12);
    const code = CODES[mo - 1];
    if (grain.months.includes(code)) return `${grain.root}${code}${String(y % 100).padStart(2, "0")}`;
  }
  return null;
}

/* What an error may quote of a line it could not read: a little, and never an address. */
export const snippet = (l) => String(l ?? "").slice(0, 60).replace(/[^\s<>"]+@[^\s<>"]+/g, "<address>");

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const ROW_RX = new RegExp(String.raw`^(.+?)\s+${NUM}\s+${NUM}\s+${NUM}$`);
const HEAD_RX = /^delivery\s+bid\s+basis\s+futures$/i;
const cents = (d) => Math.round(d * 10000) / 100;   // dollars -> cents, four-place safe

/**
 * The bids in one email body (plain text, or HTML when that is all there is).
 * Returns { location, listingId, town, state, asOf, hours, phone, bids: [...] }.
 * Throws BungeEmailRefused with a message that names what was not found, and
 * never quotes more of the body than the line it could not read.
 */
export function parseEmail(body, { html = false } = {}) {
  const text = html ? htmlToText(body) : String(body ?? "");
  /* Quoted forwards put "> " in front of every line; a forward header sits above. */
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/^(>\s?)+/, "").trim());
  /* "Cash Bids for Haw Creek" names the place; "Cash bids for Wednesday,October 14 2026" the day. */
  const start = lines.findIndex((l) => /^cash bids for\s+\S/i.test(l) && !bidDate(l.replace(/^cash bids for\s+/i, "")));
  if (start < 0) throw new BungeEmailRefused('no "Cash Bids for <location>" heading: not a Bunge cash-bid email, or its layout changed');
  const location = lines[start].replace(/^cash bids for\s+/i, "").trim();
  const loc = LOCATIONS[location.toLowerCase()];
  if (!loc) throw new BungeEmailRefused(`the email is for "${snippet(location)}", which is not a location this repository knows (${Object.keys(LOCATIONS).join(", ")})`);

  let asOf = null, hours = null, phone = null;
  const bids = [];
  let grain = null, heading = null, header = false, ended = false, seq = 0, inSection = 0;
  for (let i = start + 1; i < lines.length && !ended; i++) {
    const l = lines[i];
    if (!l) continue;
    if (/^see bid details/i.test(l)) { ended = true; break; }
    let m;
    if (!asOf && (m = /^cash bids for\s+(.+)$/i.exec(l))) {
      asOf = bidDate(m[1]);
      if (!asOf) throw new BungeEmailRefused(`the date line does not read as a date: "${snippet(l)}"`);
      continue;
    }
    if ((m = /^hours:\s*(.+)$/i.exec(l))) { hours = m[1].trim().slice(0, 80); continue; }
    if ((m = /^phone:\s*(.+)$/i.exec(l))) { phone = m[1].replace(/\D/g, "").slice(-10) || null; continue; }
    if (HEAD_RX.test(l.replace(/\t/g, " ").replace(/\s+/g, " "))) {
      if (!grain) throw new BungeEmailRefused(`a "Delivery Bid Basis Futures" header with no commodity heading above it`);
      header = true; continue;
    }
    if ((m = ROW_RX.exec(l.replace(/\t/g, " ")))) {
      if (!grain || !header) throw new BungeEmailRefused(`a bid row before any commodity and column header: "${snippet(l)}"`);
      const d = readDelivery(m[1]);
      if (!d) throw new BungeEmailRefused(`${heading}: delivery "${snippet(m[1])}" has no year`);
      const [bid, basis, fut] = [Number(m[2]), Number(m[3]), Number(m[4])];
      /* THE ROW PROVES ITSELF OR NOTHING IS WRITTEN. */
      if (Math.abs(cents(fut) + cents(basis) - cents(bid)) > 0.001)
        throw new BungeEmailRefused(`${heading} ${d.label}: bid ${bid} is not futures ${fut} + basis ${basis}. `
          + `A column has moved or been relabelled; nothing from this email is written`);
      if (!(bid > 0) || !(fut > 0)) throw new BungeEmailRefused(`${heading} ${d.label}: bid ${bid} / futures ${fut} is not a price`);
      bids.push({ seq: seq++, commodity: heading, delivery: d.label, cash: bid, basis, futures: fut,
        _grain: grain, _d: d });
      inSection++;
      continue;
    }
    /* Anything else is a commodity heading, and it has to be a grain we know. */
    const g = grainOf(l);
    if (!g) throw new BungeEmailRefused(`a line that is neither a bid row nor a grain heading: "${snippet(l)}"`);
    if (heading && !inSection) throw new BungeEmailRefused(`"${heading}" has a heading and no bid rows`);
    grain = g; heading = l.replace(/\s+/g, " ").slice(0, 60); header = false; inSection = 0;
  }
  if (heading && !inSection) throw new BungeEmailRefused(`"${heading}" has a heading and no bid rows`);
  if (!ended) throw new BungeEmailRefused('no "See Bid Details" line after the bids: the email was cut off or its layout changed');
  if (!asOf) throw new BungeEmailRefused('no "Cash bids for <date>" line');
  if (!bids.length) throw new BungeEmailRefused(`no bid rows for ${location}`);

  return {
    location, ...loc, asOf, hours, phone,
    bids: bids.map(({ _grain, _d, ...b }) => ({
      ...b, contract: calendarContract(_grain, _d.year, _d.startMonth),
    })),
  };
}

/* ---------- the snapshot ---------- */

/** What scripts/email-bids.mjs writes. receivedAt is when the email was sent (its Date header). */
export function snapshotOf(parsed, receivedAt) {
  return {
    schema: SCHEMA,
    listingId: parsed.listingId,
    bungeLocation: parsed.location,
    town: parsed.town,
    state: parsed.state,
    asOf: parsed.asOf,
    receivedAt,
    hours: parsed.hours ?? null,
    phone: parsed.phone ?? null,
    bids: parsed.bids.map((b) => ({ commodity: b.commodity, delivery: b.delivery, cash: b.cash,
      basis: b.basis, futures: b.futures, contract: b.contract ?? null })),
  };
}

/** Did anything a reader would care about change? The date and the rows; not when the email arrived. */
export const snapshotChanged = (a, b) => !a || !b || a.asOf !== b.asOf || a.listingId !== b.listingId
  || JSON.stringify(a.bids) !== JSON.stringify(b.bids);

/** The business day before a "YYYY-MM-DD" (Saturday and Sunday are not business days). */
export function previousBusinessDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/* THE CONTRACT, CHECKED. Per grain: the email against itself, then against
   the quotes when the poller has them. Returns symbol-by-row and why any grain
   lost its symbols. */
export function checkContracts(bids, contracts = null) {
  const out = bids.map((b) => b.contract ?? null);
  const notes = [];
  const byGrain = new Map();
  bids.forEach((b, i) => {
    const g = grainOf(b.commodity)?.root ?? b.commodity;
    if (!byGrain.has(g)) byGrain.set(g, []);
    byGrain.get(g).push(i);
  });
  const quotes = new Map((contracts ?? []).filter((c) => c && c.priced && c.symbol && Number.isFinite(c.lastCents))
    .map((c) => [c.symbol, c.lastCents]));
  for (const [root, idx] of byGrain) {
    const drop = (why) => { for (const i of idx) out[i] = null; notes.push(`${root}: ${why}`); };
    if (idx.some((i) => !out[i])) { drop("a delivery period names no month, so no contract is inferred for this grain"); continue; }
    const priceOf = new Map(), symOf = new Map();
    let bad = null;
    for (const i of idx) {
      const s = out[i], p = cents(bids[i].futures);
      if (priceOf.has(s) && priceOf.get(s) !== p) { bad = `${s} is printed at both ${priceOf.get(s)}c and ${p}c`; break; }
      if (symOf.has(p) && symOf.get(p) !== s) { bad = `${symOf.get(p)} and ${s} are both printed at ${p}c`; break; }
      priceOf.set(s, p); symOf.set(p, s);
    }
    if (bad) { drop(`${bad}; the calendar's contracts do not fit the email`); continue; }
    const offs = [...priceOf].filter(([s]) => quotes.has(s)).map(([s, p]) => [s, p - quotes.get(s)]);
    if (offs.length >= 2) {
      const vals = offs.map(([, o]) => o);
      if (Math.max(...vals) - Math.min(...vals) > SPREAD_TOL_CENTS)
        drop(`the email's spreads do not match the quotes (email minus quote: `
          + `${offs.map(([s, o]) => `${s} ${Math.round(o * 100) / 100}c`).join(", ")})`);
    }
  }
  return { symbols: out, notes };
}

/* ---------- the adapter ---------- */

export function parseSnapshot(body) {
  let d;
  try { d = JSON.parse(String(body)); }
  catch (e) { throw new BungeEmailRefused(`the email snapshot is not JSON (${e.message})`); }
  if (!d || d.schema !== SCHEMA) throw new BungeEmailRefused(`the email snapshot is not ${SCHEMA} (schema ${JSON.stringify(d?.schema)})`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.asOf ?? ""))) throw new BungeEmailRefused(`the email snapshot has no asOf date`);
  if (!Number.isFinite(Date.parse(d.receivedAt))) throw new BungeEmailRefused(`the email snapshot has no receivedAt time`);
  if (!Array.isArray(d.bids) || !d.bids.length) throw new BungeEmailRefused(`the email snapshot has no bids`);
  return d;
}

export function extract(body, sourceUrl = "", shared = null) {
  const snap = parseSnapshot(body);
  const nowMs = Number.isFinite(shared?.nowMs) ? shared.nowMs : Date.now();
  const today = chicagoDay(nowMs);
  if (snap.asOf > today)
    throw new BungeEmailRefused(`the newest Bunge email is dated ${snap.asOf}, after today (${today} in Chicago); not published`);
  const oldest = previousBusinessDay(today);
  if (snap.asOf < oldest)
    throw new BungeEmailRefused(`STALE: the newest Bunge email is for ${snap.asOf} and today is ${today}. `
      + `Bids older than the last business day (${oldest}) are not shown as today's: the board is held and then `
      + `withdrawn on the usual age rule. Has the morning email stopped arriving, or the forward stopped?`);
  const { symbols, notes } = checkContracts(snap.bids, shared?.contracts ?? null);
  const rows = [];
  for (const [i, b] of snap.bids.entries()) {
    if (Math.abs(cents(b.futures) + cents(b.basis) - cents(b.cash)) > 0.001)
      throw new BungeEmailRefused(`${b.commodity} ${b.delivery}: bid ${b.cash} is not futures ${b.futures} + basis ${b.basis}`);
    rows.push({
      seq: i, location: `Bunge ${snap.town}`, locationId: snap.listingId, commodity: b.commodity, delivery: b.delivery,
      cash: b.cash, basis: b.basis, basisCents: cents(b.basis),
      futures: symbols[i], futuresPrice: cents(b.futures), futuresAt: snap.receivedAt, futuresFlag: null, futuresChange: null,
      unit: "bushel", source: sourceUrl, postedAt: snap.receivedAt,
      raw: `${snap.bungeLocation} ${snap.asOf} | ${b.commodity} | ${b.delivery} | ${b.cash} | ${b.basis} | ${b.futures}`,
    });
  }
  Object.defineProperty(rows, "unreconciled", { value: [], enumerable: false });
  Object.defineProperty(rows, "contractNotes", { value: notes, enumerable: false });
  return rows;
}

export default extract;

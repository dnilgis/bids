/* ADAPTER: the CIH (cihedging.com) cash-bid widget.
 *
 * FOUND 2026-10-01, BEHIND THIRTY "AGHOST" FAILURES.
 *
 * discover.mjs filed about thirty sites as AgHost, and board-sweep refused
 * every one with "no displayNumber() definition on the page". A capture of
 * the rendered pages (capture.yml, run 36953837601) showed why: Al-Corn,
 * Husker Ag, Ladd Elevator and Tremont Co-op do not draw an AgHost board at
 * all now. Their page loads CashBidWidget.js from cihedging.com, and the
 * widget asks
 *
 *     GET https://www.cihedging.com/cih/api/index.cfm/v2/origination/cashbids/<siteId>/widget?...
 *
 * which answers with a JSON-encoded STRING of HTML: a <style> block, then one
 * card per location. No key, no cookie, no session; the site number is in the
 * path and is the same number every visitor's browser asks for.
 *
 * THE SHAPE, read off four captures (fixtures/cih-*-2026-10-02.json):
 *
 *   <div class="cih-loc-card ..." data-location-i-d="46250"> ... <b>Ladd</b>
 *     <div class="cih-com-row ..." data-commodity-name="Corn">
 *       <table class="cih-table"> Delivery | Futures | Change | Basis | Bid
 *         <tr data-delivery-period-label="Oct 2026" ...>
 *           <td>…Oct 2026</td>
 *           <td><span>Dec 26</span>…<span>4.9850</span></td>      month, then price
 *           <td class="change negative">…<span>-0.0375</span></td>
 *           <td>-0.30</td>
 *           <td>4.68</td>
 *
 * The board prints the futures PRICE beside the contract, so every row can be
 * proved by cash - basis = futures in lib/board.mjs, like Grain Desk and DTN.
 * The bid is posted to the cent, so cash - basis can sit up to a cent off the
 * four-decimal quote (4.9850 - 0.30 = 4.6850, posted 4.68). A manifest
 * declares the rounding the captures support, never a guess.
 *
 * locationId is the widget's own data-location-i-d, a number that does not
 * change when a location is renamed. */
import { classRoot } from "./stonehedge.mjs";

export class CihRefused extends Error {}

export const API_HOST = "www.cihedging.com";
export const QUERY = "commodity_ids=&custom_commodity_ids=&exclude_non_custom=false&exclude_custom=false"
  + "&address_ids=&show_cash_bid_title=true&show_cash_bid_filters=true&show_cash_bid_note=true"
  + "&show_location_names=true&with_new_chart=true";

/** The widget URL for a CIH site number, with the query every captured page sends. */
export function widgetUrl(siteId) {
  if (!/^\d+$/.test(String(siteId ?? ""))) throw new CihRefused(`a CIH site number is digits, not "${siteId}"`);
  return `https://${API_HOST}/cih/api/index.cfm/v2/origination/cashbids/${siteId}/widget?${QUERY}`;
}

/** The site number out of a widget URL, or null. */
export function siteIdOf(url) {
  const m = /\/origination\/cashbids\/(\d+)\/widget/.exec(String(url ?? ""));
  return m ? m[1] : null;
}

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_CODE = { 1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M", 7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z" };

const decode = (s) => String(s ?? "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const text = (h) => decode(String(h ?? "").replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/<[^>]+>/g, " "))
  .replace(/\s+/g, " ").trim();

/** A plain decimal, or null for blank, or undefined for something that is not a number. */
export function num(v) {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (s === "" || s === "-" || /^n\/?a$/i.test(s)) return null;
  return /^[+-]?\d*\.?\d+$/.test(s) ? parseFloat(s) : undefined;
}

/** "Dec 26" -> { code: "Z", year: 2026 }. null when it is not a month and a year. */
export function contractMonth(v) {
  const m = /^([A-Za-z]{3})[A-Za-z]*\.?\s*'?(\d{2}|\d{4})$/.exec(String(v ?? "").trim());
  if (!m || !MON3[m[1].toLowerCase()]) return null;
  const mo = MON3[m[1].toLowerCase()];
  return { code: MONTH_CODE[mo], month: mo, year: m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]), label: String(v).trim() };
}

/** The widget body as HTML. The API returns a JSON string; a raw document is accepted too. */
export function htmlOf(body) {
  const s = String(body ?? "");
  const t = s.trimStart();
  if (t.startsWith('"')) {
    let v;
    try { v = JSON.parse(t); } catch (e) { throw new CihRefused(`the body starts like a JSON string and does not parse: ${e.message}`); }
    if (typeof v !== "string") throw new CihRefused("the JSON body is not a string of HTML");
    return v;
  }
  if (t.startsWith("{") || t.startsWith("[")) {
    let v; try { v = JSON.parse(t); } catch { v = null; }
    if (v && typeof v === "object") throw new CihRefused(`the widget answered with a JSON ${Array.isArray(v) ? "array" : "object"}, not its HTML: ${t.slice(0, 160)}`);
  }
  return s;
}

/** "Prices current as of: 10/01/26 8:54 PM." -> the string as printed, or null. */
export function boardUpdated(html) {
  const m = /Prices current as of:\s*([0-9/]+\s+[0-9:]+\s*[AP]M)/i.exec(text(html));
  return m ? m[1] : null;
}

/** Every location card: { id, name, html }. */
export function cards(html) {
  const re = /<div\s+class="cih-loc-card[^"]*"[^>]*?data-location-i-d="(\d+)"/g;
  const hits = [...String(html).matchAll(re)];
  return hits.map((m, i) => {
    const chunk = String(html).slice(m.index, i + 1 < hits.length ? hits[i + 1].index : undefined);
    const name = (/<b>([\s\S]*?)<\/b>/.exec(chunk) ?? [])[1];
    return { id: m[1], name: name ? text(name) : null, html: chunk };
  });
}

function sections(cardHtml) {
  const re = /<div\s+class="cih-com-row[^"]*"[^>]*?data-commodity-name="([^"]*)"/g;
  const hits = [...cardHtml.matchAll(re)];
  return hits.map((m, i) => ({
    commodity: decode(m[1]).trim(),
    html: cardHtml.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : undefined),
  }));
}

function rowsOf(sectionHtml) {
  const out = [];
  const head = (/<thead>([\s\S]*?)<\/thead>/.exec(sectionHtml) ?? [])[1] ?? "";
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).toLowerCase());
  for (const m of sectionHtml.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const attrs = m[1];
    if (!/data-delivery-period-label=/.test(attrs)) continue;
    const label = decode((/data-delivery-period-label="([^"]*)"/.exec(attrs) ?? [])[1] ?? "").trim();
    const tds = [...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    const spans = (h) => [...String(h).matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)].map((x) => text(x[1])).filter((x) => x !== "");
    out.push({ label, cols, tds, spans, attrs, raw: text(m[2]) });
  }
  return out;
}

/** The site number out of the OLDER endpoint, /cih/api/index.cfm/origination/cashbids/<n>. */
export function legacyUrl(siteId) {
  if (!/^\d+$/.test(String(siteId ?? ""))) throw new CihRefused(`a CIH site number is digits, not "${siteId}"`);
  return `https://${API_HOST}/cih/api/index.cfm/origination/cashbids/${siteId}`;
}

/* THE OLDER WIDGET, still served to St. Ansgar Mills and Whitewater Milling
 * (capture.yml run 36954854588): no cards and no ids, but the same columns.
 *   <h1 class="cashbid_h1">St. Ansgar Mills, Inc</h1>
 *   <h2 class="cashbid_h2">Corn</h2>
 *   <table class="cashbid_table"> Delivery | Futures (month, price) | Change | Basis | Bid
 * One heading is one location; its locationId is the heading itself. */
export function extractLegacy(html, sourceUrl = "") {
  const s = String(html);
  const heads = [...s.matchAll(/<h1 class="cashbid_h1">\s*([\s\S]*?)\s*<\/h1>/g)];
  if (!heads.length) return [];
  const out = [];
  let seq = 0;
  heads.forEach((h, i) => {
    const loc = text(h[1]);
    const chunk = s.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const secs = [...chunk.matchAll(/<h2 class="cashbid_h2">\s*([\s\S]*?)\s*<\/h2>([\s\S]*?)<\/table>/g)];
    for (const sec of secs) {
      const commodity = text(sec[1]);
      const root = classRoot(commodity);
      for (const tr of sec[2].matchAll(/<tr class="cashbid_tr">([\s\S]*?)<\/tr>/g)) {
        const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
        if (tds.length < 6) continue;
        const [delivery, monthRaw, futRaw, chgRaw, basisRaw, bidRaw] = tds;
        const month = contractMonth(monthRaw);
        const fut = num(futRaw), cash = num(bidRaw), basis = num(basisRaw), chg = num(chgRaw);
        if (!delivery || !month || fut == null || cash == null || basis == null) continue;
        if (fut === undefined || cash === undefined || basis === undefined || !(cash > 0)) continue;
        out.push({ seq: seq++, location: loc, locationId: loc, commodity, delivery, cash, basis,
          basisCents: Math.round(basis * 100),
          futures: root ? `${root}${month.code}${String(month.year).slice(2)}` : month.label,
          futuresPrice: Math.round(fut * 100 * 10000) / 10000, futuresAt: null, futuresFlag: null,
          futuresChange: chg === undefined ? null : chg, unit: "bushel", source: sourceUrl,
          raw: `${loc} | ${commodity} | ${tds.join(" | ")}` });
      }
    }
  });
  return out;
}

/** Read the board. Rows carry futuresPrice in CENTS, as lib/board.mjs checks it. */
export function extract(body, sourceUrl = "") {
  const html = htmlOf(body);
  const cs = cards(html);
  if (!cs.length) {
    const legacy = extractLegacy(html, sourceUrl);
    if (legacy.length) return legacy;
    throw new CihRefused(`no location card (cih-loc-card) in ${html.length} bytes: `
      + `this is not the CIH widget, or the site number serves an empty board. Starts: ${JSON.stringify(text(html).slice(0, 160))}`);
  }
  const updated = boardUpdated(html);
  const out = [];
  let seq = 0;
  for (const card of cs) {
    if (!card.name) continue;
    for (const sec of sections(card.html)) {
      for (const r of rowsOf(sec.html)) {
        const want = ["delivery", "futures", "change", "basis", "bid"];
        if (r.cols.length && want.some((c, i) => r.cols[i] !== c)) continue;   // a layout this adapter has not seen is not guessed at
        if (r.tds.length < 5) continue;
        const [, futTd, chgTd, basisTd, bidTd] = r.tds;
        const fut = r.spans(futTd);
        const month = contractMonth(fut[0]);
        const futDollars = num(fut[fut.length - 1]);
        const cash = num(text(bidTd));
        const basis = num(text(basisTd));
        const change = num(r.spans(chgTd).slice(-1)[0] ?? text(chgTd));
        if (!r.label || cash == null || basis == null || futDollars == null || !month) continue;
        if (cash === undefined || basis === undefined || futDollars === undefined) continue;
        if (!(cash > 0)) continue;
        const root = classRoot(sec.commodity);
        out.push({
          seq: seq++,
          location: card.name,
          locationId: card.id,
          commodity: sec.commodity,
          delivery: r.label,
          cash,
          basis,
          basisCents: Math.round(basis * 100),
          futures: root ? `${root}${month.code}${String(month.year).slice(2)}` : month.label,
          futuresPrice: Math.round(futDollars * 100 * 10000) / 10000,
          futuresAt: updated,
          futuresFlag: null,
          futuresChange: change === undefined ? null : change,
          unit: "bushel",
          source: sourceUrl,
          raw: `${card.name} | ${sec.commodity} | ${r.raw}`,
        });
      }
    }
  }
  if (!out.length) {
    throw new CihRefused(`${cs.length} location card(s) (${cs.map((c) => c.name).join(", ")}) and no row with a delivery, `
      + `a contract month, a futures price, a basis and a bid together`);
  }
  return out;
}

export default extract;

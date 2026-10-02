/* ADAPTER: Nexus Cooperative's own cash-bid page, www.nexus.coop/cash-bids/.
 *
 * FOUND 2026-10-01. The Barchart roster lists 29 Nexus elevators and none was
 * read here; discover filed nexus.coop "no-platform" because the board is
 * rendered by their own server. The capture (capture.yml run 36956170275,
 * 529,796 bytes) holds 36 locations in one document:
 *
 *   <select name="location"> <option value="W3E60SF5NVTPEDBRCXJ1">Northwood, IA</option> ...
 *   <section class="location"><h1>Northwood, IA</h1>
 *     <div class="cashbids_table"><h1>Corn</h1>
 *       <table> Delivery Start | Delivery End | Basis Month | Futures Price | Basis | Cash Price | Futures Change
 *         09/30/2026 | 10/09/2026 | Dec 2026 | 4.99 | -0.68 | $4.31 | 0.0325
 *
 * The option values are StoneHedge location ids (twenty capitals and digits),
 * so their data is StoneHedge's, served from their own page. Each row names the
 * contract AND prints its price, so lib/board.mjs proves cash - basis = futures.
 * The printed price is sometimes rounded to the cent (4.99 for 4.9875), which
 * leaves a residual inside half a cent; the manifest declares what the capture
 * measured.
 *
 * locationId is the picker's id when the section heading matches exactly one
 * option (with or without its ", ST"); otherwise the heading itself. The
 * Futures Change cell carries its sign in a CSS class, not the number, so it is
 * not read. */
import { classRoot } from "./stonehedge.mjs";

export class NexusRefused extends Error {}

export const BOARD_URL = "https://www.nexus.coop/cash-bids/";

const decode = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (h) => decode(String(h ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const base = (n) => String(n ?? "").replace(/,\s*[A-Z]{2}$/, "").trim().toLowerCase();

export function money(v) {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  return /^-?\d*\.?\d+$/.test(s) ? Number(s) : undefined;
}

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CODE = { 1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M", 7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Dec 2026" -> { code: "Z", year: 2026 }, or null. */
export function contractMonth(v) {
  const m = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/.exec(String(v ?? "").trim());
  if (!m || !MON3[m[1].toLowerCase()]) return null;
  return { code: CODE[MON3[m[1].toLowerCase()]], year: Number(m[2]), label: String(v).trim() };
}

/** "09/30/2026", "10/09/2026" -> "30 Sep 2026 to 09 Oct 2026". */
export function dateRange(a, b) {
  const one = (v) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v ?? "").trim());
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
    return `${m[2].padStart(2, "0")} ${MON[Number(m[1]) - 1]} ${m[3]}`;
  };
  const x = one(a), y = one(b);
  return x && y ? `${x} to ${y}` : null;
}

/** The picker: heading -> id, matched with and without ", ST". */
export function picker(html) {
  const opts = [...String(html).matchAll(/<option\s+value="([A-Z0-9]{20})">([^<]+)<\/option>/g)].map((m) => ({ id: m[1], name: text(m[2]) }));
  return (heading) => {
    const exact = opts.filter((o) => o.name === heading);
    if (exact.length === 1) return exact[0].id;
    const loose = opts.filter((o) => base(o.name) === base(heading));
    return loose.length === 1 ? loose[0].id : null;
  };
}

export function extract(html, sourceUrl = "") {
  const s = String(html);
  const idOf = picker(s);
  const secRe = /<section class="location">\s*<h1>([\s\S]*?)<\/h1>/g;
  const hits = [...s.matchAll(secRe)];
  if (!hits.length) throw new NexusRefused(`no <section class="location"> in ${s.length} bytes: not Nexus's board, or the page moved`);
  const want = ["delivery start", "delivery end", "basis month", "futures price", "basis", "cash price"];
  const out = [];
  let seq = 0;
  hits.forEach((m, i) => {
    const name = text(m[1]);
    const sec = s.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : undefined);
    const locationId = idOf(name) ?? name;
    const tables = [...sec.matchAll(/<div class="cashbids_table">\s*<h1>([\s\S]*?)<\/h1>([\s\S]*?)<\/table>/g)];
    for (const t of tables) {
      const commodity = text(t[1]);
      const head = [...t[2].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((x) => text(x[1]).toLowerCase());
      if (want.some((c, k) => head[k] !== c)) continue;
      for (const tr of t[2].matchAll(/<tr>\s*([\s\S]*?)<\/tr>/g)) {
        const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((x) => text(x[1]));
        if (tds.length < 6) continue;
        const [start, end, monthRaw, futRaw, basisRaw, cashRaw] = tds;
        const delivery = dateRange(start, end);
        const month = contractMonth(monthRaw);
        const fut = money(futRaw), basis = money(basisRaw), cash = money(cashRaw);
        if (!delivery || !month || fut == null || basis == null || cash == null) continue;
        if (fut === undefined || basis === undefined || cash === undefined || !(cash > 0)) continue;
        const root = classRoot(commodity);
        out.push({
          seq: seq++, location: name, locationId, commodity, delivery,
          cash, basis, basisCents: Math.round(basis * 100),
          futures: root ? `${root}${month.code}${String(month.year).slice(2)}` : month.label,
          futuresPrice: Math.round(fut * 100 * 10000) / 10000,
          futuresAt: null, futuresFlag: null, futuresChange: null,
          unit: "bushel", source: sourceUrl,
          raw: `${name} | ${commodity} | ${tds.join(" | ")}`,
        });
      }
    }
  });
  if (!out.length) throw new NexusRefused(`${hits.length} location section(s) and no readable row`);
  return out;
}

export default extract;

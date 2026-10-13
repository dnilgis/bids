/* ADAPTER: Bunge's own location pages, www.bungeag.com/locations/<slug>/.
 *
 * FOUND 2026-10-13 while looking for Bunge at Ladoga, IN. bungeag.com is a
 * WordPress site; every location has a page, and the pages Bunge calls
 * "legacy-bunge" (24 of the 85 in the list the site prints into every page as
 * bungeservicesapi_vars.api_get_all_locations) render their cash bids on the
 * server, one tab per commodity:
 *
 *   <h2 class="weight300 bunge-blue">Decatur, IN Cash Bids</h2>
 *   <div class="content-commodites"> ... <div class="tab-content">
 *     <div id="soybeans" class="tab-pane fade active in">
 *       <h3 class="... commodity-title onlymobile">Soybeans</h3>
 *       <table> Delivery Period | Symbol | Futures | Basis | Cash
 *         Oct/Nov | @SX26 | 12.8375 | -0.2000 | 12.6375
 *       <p class="last-update ..." data-currency="USD">USD per BU as of 10-13-2026 at 01:25:14 PM CDT</p>
 *
 * Futures, basis and cash are all dollars and the futures PRICE is printed, so
 * every row proves itself with cash - basis = futures (12.8375 - 0.20 =
 * 12.6375). The futures price is handed on in cents.
 *
 * THE 61 "legacy-viterra" PAGES (Haw Creek at Ladoga, Roachdale, Terre Haute,
 * Shelburn, ...) CARRY NO BID TABLE. Their pages print an address, hours and a
 * team and nothing else; extract() refuses them with BungeRefused, so a source
 * pointed at one fails loudly rather than reading empty.
 *
 * A page is one location. locationId is the page's own slug, read from its
 * canonical URL (decatur-in for /locations/decatur-in/), and a page whose
 * canonical URL is not the one asked for is refused: a redirect to another
 * location is not this location's board.
 *
 * Byproducts (soybean meal, hulls) are quoted per ton against meal futures and
 * are left out: only rows on a grain contract are kept. */
export class BungeRefused extends Error {}

export const SITE = "https://www.bungeag.com";
export const pageUrl = (slug) => {
  if (!/^[a-z0-9-]+$/.test(String(slug ?? ""))) throw new BungeRefused(`a bungeag.com location slug is lower-case letters, digits and dashes, not "${slug}"`);
  return `${SITE}/locations/${slug}/`;
};

/* Bunge's symbols are @<root><month><yy>. Grain roots only. */
export const ROOTS = { C: "ZC", S: "ZS", W: "ZW", KW: "KE", MW: "MW", O: "ZO" };

const decode = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
const text = (h) => decode(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const dollars = (s) => (/^-?\d+(\.\d+)?$/.test(String(s).trim()) ? Number(String(s).trim()) : null);

export function symbolOf(sym) {
  const m = /^@([A-Z]{1,2})([FGHJKMNQUVXZ])(\d{2})$/.exec(String(sym ?? "").trim());
  if (!m || !ROOTS[m[1]]) return null;
  return `${ROOTS[m[1]]}${m[2]}${m[3]}`;
}

/** The list every bungeag.com page prints: [{ id, code, name, source, address, geoCode, link }]. */
export function locationList(html) {
  const m = /var bungeservicesapi_vars = (\{[\s\S]*?\});\s*\n/.exec(String(html));
  if (!m) return [];
  try { return JSON.parse(m[1]).api_get_all_locations ?? []; } catch { return []; }
}

/** "USD per BU as of 10-13-2026 at 01:25:14 PM CDT" -> { currency, unit, at (ISO, offset kept) } */
export function lastUpdate(s) {
  const m = /([A-Z]{3}) per ([A-Z]+) as of (\d{2})-(\d{2})-(\d{4}) at (\d{1,2}):(\d{2}):(\d{2}) (AM|PM) (C[DS]T)/.exec(text(s));
  if (!m) return null;
  let h = Number(m[6]) % 12; if (m[9] === "PM") h += 12;
  const off = m[10] === "CDT" ? "-05:00" : "-06:00";
  const at = `${m[5]}-${m[3]}-${m[4]}T${String(h).padStart(2, "0")}:${m[7]}:${m[8]}${off}`;
  return { currency: m[1], unit: m[2], at: new Date(at).toISOString() };
}

export const slugOf = (url) => { const m = /\/locations\/([a-z0-9-]+)\/?(?:[?#].*)?$/.exec(String(url ?? "")); return m ? m[1] : null; };

export function extract(html, sourceUrl = "") {
  const s = String(html);
  const canon = (/<link rel="canonical" href="([^"]+)"/.exec(s) || [])[1] ?? null;
  const slug = slugOf(canon);
  const heading = /<h2 class="weight300 bunge-blue">([^<]*?) Cash Bids<\/h2>/.exec(s);
  if (!heading) {
    const me = locationList(s).find((l) => String(l.link ?? "") === canon);
    const name = me ? `${me.name} (${me.source})` : canon ?? "this page";
    throw new BungeRefused(`${name}: no "Cash Bids" section in ${s.length} bytes. bungeag.com prints bids only on its legacy-bunge pages`);
  }
  if (!slug) throw new BungeRefused(`the page names no canonical /locations/<slug>/ URL (${canon}), so its location cannot be named`);
  if (sourceUrl && slugOf(sourceUrl) && slugOf(sourceUrl) !== slug)
    throw new BungeRefused(`asked for ${sourceUrl} and the page says it is ${canon}: a redirect to another location is not that location's board`);
  const location = text(heading[1]);
  const tabsAt = s.indexOf('<div class="tab-content">', heading.index);
  const endAt = s.indexOf('bunge-blue">Address</h2>', tabsAt);
  if (tabsAt < 0 || endAt < 0) throw new BungeRefused(`${location}: the Cash Bids section has no tab-content, or no end`);
  const body = s.slice(tabsAt, endAt);
  const panes = [...body.matchAll(/<div id="([^"]+)" class="tab-pane[^"]*">([\s\S]*?)(?=<div id="[^"]+" class="tab-pane|$)/g)];
  const want = ["delivery period", "symbol", "futures", "basis", "cash"];
  const out = [];
  const unreconciled = [];
  let seq = 0;
  for (const [, paneId, pane] of panes) {
    const commodity = text((/<h3[^>]*commodity-title[^>]*>([\s\S]*?)<\/h3>/.exec(pane) || [])[1]);
    const head = [...pane.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).toLowerCase());
    if (want.some((c, i) => head[i] !== c)) { unreconciled.push(`${commodity || paneId}: columns ${JSON.stringify(head)}`); continue; }
    const upd = lastUpdate((/<p class="last-update[^>]*>([\s\S]*?)<\/p>/.exec(pane) || [])[1]);
    if (upd && upd.unit !== "BU") continue;   // meal and hulls, quoted per ton: not grain, not read
    if (!upd || upd.currency !== "USD") { unreconciled.push(`${commodity}: no "USD per BU as of" line`); continue; }
    for (const tr of pane.matchAll(/<tr class="parent">([\s\S]*?)<\/tr>/g)) {
      /* The Delivery Period cell is never closed (<td>Oct/Nov<td>@SX26</td>), so split on the opening tag. */
      const tds = tr[1].split(/<td\b[^>]*>/).slice(1).map(text);
      if (tds.length < 5) continue;
      const [delivery, sym, futRaw, basisRaw, cashRaw] = tds;
      const futures = symbolOf(sym);
      if (!futures) continue;   // meal, hulls, oil: not a grain contract
      const fut = dollars(futRaw), basis = dollars(basisRaw), cash = dollars(cashRaw);
      if (!delivery || fut == null || basis == null || cash == null || !(cash > 0)) {
        unreconciled.push(`${commodity} ${delivery}: ${tds.join(" | ")}`); continue;
      }
      out.push({
        seq: seq++, location, locationId: slug, commodity, delivery,
        cash, basis, basisCents: Number((basis * 100).toFixed(4)),
        futures, futuresPrice: Number((fut * 100).toFixed(4)), futuresAt: upd.at, futuresFlag: null, futuresChange: null,
        unit: "bushel", source: sourceUrl, raw: `${location} | ${commodity} | ${tds.join(" | ")}`,
      });
    }
  }
  if (!out.length) throw new BungeRefused(`${location}: ${panes.length} commodity tab(s) and no grain row`);
  out.unreconciled = unreconciled;
  return out;
}

export default extract;

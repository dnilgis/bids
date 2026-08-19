/* ADAPTER — DTN AgHost cash bid pages.
 *
 * Fingerprint: aghost.net assets, ColdFusion `index.cfm`, `cid=####&sid=#`,
 * a `table.DataGrid` with Cash Price / Futures Change / Basis / Futures Month /
 * Futures Price rows, and a `displayNumber()` shim.
 *
 * Exports an `extract(html, sourceUrl)` with the SAME row shape the
 * cashbidssingle parser produces, so `buildFile()` applies exactly the same
 * guards to it. That is the point of the adapter boundary: parsing is
 * per-platform, guarding never is.
 *
 * THE OFFSET IS DERIVED, NEVER READ FROM THE COMMENT.
 * Every figure is passed through a function that adds a hidden constant, and
 * the constant differs between page loads (measured 2026-08-19: -67.4816 on
 * one page, +96.1297 on another). We sum the actual terms. The page also
 * states the value in a comment; the two must negate each other, which is a
 * free cross-check on our own term regex — see `offsetDisagreement`.
 */

const stripTags = (h) => String(h).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

/** Sum the signed constants inside displayNumber(). null when absent. */
export function deriveOffset(html) {
  const fn = html.match(/function\s+displayNumber\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*document\.write/);
  if (!fn) return null;
  const terms = [...fn[1].matchAll(/x\s*=\s*\(\s*-\(\s*([+-])\s*\(\(\s*([\d.]+)\s*\)[\s)]*\+\s*x\s*\)/g)];
  if (!terms.length) return null;
  let off = 0;
  for (const [, sign, mag] of terms) off += -(sign === "+" ? +mag : -+mag);
  return { offset: off, termCount: terms.length };
}

export function statedOffset(html) {
  const m = html.match(/NoScrapeOffset:\s*(-?[\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

/** "" when they agree, else why they do not. Two statements of one number. */
export function offsetDisagreement(html, derived) {
  const stated = statedOffset(html);
  if (stated === null) return "";
  const residual = Math.round((derived + stated) * 10000) / 10000;
  return residual === 0 ? ""
    : `derived offset ${derived} does not negate the stated ${stated} ` +
      `(residual ${residual}); the term regex is probably missing terms`;
}

/** "473'0" / "1222'2" -> cents. Eighths after the apostrophe. */
export function parseEighths(text) {
  const t = stripTags(text).replace(/s$/, "").trim();
  const m = t.match(/^(\d+)'(\d)$/);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 8;
  /* Tick-shaped but unparsed must not fall through to a truncated number —
     the same failure that froze the Boyceville feed on 2026-08-19. */
  if (/^\d+'/.test(t)) return null;
  return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
}

/* WHAT WE ACTUALLY RECEIVED.
 * Returning [] on every structural miss made buildFile say "0 bids parsed;
 * their page layout has changed" -- which names a cause we have not
 * established. On the first live run against Flash Grain that message was the
 * only evidence, and it pointed at their markup when the likeliest culprit is
 * that a bare fetch of a ColdFusion page gets a session/cookie landing rather
 * than the board. Describe the page in front of us and let a human read it. */
export function describe(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim().slice(0, 80);
  /* THE DECIDING NUMBER IS THE CALL COUNT.
     `displayNumber` being defined tells us almost nothing -- the definition is
     in the template whether or not the board rendered with any data. Every
     PRICE is a call to it, so:
        calls <= 1  the page carries the function and no figures. We were
                    served the shell: a session, a cookie or a parameter is
                    missing, and their markup is not the problem.
        calls > 1   the figures are there and our regexes are the problem.
     The first live run reported "displayNumber present" and refused anyway,
     which distinguished nothing. This does. */
  const calls = (html.match(/displayNumber\(\s*-?[\d.]+/g) || []).length;
  const d = deriveOffset(html);
  return [
    `${html.length} bytes`,
    `title "${title || "(none)"}"`,
    `displayNumber ${/function\s+displayNumber/.test(html) ? "defined" : "NOT DEFINED"}`,
    `price calls ${calls}`,
    `offset terms ${d ? d.termCount : 0}`,
    `NoScrapeOffset comment ${statedOffset(html) === null ? "ABSENT" : "present"}`,
    `DataGrid ${/<table class="DataGrid/.test(html) ? "present" : "ABSENT"}`,
    calls <= 1 ? "=> SERVED THE SHELL, NO FIGURES ON THE PAGE"
               : (d ? "" : "=> FIGURES PRESENT BUT THE TERM REGEX MATCHED NOTHING"),
    /cookieHelp|noCookiesWin/i.test(html) ? "cookie-help script inline (also on the good page)" : "",
  ].filter(Boolean).join(" · ");
}

export class AghostRefused extends Error {}

export function extract(html, sourceUrl = "") {
  const d = deriveOffset(html);
  /* Do not name a cause the evidence has not established. The first version
     said "no displayNumber() on the page" while describe() was reporting it
     present -- the message contradicted the diagnosis printed beside it. */
  if (!d) throw new AghostRefused(`could not derive the offset, so no figure on this page is decodable. ${describe(html)}`);
  const complaint = offsetDisagreement(html, d.offset);
  if (complaint) throw new AghostRefused(complaint);
  const off = d.offset;

  const grid = html.match(/<table class="DataGrid[^"]*"[\s\S]*?<\/table>/);
  if (!grid) throw new AghostRefused(`displayNumber() is there but no table.DataGrid. Got: ${describe(html)}`);
  const table = grid[0];

  const thead = table.match(/<thead>([\s\S]*?)<\/thead>/);
  if (!thead) throw new AghostRefused(`the DataGrid has no thead, so the delivery columns cannot be labelled. Got: ${describe(html)}`);
  const deliveries = [...thead[1].matchAll(/<th[^>]*scope="col"[^>]*>\s*<span>([^<]*)<\/span>/g)]
    .map((m) => m[1].trim());
  if (!deliveries.length) throw new AghostRefused(`no delivery columns in the DataGrid header. Got: ${describe(html)}`);

  const blocks = [];
  let curLoc = null, block = null;
  for (const tr of [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1])) {
    const two = tr.match(/<th[^>]*rowspan="\d+"[^>]*scope="rowgroup"[^>]*>([^<]+)<\/th>\s*<th[^>]*rowspan="\d+"[^>]*scope="rowgroup"[^>]*>([^<]+)<\/th>/);
    const one = tr.match(/<th[^>]*rowspan="\d+"[^>]*scope="rowgroup"[^>]*>([^<]+)<\/th>/);
    const label = stripTags((tr.match(/<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/) || [, ""])[1]);
    if (two) curLoc = two[1].trim();
    if (label === "Cash Price") {
      block = { location: curLoc, commodity: (two ? two[2] : one ? one[1] : "").trim(),
                cash: [], basis: [], month: [], price: [] };
      blocks.push(block);
    }
    if (!block) continue;
    const cells = [...tr.matchAll(/<td[\s\S]*?<\/td>/g)].map((m) => m[0]);
    const nums = cells.map((c) => {
      const n = c.match(/displayNumber\(\s*(-?[\d.]+)\s*,/);
      return n ? Math.round((parseFloat(n[1]) + off) * 10000) / 10000 : null;
    });
    if (label === "Cash Price") block.cash = nums;
    else if (label === "Basis") block.basis = nums;
    else if (label === "Futures Month") block.month = cells.map((c) => stripTags(c) || null);
    else if (label === "Futures Price") block.price = cells.map(parseEighths);
  }

  const out = [];
  let seq = 0;
  for (const b of blocks) {
    for (let i = 0; i < deliveries.length; i++) {
      const cash = b.cash[i], basis = b.basis[i], price = b.price[i];
      if (cash == null || basis == null || price == null) continue;  // blank column
      out.push({
        seq: seq++,
        location: b.location,
        /* AgHost has no numeric location id; the board labels rows by town, so
           the town IS the id. The manifest row uses the same string. */
        locationId: b.location,
        commodity: b.commodity,
        delivery: deliveries[i],
        cash: Math.round(cash * 100) / 100,
        basis: Math.round(basis * 100) / 100,
        basisCents: Math.round(basis * 100),
        futures: b.month[i],
        futuresPrice: price,
        futuresAt: null,
        futuresFlag: /s<\/span>/.test(html) ? "s" : null,
        source: sourceUrl,
        raw: `${b.location} ${b.commodity} ${deliveries[i]}`,
      });
    }
  }
  return out;
}

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

/* WHERE THE FIGURES ARE HIDDEN.
 * Every price on an AgHost board is written as `displayNumber(<encoded>, 2)`,
 * and displayNumber() adds a hidden constant that changes between page loads.
 * Recovering that constant is the whole job of this file.
 *
 * TWO REGEXES HAVE NOW AGREED WITH A FIXTURE AND DISAGREED WITH THE PAGE.
 * The first required `\s*` in the exact places the fixture happened to have
 * whitespace: 19 terms in the fixture, 0 live. The second stripped whitespace
 * and pinned the token shape `x=(-(±((n))))+x)`: 19 terms in the fixture,
 * 0 live again (run 87593083735, 22:47 UTC, both Flash Grain pages, 16 price
 * calls present, so the figures were right there). Pinning a shape means
 * guessing which of their formatting choices is load-bearing, and I have now
 * guessed wrong twice.
 *
 * So stop matching the arithmetic and RUN it. Take the function body, strip
 * whitespace, prove it contains nothing but arithmetic on `x`, and evaluate it
 * at x = 0. Whatever nesting, spacing or sign convention they use, the value
 * of the body at zero IS the offset, by definition -- there is no shape left
 * to guess.
 *
 * WHY EVALUATING A REMOTE PAGE IS SAFE HERE, AND ONLY HERE.
 * The body must match ONE_TERM_CHARS: digits, `.`, `+ - * / ( )`, `=`, `;`
 * and the single letter `x`. No other letter can appear, so no identifier, no
 * property, no call and no literal of any other type can be written -- there
 * is nothing to reach. Every statement must also be an assignment to `x`.
 * A body that fails either test is not evaluated at all: we refuse and print
 * it, which is how the next surprise gets diagnosed in one run instead of two.
 *
 * The `NoScrapeOffset` comment states the same number independently, and
 * `offsetDisagreement()` requires the two to negate. A derivation that is
 * loose in the wrong way therefore produces a refusal, never a wrong price. */
/* WHAT THE BODY IS ALLOWED TO CONTAIN.
 *
 * Digits, `. + - * / ( ) = ;`, the comparison characters `< > !`, the single
 * letter `x`, and the keyword `if` -- and `if` only where it is immediately
 * followed by `(`. Nothing else. No other letter can appear, so there is no
 * identifier, no property, no call, no string and no loop: the body can compute
 * a number and it can do nothing else. That is what makes evaluating a script
 * off someone else's website safe HERE and nowhere else in this repo.
 *
 * `if` earned its place on 2026-08-19 when Sig pasted the live page. The board
 * had switched to gating each term behind a condition:
 *
 *     if( -19.098600 >= -29.602800 )
 *     x = x -(  -(-(-19.098600)  ));
 *     x = x;
 *
 * Four of the twelve conditions on that page were FALSE, so four of the terms
 * did not apply. Any regex that sums the terms it can see -- including the two
 * this file has already shipped -- would have added all twelve and produced an
 * offset wrong by the four skipped ones, on every figure, with cash and basis
 * shifted equally so the identity check `cash - basis == futures` still passed.
 * The only thing standing between that and a wrong published price is the
 * NoScrapeOffset cross-check. Running the body is not the convenient way to
 * read this page; on this page it is the only correct way. */
const ARITHMETIC_ONLY = /^[0-9.+\-*/()=;<>!x]*$/;

/** `if(<balanced>)` removed from the front of a statement; null if unbalanced. */
function stripCondition(st) {
  if (!st.startsWith("if(")) return st;
  let depth = 0;
  for (let i = 2; i < st.length; i++) {
    if (st[i] === "(") depth++;
    else if (st[i] === ")" && --depth === 0) return st.slice(i + 1);
  }
  return null;
}

/** Every `function displayNumber(` on the page, in order. */
function definitionsOf(html) {
  return [...String(html).matchAll(/function\s+displayNumber\s*\(/g)].map((m) => m.index);
}

/** The body of the definition starting at `at`, whitespace stripped, or a why. */
function bodyAt(html, at) {
  const open = String(html).indexOf("{", at);
  const end = String(html).indexOf("document.write", at);
  if (open === -1) return { ok: false, why: "displayNumber() has no opening brace" };
  if (end === -1) return { ok: false, why: "no document.write() closing displayNumber(); the body could not be bounded" };
  if (open > end) return { ok: false, why: "document.write() appears before displayNumber()'s brace" };
  /* FROM THE BRACE, NOT FROM THE PAREN.
     Slicing at the paren keeps the parameter list -- `x,decimal_places){` --
     which is 15 characters of letters before the arithmetic even starts. It ate
     the whole of the 2026-08-19 diagnostic sample and it fails the whitelist
     below on `decimal_places`. The body begins at `{`. */
  return { ok: true, body: String(html).slice(open + 1, end).replace(/\s+/g, "") };
}

/** Evaluate one body. `{ok:true, offset, termCount}` or `{ok:false, why}`. */
function offsetOfBody(body) {
  if (!body) return { ok: false, why: "displayNumber()'s body is empty" };
  const scrubbed = body.replace(/if\(/g, "(");
  if (!ARITHMETIC_ONLY.test(scrubbed)) {
    const bad = [...new Set(scrubbed.replace(/[0-9.+\-*/()=;<>!x]/g, "").split(""))].join("");
    return { ok: false, why: `the body is not arithmetic on x (characters outside the whitelist: ${JSON.stringify(bad)})` };
  }
  const statements = body.split(";").filter(Boolean);
  if (!statements.length) return { ok: false, why: "no statements in displayNumber()'s body" };
  for (const st of statements) {
    const assign = stripCondition(st);
    if (assign === null) return { ok: false, why: `an if( is never closed: ${JSON.stringify(st.slice(0, 60))}` };
    if (!/^x=[^=]/.test(assign)) return { ok: false, why: `a statement does not assign to x: ${JSON.stringify(st.slice(0, 60))}` };
  }

  let value;
  try {
    // eslint-disable-next-line no-new-func
    value = new Function("x", `${body};return x;`)(0);
  } catch (e) {
    return { ok: false, why: `the body did not evaluate: ${e.message}` };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, why: `the body evaluated to ${JSON.stringify(value)}, which is not a finite number` };
  }
  const termCount = (body.match(/\d+(\.\d+)?/g) || []).length;
  /* An offset of exactly zero is what an emptied-out body evaluates to, and it
     is also what a board with no obfuscation would give. We have never seen the
     latter; treat it as evidence we read the wrong thing. */
  if (value === 0) return { ok: false, why: `the body evaluates to 0 at x=0 (${termCount} numbers in it), which is not an offset we have ever seen` };
  return { ok: true, offset: Math.round(value * 10000) / 10000, termCount };
}

/** Detail behind deriveOffset: `{ok:true, offset, termCount}` or `{ok:false, why}`.
 *
 * EVERY DEFINITION, NOT THE FIRST ONE.
 * The live Flash Grain page is 103,796 bytes against a 9,516-byte fixture that
 * carries the same sixteen price calls -- i.e. the fixture is the board and the
 * live page is the board inside ninety more kilobytes of site. A second
 * `displayNumber` anywhere in that ninety -- a stub in a header script, a copy
 * in a widget -- is matched first by a `.match()`, and its empty body is what
 * gets read. That is consistent with every symptom of run 87593083735: figures
 * present, terms zero, body sample starting at the parameter list. So take all
 * of them, and require the ones that decode to agree. */
export function deriveOffsetDetail(html) {
  const ats = definitionsOf(html);
  if (!ats.length) return { ok: false, why: "no displayNumber() definition on the page", definitions: 0 };

  const results = ats.map((at) => {
    const b = bodyAt(html, at);
    return b.ok ? { ...offsetOfBody(b.body), body: b.body } : b;
  });
  const good = results.filter((r) => r.ok);
  const offsets = [...new Set(good.map((r) => r.offset))];

  if (offsets.length > 1) {
    return { ok: false, definitions: ats.length,
      why: `the page defines displayNumber() ${ats.length} times and they do not agree (${offsets.join(", ")}); which one the figures use is a guess` };
  }
  if (good.length) return { ok: true, offset: good[0].offset, termCount: good[0].termCount, definitions: ats.length };

  const why = results.map((r, i) => ats.length > 1 ? `#${i + 1}: ${r.why}` : r.why).join("; ");
  return { ok: false, why, definitions: ats.length };
}

/** The hidden constant inside displayNumber(), or null when it cannot be had. */
export function deriveOffset(html) {
  const d = deriveOffsetDetail(html);
  return d.ok ? { offset: d.offset, termCount: d.termCount } : null;
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
/** The start of EVERY displayNumber body on the page, whitespace removed. */
export function bodySample(html, n = 400) {
  const ats = definitionsOf(html);
  if (!ats.length) return "(no displayNumber)";
  return ats.map((at, i) => {
    const b = bodyAt(html, at);
    const head = ats.length > 1 ? `#${i + 1} ` : "";
    if (!b.ok) return `${head}(${b.why})`;
    return head + JSON.stringify(b.body.slice(0, n)) + (b.body.length > n ? "…" : "");
  }).join(" | ");
}

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
  const d = deriveOffsetDetail(html);
  return [
    `${html.length} bytes`,
    `title "${title || "(none)"}"`,
    `displayNumber defined ${definitionsOf(html).length}\u00d7`,
    `price calls ${calls}`,
    `offset ${d.ok ? d.offset : `NOT DERIVED (${d.why})`}`,
    `NoScrapeOffset comment ${statedOffset(html) === null ? "ABSENT" : "present"}`,
    `DataGrid ${/<table class="DataGrid/.test(html) ? "present" : "ABSENT"}`,
    calls <= 1 ? "=> SERVED THE SHELL, NO FIGURES ON THE PAGE"
               : (d.ok ? "" : "=> THE FIGURES ARE ON THE PAGE AND WE COULD NOT READ THE OFFSET"),
    /* If the figures are there and the terms still will not match, the next
       thing anyone needs is the actual token shape -- not another round trip.
       Whitespace is already stripped, so this is the structure itself. */
    (calls > 1 && !d.ok) ? `body starts: ${bodySample(html)}` : "",
    /cookieHelp|noCookiesWin/i.test(html) ? "cookie-help script inline (also on the good page)" : "",
  ].filter(Boolean).join(" · ");
}

export class AghostRefused extends Error {}

export function extract(html, sourceUrl = "") {
  const d = deriveOffsetDetail(html);
  /* Do not name a cause the evidence has not established. The first version
     said "no displayNumber() on the page" while describe() was reporting it
     present -- the message contradicted the diagnosis printed beside it. */
  if (!d.ok) throw new AghostRefused(`could not derive the offset, so no figure on this page is decodable: ${d.why}. ${describe(html)}`);
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

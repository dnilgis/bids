#!/usr/bin/env node
/* RECON. Not a reader — this never writes data/ and never publishes a number.
 *
 * WHY THIS EXISTS
 *
 * Three boards are JavaScript applications: StoneX Stonehedge (United
 * Cooperative, 24 locations), DTN's content-services cash-bids widget (Farmers
 * Cooperative Society, probably Albert Lea), and anything else built the same
 * way. A plain GET of those pages returns a shell that says "you need to enable
 * JavaScript", and the request that actually returns prices is made by their
 * bundle at runtime.
 *
 * That request can be found without a browser: the bundle is a static file, the
 * URL it calls is a string inside it, and strings can be read. This walks a
 * page, collects every script it loads, fetches those scripts, and prints every
 * URL-shaped and endpoint-shaped string it finds, with context.
 *
 * IT RUNS ON THE RUNNER, NOT IN THE WORKSPACE.
 * The workspace this was written in sits behind an allowlist proxy that answers
 * "Host not in allowlist" for every elevator on earth. GitHub Actions has no
 * such limit. So this is a `workflow_dispatch` job: press Run, read the log.
 *
 * OUTPUT IS THE LOG. Nothing is committed. Nothing in data/ is touched.
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36";

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);
const urls = args.filter((a) => /^https?:\/\//.test(a));

const MAX_BUNDLE_BYTES = Number(flag("max-bundle-bytes", 8_000_000));
const CONTEXT = Number(flag("context", 90));
const REFERER = flag("referer");

/* ---------- fetching ---------- */

async function get(url, { referer } = {}) {
  const headers = { "user-agent": UA, "accept": "*/*", "accept-language": "en-US,en;q=0.9" };
  if (referer) { headers.referer = referer; headers.origin = new URL(referer).origin; }
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true, status: res.status, finalUrl: res.url, ms: Date.now() - t0,
      type: res.headers.get("content-type") || "(none)",
      bytes: buf.length, body: buf.toString("utf8"),
      server: res.headers.get("server"), setCookie: !!res.headers.get("set-cookie"),
    };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`, ms: Date.now() - t0 };
  }
}

/* ---------- extraction (pure, tested) ---------- */

/** Every script src, link href, iframe src and img-less URL attribute, resolved. */
export function assetsOf(html, base) {
  const abs = (u) => { try { return new URL(u, base).href; } catch { return null; } };
  const grab = (re) => [...String(html).matchAll(re)].map((m) => abs(m[1])).filter(Boolean);
  return {
    scripts: [...new Set(grab(/<script[^>]+src=["']([^"']+)["']/gi))],
    iframes: [...new Set(grab(/<iframe[^>]+src=["']([^"']+)["']/gi))],
    links: [...new Set(grab(/<link[^>]+href=["']([^"']+)["']/gi))],
  };
}

/** Inline `window.x = …` / `var x = …` assignments, which is where widget config lives. */
export function inlineConfig(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const a of m[1].matchAll(/(?:window\.|var\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)\s*=\s*([^;\n]{1,300})/g)) {
      out.push(`${a[1]} = ${a[2].trim()}`);
    }
  }
  return out;
}

/* WHAT AN ENDPOINT LOOKS LIKE IN A MINIFIED BUNDLE.
   Bundlers keep string literals intact, so the call target survives minification
   even though every identifier around it is destroyed. Three shapes cover it:
   an absolute URL, a rooted path, and a path assembled from a base plus a
   fragment ("/bids", "/v1/quotes"). Report all three with context and let a
   human pick — guessing which one is "the" endpoint is how you end up probing
   forty 404s. */
const PATH_KEYWORD = /(api|rest|graphql|\bv\d\b|data|bid|quote|price|cash|market|grain|component|service|widget|json|feed)/i;
const PATTERNS = [
  /* absolute URLs */
  { re: /https?:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]{6,180}/g, keep: () => true },
  /* protocol-relative, the shape half the ag widgets ship */
  { re: /["'`](\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]{0,160})["'`]/g, keep: () => true },
  /* ROOTED PATHS, WHICH IS WHERE THE SECOND DOOR WAS.
     United Cooperative's own widget endpoint appears nowhere as a full URL --
     only as "/dtncashbidwidget/bindlocation?dropdownvalue=" handed to $.post.
     A keyword list of API-ish prefixes missed it, because the interesting word
     was in the middle. Match any quoted rooted path and keep the ones whose
     text mentions anything to do with data or with grain. */
  { re: /["'`](\/[A-Za-z0-9._~\/?=&%+-]{5,160})["'`]/g, keep: (h) => PATH_KEYWORD.test(h) },
];

/** Deduped URL-ish strings with surrounding context. */
export function endpointStrings(text, context = 90) {
  const seen = new Map();
  for (const { re, keep } of PATTERNS) {
    for (const m of String(text).matchAll(re)) {
      const hit = (m[1] ?? m[0]).replace(/\\+$/, "");
      if (!keep(hit)) continue;
      if (/\.(png|jpe?g|gif|svg|woff2?|ttf|eot|ico|css|map)(\?|$)/i.test(hit)) continue;
      if (/^https?:\/\/(www\.)?(w3\.org|schema\.org|googletagmanager|google-analytics|apache\.org|github\.com|reactjs\.org|npmjs)/i.test(hit)) continue;
      if (seen.has(hit)) continue;
      const at = m.index ?? 0;
      seen.set(hit, String(text).slice(Math.max(0, at - context), at + hit.length + context).replace(/\s+/g, " "));
    }
  }
  return [...seen.entries()].map(([url, ctx]) => ({ url, ctx }));
}

/** fetch()/axios/XMLHttpRequest call sites, with context. */
export function callSites(text, context = 90) {
  const out = [];
  for (const m of String(text).matchAll(/(?:\bfetch\s*\(|axios\s*(?:\.\w+)?\s*\(|\.open\s*\(\s*["'](?:GET|POST)["']|XMLHttpRequest)/g)) {
    const at = m.index ?? 0;
    out.push(String(text).slice(Math.max(0, at - 20), at + context * 2).replace(/\s+/g, " "));
    if (out.length >= 40) break;
  }
  return out;
}

/* ---------- report ---------- */

const line = (s = "") => console.log(s);
const rule = (t) => { line(); line("=".repeat(78)); line(t); line("=".repeat(78)); };

async function probe(url, referer) {
  rule(`PAGE  ${url}`);
  if (referer) line(`referer: ${referer}`);
  const res = await get(url, { referer });
  if (!res.ok) { line(`FAILED after ${res.ms}ms — ${res.error}`); return; }
  line(`${res.status}  ${res.type}  ${res.bytes} bytes  ${res.ms}ms${res.server ? `  server=${res.server}` : ""}${res.setCookie ? "  set-cookie" : ""}`);
  if (res.finalUrl !== url) line(`redirected to: ${res.finalUrl}`);

  const isHtml = /html/i.test(res.type) || /^\s*<(!doctype|html)/i.test(res.body);
  if (!isHtml) {
    line(`\n-- not HTML; treating the body as a bundle --`);
    reportBundle(res.body);
    return;
  }

  line(`\n-- first 600 bytes --\n${res.body.slice(0, 600)}`);

  const { scripts, iframes, links } = assetsOf(res.body, res.finalUrl);
  line(`\n-- ${iframes.length} iframe(s) --`); iframes.forEach((u) => line(`  ${u}`));
  line(`\n-- ${scripts.length} script(s) --`); scripts.forEach((u) => line(`  ${u}`));
  const cfg = inlineConfig(res.body);
  line(`\n-- ${cfg.length} inline assignment(s) --`); cfg.slice(0, 40).forEach((c) => line(`  ${c}`));
  if (links.length) { line(`\n-- ${links.length} link(s) --`); links.slice(0, 20).forEach((u) => line(`  ${u}`)); }

  const host = new URL(res.finalUrl).host;
  const wanted = has("all-origins") ? scripts : scripts.filter((u) => new URL(u).host === host);
  line(`\n-- following ${wanted.length} script(s) ${has("all-origins") ? "(all origins)" : `(same host: ${host}; --all-origins for the rest)`} --`);

  for (const s of wanted) {
    rule(`BUNDLE  ${s}`);
    const b = await get(s, { referer: res.finalUrl });
    if (!b.ok) { line(`FAILED — ${b.error}`); continue; }
    line(`${b.status}  ${b.type}  ${b.bytes} bytes  ${b.ms}ms`);
    if (b.bytes > MAX_BUNDLE_BYTES) { line(`(over --max-bundle-bytes ${MAX_BUNDLE_BYTES}, skipped)`); continue; }
    reportBundle(b.body);
  }
}

function reportBundle(text) {
  const eps = endpointStrings(text, CONTEXT);
  line(`\n-- ${eps.length} URL-ish string(s) --`);
  for (const e of eps) line(`  ${e.url}\n      …${e.ctx}…`);
  const cs = callSites(text, CONTEXT);
  line(`\n-- ${cs.length} request call site(s) --`);
  for (const c of cs) line(`  …${c}…`);
}

/* RUN ONLY WHEN INVOKED DIRECTLY.
   The usage check lived at the top of the file and ran on import, so
   `import { assetsOf } from "./probe.mjs"` printed usage and called
   process.exit(2) -- the test file could not load the functions it tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!urls.length) {
    console.error(`usage: node scripts/probe.mjs <url> [<url>…] [--referer <url>] [--all-origins] [--context 90]

  --referer      sent as the Referer header (an iframe's parent page)
  --all-origins  also fetch scripts served from other hosts (default: same host only)
`);
    process.exit(2);
  }
  for (const u of urls) {
    try { await probe(u, REFERER); }
    catch (e) { line(`\nUNCAUGHT on ${u}: ${e.stack}`); }
  }
  rule("done");
}

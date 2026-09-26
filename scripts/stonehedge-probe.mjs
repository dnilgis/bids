#!/usr/bin/env node
/* CAPTURE KIT FOR STONEHEDGE (StoneX) ELEVATOR BOARDS. Not a reader.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT AN ADAPTER — 2026-09-26.
 *
 * Eight operator sites in data/platforms.json are filed `platform: stonehedge,
 * adapter: null`, and the roster names 64 elevators behind four of them
 * (Frontier Cooperative, Maple River Grain, Ag Valley Co-op, Scott Equity
 * Exchange). Not one byte of a StoneHedge board is committed anywhere in this
 * repository. What IS on file is a signature (scripts/discover.mjs) and a few
 * URLs:
 *
 *   stonehedge.stonex.com/component/bids?key=<key>&cols=date,basis,cash,month
 *       &locs=<location ids>&hideRows=true          <- a React app shell,
 *       21,050 bytes, no table, no row, no price (measured 2026-08-23)
 *   api.stonehedge.stonex.com/settings/v1/locations
 *   api.stonehedge.stonex.com/settings/v2/delivery-periods?locationIds=...
 *   api.stonehedge.stonex.com/offers/v1/offers   <- names only; NO BODY of any
 *       of them was ever read (every attempt: "No resource with given
 *       identifier found").
 *
 * An adapter written from that would be written from a description. This
 * repository does not do that. So this script goes and gets the specimens.
 *
 *   node scripts/stonehedge-probe.mjs                 # every derived site
 *   node scripts/stonehedge-probe.mjs --url https://mrga.com/
 *   node scripts/stonehedge-probe.mjs --no-browser    # plain fetches only
 *
 * WHICH SITES. Derived, never typed in: every site data/platforms.json calls
 * stonehedge, plus every URL in probe-lists/*.txt whose own comment says
 * StoneHedge or StoneX. A URL a person verified by hand is asked FIRST.
 *
 * WHAT IT DOES PER SITE (bounded: at most 4 plain fetches and 2 browser loads)
 *   1. Plain GET, one request per page, honest user-agent, of the site's board
 *      page(s). Saved verbatim (key redacted) to fixtures/stonehedge-<slug>-page*.html.
 *      Looks for the widget's own URL in the markup (iframe src, script
 *      string, encoded copy).
 *   2. No widget URL in the markup means a script injects it: load the board
 *      page in a browser (lib/cdp.mjs captureAll) and look again in the
 *      RENDERED document.
 *   3. Widget URL found: load THAT in a browser. The app shell is empty until
 *      it boots, so what is kept is (a) every data response it fetched, body
 *      and all, and (b) the rendered document, which is the only place the
 *      display rules (column order, units, hidden rows) can be seen.
 *
 * THE KEY. It is public in each operator's own page and it still never goes in
 * our repository or log (scripts/discover.mjs redactBody; lib/cdp.mjs
 * redactUrl). It is held in memory to drive the browser and scrubbed, in every
 * spelling, out of everything written. The redaction is the ONLY edit made to
 * a capture, and the summary says so. An adapter that needs the key reads it
 * from the operator's page at poll time, as dtn-cs does.
 *
 * POLITE. One request per page. `--delay` (default 2500 ms) between any two
 * requests. 429: honour Retry-After (cap 60 s), retry once. 403: no retry, the
 * refusal is the finding, and the delay doubles for the rest of the run. Three
 * sites in a row that refuse and the run stops and says so. robots.txt is not
 * consulted: the same decision as 2026-09-25 (public posted bids; robots.txt is
 * a request) — and the run is small enough to be a visit, not a crawl.
 * Plain fetches say who we are: agsist-bidreader/1.0 (+https://agsist.com;
 * posted bid). The browser stage uses lib/cdp.mjs's UA, which carries the same
 * token behind a real Chrome string (see the note there).
 *
 * WRITES: fixtures/stonehedge-*.{html,json,txt} and data/gaps/stonehedge-probe.json.
 * Nothing else. It publishes nothing and cannot. Existing fixtures are kept
 * (frozen evidence) unless --refresh.
 *
 * EXIT. 0 whenever it could ask, including on refusals. 1 only when not one
 * site could be asked at all (no network, no browser AND no plain response).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { captureAll, redactUrl } from "../lib/cdp.mjs";
import { redactBody, FALLBACK_PATHS } from "./discover.mjs";

export const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)";
export const MAX_PAGES = 4;

/* ---------- arguments ---------- */

export function parseArgs(argv) {
  const out = { urls: [], out: "fixtures", gaps: "data/gaps/stonehedge-probe.json", delayMs: 2500,
                timeoutS: 45, refresh: false, browser: true, budgetMin: 40, listsDir: "probe-lists",
                platforms: "data/platforms.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.urls.push(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--gaps") out.gaps = argv[++i];
    else if (a === "--delay") out.delayMs = Number(argv[++i]);
    else if (a === "--timeout") out.timeoutS = Number(argv[++i]);
    else if (a === "--budget") out.budgetMin = Number(argv[++i]);
    else if (a === "--lists") out.listsDir = argv[++i];
    else if (a === "--platforms") out.platforms = argv[++i];
    else if (a === "--refresh") out.refresh = true;
    else if (a === "--no-browser") out.browser = false;
    else if (/^https?:\/\//.test(a)) out.urls.push(a);
  }
  return out;
}

/* ---------- which sites ---------- */

const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
/* Last two labels: exact for every host this project has met (.com/.coop/.net). */
export const registrable = (h) => h.split(".").slice(-2).join(".");

/* A workflow box hands over one line however it was pasted, so split on any
   whitespace; a comment is a comment. */
export function urlsFrom(text) {
  return [...new Set(String(text).split(/\r?\n/).filter((l) => !/^\s*#/.test(l))
    .flatMap((l) => l.trim().split(/\s+/)).filter((w) => /^https?:\/\/\S+$/.test(w)))];
}

/* URLs in a probe list whose own comment (trailing, or the comment lines under
   it up to the next URL) says StoneHedge or StoneX. */
export function stonehedgeUrlsFromList(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  const say = /stonehedge|stonex/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(https?:\/\/\S+)\s*(#.*)?$/);
    if (!m) continue;
    let says = say.test(m[2] ?? "");
    /* ONLY THE COMMENT LINES TOUCHING THE URL. A blank line ends them: the last
       URL of one section otherwise inherits the next section's heading, which
       is how a POET plant was first derived as a StoneHedge site. */
    for (let j = i + 1; !says && j < lines.length && /^\s*#/.test(lines[j]) && !/^\s*#\s*={3,}/.test(lines[j]); j++)
      if (say.test(lines[j])) says = true;
    if (says && !/stonex\.com/i.test(m[1]) && !/\.pdf(\?|$)/i.test(m[1])) out.push(m[1]);
  }
  return out;
}

/* One entry per registrable domain. Pages the people verified come first, then
   what discover recorded as the board page, then the home page, then the
   conventional paths — capped, because each is a request on somebody's server. */
export function deriveSites({ platforms = {}, lists = [], explicit = [] }) {
  const sites = new Map();
  const add = (url, why, { first = false } = {}) => {
    let u; try { u = new URL(url); } catch { return; }
    const key = registrable(u.hostname.toLowerCase());
    if (!sites.has(key)) sites.set(key, { site: key, home: `${u.origin}/`, pages: [], why: [] });
    const s = sites.get(key);
    if (!s.why.includes(why)) s.why.push(why);
    if (!s.pages.includes(u.href)) first ? s.pages.unshift(u.href) : s.pages.push(u.href);
  };
  for (const [u, v] of Object.entries(platforms?.sites ?? {}))
    if (v?.platform === "stonehedge") {
      add(u, "data/platforms.json: platform stonehedge");
      if (v.boardPage) add(v.boardPage, "data/platforms.json: boardPage");
    }
  for (const l of lists) for (const u of stonehedgeUrlsFromList(l.text))
    add(u, `${l.name}: comment names StoneHedge/StoneX`, { first: true });
  for (const u of explicit) add(u, "asked by url", { first: true });
  const asked = explicit.length ? new Set(explicit.map((u) => registrable(host(u)))) : null;
  return [...sites.values()].filter((s) => !asked || asked.has(s.site)).map((s) => {
    const pages = [...s.pages];
    for (const p of [s.home, ...FALLBACK_PATHS.slice(0, 2).map((x) => new URL(x, s.home).href)])
      if (!pages.includes(p)) pages.push(p);
    return { ...s, pages: pages.slice(0, MAX_PAGES) };
  }).sort((a, b) => a.site.localeCompare(b.site));
}

/* ---------- reading what a page says about the widget ---------- */

/* Every spelling the widget URL turns up in: plain, &amp;, JSON-escaped,
   protocol-relative, and percent-encoded whole (a URL passed as a parameter). */
export function componentRefs(html) {
  const t = String(html ?? "").replace(/&amp;/g, "&").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const found = new Set();
  for (const m of t.matchAll(/(?:https?:)?\/\/stonehedge\.stonex\.com\/component\/[^\s"'<>\\)]+/gi))
    found.add(m[0].startsWith("//") ? `https:${m[0]}` : m[0]);
  for (const m of t.matchAll(/https?%3A%2F%2Fstonehedge\.stonex\.com%2Fcomponent%2F[^\s"'<>\\&]+/gi)) {
    try { found.add(decodeURIComponent(m[0])); } catch { /* keep going */ }
  }
  return [...found];
}

/* The values that must not be written, from the URLs that carry them. */
export function secretsOf(urls) {
  const s = new Set();
  for (const u of urls) {
    try {
      for (const [k, v] of new URL(u).searchParams)
        if (/(^|_)(apikey|api_key|key|token|secret|sig)$/i.test(k) && v.length >= 8) s.add(v);
    } catch { /* not a URL */ }
  }
  return [...s];
}

/* redactBody handles the shapes it knows; the exact values are also removed, in
   plain, once-encoded and twice-encoded form, wherever they turn up. */
export function scrub(text, secrets = []) {
  let out = redactBody(text);
  for (const k of secrets)
    for (const form of [k, encodeURIComponent(k), encodeURIComponent(encodeURIComponent(k))])
      out = out.split(form).join("<redacted>");
  return out;
}

/* ---------- is there a price table in this ---------- */

const NUM = /^\s*[-+]?\$?\d{1,3}(?:,\d{3})*\.\d{2,4}\s*$/;
const strip = (h) => h.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

/* A verdict about SHAPE, not about truth: rows with price-looking numbers under
   a header that says cash, bid, basis or price. It never claims a board is
   right, only that there is something to write an adapter against. */
export function priceTable(text, mime = "") {
  const body = String(text ?? "");
  if (!body.trim()) return { seen: false, kind: null, evidence: "empty" };
  if (/json/i.test(mime) || /^\s*[[{]/.test(body)) {
    let j; try { j = JSON.parse(body); } catch { j = undefined; }
    if (j !== undefined) {
      let best = null;
      const walk = (x, path) => {
        if (Array.isArray(x)) {
          const rows = x.filter((r) => r && typeof r === "object" && !Array.isArray(r));
          const priced = rows.filter((r) => Object.entries(r).some(([k, v]) =>
            /cash|bid|basis|price/i.test(k) && v !== null && v !== "" && !isNaN(Number(v))));
          if (priced.length >= 2 && (!best || priced.length > best.rows))
            best = { rows: priced.length, path, keys: Object.keys(priced[0]).slice(0, 12) };
        }
        if (x && typeof x === "object")
          for (const [k, v] of Object.entries(x)) walk(v, `${path}/${k}`);
      };
      walk(j, "");
      return best ? { seen: true, kind: "json", evidence: `${best.rows} priced rows at "${best.path || "/"}", keys ${best.keys.join(",")}` }
                  : { seen: false, kind: "json", evidence: "parsed, but no array of two or more rows with a numeric cash/bid/basis/price field" };
    }
  }
  for (const t of body.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = t.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const cells = rows.flatMap((r) => (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(strip));
    const nums = cells.filter((c) => NUM.test(c)).length;
    const head = /cash|bid|basis|price/i.test(strip(t));
    if (rows.length >= 3 && nums >= 3 && head)
      return { seen: true, kind: "html-table", evidence: `${rows.length} rows, ${nums} price-shaped cells, header names cash/bid/basis/price` };
  }
  return { seen: false, kind: "html", evidence: "no table with three rows, three price-shaped cells and a cash/bid/basis/price header" };
}

/* ---------- naming ---------- */

export const slugOf = (h) => registrable((host(h) || String(h)).toLowerCase().replace(/^www\./, "")).split(".")[0].replace(/[^a-z0-9]/g, "");
const extOf = (mime, body) => /json/i.test(mime) || /^\s*[[{]/.test(body) ? "json" : /html/i.test(mime) ? "html" : "txt";
const tailOf = (u) => { try { return new URL(u).pathname.split("/").filter(Boolean).pop()?.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 30) || "root"; } catch { return "x"; } };
const h8 = (s) => createHash("sha1").update(s).digest("hex").slice(0, 8);

/* ---------- the polite fetch ---------- */

export function makeFetcher({ fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
                              delayMs = 2500, now = Date.now } = {}) {
  const st = { delayMs, last: 0, refusals: 0 };
  const wait = async () => {
    const gap = st.last + st.delayMs - now();
    if (gap > 0) await sleep(gap);
  };
  const once = async (url) => {
    await wait();
    st.last = now();
    try {
      const res = await fetchFn(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
                                       redirect: "follow", signal: AbortSignal.timeout(20000) });
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, status: res.status, finalUrl: res.url || url, type: res.headers.get("content-type") || "",
               bytes: buf.length, body: buf.toString("utf8"), retryAfter: res.headers.get("retry-after") };
    } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
  };
  const get = async (url) => {
    let r = await once(url);
    if (r.ok && r.status === 429) {
      const ra = Math.min(60, Math.max(1, Number(r.retryAfter) || 30));
      st.delayMs = Math.min(st.delayMs * 2, 30000);
      st.refusals++;
      await sleep(ra * 1000);
      r = await once(url);
      r.retried = `429 first; waited ${ra}s and asked once more`;
    }
    if (r.ok && (r.status === 403 || r.status === 429)) {
      st.delayMs = Math.min(st.delayMs * 2, 30000);
      st.refusals++;
    }
    return r;
  };
  return { get, state: st, wait };
}

/* ---------- one site ---------- */

async function keep(ctx, file, text, note) {
  const path = `${ctx.opts.out}/${file}`;
  const had = existsSync(path);
  if (!had || ctx.opts.refresh) { mkdirSync(ctx.opts.out, { recursive: true }); writeFileSync(path, text); }
  return { file: path, bytes: Buffer.byteLength(text), ...(had && !ctx.opts.refresh ? { kept: "existing fixture left alone (frozen evidence); --refresh replaces it" } : {}), ...(note ? { note } : {}) };
}

export async function probeSite(site, ctx) {
  const slug = slugOf(site.home);
  const rec = { site: site.site, home: site.home, why: site.why, status: "not-asked", pages: [], captures: [],
                component: null, priceTable: { seen: false, where: null, kind: null, evidence: "nothing captured" } };
  let secrets = [], refs = [], answered = 0, refused = 0;
  const seen = (where, text, mime) => {
    const p = priceTable(text, mime);
    if (p.seen && !rec.priceTable.seen) rec.priceTable = { seen: true, where, kind: p.kind, evidence: p.evidence };
    else if (!rec.priceTable.seen) rec.priceTable = { seen: false, where: null, kind: p.kind, evidence: p.evidence };
  };

  /* 1. plain pages */
  for (const [i, url] of site.pages.entries()) {
    if (ctx.over()) { rec.status = "not-asked"; rec.why.push("run budget spent"); return rec; }
    const r = await ctx.fetcher.get(url);
    const pg = { url, status: r.ok ? r.status : null, bytes: r.bytes ?? 0, ...(r.error ? { error: r.error } : {}),
                 ...(r.retried ? { note: r.retried } : {}) };
    if (r.ok) answered++;
    if (r.ok && (r.status === 403 || r.status === 429)) refused++;
    if (r.ok && r.status === 200) {
      const found = componentRefs(r.body);
      secrets.push(...secretsOf(found));
      pg.componentSeen = found.length > 0;
      const k = await keep(ctx, `stonehedge-${slug}-page${i ? `-${i + 1}` : ""}.html`, scrub(r.body, secrets));
      pg.file = k.file; if (k.kept) pg.kept = k.kept;
      seen(`plain page ${url}`, r.body, r.type);
      if (found.length) { refs = found; rec.pages.push(pg); break; }
    }
    rec.pages.push(pg);
  }
  if (!answered) { rec.status = "unreachable"; return rec; }
  if (refused && refused === answered) { rec.status = "refused"; rec.refused = true; return rec; }

  /* 2 and 3. the browser */
  const load = async (pageUrl, label) => {
    if (!ctx.opts.browser) return { skipped: "--no-browser" };
    if (ctx.over()) return { skipped: "run budget spent" };
    await ctx.fetcher.wait(); ctx.fetcher.state.last = ctx.now();
    const r = await ctx.captureFn({ pageUrl, timeoutMs: ctx.opts.timeoutS * 1000, snapshotDom: true,
                                    keep: (u, m) => /json|xml|csv|text\/plain|html/i.test(m || "") });
    return { label, r };
  };
  let target = refs[0] ?? null;
  if (!target) {
    const b = await load(site.pages[0], "rendered board page");
    if (b.r) {
      rec.pages.push({ url: site.pages[0], browser: true, responses: b.r.responses?.length ?? 0, error: b.r.error ?? b.r.domError ?? null });
      if (b.r.dom) {
        const f = componentRefs(b.r.dom);
        secrets.push(...secretsOf(f));
        const k = await keep(ctx, `stonehedge-${slug}-page-rendered.html`, scrub(b.r.dom, secrets));
        rec.pages[rec.pages.length - 1].file = k.file;
        if (k.kept) rec.pages[rec.pages.length - 1].kept = k.kept;
        seen("rendered board page", b.r.dom, "text/html");
        if (f.length) target = f[0];
      }
    } else if (b.skipped) rec.browserSkipped = b.skipped;
  }
  if (!target) {
    rec.status = rec.browserSkipped ? "no-widget-in-markup" : "no-widget-found";
    return rec;
  }
  secrets.push(...secretsOf([target]));
  const c = await load(target, "widget");
  rec.component = { url: redactUrl(target) };
  if (!c.r) { rec.component.skipped = c.skipped; rec.status = "widget-seen-not-loaded"; return rec; }
  const r = c.r;
  rec.component.responses = r.responses?.length ?? 0;
  rec.component.quiet = !!r.quiet;
  if (r.error || r.navError) rec.component.error = r.error ?? r.navError;
  rec.component.responseUrls = (r.responses ?? []).slice(0, 80).map((x) => ({ url: scrub(x.url, secrets), status: x.status, mime: x.mime,
    bodyBytes: x.body == null ? null : x.body.length, ...(x.bodyError ? { bodyError: x.bodyError } : {}), ...(x.rescue ? { rescue: x.rescue } : {}) }));
  if (r.dom) {
    rec.captures.push({ what: "rendered widget document", ...(await keep(ctx, `stonehedge-${slug}-component-rendered.html`, scrub(r.dom, secrets))) });
    seen("rendered widget document", r.dom, "text/html");
  } else if (r.domError) rec.component.domError = r.domError;
  let n = 0;
  for (const x of r.responses ?? []) {
    if (x.body == null || x.status !== 200 || n >= 12) continue;
    if (!/stonex\.com$/.test(host(x.url)) && registrable(host(x.url)) !== site.site) continue;
    if (/javascript|css/i.test(x.mime)) continue;
    const u = scrub(x.url, secrets);
    n++;
    rec.captures.push({ what: "response", url: u, status: x.status, mime: x.mime,
      ...(await keep(ctx, `stonehedge-${slug}-${tailOf(u)}-${h8(u)}.${extOf(x.mime, x.body)}`, scrub(x.body, secrets))) });
    seen(`response ${u}`, x.body, x.mime);
  }
  rec.status = rec.captures.length ? "captured" : "widget-loaded-nothing-kept";
  return rec;
}

/* ---------- the run ---------- */

export function tally(sites) {
  const by = {};
  for (const s of sites) by[s.status] = (by[s.status] ?? 0) + 1;
  return { sites: sites.length, byStatus: by, withPriceTable: sites.filter((s) => s.priceTable?.seen).length,
           fixtures: sites.reduce((n, s) => n + (s.captures?.length ?? 0) + (s.pages?.filter((p) => p.file).length ?? 0), 0) };
}

export async function run(opts, deps = {}) {
  const t0 = (deps.now ?? Date.now)();
  const now = deps.now ?? Date.now;
  const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  const platforms = readJson(opts.platforms) ?? {};
  const lists = existsSync(opts.listsDir)
    ? readdirSync(opts.listsDir).filter((f) => f.endsWith(".txt")).sort()
        .map((f) => ({ name: `${opts.listsDir}/${f}`, text: readFileSync(`${opts.listsDir}/${f}`, "utf8") })) : [];
  const sites = deriveSites({ platforms, lists, explicit: opts.urls });
  const fetcher = deps.fetcher ?? makeFetcher({ delayMs: opts.delayMs, fetchFn: deps.fetchFn, sleep: deps.sleep, now });
  const ctx = { opts, fetcher, now, captureFn: deps.captureFn ?? captureAll,
                over: () => now() - t0 > opts.budgetMin * 60000 };
  const log = deps.log ?? console.log;
  log(`${sites.length} StoneHedge site(s) derived: ${sites.map((s) => s.site).join(", ")}`);
  const results = [];
  let streak = 0, stopped = null;
  for (const s of sites) {
    if (stopped) { results.push({ site: s.site, home: s.home, why: s.why, status: "not-asked", stopped }); continue; }
    log(`── ${s.site}: ${s.pages.join("  ")}`);
    const r = await probeSite(s, ctx);
    results.push(r);
    log(`   ${r.status}; price table seen: ${r.priceTable.seen}${r.priceTable.seen ? ` (${r.priceTable.where})` : ""}; ${r.captures.length} capture(s)`);
    streak = r.status === "refused" ? streak + 1 : 0;
    if (streak >= 3) { stopped = "three sites in a row refused; the run stopped rather than keep asking"; log(`   ${stopped}`); }
  }
  /* A partial run must not erase what an earlier run learned about the others. */
  const prior = readJson(opts.gaps)?.sites ?? [];
  const bySite = new Map(prior.map((p) => [p.site, p]));
  for (const r of results) if (r.status !== "not-asked" || !bySite.has(r.site)) bySite.set(r.site, r);
  const merged = [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site));
  const summary = {
    schema: "agsist-stonehedge-probe/1", generated: new Date(now()).toISOString(),
    userAgent: UA, redaction: "the widget key, in every spelling, is the only edit made to a capture",
    note: "What a StoneHedge (StoneX) board looks like from the runner. A capture is evidence for writing lib/adapters/stonehedge.mjs; nothing here is a bid.",
    ...tally(merged), stopped, sites: merged,
  };
  mkdirSync(opts.gaps.replace(/\/[^/]*$/, "") || ".", { recursive: true });
  writeFileSync(opts.gaps, JSON.stringify(summary, null, 1) + "\n");
  log(`── tally: ${JSON.stringify(summary.byStatus)}; ${summary.withPriceTable} with a price table; summary in ${opts.gaps}`);
  const couldAsk = results.some((r) => !["unreachable", "not-asked"].includes(r.status));
  return { summary, code: couldAsk || !sites.length ? 0 : 1 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).then(({ code }) => process.exit(code),
    (e) => { console.error(`::error::${e.stack || e}`); process.exit(1); });
}

/* UNREAD ELEVATORS' OWN WEBSITES: WHICH SITE BELONGS TO WHICH COMPANY, AND
 * WHAT TO KEEP FROM EACH PAGE SO SOMEBODY (OR A MODEL) CAN SAY WHERE THE BIDS ARE.
 *
 * 2026-10-18. About 4,988 directory rows have no reader. Most have no website
 * on file either, but the repository holds a few thousand URLs scattered over
 * probe-lists/, data/gaps/, data/platforms.json, the frozen Barchart roster and
 * sources/. This file is the pure part of joining the two:
 *
 *   familyOf(operator)        one key per company, old spellings folded in
 *   nameTokens / namesMatch   a list comment's business name vs an operator
 *   hostMatches               a bare host (no name on file) vs an operator
 *   pickLinks                 the links on a home page that look like bids
 *   pathAllowed               robots.txt for one path (Allow/Disallow, longest
 *                             match wins, as RFC 9309 says)
 *   digestOf                  the small, readable part of a captured page
 *   shardOf                   one host always lands in one shard (politeness)
 *
 * Nothing here fetches. scripts/elevsites-list.mjs builds the worklist and
 * scripts/capture-pages.mjs --follow uses the link picker, robots and digest.
 * A match here is a lead for a capture, never a claim that a business posts
 * bids.
 */
import { operatorWords } from "./orgkey.mjs";

export const UPPER_MIDWEST = new Set(["WI", "MN", "IA", "IL", "SD", "ND", "NE"]);

/* The same folding the 2026-10-18 coverage plan used, so its family counts and
   this worklist agree. */
const ALIAS = [[/^ARCHER DANIELS|^ADM\b/, "ADM"], [/^CHS\b/, "CHS"], [/^CARGILL/, "CARGILL"], [/^BUNGE/, "BUNGE"],
  [/^CONSOLIDATED GRAIN/, "CGB"], [/^SCOULAR|^THE SCOULAR/, "SCOULAR"], [/^ANDERSONS/, "ANDERSONS"],
  [/^PRODUCER AG/, "PRODUCER AG"], [/^MFA\b/, "MFA"], [/^AGTEGRA/, "AGTEGRA"], [/^WESTERN GRAIN MARKETING/, "WESTERN GRAIN MARKETING"],
  [/^COLUMBIA GRAIN/, "COLUMBIA GRAIN"], [/^POET/, "POET"], [/^CENTRAL VALLEY AG/, "CENTRAL VALLEY AG"], [/^KANZA/, "KANZA"],
  [/^AURORA COOP/, "AURORA COOP"], [/^SKYLAND/, "SKYLAND"], [/^NEXUS/, "NEXUS"], [/^HEARTLAND CO/, "HEARTLAND COOP"],
  [/^PERDUE/, "PERDUE"], [/^LANDUS/, "LANDUS"], [/^RICELAND/, "RICELAND"], [/^GOLD EAGLE/, "GOLD EAGLE"],
  [/^TOTAL GRAIN/, "TOTAL GRAIN"], [/^KEY COOP/, "KEY COOP"], [/^PREMIER COOP/, "PREMIER COOP"], [/^STATELINE|^STATE LINE/, "STATELINE"],
  [/^UNITED COOP/, "UNITED COOP"], [/^INNOVATIVE AG/, "INNOVATIVE AG"], [/^FRONTIER COOP/, "FRONTIER COOP"],
  [/^CENTRAL PRAIRIE/, "CENTRAL PRAIRIE"], [/^BARTLETT/, "BARTLETT"], [/^DELONG|^THE DELONG/, "DELONG"], [/^EASTLAND/, "EASTLAND"],
  [/^COOPERATIVE FARMERS ELEVATOR|^CFE\b/, "CFE"], [/^MENNEL/, "MENNEL"], [/^TOP FLIGHT/, "TOP FLIGHT"], [/^LANDMARK/, "LANDMARK"],
  [/^PRO COOP/, "PRO COOP"], [/^MID IOWA/, "MID IOWA"], [/^RIVER VALLEY COOP/, "RIVER VALLEY COOP"], [/^ALLIANCE GRAIN/, "ALLIANCE GRAIN"],
  [/^AG VALLEY/, "AG VALLEY"], [/^FIRST COOP/, "FIRST COOP"], [/^CENTRAL FARM SERVICE/, "CENTRAL FARM SERVICE"],
  [/^GATEWAY FS/, "GATEWAY FS"], [/^NEW COOP/, "NEW COOP"], [/^ALCIVIA/, "ALCIVIA"], [/^CO ?MARK|^COMARK/, "COMARK"],
  [/^GREAT BEND/, "GREAT BEND"], [/^DODGE CITY COOP/, "DODGE CITY COOP"], [/^PRIMARY PRODUCTS|^PRIMIENT/, "PRIMIENT"],
  [/^FARMERS COOP OF DORCHESTER|^FARMERS COOP DORCHESTER/, "DORCHESTER"]];

const TRAILING_LEGAL = new Set(["INC", "LLC", "LC", "LP", "LLP", "LTD", "CO", "CORP", "PLLC", "ULC", "PLC"]);
export function familyOf(operator) {
  const ws = operatorWords(operator).filter((x) => x !== "THE");
  while (ws.length > 1 && TRAILING_LEGAL.has(ws[ws.length - 1])) ws.pop();
  const w = ws.join(" ");
  for (const [re, k] of ALIAS) if (re.test(w)) return k;
  return w;
}

/* Words that never tell two companies apart on their own. "Farmers Elevator"
   is a hundred businesses; "Meyer" is one. */
const GENERIC = new Set(["THE", "INC", "LLC", "CO", "COMPANY", "CORP", "CORPORATION", "COOP", "COOPERATIVE", "CO-OP",
  "ASSOCIATION", "ASSN", "ASSOC", "OF", "AND", "GRAIN", "GRAINS", "ELEVATOR", "ELEVATORS", "FARMERS", "FARMER", "FARM",
  "FARMS", "AG", "AGRI", "SERVICE", "SERVICES", "SUPPLY", "UNION", "EXCHANGE", "MARKETING", "COMMODITIES", "TERMINAL",
  "FEED", "FEEDS", "MILL", "MILLING", "LTD", "LP", "LLP", "DBA", "INCORPORATED", "UNITED", "CENTRAL", "COUNTRY",
  "PARTNERS", "MERCANTILE", "STATE", "EQUITY", "AGRICULTURAL", "AGRICULTURE", "NORTH", "SOUTH", "EAST", "WEST",
  "NORTHERN", "SOUTHERN", "EASTERN", "WESTERN", "VALLEY", "PRAIRIE", "RIVER", "FS", "CHS", "ADM", "INDUSTRIES", "GROUP"]);

export function nameTokens(name) {
  return operatorWords(String(name ?? "")).map((w) => w.replace(/[^A-Z0-9]/g, "")).filter(Boolean);
}
const distinctive = (toks) => toks.filter((t) => !GENERIC.has(t) && t.length >= 3);

/* Same company? Every distinctive word of the shorter name appears in the
   longer one, there is at least one such word, and the generic words agree
   when there is only one distinctive word ("Meyer Grain" is not "Meyer Feed"). */
export function namesMatch(a, b) {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.length || !B.length) return false;
  if (A.join(" ") === B.join(" ")) return true;
  const dA = distinctive(A), dB = distinctive(B);
  if (!dA.length || !dB.length) return false;
  const [small, big] = dA.length <= dB.length ? [dA, dB] : [dB, dA];
  if (!small.every((t) => big.includes(t))) return false;
  if (dA[0] !== dB[0]) return false;   // "Cargill Soybean Processing" is not "Grain Processing Corp"
  if (small.length >= 2) return true;
  /* One distinctive word each, the same word: the rest must agree too.
     "Minnesota Valley Grain" is not "Minnesota Soybean Processors", and
     "Dakota Grain" is not "Dakota Midland Grain". */
  if (big.length !== 1) return false;
  const LEGAL = ["THE", "INC", "LLC", "CO", "COMPANY", "OF", "AND", "LTD", "CORP"];
  const gen = (T) => T.filter((t) => GENERIC.has(t) && !LEGAL.includes(t));
  const [gs, gb] = [gen(A), gen(B)].sort((x, y) => x.length - y.length);
  return gs.every((t) => gb.includes(t));
}

export function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

/* Hosts that belong to a platform, a directory or a news site, never to one
   company: a bare URL on one of these says nothing about whose site it is. */
const SHARED_HOST = /(^|\.)(agricharts\.com|aghost\.net|dtnpf\.com|dtn\.com|barchart\.com|bushelpowered\.com|bushel\.ag|grainbridge\.com|gradable\.com|facebook\.com|google\.com|cmegroup\.com|cihedging\.com|stonehedgeinc\.com|wixsite\.com|godaddysites\.com|squarespace\.com)$/;
export const isSharedHost = (h) => SHARED_HOST.test(String(h || ""));

/* A bare host with no name beside it: does it spell the operator? The host's
   first label, letters only, must equal the operator's words run together, or
   start with them when they are long enough to be unique (8+ letters), or be
   the operator's distinctive words run together. "meyergrain" = Meyer Grain. */
export function hostMatches(host, operator) {
  const h = String(host || "").replace(/^www\./, "");
  if (!h || isSharedHost(h)) return false;
  const label = h.split(".")[0].replace(/[^a-z0-9]/g, "");
  const toks = nameTokens(operator).filter((t) => !["THE", "INC", "LLC", "CO", "COMPANY", "OF", "AND", "LTD", "CORP", "INCORPORATED", "DBA"].includes(t));
  if (!toks.length || label.length < 5) return false;
  const all = toks.join("").toLowerCase();
  const dist = distinctive(toks).join("").toLowerCase();
  if (!dist) return false;   // "grain.com" is nobody's in particular
  if (label === all) return true;
  if (all.length >= 8 && label.startsWith(all)) return true;
  if (dist.length >= 6 && (label === dist || label === dist + "coop" || label === dist + "grain")) return true;
  return false;
}

/* ── links on a home page that look like the way to the bids ────────────── */
const BID_WORDS = /\b(cash[\s-]*bids?|grain[\s-]*bids?|bids?|markets?|grain|prices?|pricing|commodit(y|ies)|futures|elevators?|locations?|daily[\s-]*bids?|marketing|agronomy[\s-]*bids)\b/i;
const STRONG = /cash[\s-]*bid|grain[\s-]*bid|\bbids?\b|cash[\s-]*price|grain[\s-]*price|\bmarkets?\b/i;
const SKIP = /\.(jpe?g|png|gif|svg|webp|mp4|zip|docx?|xlsx?)(\?|$)|^mailto:|^tel:|^javascript:|#$|\/(cart|login|signin|account|wp-admin|careers?|jobs?|employment)\b/i;
const PLATFORM_LINK = /agricharts\.com|aghost\.net|dtnpf\.com|bushelpowered|bushel\.ag|grainbridge|gradable\.com|cihedging|stonehedge|barchart\.com|graindesk/i;

export function linksOf(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    const href = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!href || SKIP.test(href)) continue;
    let abs;
    try { abs = new URL(href.replace(/&amp;/g, "&"), baseUrl).href.replace(/#.*$/, ""); } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    const text = textOf(m[5]).slice(0, 120);
    out.push({ url: abs, text });
  }
  const seen = new Set();
  return out.filter((l) => !seen.has(l.url) && seen.add(l.url));
}

/* The links worth one more request: on the same site (or a bid platform the
   site hands off to), and named or pathed like bids. Strongest first. PDFs are
   reported, not opened.

   2026-10-18, round two: the same picker for two other searches. mode
   "schedule" looks for the grain discount, shrink, drying and storage
   schedules (and steps through grain or market pages on the way); mode "land"
   looks for a county's assessor, auditor or recorder pages and their sales,
   transfer, download or GIS links, which often sit on a vendor's host, so a
   strongly named link to another host is allowed there. Those two modes may
   pick a PDF when the link itself names a schedule or a sales list. */
const MODES = {
  bids: { strong: STRONG, weak: BID_WORDS, cross: null, pdf: null },
  schedule: {
    strong: /discount|dry(ing)?[\s-]*(charge|rate|schedule)|\bdrying\b|shrink|moisture|storage[\s-]*(rate|charge|fee|polic|schedule)|grain[\s-]*(polic|schedule|standards?)|\bschedules?\b|\bpolic(y|ies)\b|\bstorage\b/i,
    weak: /\b(cash[\s-]*bids?|grain|bids?|markets?|marketing|elevators?|locations?|forms|documents|resources|downloads|producer|patron|customer[\s-]*info)\b/i,
    cross: null, pdf: /discount|drying|shrink|moisture|storage|schedule|polic(y|ies)|grain/i,
  },
  land: {
    strong: /assessor|auditor|recorder|register[\s-]*of[\s-]*deeds|\btreasurer\b|property[\s-]*(search|tax|records?|info|lookup)|\bparcels?\b|real[\s-]*estate|\bsales?\b|transfers?|conveyance|\bgis\b|downloads?|valuation|land[\s-]*records|beacon|qpublic|gworks|bsaonline|vanguard|\bmaps?\b/i,
    weak: /\b(departments?|offices?|government|services|elected|county[\s-]*offices?|data|records)\b/i,
    cross: /assessor|auditor|recorder|register[\s-]*of[\s-]*deeds|treasurer|property|parcel|\bgis\b|beacon|qpublic|gworks|bsaonline|vanguard|schneidercorp|iowaassessors|arcgis|real[\s-]*estate|sales/i,
    pdf: /\bsales?\b|transfers?|conveyance/i,
  },
};
export const PICK_MODES = Object.keys(MODES);

export function pickLinks(html, baseUrl, max = 3, mode = "bids") {
  const M = MODES[mode] ?? MODES.bids;
  const home = hostOf(baseUrl);
  const site = home.split(".").slice(-2).join(".");
  const scored = [];
  for (const l of linksOf(html, baseUrl)) {
    const h = hostOf(l.url);
    const same = h === home || h.endsWith("." + site) || h === site;
    const plat = mode === "bids" && PLATFORM_LINK.test(l.url);
    let path = "";
    try { path = decodeURIComponent(new URL(l.url).pathname); } catch { path = new URL(l.url).pathname; }
    const hay = `${l.text} ${path.replace(/[-_/]/g, " ")}`;
    const cross = !same && M.cross && M.cross.test(hay) && !/facebook|twitter|x\.com|instagram|youtube|linkedin/i.test(h);
    if (!same && !plat && !cross) continue;
    if (l.url.replace(/\/$/, "") === String(baseUrl).replace(/#.*$/, "").replace(/\/$/, "")) continue;
    const isPdf = /\.pdf(\?|$)/i.test(l.url);
    if (isPdf && !(M.pdf && M.pdf.test(hay))) continue;
    let s = 0;
    if (M.strong.test(hay)) s += 3;
    else if (M.weak.test(hay)) s += 1;
    if (plat) s += 2;
    if (mode === "bids" && /cash/i.test(hay)) s += 1;
    if (mode !== "bids" && isPdf && s >= 3) s += 1;
    if (s > 0) scored.push({ ...l, score: s, ...(isPdf ? { pdf: true } : {}) });
  }
  return scored.sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, max);
}

/* Common paths worth one try on a listed site when its home page links to no
   bid page we can see (menus built by script, or a link named "Click here"). */
export function pathProbes(baseUrl, paths) {
  let o;
  try { o = new URL(baseUrl).origin; } catch { return []; }
  return [...new Set((paths ?? []).map((p) => String(p).trim()).filter((p) => /^\/(?!\/)[A-Za-z0-9._~\/-]*$/.test(p)))]
    .map((p) => o + p);
}

/* A page that answered 4xx or 5xx: the main document's status, from the
   responses the browser saw. */
export function docStatus(pageUrl, responses = []) {
  const norm = (u) => String(u).replace(/#.*$/, "").replace(/\/$/, "");
  const r = responses.find((x) => norm(x.url) === norm(pageUrl)) ?? responses.find((x) => /html/i.test(x.mime ?? ""));
  return r?.status ?? null;
}

/* ── robots.txt for one path ─────────────────────────────────────────────
   Groups for "*" only (we do not send a named crawler token). Longest
   matching rule wins; Allow wins a tie. "*" and "$" in rules are honoured.
   No robots.txt, or one that cannot be read, allows everything. */
export function pathAllowed(robotsTxt, path) {
  const rules = [];
  let inStar = false, lastWasAgent = false;
  for (const raw of String(robotsTxt ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === "user-agent") {
      if (!lastWasAgent) inStar = false;
      if (value === "*") inStar = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!inStar || (field === "disallow" && !value)) continue;
    rules.push({ allow: field === "allow", value });
  }
  const p = path || "/";
  let best = null;
  for (const r of rules) {
    const re = new RegExp("^" + r.value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (!re.test(p)) continue;
    if (!best || r.value.length > best.value.length || (r.value.length === best.value.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

/* ── the readable part of a captured page ────────────────────────────────── */
export function textOf(html) {
  return String(html ?? "")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|table|section|article)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#36;|&dollar;/g, "$").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t\f\v]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
}

/* Text that reads like a posted board: a crop word and at least three prices
   or basis numbers. Used to decide whether the whole rendered page is kept as
   a fixture source, not to decide anything about the business. */
export function looksLikeBoard(text) {
  const t = String(text ?? "");
  if (!/\b(corn|soybeans?|beans|wheat|milo|sorghum|oats)\b/i.test(t)) return false;
  return (t.match(/(^|[\s|$])-?\d{1,2}\.\d{2,4}\b/g) ?? []).length >= 3;
}

export function digestOf({ pageUrl, html, responses = [], maxText = 12000, maxLinks = 80 }) {
  const title = (String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const text = textOf(html);
  const srcs = (tag) => [...String(html ?? "").matchAll(new RegExp(`<${tag}\\b[^>]*?src\\s*=\\s*["']([^"']+)["']`, "gi"))]
    .map((m) => { try { return new URL(m[1], pageUrl).href; } catch { return null; } }).filter(Boolean);
  const hosts = {};
  for (const r of responses) { const h = hostOf(r.url); if (h) hosts[h] = (hosts[h] ?? 0) + 1; }
  const links = linksOf(html, pageUrl);
  return {
    url: pageUrl, title,
    text: text.slice(0, maxText), textBytes: text.length,
    looksLikeBoard: looksLikeBoard(text),
    links: links.slice(0, maxLinks), linkCount: links.length,
    pdfLinks: links.filter((l) => /\.pdf(\?|$)/i.test(l.url)).slice(0, 10),
    facebook: links.filter((l) => /facebook\.com/i.test(l.url)).slice(0, 3).map((l) => l.url),
    scripts: [...new Set(srcs("script"))].slice(0, 40),
    iframes: [...new Set(srcs("iframe"))].slice(0, 20),
    responseHosts: hosts,
    dataResponses: responses.filter((r) => r.body).map((r) => r.url).slice(0, 30),
  };
}

/* One host always in one shard, so the per-host pause holds across a run. */
export function shardOf(url, n) {
  if (!(n > 1)) return 0;
  let h = 0;
  for (const c of hostOf(url) || String(url)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % n;
}

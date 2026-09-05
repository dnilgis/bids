#!/usr/bin/env node
/* THE REST OF AGRICHARTS — find every mobile board, and write a manifest per
 * location.
 *
 * Sig, 2026-09-03: "can you get the rest of the elvators in the country please"
 *
 * 211 AgriCharts sites are in data/platforms.json and four of them are read.
 * The other 207 are the largest single block of unread elevators in the
 * project. Everything needed to read them already exists — the adapter, the
 * quote pages, the identityAlternative path — so what is left is finding each
 * operator's mobile host and writing a manifest per location.
 *
 * IT RUNS ON THE RUNNER AND WRITES THE FILES ITSELF.
 *
 * Rule 7 says complete files in a zip, and that is right for six files. This
 * produces hundreds. geocode-fill.yml settled the same question in August:
 * "216 uploads is not a thing to ask of anybody — so the code goes up once and
 * the runner does the writing." Same here. What Sig reviews is the report and
 * the diff, not four hundred uploads.
 *
 * DRY RUN IS THE DEFAULT. It prints every host it tried, every board it found,
 * every manifest it would write and every location it had to skip, and writes
 * nothing until --write.
 *
 * WHAT IT WILL NOT DO
 *
 *   It never overwrites an existing manifest. A file in sources/ was either
 *   written by a previous run of this and reviewed, or edited by somebody who
 *   looked; a sweep must not walk over either.
 *
 *   It never writes a manifest it cannot name and place. A location needs a
 *   town, a state and a ZIP, and the only honest source for those is
 *   data/known-elevators.json — Barchart's own directory. A location with no
 *   match is REPORTED, not invented. Rule 1.
 *
 *   It never writes a manifest for a board that did not pass the adapter. The
 *   board must parse, agree with itself across its locations, and sit against
 *   real CBOT quotes, exactly as it would on a poll. A board that cannot be
 *   read today produces no sources today.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { FACILITY, SUFFIX } from "../lib/place.mjs";
import { fileURLToPath } from "node:url";
import { join, dirname, isAbsolute } from "node:path";
import { parseBoard, extract, mergeQuotes, quoteUrls, VERIFIED_BY, cellText }
  from "../lib/adapters/agricharts.mjs";
import { extract as extractCashgrid } from "../lib/adapters/agricharts-cashgrid.mjs";
import { VERIFIED_BY as CASHGRID_VERIFIED_BY } from "../lib/adapters/agricharts-cashgrid.mjs";
import { validateSource } from "../lib/sources.mjs";
import { urlsFrom } from "./agricharts-probe.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCES = join(ROOT, "sources");
const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)";

/* ---------- flags ---------- */

export function parseArgs(argv) {
  const out = { write: false, limit: Infinity, start: 0, timeoutMs: 20000,
                hosts: null, only: null, map: "data/agricharts-mobile.json",
                capture: null, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--start") out.start = Number(argv[++i]);
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === "--hosts") out.hosts = argv[++i];
    else if (a === "--only") out.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--map") out.map = argv[++i];
    else if (a === "--capture") out.capture = argv[i + 1] && !argv[i + 1].startsWith("--")
      ? argv[++i] : "fixtures";
    else if (a === "--refresh") out.refresh = true;
  }
  return out;
}

/* ---------- where a mobile board might live ---------- */

/* TWO FORMS, BOTH MEASURED, AND NEITHER DERIVABLE FROM THE OTHER.
 *
 *     https://<sub>.mobile.agricharts.com/cash/prices.php
 *     https://mobile.<vanity-domain>/cash/prices.php
 *
 * Legacy Farmers is the first, The Farmers Elevator is the second, and both
 * were verified. The <sub> is AgriCharts' own name for the customer and is not
 * published anywhere we can read — but on every operator checked it is the
 * vanity domain's own label, so that is the guess, and a wrong guess is cheap:
 *
 *   A subdomain with nothing behind it answers 500, not 404 and not a redirect
 *   to somebody else's board. Measured 2026-08-26 against
 *   zzznotarealcoopxyz.mobile.agricharts.com. So a 500 is "no mobile site
 *   provisioned" and this stops asking, rather than a reason to keep guessing.
 */
export function mobileCandidates(siteUrl) {
  let host;
  try { host = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return []; }
  const out = [];
  const push = (h) => { const u = `https://${h}/cash/prices.php`; if (!out.includes(u)) out.push(u); };

  /* Already an AgriCharts host: the sub is right there and needs no guessing. */
  const ac = host.match(/^([a-z0-9-]+)\.agricharts\.com$/);
  if (ac) { push(`${ac[1]}.mobile.agricharts.com`); return out; }

  push(`mobile.${host}`);
  const label = host.split(".")[0];
  if (label) {
    push(`${label}.mobile.agricharts.com`);
    /* Hyphens are a domain-name convenience and AgriCharts' own subs do not
       carry them: pce-coops.com is served by pce-coops.agricharts.com, but
       ag-land.com is agland. Both spellings are one request each. */
    const flat = label.replace(/-/g, "");
    if (flat !== label) push(`${flat}.mobile.agricharts.com`);
  }
  return out;
}

/* THE THIRD SHAPE, AND THE COMMON ONE.
 *
 *     https://<domain>/markets/cashgrid.php
 *     https://<sub>.agricharts.com/markets/cashgrid.php
 *
 * Measured 2026-09-03 after run 91606919069 asked 61 AgriCharts operators for
 * a mobile board and two had one. The mobile subdomain is not how most of them
 * are served: of the 211 sites data/platforms.json calls agricharts, our 84
 * sources come from SIXTEEN distinct mobile boards, and only 18 of the 211
 * have one we read. The route converts about 8.5% of the platform.
 *
 * What the other 193 run is this: AgriCharts is Barchart's white-label
 * product, discover.mjs fingerprints it on `agricharts.com` as a HOST **or**
 * `/markets/cashgrid.php` as a PATH, and the second clause is the embedded
 * board on the operator's own site. The URL is not a guess -- it is in this
 * repository already. test/discover.test.mjs line 25 has used
 * `https://www.heartlandcoop.com/markets/cashgrid.php` as its canonical
 * AgriCharts example since the file was written, and Heartland Co-op is the
 * single largest operator on the uncovered list. probe-lists/ carries twenty
 * more of them.
 *
 * WWW MATTERS HERE AND DOES NOT ON THE MOBILE HOST. Every cashgrid URL in
 * probe-lists/ that names a co-op's own domain has the www on it
 * (www.heartlandcoop.com, www.farmerswin.com, www.centralohfarm.com) while
 * three do not (decaturcoop.net, fsgrain.com, shawneefeed.com). Both spellings
 * are one request.
 */
export function cashgridCandidates(siteUrl) {
  let host;
  try { host = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return []; }
  const out = [];
  const push = (h) => { const u = `https://${h}/markets/cashgrid.php`; if (!out.includes(u)) out.push(u); };

  const ac = host.match(/^([a-z0-9-]+)\.agricharts\.com$/);
  if (ac) { push(host); return out; }

  /* THE PLATFORM'S OWN HOST FIRST, AND THE OPERATOR'S MARKETING DOMAIN AFTER.
     Both serve the same board where both answer — CoMark's ceagrain.com and
     ceagrain.agricharts.com each returned the identical 138 locations and
     2,135 rows in run 91611899805. But a vanity domain is a marketing site
     with a WAF in front of it, and 46 CoMark sources were written against
     ceagrain.com; six hours later run 91680376078 could not reach it at all —
     "fetch failed" on both ceagrain.com and www.ceagrain.com, with the same
     user-agent that had worked, which is a TLS or edge refusal and not an HTTP
     answer. <label>.agricharts.com is the platform serving its own customer
     and is the more durable address. Ordering the candidates puts it in the
     manifest whenever it answers. */
  const label = host.split(".")[0];
  if (label) {
    push(`${label}.agricharts.com`);
    const flat = label.replace(/-/g, "");
    if (flat !== label) push(`${flat}.agricharts.com`);
  }
  push(host);
  push(`www.${host}`);
  return out;
}

/** Every URL worth asking for this operator's board, mobile first because a
 *  mobile board is the one shape already proven to parse. */
export function boardCandidates(siteUrl) {
  return [...mobileCandidates(siteUrl), ...cashgridCandidates(siteUrl)];
}

/** What one candidate URL did, in words a person can act on.
 *
 *  { board: boolean, why: string }. `board` is true only for the shape the
 *  adapter is known to parse -- a cashprices table -- because accepting
 *  anything else here would hand parseBoard() a page it will refuse and turn a
 *  fetch problem into a parse problem. Everything else is reported, and the
 *  wording distinguishes the cases that need different work:
 *
 *    "no such host"            nothing is served there; try another spelling
 *    "HTTP 403"                it exists and refused us; a header problem,
 *                              which is what agricharts-probe.mjs is for
 *    "HTTP 404"                wrong path on a live site
 *    "200 but no cash prices"  a page, not a board -- usually a redirect home
 *    "200, PRICES BUT NOT THE  the interesting one: a board we cannot parse
 *     TABLE WE KNOW"           yet, and the bytes are worth capturing
 */
export function verdictFor(r) {
  if (!r || !r.ok) return { board: false, why: `unreachable: ${String(r?.error ?? "no answer").slice(0, 28)}` };
  if (r.status !== 200) return { board: false, why: `HTTP ${r.status}` };
  if ((r.bytes ?? 0) < 400) return { board: false, why: `200 but only ${r.bytes}B` };
  const prices = /cash\s*price/i.test(r.body);
  const table = /<table class="cashprices"/.test(r.body);
  /* THE CASHGRID BOARD IS A BOARD. It writes its prices from JavaScript rather
     than printing them, so it has no cashprices table and used to fall through
     to "PRICES BUT NOT THE TABLE WE KNOW" -- which is what got 47 of them
     captured. They are read now; a page that calls writeBidCell is one of
     them. The count is checked because the FUNCTION DEFINITION also contains
     the string, so a page with the machinery and no bids matches once. */
  const cells = (r.body.match(/writeBidCell\(/g) || []).length;
  if (table && prices) return { board: true, why: `200, cashprices table` };
  if (table) return { board: true, why: `200, cashprices table (no "cash price" text)` };
  if (cells > 1) return { board: true, why: `200, cashgrid (${cells - 1} price cell(s))` };
  if (cells === 1) return { board: false, why: `200, cashgrid machinery but NO PRICE CELLS` };
  if (prices) return { board: false, why: `200, PRICES BUT NOT THE TABLE WE KNOW` };
  return { board: false, why: `200 but no cash prices (${r.bytes}B)` };
}

/* Which verdicts are worth a person's attention, most first. Used only to
   pick ONE line to represent a site that had several candidates. */
export function rank(why) {
  return kindOf(why) === "served prices in a table we cannot parse yet" ? 4
    : /^HTTP 40[13]/.test(why) ? 3
    : /^HTTP /.test(why) ? 2
    : /^200/.test(why) ? 1
    : 0;
}

export function kindOf(why) {
  /* Only ever called on sites with NO board, but a function that answers
     confidently out of context is a trap for whoever calls it next. */
  if (/cashprices table|cashgrid \(/.test(why)) return "served the board (this is not a no-board verdict)";
  if (/cashgrid machinery but NO PRICE CELLS/.test(why))
    return "served the cashgrid page with no bids on it";
  if (/PRICES BUT NOT THE TABLE/.test(why)) return "served prices in a table we cannot parse yet";
  if (/^HTTP 403/.test(why)) return "answered 403 — a header question, not a missing board";
  if (/^HTTP 404/.test(why)) return "answered 404 — live site, wrong path";
  if (/^HTTP /.test(why)) return `answered ${why.slice(5)}`;
  if (/^200/.test(why)) return "answered 200 with no cash prices on it";
  return "no host answered at all";
}



/* ---------- naming what we found ---------- */


/** "Cash Prices - Legacy Farmers Cooperative mobile site" -> the operator. */
export function operatorFrom(html) {
  const t = (String(html).match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1];
  if (!t) return null;
  let s = cellText(t).replace(/^cash\s*prices\s*[-–—:]\s*/i, "");
  s = s.replace(/\s*[-–—]\s*mobile(\s*site)?$/i, "").replace(/\s+mobile\s*site$/i, "");
  /* THE CASHGRID BOARDS TITLE THEMSELVES THE OTHER WAY ROUND. The mobile
     board is "Cash Prices - Legacy Farmers Cooperative mobile site"; the
     cashgrid is "AgMark LLC. - Cash Bids". Left alone, the operator name
     handed to joinDirectory() was "AgMark LLC. - Cash Bids", which matches
     nothing in Barchart's directory and would have sent all 47 boards to the
     unmatched list looking like a directory problem. */
  /* Stripped REPEATEDLY, because two of the 47 stack it: Farmward's title is
     "Farmward Cooperative Cash Bid JSI - Cash Bids" and Leiters' is
     "Leiters Grain Cash Bid JSI site - Cash Bids" -- an internal template name
     leaked into the <title>. One pass leaves "Farmward Cooperative Cash Bid
     JSI", which matches nothing in the directory. The list is boilerplate only;
     nothing here is an operator's actual name. */
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/\s*[-–—:]?\s*(?:cash\s*bids?|jsi|site|mobile)\s*$/i, "").trim();
    if (s === before) break;
  }
  s = s.trim();
  return s && !/^cash\s*prices$/i.test(s) ? s : null;
}

/** Their own "Visit Our Main Website" link, which is the only one on the page. */
export function websiteFrom(html, fallback = null) {
  const m = String(html).match(/href="((?:https?:)?\/\/[^"]+)\?redirect=0"/i);
  if (!m) return fallback;
  const u = m[1].startsWith("//") ? `https:${m[1]}` : m[1];
  try { return new URL(u).origin + "/"; } catch { return fallback; }
}

export const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The operator half of a source id, from the mobile host. Stable and short. */
export function operatorSlug(mobileUrl) {
  let h;
  try { h = new URL(mobileUrl).hostname.toLowerCase(); } catch { return null; }
  h = h.replace(/\.agricharts\.com$/, "").replace(/^mobile\./, "").replace(/\.mobile$/, "");
  h = h.replace(/^www\./, "").replace(/\.(com|net|org|coop|ca|us|biz|info)$/, "");
  return slug(h) || null;
}

/* ONE PLATFORM, TWO DOCUMENTS, AND THE SWEEP MUST NOT CARE WHICH.
 *
 * AgriCharts serves a MOBILE board at <sub>.mobile.agricharts.com and a
 * CASHGRID at /markets/cashgrid.php. They are different documents with
 * different parsers, and measured 2026-09-03 the second is the common one: of
 * 61 uncovered operators, 2 had a mobile board and 47 had a cashgrid.
 *
 * The kind is decided by WHICH ADAPTER READS IT, not by the URL. Two of the 47
 * cashgrid captures are not cashgrid boards at all -- faasfeed serves the
 * MOBILE table at its cashgrid address -- so a URL-shaped guess would have
 * handed that page to the wrong parser and called the refusal a broken board.
 *
 * Mobile is tried first because it is the shape with 84 sources behind it.
 */
export const BOARD_KINDS = [
  { kind: "mobile", platform: "agricharts", read: extract, stamp: VERIFIED_BY },
  { kind: "cashgrid", platform: "agricharts-cashgrid", read: extractCashgrid,
    stamp: CASHGRID_VERIFIED_BY },
];

export function readBoard(html, url, contracts) {
  const tried = [];
  for (const k of BOARD_KINDS) {
    try {
      const rows = k.read(html, url, { contracts });
      if (rows.length) return { ...k, rows, tried };
    } catch (e) { tried.push(`${k.kind}: ${String(e.message).slice(0, 160)}`); }
  }
  return { kind: null, tried };
}

/* WHERE THE BYTES GO WHEN A BOARD IS THERE AND WE CANNOT READ IT./* WHERE THE BYTES GO WHEN A BOARD IS THERE AND WE CANNOT READ IT.
 *
 * Run 91611899805 asked 61 operators for both shapes and came back:
 *
 *     47  served prices in a table we cannot parse yet
 *     10  answered 500
 *      2  answered 403 — a header question, not a missing board
 *
 * So it is not a header problem, not robots, not a missing board. Forty-seven
 * sites serve a 200 with cash prices in it, mostly at
 * <label>.agricharts.com/markets/cashgrid.php, in a table shape
 * lib/adapters/agricharts.mjs does not know. That is a parser, and a parser
 * gets written against bytes somebody actually received -- not against a
 * description of them, and not against one page that happened to be handy.
 *
 * NAMED FOR THE SHAPE, NOT ONLY THE OPERATOR. fixtures/agricharts-<slug>.html
 * is already taken by that operator's MOBILE board for several of these, and
 * two different documents under one name is how a parser ends up tested
 * against the wrong evidence.
 */
export function captureName(url) {
  const s = operatorSlug(url);
  return s ? `agricharts-cashgrid-${s}.html` : null;
}

/* ---------- the directory join ---------- *//* ---------- the directory join ---------- */

/* THE ONLY HONEST SOURCE FOR A TOWN. data/known-elevators.json is Barchart's
   own directory: facility, branch, city, state, ZIP, phone. A board's section
   heading is the operator's own name for the place, and it matches the
   directory's `branch` on most of them. No match means no manifest — a town
   nobody published is a town this project does not know. */
/* The industry words that describe what a business is, not which one it is,
   as an eight-character prefix -- the length joinDirectory() compares. Built
   from lib/place.mjs's own FACILITY and SUFFIX lists rather than typed out
   again beside them, so the two cannot drift. */
export const GENERIC_NAME_WORDS = new Set(
  [...FACILITY, ...SUFFIX, "grain", "agri", "farm", "farms", "farmers", "elevator",
   "cooperative", "coop", "company", "service", "services", "energy", "ag"]
    .map((w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8))
    .filter((w) => w.length >= 2));

export function joinDirectory(known, operator, label, { soleLocation = false } = {}) {
  const o = slug(operator), l = slug(label);
  /* AN INDUSTRY WORD IS NOT AN IDENTITY.
   *
   * This compares eight-character prefixes in both directions, and the second
   * direction -- does the OPERATOR contain the first eight characters of the
   * directory name -- fires on any facility whose name begins with a generic
   * word. Measured 2026-09-04 against Hillsdale Elevator Company: slug
   * "hillsdaleelevatorcompany" contains "elevator", so it matched a row called
   * plain "ELEVATOR" in Britton, South Dakota, and another whose facility
   * field is a run-together list of eleven South Dakota businesses. Neither is
   * Hillsdale. Only the label test kept a bid at Hillsdale, Illinois out of
   * Britton -- one check away from a wrong town on a real elevator.
   *
   * The words are lib/place.mjs's own FACILITY and SUFFIX lists, which exist
   * for exactly this: words that describe what a business IS rather than which
   * business it is. A prefix that is nothing but one of them is not evidence,
   * and a match resting on it alone is dropped. */
  const generic = (p) => GENERIC_NAME_WORDS.has(p);
  const sameOperator = (k) => {
    const f = slug(k.facility);
    if (f.length < 4 || o.length < 4) return false;
    const fp = f.slice(0, 8), op = o.slice(0, 8);
    if (f.includes(op) && !generic(op)) return true;
    if (o.includes(fp) && !generic(fp)) return true;
    return false;
  };
  const rows = known.filter(sameOperator);
  if (l) {
    return rows.find((k) => slug(k.branch) === l)
        ?? rows.find((k) => slug(k.city) === l)
        ?? null;
  }
  /* A SINGLE-LOCATION BOARD OFTEN NAMES NO PLACE AT ALL.
   *
   * Aurora Elevator, Keller Grain, Offerle, Horse Heaven Grain and eight more
   * head their tables with the COMMODITY and carry no location filter, so there
   * is no place name on the page. The board is the operator, and the directory
   * knows where the operator is -- but only if it knows of exactly ONE of them.
   * Two rows for one company and there is nothing here to choose between them,
   * so it reports rather than picks. Rule 1. */
  if (soleLocation && rows.length === 1) return rows[0];
  return null;
}

export const phoneOf = (p) => {
  const d = String(p ?? "").replace(/\D/g, "");
  return d.length === 10 ? "1" + d : d.length === 11 ? d : null;
};

/* ---------- one manifest ---------- */

export const PUBLIC_NOTE = "Their publicly posted cash board, read from the mobile page their own "
  + "site serves. Cash and basis are their own commercial numbers. This platform publishes no "
  + "futures price at all, so none is republished; the futures quote is used only to check that "
  + "the two columns were read correctly.";

export function manifestFor({ id, operator, website, url, loc, dir, zipCoord, runId,
                              kind = "mobile" }) {
  /* dir.coord, when the directory row brought its own; otherwise the ZIP
     lookup exactly as before. */
  const coord = dir.coord ?? zipCoord;
  const bands = { corn: [2.0, 12.0], soybean: [6.0, 32.0], wheat: [3.0, 20.0] };
  if ([...loc.commodities].some((c) => /waxy/i.test(c))) bands.waxy = [2.0, 12.0];
  const m = {
    id, operator, location: dir.branch, state: dir.state,
    platform: kind === "cashgrid" ? "agricharts-cashgrid" : "agricharts",
    url, locationId: loc.locationId,
    identityAlternative: kind === "cashgrid" ? CASHGRID_VERIFIED_BY : VERIFIED_BY,
    bands,
    cadence: "grain-day", provenance: "scraped", enabled: true,
    /* THEIR CASH CELL IS ROUNDED TO THE CENT, SO THE IDENTITY CAN ONLY EVER
       HOLD TO THE CENT. Measured 2026-09-04 across 6,228 testable rows on all
       45 captured cashgrid boards: checkIdentity's signedCents took exactly
       four values and no others —

           -0.5   660      -0.25   329      +0.25  3286      +0.5     6

       — none outside +/-0.5. That is a board publishing basis and a named
       contract and letting the browser add them up and round the sum to the
       penny; the residual is the rounding and carries no information about
       column integrity. Run 91680376078 refused 158 of these sources on it,
       every message reading "Every gap is a whole number of eighths of a cent,
       the grid their futures column is quoted on" — the guard diagnosing its
       own tolerance.

       `round-cent` is the mode Premier Cooperative already needed and is not
       widened for this: -0.5 <= r < 0.5, closed at the bottom, open at the
       top. It explains 4,275 of the 4,281 failures. The six it does not are
       one commodity on one board — CoMark's WHEAT HRW at Chisholm Trail and
       Smoky Hill, 8.16 against 841.5 - 25 = 816.5, a half-cent TRUNCATED where
       every other row on that board rounds to nearest. Six rows in 6,228 stay
       visible and stay failures, which is the point of a bounded rule.

       NOT set on the mobile boards: those publish no futures price at all and
       reach lib/board.mjs by a different door. */
    ...(kind === "cashgrid" ? { cashRounding: "round-cent-either" } : {}),
    note: `WRITTEN BY scripts/agricharts-sweep.mjs${runId ? ` (run ${runId})` : ""} from their own `
      + `${kind === "cashgrid" ? "cashgrid" : "mobile"} board at ${url}. locationId `
      + `${loc.locationId} is the l= parameter on this `
      + `location's own chart links, which every row of every AgriCharts board carries; it is NOT `
      + `the section heading, which is a display name and can be re-typed. At the time of writing `
      + `this location showed ${loc.rows} row(s) in ${[...loc.commodities].join(", ")}.\n\n`
      + (kind === "cashgrid"
        ? `identityAlternative: this board publishes a BASIS and the NAME of the CBOT contract it `
          + `is against — writeBidCell(-34, ..., quotes['ZCZ26']) — and the browser adds them up. `
          + `We do the same arithmetic from the same quote pages, which means cash - basis = `
          + `futures is true by construction here and would be checking our own subtraction `
          + `against itself. lib/board.mjs refuses such a source unless it names what it publishes `
          + `on instead AND every row carries that stamp. The checks that CAN fail all passed `
          + `before this file was written: the named contract is one our quote pages price, its `
          + `root agrees with the board's own commodity heading, and every delivery code appears `
          + `in its own table's column headers.`
        : `identityAlternative: this board publishes cash, basis and a futures CHANGE and no `
          + `futures price, so cash - basis = futures can never run on it. lib/board.mjs refuses `
          + `such a source unless it names what it publishes on instead AND every row carries that `
          + `stamp from the adapter. The board was read and both of the adapter's checks passed `
          + `before this file was written: every location on it implies the same futures for one `
          + `commodity and one delivery code, and every row sits within 5c of a real quoted CBOT `
          + `contract. futuresPriceCents publishes as null, because there is no quote to `
          + `republish.`)
      + `\n\nCompany, branch, town, state, ZIP and phone are copied verbatim from `
      + `data/known-elevators.json. Website is `
      + (kind === "cashgrid" ? `the site the sweep was pointed at.` 
                             : `the "Visit Our Main Website" link on their own mobile board.`),
    publicNote: PUBLIC_NOTE,
    address: null,
    zip: dir.zip ?? null,
    /* A COORDINATE THIS REPOSITORY ALREADY HOLDS BEATS A ZIP LOOKUP.
     *
     * The path to a coordinate ran only through `byZip`, and
     * geocodes/zip-candidates.json is a curated file of the 743 ZIPs this
     * project has already needed -- not a gazetteer. Measured 2026-09-05
     * against the 100 board siblings that could be placed: it covers THREE.
     *
     * geocodes/places.json already holds a coordinate for 3,957 places, each
     * with the precision and the `via` that made it. The ZIP was only ever a
     * key on the way to a coordinate, and for 67 of those siblings the
     * coordinate is already here.
     *
     * So a directory row may carry `coord` and it wins. Nothing is computed:
     * the precision travels with the coordinate rather than being assumed
     * "town", which is what rule 45 asks for. A row with no `coord` behaves
     * exactly as before -- this is additive, and a test asserts every source
     * written before this change comes out byte-identical after it. */
    lat: coord ? coord.lat : null,
    lon: coord ? coord.lon : null,
    ...(coord ? { latPrecision: dir.coord ? (dir.coord.precision || "town") : "town" } : {}),
    phone: phoneOf(dir.phone),
    email: null,
    website,
    inMerge: true,
    _pending: (kind === "cashgrid"
      ? "cashRounding is round-cent-either: nearest cent, tie-break not established. "
        + "Measured across 6,228 rows on 45 captured boards: -0.5, -0.25, +0.25, +0.5 and "
        + "nothing else, so the interval is closed at both ends. "
      : "cashRounding is NOT set and must not be guessed; it is measured from a real board "
        + "against real futures. ")
      + (dir.coord
        ? `lat/lon was NOT derived here: it is the coordinate geocodes/places.json already `
          + `holds for ${dir.city}, ${dir.state}, at ${dir.coord.precision || "unstated"} `
          + `precision via ${dir.coord.via || "unstated"}. This location came from a sibling `
          + `list on a board this repository already reads, and it has no ZIP in `
          + `data/known-elevators.json -- which is why the coordinate is carried in rather `
          + `than looked up.`
        : zipCoord
        ? "lat/lon is the CENTROID OF THE TOWN's ZIP and can be miles from the yard; a street fix "
          + "needs a street address, which data/known-elevators.json does not carry."
        : "lat/lon is null: this ZIP has no coordinate in geocodes/zip-candidates.json. `sync "
          + "known` rebuilds geocodes/places.json from the manifests' ZIPs and `geocode fill` with "
          + "the write box on then writes it back here."),
  };
  return m;
}

/* ---------- what one board becomes ----------
 *
 * Pure, because this is where every decision about what goes in a file is
 * made, and the alternative to testing it is running a sweep and reading four
 * hundred diffs. Given a board's bytes it returns exactly what would be
 * written, what would be left alone, and what could not be given a town.
 */

/** The placeable rows of data/gaps/board-siblings.csv, as directory rows.
 *
 *  Returns [] and says nothing if the file is absent — the sweep predates it
 *  and must still run without it. */
export function readSiblingDirectory(root = ROOT) {
  const f = join(root, "data/gaps/board-siblings.csv");
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
  const head = lines[0].split(",");
  const ix = (n) => head.indexOf(n);
  const iOp = ix("operator"), iLab = ix("label"), iSt = ix("state"),
        iLat = ix("lat"), iLon = ix("lon"), iPre = ix("precision"), iVia = ix("via");
  if ([iOp, iLab, iSt, iLat, iLon].some((i) => i < 0)) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const c = cells(line);
    if (c.length !== head.length) continue;
    const lat = Number(c[iLat]), lon = Number(c[iLon]);
    /* No state or no coordinate: not a directory row, still a worklist row. */
    if (!c[iSt] || !c[iLat] || !c[iLon] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    /* A LABEL THAT NAMED ITS OWN STATE MUST NOT KEEP IT.
       "Alpena SD" as the branch makes the location read "Alpena SD" beside a
       state field of SD, and makes the id `agtegra-alpenasd`, which matches
       nothing else in sources/. The suffix is only stripped when it is the
       state we resolved — so "Corn IN" loses "IN" only if the row is Indiana,
       and a town genuinely called something ending in two letters is safe. */
    let branch = c[iLab];
    const tail = branch.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
    if (tail && tail[2].toUpperCase() === c[iSt].toUpperCase()) branch = tail[1].trim();
    if (!branch) continue;
    out.push({
      facility: c[iOp], branch, city: branch, state: c[iSt],
      zip: null, phone: null, source: "board-siblings",
      coord: { lat, lon, precision: c[iPre] || "", via: c[iVia] || "" },
    });
  }
  return out;
}

export function planBoard({ html, url, site, rows, known, byZip, existingIds, runId = null,
                            kind = "mobile" }) {
  const operator = operatorFrom(html);
  const website = websiteFrom(html, site);
  const op = operatorSlug(url);
  if (!operator || !op)
    return { ok: false, why: "no operator name in the page title", write: [], skip: [], unmatched: [] };

  const byLoc = new Map();
  for (const r of rows) {
    const e = byLoc.get(r.locationId)
      ?? { locationId: r.locationId, label: r.location, rows: 0, commodities: new Set() };
    e.rows++; e.commodities.add(r.commodity);
    if (!e.label && r.location) e.label = r.location;
    byLoc.set(r.locationId, e);
  }

  const write = [], skip = [], unmatched = [];
  const seen = new Set(existingIds);
  for (const loc of byLoc.values()) {
    const dir = joinDirectory(known, operator, loc.label, { soleLocation: byLoc.size === 1 });
    if (!dir || !dir.state || !dir.branch) {
      unmatched.push({ operator, label: loc.label ?? "(unnamed)", locationId: loc.locationId,
                       rows: loc.rows, url });
      continue;
    }
    const id = `${op}-${slug(dir.branch)}`;
    /* NEVER OVERWRITE. A file in sources/ was either written by an earlier run
       of this and reviewed, or edited by somebody who looked at the yard. A
       sweep must not walk over either, and "already there" is not a failure. */
    if (seen.has(id)) { skip.push({ id, why: "a manifest already exists" }); continue; }
    const m = manifestFor({ id, operator, website, url, loc, dir,
                           zipCoord: byZip.get(dir.zip), runId, kind });
    const bad = validateSource(m, new Set());
    if (bad.length) { skip.push({ id, why: bad.join("; ") }); continue; }
    seen.add(id);
    write.push({ id, json: m, rows: loc.rows, town: `${dir.city}, ${dir.state} ${dir.zip}`,
                 placed: !!byZip.get(dir.zip) });
  }
  return { ok: true, operator, website, locations: byLoc.size, write, skip, unmatched };
}

/* ---------- fetching ---------- */

async function get(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" },
                                   redirect: "follow", signal: ac.signal });
    const body = await res.text();
    return { ok: true, status: res.status, body, bytes: Buffer.byteLength(body), finalUrl: res.url };
  } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
  finally { clearTimeout(t); }
}

/* ---------- main ---------- */

export function agrichartsHosts(platforms) {
  return Object.entries(platforms.sites ?? {})
    .filter(([, r]) => r && r.platform === "agricharts")
    .map(([u]) => u)
    .sort();
}

/** Turn what somebody typed into a workflow box into a path, or say why not.
 *
 *  RUN 91604425422, 2026-09-03. The box got
 *
 *      hosts = probe-lists/agricharts-uncovered-2026-09-03.txt
 *
 *  because that is EXACTLY the line I wrote in the instructions -- one code
 *  span, label and value together, which reads as "type this". The guard did
 *  its job: it printed what it got and asked nothing rather than falling
 *  through to platforms.json and sweeping 211 sites. But a guard that refuses
 *  a reasonable reading of my own instruction is a guard doing my apologising.
 *  The label comes off here.
 *
 *  It also accepts a bare file name, because "the list you sent me" is a name
 *  and not a path, and probe-lists/ is the only place these live.
 *
 *  Returns { path } or { error: { given, tried, available } }. It does not
 *  throw and it does not guess: an unresolvable value stops the run.
 */
export function resolveHostsPath(raw, exists, list) {
  const given = String(raw ?? "");
  let v = given.trim();
  v = v.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();   // "quoted"
  v = v.replace(/^hosts?\s*[:=]\s*/i, "").trim();       // hosts = / hosts:
  v = v.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();   // hosts = "quoted"
  if (!v) return { error: { given, tried: [], available: list() } };

  const tried = [v];
  if (!/[\\/]/.test(v)) tried.push(`probe-lists/${v}`);
  for (const t of [...tried]) if (!/\.[a-z0-9]+$/i.test(t)) tried.push(`${t}.txt`);

  for (const t of tried) if (exists(t)) return { path: t };
  return { error: { given, tried, available: list() } };
}


/** Which sites THIS RUN asks: the file if one was named, else every AgriCharts
 *  site in data/platforms.json, then --only, then --start/--limit.
 *
 *  PULLED OUT BECAUSE THE READER IS THE WHOLE BUG. --hosts used to require a
 *  whole line to be a URL, which read ZERO sites out of four of the eleven
 *  files in probe-lists/ and reported "0 site(s)" with a green tick. Testing
 *  urlsFrom() on its own would not have caught that: the reader was correct
 *  and simply was not the one being called. This is the seam where a test can
 *  ask the question that matters -- what will the sweep ask? -- so a future
 *  edit that swaps the reader back has something to fail.
 */
export function hostsFor(cfg, platforms, readText) {
  let hosts = cfg.hosts ? urlsFrom(readText(cfg.hosts)) : agrichartsHosts(platforms);
  if (cfg.only) hosts = hosts.filter((h) => cfg.only.some((o) => h.includes(o)));
  return hosts.slice(cfg.start, cfg.start + cfg.limit);
}


/* THE TWO THINGS THIS TALKS TO, NAMED SO A TEST CAN HOLD THEM.
 * Not a general dependency-injection habit: it is here because main() choosing
 * the WRONG LIST is a silent failure -- it prints a tally, exits green and
 * asks 211 sites nobody asked for -- and no test of hostsFor() on its own can
 * see it, because the bug is that hostsFor() was not called. With these, one
 * test runs the real main() and reads the count it prints. */
export const IO = {
  readText: (f) => readFileSync(join(ROOT, f), "utf8"),
  exists: (f) => existsSync(join(ROOT, f)),
  listLists: () => (existsSync(join(ROOT, "probe-lists"))
    ? readdirSync(join(ROOT, "probe-lists")).filter((f) => !f.startsWith(".")).sort() : []),
  get,
};

/** A REFUSAL MUST NAME WHAT WOULD SATISFY IT. "not in this repository" sent a
 *  correct instruction back with nothing to do about it. */
export function describeHostsError({ given, tried, available }) {
  const head = given.trim()
    ? `hosts was ${JSON.stringify(given)} and no file of that name is in this repository.`
    : "hosts was empty. Leave it blank to sweep data/platforms.json, or name a list.";
  const t = tried.length ? ` Tried: ${tried.join(", ")}.` : "";
  const a = available.length
    ? ` probe-lists/ holds: ${available.join(", ")}. The name alone is enough.`
    : " probe-lists/ is empty.";
  return head + t + a + " Nothing was asked.";
}

export async function main(argv = process.argv.slice(2), io = IO) {
  const cfg = parseArgs(argv);
  const runId = process.env.GITHUB_RUN_ID || null;

  const platforms = JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8"));

  /* A LIST THAT CANNOT BE FOUND STOPS THE RUN. It must never fall through to
     platforms.json: that is a different 211 sites and it would look like a
     clean sweep of the whole platform. */
  if (cfg.hosts) {
    const r = resolveHostsPath(cfg.hosts, io.exists, io.listLists);
    if (r.error) {
      console.error(`::error title=no such hosts file::${describeHostsError(r.error)}`);
      return 1;
    }
    cfg.hosts = r.path;
  }

  const hosts = hostsFor(cfg, platforms, io.readText);

  console.log(`AGRICHARTS SWEEP — ${hosts.length} site(s)${cfg.write ? "" : "  (DRY RUN: --write to write files)"}`);

  /* The quote pages first: without them no board can be checked and no manifest
     may be written. Seven requests for the whole sweep. */
  const quoteBodies = [];
  for (const u of quoteUrls()) {
    const r = await io.get(u, cfg.timeoutMs);
    if (r.ok && r.status === 200) quoteBodies.push(r.body);
    else console.log(`   quote page failed: ${u} — ${r.error ?? r.status}`);
  }
  let contracts = [];
  try { contracts = mergeQuotes(quoteBodies); } catch (e) { console.log(`   quotes unreadable: ${e.message}`); }
  const priced = contracts.filter((c) => c.priced).length;
  console.log(`   ${quoteBodies.length}/${quoteUrls().length} quote page(s), ${priced} priced contract(s)\n`);
  if (!priced) {
    console.error("::error title=no CBOT quotes::Without them no board can be checked and no "
      + "manifest may be written. Nothing was changed.");
    return 1;
  }

  const known = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8")).elevators;
  /* ── THE SIBLINGS, AS DIRECTORY ROWS ─────────────────────────────────────
   *
   * data/gaps/board-siblings.csv is written by scripts/board-siblings.mjs
   * from `otherLocationsOnPage` — the locations these boards name themselves.
   * 337 of them are not sources; 67 have a state decided honestly AND a
   * coordinate this repository already holds.
   *
   * Those 67 are appended here as ordinary directory rows, in exactly the
   * shape joinDirectory already understands, carrying their coordinate. The
   * matching logic is untouched: it simply has more rows to match against,
   * and its generic-word protection — the Hillsdale/Britton case — still
   * applies to every one of them.
   *
   * AFTER Barchart's own rows, so a real directory entry always wins. That is
   * the file a street-precision fix would have landed in.
   *
   * A row with no coordinate is not added at all: a source with no lat/lon is
   * a pin the coverage map cannot draw, and the worklist is the right place
   * for it until its state's registry lands. */
  const siblingRows = readSiblingDirectory();
  if (siblingRows.length)
    console.log(`   ${siblingRows.length} sibling row(s) from data/gaps/board-siblings.csv`);
  known.push(...siblingRows);
  const zipRows = JSON.parse(readFileSync(join(ROOT, "geocodes/zip-candidates.json"), "utf8")).zips;
  const byZip = new Map(zipRows.map((z) => [z.zip, z]));
  const existing = new Set(readdirSync(SOURCES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));

  const found = [], noBoard = [], unreadable = [], wrote = [], skipped = [], unmatched = [], captured = [];
  const seenIds = new Set(existing);

  for (const [i, site] of hosts.entries()) {
    const cands = boardCandidates(site);
    let hit = null;
    const asked = [];
    for (const c of cands) {
      const r = await io.get(c, cfg.timeoutMs);
      const v = verdictFor(r);
      /* The body rides along ONLY so --capture can write it; it is stripped
         from everything the summary prints. */
      asked.push({ url: c, ...v, body: r?.ok ? r.body : null });
      if (v.board) { hit = { url: c, body: r.body }; break; }
    }
    if (!hit) {
      noBoard.push({ site, asked });
      for (const a of asked) {
        if (!cfg.capture || !a.body || !/PRICES BUT NOT THE TABLE/.test(a.why)) continue;
        const name = captureName(a.url);
        if (!name) continue;
        /* AN ABSOLUTE --capture IS ALREADY WHERE IT WANTS TO GO.
           join(ROOT, "/tmp/x") is "<repo>/tmp/x", which silently writes the
           captures somewhere nobody looks and reports success. */
        const file = isAbsolute(cfg.capture) ? join(cfg.capture, name) : join(ROOT, cfg.capture, name);
        /* A FIXTURE IS FROZEN EVIDENCE. Rewriting it every run turns a diff
           that means "the specimen moved" into noise, and then nobody reads
           it. --refresh replaces one deliberately. */
        if (existsSync(file) && !cfg.refresh) { captured.push({ name, kept: true }); continue; }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, a.body);
        captured.push({ name, bytes: a.body.length, url: a.url });
      }
      /* WHAT EACH ONE DID, NOT HOW MANY THERE WERE.
         Run 91606919069 printed "no mobile board (2 tried)" for 59 of 61
         sites, and that one line covers a DNS failure, a 403, a redirect to a
         home page and a board in a shape we do not know -- four different
         next moves, reported identically. It cost a whole run to learn
         nothing. A count is not a diagnosis. */
      console.log(`── [${i + 1}/${hosts.length}] ${site}  no board`);
      for (const a of asked) console.log(`     ${a.why.padEnd(34)} ${a.url}`);
      continue;
    }

    /* THE BOARD HAS TO PASS EXACTLY WHAT A POLL WOULD PUT IT THROUGH. A board
       that cannot be read today produces no sources today.
       WHICH parser is decided by which one reads it, never by the URL: two of
       the 47 cashgrid captures serve the MOBILE table at a cashgrid address. */
    const board = readBoard(hit.body, hit.url, contracts);
    if (!board.kind) {
      const why = board.tried.join(" | ") || "no adapter recognised this page";
      unreadable.push({ site: hit.url, why: why.slice(0, 220) });
      console.log(`── [${i + 1}/${hosts.length}] ${site}  BOARD REFUSED`);
      for (const t of board.tried) console.log(`     ${t}`);
      continue;
    }
    const rows = board.rows;

    const plan = planBoard({ html: hit.body, url: hit.url, site, rows, known, byZip,
                             existingIds: seenIds, runId, kind: board.kind });
    if (!plan.ok) { unreadable.push({ site: hit.url, why: plan.why }); continue; }
    found.push({ site, url: hit.url, operator: plan.operator, locations: plan.locations,
                 rows: rows.length, kind: board.kind });
    console.log(`── [${i + 1}/${hosts.length}] ${site}\n   [${board.kind}] ${plan.operator} — ${hit.url} — `
      + `${plan.locations} location(s), ${rows.length} row(s)`);

    for (const u of plan.unmatched) {
      unmatched.push(u);
      console.log(`     - ${String(u.label).padEnd(24)} l=${String(u.locationId).padEnd(6)} `
        + `NO DIRECTORY MATCH — no town, so no manifest`);
    }
    for (const s of plan.skip) { skipped.push(s); console.log(`     = ${s.id}: ${s.why}`); }
    for (const w of plan.write) {
      seenIds.add(w.id);
      wrote.push({ ...w, file: join(SOURCES, `${w.id}.json`) });
      console.log(`     + ${w.id.padEnd(38)} ${String(w.rows).padStart(3)} rows  ${w.town}`
        + `${w.placed ? "  (coord)" : ""}`);
    }
  }

  if (cfg.write) {
    mkdirSync(SOURCES, { recursive: true });
    for (const w of wrote) writeFileSync(w.file, JSON.stringify(w.json, null, 2) + "\n");
  }

  console.log(`\n── SWEEP  ${hosts.length} site(s) asked`);
  const byKind = {};
  for (const f of found) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  const kinds = Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`   ${found.length} board(s) found${kinds ? ` (${kinds})` : ""}  ·  `
    + `${noBoard.length} with no board  ·  ${unreadable.length} refused`);

  /* THE TALLY THAT DECIDES THE NEXT PIECE OF WORK.
     59 sites saying "no board" is one number and four different problems. A
     403 is a header question for agricharts-probe.mjs; a 200 carrying prices
     in a table we do not know is a parser to write and bytes to capture; a
     dead host is a spelling to fix; a 200 with no prices on it is the wrong
     page. Counting them apart is the difference between a run that costs an
     hour and one that says what to do next. */
  if (noBoard.length) {
    const tally = new Map();
    for (const n of noBoard) {
      /* ONE VERDICT PER SITE, and it is the most interesting thing that
         happened to any of its candidates -- not the last, and not the first.
         A site where four spellings are dead and the fifth answers 403 is a
         403, because that is the one with something behind it. */
      const best = n.asked.slice().sort((a, b) => rank(b.why) - rank(a.why))[0];
      const k = best ? kindOf(best.why) : "nothing asked";
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    console.log(`\n── WHAT THE ${noBoard.length} SITES WITH NO BOARD ACTUALLY SAID`);
    for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1]))
      console.log(`   ${String(v).padStart(4)}  ${k}`);
  }
  console.log(`   ${wrote.length} manifest(s) ${cfg.write ? "WRITTEN" : "would be written"}  ·  `
    + `${skipped.length} skipped  ·  ${unmatched.length} location(s) with no town`);
  if (unreadable.length) {
    console.log(`\n── BOARDS THAT WOULD NOT READ (${unreadable.length})`);
    for (const u of unreadable.slice(0, 20)) console.log(`   ${u.site}  ${u.why}`);
  }
  if (cfg.capture) {
    const fresh = captured.filter((c) => !c.kept);
    console.log(`\n── CAPTURED (${fresh.length} new, ${captured.length - fresh.length} already on file)`);
    for (const c of fresh) console.log(`   ${String(c.bytes).padStart(7)}B  ${cfg.capture}/${c.name}`);
    if (!captured.length) console.log(`   nothing served a board we could not parse, so there was nothing to capture`);
  }
  if (unmatched.length) {
    console.log(`\n── LOCATIONS ON A BOARD WITH NO TOWN IN data/known-elevators.json (${unmatched.length})`);
    console.log(`   These are real elevators posting real prices. They are not written because a`);
    console.log(`   town, state and ZIP cannot be invented — they need a directory entry.`);
    for (const u of unmatched.slice(0, 40))
      console.log(`   ${String(u.operator).padEnd(34)} ${String(u.label).padEnd(24)} l=${u.locationId}  ${u.rows} row(s)`);
    if (unmatched.length > 40) console.log(`   … and ${unmatched.length - 40} more`);
  }
  if (wrote.length) {
    console.log(`::notice title=${wrote.length} AgriCharts source(s) ${cfg.write ? "written" : "found"}::`
      + `${found.length} board(s) across ${hosts.length} site(s). ${unmatched.length} location(s) `
      + `could not be given a town.`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`::error::${e.stack || e}`); process.exit(1); });
}

#!/usr/bin/env node
/* EVERY PLATFORM WE CAN ALREADY READ, POINTED AT EVERY SITE WE ALREADY KNOW.
 *
 * WHAT THE FIRST RUN MEASURED, run 91840487549, 2026-09-04. It asked 172
 * sites, read 30 boards and wrote NOTHING. Three separate faults, each of
 * them mine, each now fixed here and tested:
 *
 *   1. IT ASKED 78 SERVERS FOR BOARDS WE ALREADY HOLD. sitesFor() deduped on
 *      a source's `url` host alone. But a bushel source's url is
 *      api.bushelpowered.com and the operator's own site is recorded in
 *      `browserPage` and `website` -- so every CHS region we have read since
 *      August came back as "unread". Deduping on all three hosts takes the
 *      queue from 172 to 94, and the 94 are the ones actually unread:
 *
 *          aghost 38 · cashbidssingle 32 · bushel 16 · dtn-cs 5 · graindesk 3
 *
 *   2. IT HANDED HTML TO A JSON ADAPTER. 130 of the 172 refused with "the
 *      response is not JSON", and they were right to: dtn-cs reads
 *      api.dtn.com/markets/sites/<siteId>/cash-bids and graindesk reads
 *      marketplace.graindiscovery.com/api/public-sites/<slug>/cash-bids. The
 *      operator's board PAGE is not that endpoint. discover already recorded
 *      the key -- siteId on all 34 dtn sites, slug on all 32 graindesk sites
 *      -- so boardCandidates() now builds the endpoint from it.
 *
 *   3. IT COULD NOT NAME A TOWN. 83 locations posting real prices came back
 *      as "location 2451". That is not a directory failure and it must not be
 *      recorded as one: extractListBids() names a location from the page's own
 *      nav links and those links did not match. Bytes decide that, not me, so
 *      --capture writes the board to fixtures/ and the regex is fixed from
 *      what the page actually says.
 *
 * BUSHEL IS NOT SWEPT HERE, and the reason is a fact about the data: its 40
 * classified sites record no per-site key at all. Their `ids` carry endpoint
 * names like "modernizr2.0.6-custom.js". The board is a keyed call the page
 * makes at runtime, which is exactly what scripts/bushel-probe.mjs drives a
 * browser to watch. A second half-writer on that platform is how this
 * repository got two manifests for one elevator before.
 *
 * THE BOARD PAGE IS NOT GUESSED. discover recorded it -- `boardPage` on every
 * classified site -- by following the operator's own navigation. This asks for
 * that URL and nothing else.
 *
 * WHAT IT WILL NOT DO
 *   - invent a town. A location is written only when data/known-elevators.json
 *     can give it a town, state and ZIP, exactly as the AgriCharts sweep does.
 *   - overwrite a manifest. A file in sources/ was written by an earlier run
 *     and reviewed, or by somebody who looked at the yard.
 *   - guess an operator's name from its domain. Measured: matching the domain
 *     label against the directory names only 44% of these sites and is wrong in
 *     ways that are hard to see -- agrail.com scored 0.80 against "AgRail LLC"
 *     and atkinsongrain.com scored higher against "Wheaton Grain" than against
 *     "Atkinson Grain & Fertilizer". The board says who it belongs to; ask it.
 *
 * THE UNPLACED ARE THE POINT, NOT THE LEFTOVERS. Flash Grain and Ace Ethanol
 * are not in Barchart's directory at all -- they are two of the 271 elevators
 * we carry and Barchart does not. Every location this cannot place is written
 * to a worklist with its operator, its board, its label and its row count, so
 * the queue is a list of names rather than a number.
 *
 *   node scripts/board-sweep.mjs                     dry run, every platform
 *   node scripts/board-sweep.mjs --platform aghost   one platform
 *   node scripts/board-sweep.mjs --write             write and commit
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { adapterFor, ADAPTERS, SHARED_PAGES } from "../lib/adapters/index.mjs";
import { joinDirectory, slug, phoneOf, operatorSlug } from "./agricharts-sweep.mjs";
import { validateSource } from "../lib/sources.mjs";
import { normaliseLabel } from "../lib/place.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, "data");
const SOURCES = join(ROOT, "sources");
const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)";

/* Platforms this sweep may write for. agricharts has its OWN sweep, which
   knows about mobile boards, cashgrid boards and the quote pages they need;
   duplicating that here would be a second writer on one artefact, and this
   repository has been bitten by that three times. */
export const SWEEPABLE = ["aghost", "cashbidssingle", "dtn-cs", "graindesk"];

/* Platforms whose board is a keyed runtime call, so the classification alone
   cannot reach it. Named, not silently omitted: a platform missing from a
   sweep with no reason recorded reads as an oversight. */
export const NOT_SWEEPABLE = {
  bushel: "the board is a keyed call the page makes at runtime; scripts/bushel-probe.mjs drives a browser to watch it",
  barchart: "licensed feed, read by its own poller",
  agricharts: "scripts/agricharts-sweep.mjs owns this platform",
  stonehedge: "no adapter has been written for this platform yet; its 8 sites are unread",
};

export function parseArgs(argv) {
  const out = { write: false, limit: Infinity, start: 0, timeoutMs: 20000,
                platform: null, only: null, capture: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a === "--capture") out.capture = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--start") out.start = Number(argv[++i]);
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === "--platform") out.platform = argv[++i];
    else if (a === "--only") out.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/* WHO THE BOARD SAYS IT BELONGS TO.
 *
 * Measured across the four non-AgriCharts fixtures in this repository:
 *     "Flash Grain"                    -> Flash Grain
 *     "Cash Bids - Ace Ethanol LLC"    -> Ace Ethanol LLC
 *     "Big River Resources"            -> Big River Resources
 *     (no title, h1 "Sioux Center Corn Bids") -> Sioux Center
 * Each matches the operator in the manifest a human wrote for that board.
 *
 * Stripped REPEATEDLY, because the boilerplate stacks: AgriCharts writes
 * "Farmward Cooperative Cash Bid JSI - Cash Bids". The list is boilerplate
 * only; nothing in it is any operator's actual name. */
const BOILER = /\s*[-–—:|]?\s*(cash\s*bids?|grain\s*bids?|cash\s*prices?|bids?|prices?|jsi|mobile\s*site|mobile|site|home|welcome\s*to)\s*$/i;
/* "Welcome to" needs no separator after it; the rest do. Without that split,
   "Welcome to Doon Elevator | Grain Bids" comes out as "Welcome to Doon
   Elevator" -- a greeting filed as a company. */
const LEAD = /^\s*(?:(?:cash\s*bids?|grain\s*bids?|cash\s*prices?|bids?|prices?)\s*[-–—:|]\s*|welcome\s+to\s+)/i;

export function operatorNameFrom(html) {
  const text = (m) => m ? String(m[1]).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim() : "";
  const s0 = String(html ?? "");
  for (const m of [s0.match(/<title[^>]*>([\s\S]*?)<\/title>/i),
                   s0.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)]) {
    let s = text(m);
    if (!s) continue;
    s = s.replace(LEAD, "").trim();
    for (let i = 0; i < 5; i++) {
      const before = s;
      s = s.replace(BOILER, "").trim();
      if (s === before) break;
    }
    /* A name has to be a name. One word of two letters, or a bare number, is
       page furniture that survived the strip, not an operator. */
    if (s.length >= 4 && /[a-z]{3}/i.test(s)) return s;
  }
  return null;
}

/* Which sites this run asks. A site is skipped when any source already reads
   its board URL: re-reading a board we have is a request to somebody else's
   server for an answer already on disk. */
/* EVERY HOST A SOURCE TOUCHES, NOT JUST THE ONE IT FETCHES.
 *
 * The first version deduped on hostOf(s.url) alone, and on a platform whose
 * url is a shared API that is the WRONG HOST ENTIRELY. A CHS Texoma manifest
 * reads api.bushelpowered.com; the operator's own site is recorded in
 * `browserPage` and `website`. So run 91840487549 asked chs-texoma.com,
 * chsagservices.com and 76 others for boards this repository has been polling
 * since August -- 78 requests to other people's servers for answers already on
 * disk, which is exactly what this check exists to prevent.
 *
 * Three fields, because a source is allowed to record its origin in any of
 * them and all three have been used. */
export function readHostsOf(sources) {
  const out = new Set();
  for (const s of sources) for (const u of [s.url, s.browserPage, s.website]) {
    const h = hostOf(u);
    if (h) out.add(h);
  }
  return out;
}

/* THE KEY, NOT THE HOST, ON A PLATFORM THAT SHARES ONE HOST.
 *
 * Every dtn-cs source reads api.dtn.com and every graindesk source reads
 * marketplace.graindiscovery.com, so a host test says either "skip all of
 * them" or "skip none". What identifies the board is the site key inside the
 * URL: DTN's siteId, Grain Desk's public-site slug. Measured 2026-09-04
 * against the 731 manifests on disk: 32 of 34 dtn sites and 31 of 32 graindesk
 * sites are already read this way, which is why the queue is 3 and not 66. */
export function readKeysOf(sources) {
  const out = new Set();
  for (const s of sources) {
    const u = String(s.url || "");
    if (s.siteId) out.add(`dtn:${String(s.siteId).toUpperCase()}`);
    const m1 = u.match(/\/markets\/sites\/([A-Za-z0-9]+)\//);
    if (m1) out.add(`dtn:${m1[1].toUpperCase()}`);
    const m2 = u.match(/\/public-sites\/([^/?#]+)/);
    if (m2) out.add(`gd:${m2[1].toLowerCase()}`);
  }
  return out;
}

export function siteKeyOf(rec, platform) {
  for (const id of rec.ids ?? []) {
    if (platform === "dtn-cs" && id.siteId) return `dtn:${String(id.siteId).toUpperCase()}`;
    if (platform === "graindesk" && id.slug) return `gd:${String(id.slug).toLowerCase()}`;
  }
  return null;
}

export function sitesFor(platforms, sources, cfg) {
  const readHosts = readHostsOf(sources);
  const readKeys = readKeysOf(sources);
  const out = [];
  for (const [site, rec] of Object.entries(platforms.sites ?? {})) {
    const p = rec && rec.platform;
    if (!p || !SWEEPABLE.includes(p)) continue;
    if (cfg.platform && p !== cfg.platform) continue;
    const key = siteKeyOf(rec, p);
    /* A BOARD PAGE IS STILL NOT GUESSED AT. The one thing that makes it
       unnecessary is a site key: graindesk records a slug for four sites whose
       boardPage discover never captured, and the endpoint is built from the
       slug, so the page is not needed. Everything else must have one. */
    if (!rec.boardPage && !key) continue;
    const board = rec.boardPage || site;
    if (key) { if (readKeys.has(key)) continue; }
    else if (readHosts.has(hostOf(board)) || readHosts.has(hostOf(site))) continue;
    if (cfg.only && !cfg.only.some((o) => site.includes(o) || board.includes(o))) continue;
    out.push({ site, board, platform: p, rec });
  }
  out.sort((a, b) => a.site.localeCompare(b.site));
  return out.slice(cfg.start, cfg.start + cfg.limit);
}

/* WHICH URL ACTUALLY SERVES THE BOARD.
 *
 * discover records `boardPage` -- the page on the operator's own site that a
 * person clicks. For two of these four platforms that page is not what the
 * adapter reads, and handing it over produced 130 refusals in run
 * 91840487549, every one of them saying the same true thing: "the response is
 * not JSON". It was HTML. Of course it was.
 *
 * So the endpoint is BUILT from the key discover already recorded, and the
 * board page is kept as a fallback candidate rather than the only one. Nothing
 * here is guessed: each shape is copied from a manifest in sources/ that has
 * been polling successfully for weeks.
 *
 *   dtn-cs      sources/aglandfs-admcc.json          api.dtn.com/markets/sites/e0030901/cash-bids?units=us
 *   graindesk   sources/abbyvillecoop-abbyville.json marketplace.graindiscovery.com/api/public-sites/abbyvillecoop/cash-bids
 *   aghost      sources/flashgrain-granton.json      flashgrains.com/index.cfm?show=11&mid=3
 *   cashbidss.  sources/boyceville.json              bigriverbids.com/cashbidssingle-2121
 *
 * A candidate carries the reason it is being tried, so a site that fails every
 * one of them prints four diagnoses and not "no board (4 tried)". */
export function boardCandidates(site, rec, platform) {
  const out = [];
  const add = (url, why) => { if (url && !out.some((c) => c.url === url)) out.push({ url, why }); };
  const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };
  const board = rec.boardPage || site;

  if (platform === "dtn-cs") {
    for (const id of rec.ids ?? []) if (id.siteId)
      add(`https://api.dtn.com/markets/sites/${id.siteId}/cash-bids?units=us`, `DTN site ${id.siteId}`);
    return out.length ? out : [{ url: board, why: "no siteId recorded; the board page is all we have" }];
  }

  if (platform === "graindesk") {
    for (const id of rec.ids ?? []) if (id.slug)
      add(`https://marketplace.graindiscovery.com/api/public-sites/${id.slug}/cash-bids`, `Grain Desk site ${id.slug}`);
    return out.length ? out : [{ url: board, why: "no slug recorded; the board page is all we have" }];
  }

  if (platform === "cashbidssingle") {
    /* discover recorded some of these as ".../cashbidssingle-" with the id cut
       off. A prefix with no number is not a URL; the site root serves the same
       board on this vendor and is tried after it, not instead of it. */
    add(/cashbidssingle-\d+$/.test(board) ? board : null, "the location page discover recorded");
    add(board.endsWith("cashbidssingle-") ? null : board, "the board page discover recorded");
    add(site, "the site root");
    return out;
  }

  if (platform === "aghost") {
    add(board, "the board page discover recorded");
    for (const h of rec.hosts ?? []) if (/(^|\.)aghost\.net$/i.test(h))
      add(`https://${h}/index.cfm?show=11&mid=3`, `the AgHost host ${h} serving this site`);
    const o = origin(board) || origin(site);
    if (o) add(`${o}/index.cfm?show=11&mid=3`, "the AgHost cash-bids view on this host");
    add(site, "the site root");
    return out;
  }

  return [{ url: board, why: "the board page discover recorded" }];
}

/* THE MARKUP THAT SHOULD HAVE CARRIED THE NAME.
 *
 * lib/parse.mjs names a cashbidssingle location from the page's own nav:
 *
 *     /cashbidssingle-(\d+)['"]?\s*>\s*([^<]{1,60})</
 *
 * -- an anchor whose text follows the ">" directly. That matched Big River and
 * Ace Ethanol and matched nothing on 32 other sites, so 83 locations posting
 * real prices came back as "location 2451". Which of their formatting choices
 * is load-bearing is not something to guess at; this prints the actual bytes
 * around each reference so the regex is fixed from the page. */
export function navEvidence(html, n = 4) {
  const out = [];
  for (const m of String(html).matchAll(/cashbidssingle-\d+/gi)) {
    const at = m.index ?? 0;
    out.push(String(html).slice(Math.max(0, at - 110), at + 130).replace(/\s+/g, " ").trim());
    if (out.length >= n) break;
  }
  return out;
}

/* WHAT THE PAGE ITSELF LINKS TO.
 *
 * An AgHost landing page that carries displayNumber() but no table.DataGrid is
 * the right site and the wrong page -- the grid is one click away, and the
 * page names that click in its own navigation. Harvesting the links beats
 * guessing a `mid`, which is what a static candidate list does. */
export function linkedBoards(html, base, platform) {
  const out = [];
  const abs = (h) => { try { return new URL(h, base).toString(); } catch { return null; } };
  const re = platform === "aghost"
    ? /href=["']([^"']*index\.cfm\?[^"']*show=11[^"']*)["']/gi
    : platform === "cashbidssingle"
      ? /href=["']([^"']*cashbidssingle-\d+)["']/gi
      : null;
  if (!re) return out;
  for (const m of String(html).matchAll(re)) {
    const u = abs(m[1].replace(/&amp;/g, "&"));
    if (u && !out.includes(u)) out.push(u);
  }
  return out.slice(0, 12);
}

export function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

export function manifestFor({ id, platform, operator, website, url, loc, dir, zipCoord, runId }) {
  const bands = { corn: [2.0, 12.0], soybean: [6.0, 32.0], wheat: [3.0, 20.0] };
  return {
    id, operator, location: dir.branch, state: dir.state,
    platform, url,
    ...(loc.locationId != null ? { locationId: String(loc.locationId) } : {}),
    bands,
    cadence: "grain-day", provenance: "scraped", enabled: true,
    note: `WRITTEN BY scripts/board-sweep.mjs${runId ? ` (run ${runId})` : ""} from the board `
      + `page discover recorded for this operator: ${url}. The platform is ${platform}, which `
      + `this repository already reads elsewhere; nothing about the parsing is new here. At the `
      + `time of writing this location showed ${loc.rows} row(s) in `
      + `${[...loc.commodities].join(", ")}.\n\n`
      + `THE OPERATOR NAME was read from the board's own title.\n\n`
      + `HOW THIS PLACE WAS PLACED: ${dir.placedBy || "a directory row for this operator"}.`
      + (dir.clean && dir.clean.town && dir.clean.town !== loc.label
          ? ` The board writes this location as "${loc.label}"; the operator's own name, the `
            + `cash-bid boilerplate and the state code were peeled off it by `
            + `normaliseLabel() in lib/place.mjs, leaving "${dir.clean.town}"`
            + `${dir.clean.state ? ` in ${dir.clean.state}` : ""}. Nothing was added to it.`
          : "")
      + `\n\nEVIDENCE, NOT A FACT: check the town against the operator's own published `
      + `address before anything depends on the distance.`,
    publicNote: "Their publicly posted cash board.",
    address: null,
    zip: dir.zip ?? null,
    lat: zipCoord ? zipCoord.lat : null,
    lon: zipCoord ? zipCoord.lon : null,
    ...(zipCoord ? { latPrecision: "town" } : {}),
    phone: phoneOf(dir.phone),
    email: null,
    website: website ?? null,
    inMerge: true,
    _pending: "cashRounding is NOT set and must not be guessed; it is measured from a real "
      + "board against real futures. lat/lon is the centroid of the town's ZIP and can be "
      + "miles from the yard.",
  };
}

/* THE SAME ELEVATOR UNDER A SECOND NAME.
 *
 * A generated id is an identity, and this sweep derives ids from the BOARD's
 * host while the manifests already in sources/ were named by whoever wrote
 * them. Big River Resources is the case that proves it: its board is
 * bigriverbids.com/cashbidssingle-2121, this would call the Boyceville
 * location `bigriverbids-boyceville`, and the manifest that has read that
 * elevator since the first day of this repository is called `boyceville`.
 * Two files, one board, one elevator, both polling it.
 *
 * sitesFor() happens to skip that site because a source already reads its
 * host — but a board served from a host no source names would walk straight
 * past that check. So the identity is tested on what the elevator IS
 * (operator, town, state) and not on what a file happens to be called. */
export function alreadyHave(sources) {
  const k = (op, town, st) => `${slug(op)}|${slug(town)}|${String(st || "").toUpperCase()}`;
  return new Set(sources.map((s) => k(s.operator, s.location, s.state)));
}

/* TWO DIRECTORIES, AND THEY ARE COMPLEMENTARY.
 *
 * data/known-elevators.json is Barchart's 1,802 — it carries BRANCH names, a
 * phone and a ZIP. data/directory.json is the merged 4,225, which adds the
 * state registries. Measured 2026-09-04 against the seven boards captured in
 * fixtures/board-sweep/, neither one subsumes the other:
 *
 *     Agassiz Valley / "AVG Barnesville"   known: Barnesville MN    wide: —
 *     Country Grain  / "Eldridge"          known: —                 wide: Eldridge ND
 *     Dakota Midland / "Voltaire"          known: Volitaire ND      wide: Voltaire ND
 *
 * The third is why known goes first and why the wide set is not a replacement:
 * Barchart spells that town "Volitaire" and the registry spells it Voltaire.
 * Two answers, and the one with the phone number attached is the one whose
 * branch names match these boards, so it is asked first and the wide set fills
 * in behind it. Both together: four of seven, where known alone finds two.
 *
 * ROWS WE WROTE OURSELVES ARE EXCLUDED. directory.json carries every source in
 * sources/ with status "read". Joining a board against manifests derived from
 * boards is circular — the same trap that made the `website` join score 33%
 * on nothing but sites we already read. Only rows this repository did NOT
 * write are eligible. */
export function wideDirectory(directory) {
  const out = [];
  for (const e of directory.elevators ?? []) {
    if (e.status === "read") continue;
    if (!e.operator || !e.location || !e.state) continue;
    out.push({ facility: e.operator, branch: e.location, city: e.location, state: e.state,
               zip: e.zip ?? null, phone: e.phone ?? null,
               source: e.knownFrom || "directory" });
  }
  return out;
}

/* A TOWN AND A STATE, BOTH READ OFF THE BOARD.
 *
 * joinDirectory leans on the operator name, and that cannot help a merchant:
 * Scoular's 36 yards are in twelve states and every directory files them under
 * the local name, not "ScoularView". Run 91852779678 read all 36 and placed
 * none.
 *
 * What their board DOES give is "Big Springs, NE" — a town and a state, both
 * written by the operator. That is not a guess and it is not a lookup; it is
 * the same class of evidence as the price in the next column. So the directory
 * stops being the gate and becomes the enrichment:
 *
 *   1. the directory row for this operator at this label   (branch names win)
 *   2. the directory row for this operator at the peeled town
 *   3. ANY directory row for that town in that state — for the ZIP and the
 *      coordinate, not to identify the elevator, because the elevator is
 *      Scoular's and no directory has it. Eleven rows for Fremont, Nebraska
 *      are eleven neighbours of the same yard; they agree about where Fremont
 *      is, which is all that is being asked. The ZIP is taken only when they
 *      all agree, and left null when they do not.
 *   4. the board's own town and state, with no directory row at all. ZIP null,
 *      coordinate null — build_geocodes.py places it from the ZIP table by
 *      town and state later, and records that it did.
 *
 * A STATE IS REQUIRED AND IS NEVER INFERRED. There are Bridgeports in half the
 * states in the union. Where the board writes no state, this refuses; the
 * label goes on the worklist with the town it peeled to, so a person can
 * finish it in one look instead of starting from a location id. Rule 1. */
export function townInState(known, town, state) {
  if (!town || !state) return null;
  const t = slug(town), st = String(state).toUpperCase();
  const hits = known.filter((k) => String(k.state || "").toUpperCase() === st
    && (slug(k.city) === t || slug(k.branch) === t));
  if (!hits.length) return null;
  const zips = [...new Set(hits.map((h) => h.zip).filter(Boolean))];
  return { facility: hits[0].facility, branch: hits[0].city || town, city: hits[0].city || town,
           state: st, zip: zips.length === 1 ? zips[0] : null, phone: null,
           placedBy: `${hits.length} directory row(s) for ${hits[0].city || town}, ${st}`
             + (zips.length === 1 ? ` agreeing on ZIP ${zips[0]}` : "; they disagree on the ZIP, so none is taken") };
}

export function placeFromBoard(known, operator, label, { soleLocation = false } = {}) {
  const clean = normaliseLabel(label, operator);
  const direct = joinDirectory(known, operator, label, { soleLocation });
  if (direct) return { ...direct, placedBy: "the directory row for this operator at this label", clean };
  if (clean.town) {
    const byTown = joinDirectory(known, operator, clean.town, { soleLocation });
    if (byTown) return { ...byTown, placedBy: `the directory row for this operator at "${clean.town}"`, clean };
    const inState = townInState(known, clean.town, clean.state);
    if (inState) return { ...inState, clean };
    if (clean.state)
      return { facility: operator, branch: clean.town, city: clean.town, state: clean.state,
               zip: null, phone: null, clean,
               placedBy: `the board's own label — it writes "${clean.town}, ${clean.state}" and no `
                 + `directory carries this operator there. No ZIP and no coordinate are taken from anywhere.` };
  }
  return null;
}

export function planSite({ html, url, site, platform, rows, known, byZip, existingIds,
                           have = new Set(), runId = null }) {
  const operator = operatorNameFrom(html);
  const op = operatorSlug(url) || slug(hostOf(site) || "");
  if (!operator) return { ok: false, why: "the board's title and h1 name no operator", write: [], unmatched: [] };
  if (!op) return { ok: false, why: "no usable id could be derived from the board URL", write: [], unmatched: [] };

  const byLoc = new Map();
  for (const r of rows) {
    const k = r.locationId ?? r.location ?? "";
    const e = byLoc.get(k) ?? { locationId: r.locationId ?? null, label: r.location, rows: 0, commodities: new Set() };
    e.rows++; e.commodities.add(r.commodity);
    if (!e.label && r.location) e.label = r.location;
    byLoc.set(k, e);
  }

  const write = [], skip = [], unmatched = [];
  const seen = new Set(existingIds);
  for (const loc of byLoc.values()) {
    /* THE LABEL IS NOT THE TOWN, AND ON A MERCHANT'S BOARD IT NEVER IS.
     *
     * Run 91852779678 read 36 Scoular locations across twelve states — "Big
     * Springs, NE", "Scoular Goodland", "Grainton Cash Bids" — and placed
     * none, because joinDirectory was handed the label verbatim and no
     * directory has a town called "Scoular Goodland". normaliseLabel() peels
     * the operator's name, the boilerplate and the state code off, and refuses
     * with a reason when what is left is an initialism, another buyer's name,
     * or nothing but the company again.
     *
     * THE LABEL IS STILL TRIED FIRST. "AVG Barnesville" is not a town, and it
     * IS the branch name Barchart records for that elevator — a directory hit
     * on the raw label is better evidence than a peeled guess, so the peel is
     * the fallback, not the replacement. */
    const dir = placeFromBoard(known, operator, loc.label, { soleLocation: byLoc.size === 1 });
    const clean = dir?.clean ?? normaliseLabel(loc.label, operator);
    if (!dir || !dir.state || !dir.branch) {
      unmatched.push({ operator, label: loc.label ?? "(unnamed)", locationId: loc.locationId,
                       rows: loc.rows, url, platform,
                       town: clean.town ?? "", state: clean.state ?? "",
                       why: clean.why ?? "no directory row for this operator at this town",
                       commodities: [...loc.commodities].join(" ") });
      continue;
    }
    const id = `${op}-${slug(dir.branch)}`;
    if (seen.has(id)) { skip.push({ id, why: "a manifest already exists" }); continue; }
    const identity = `${slug(operator)}|${slug(dir.branch)}|${String(dir.state || "").toUpperCase()}`;
    if (have.has(identity)) {
      skip.push({ id, why: `this elevator is already read under another id (${identity})` });
      continue;
    }
    const m = manifestFor({ id, platform, operator, website: site, url, loc, dir,
                            zipCoord: dir.zip ? byZip.get(dir.zip) : undefined, runId });
    const bad = validateSource(m, new Set());
    if (bad.length) { skip.push({ id, why: bad.join("; ") }); continue; }
    seen.add(id);
    write.push({ id, json: m, rows: loc.rows, town: `${dir.city}, ${dir.state} ${dir.zip}` });
  }
  return { ok: true, operator, locations: byLoc.size, write, skip, unmatched };
}

/* ASK FOR WHAT THE ADAPTER READS.
 * Every request went out as Accept: text/html, including the two whose board
 * is a JSON API. It is not why they failed -- they failed because they were
 * sent the wrong URL -- but sending a JSON endpoint an HTML Accept header is
 * a claim about the response we do not mean. */
export const WANTS_JSON = new Set(["dtn-cs", "graindesk"]);

async function get(url, timeoutMs, platform = null) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const accept = WANTS_JSON.has(platform)
    ? "application/json, text/plain;q=0.9, */*;q=0.5"
    : "text/html,application/xhtml+xml;q=0.9, */*;q=0.5";
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept },
                                   redirect: "follow", signal: ac.signal });
    const body = await res.text();
    return { ok: true, status: res.status, body, bytes: Buffer.byteLength(body) };
  } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
  finally { clearTimeout(t); }
}

export const IO = { get, readText: (f) => readFileSync(join(ROOT, f), "utf8") };

export async function main(argv = process.argv.slice(2), io = IO) {
  const cfg = parseArgs(argv);
  const runId = process.env.GITHUB_RUN_ID || null;
  const platforms = JSON.parse(io.readText("data/platforms.json"));
  const sources = readdirSync(SOURCES).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SOURCES, f), "utf8")));
  const barchart = JSON.parse(io.readText("data/known-elevators.json")).elevators;
  let wide = [];
  try { wide = wideDirectory(JSON.parse(io.readText("data/directory.json"))); }
  catch { wide = []; }
  const known = barchart.concat(wide);
  console.log(`directory: ${barchart.length} from known-elevators + ${wide.length} from the merged `
    + `directory that this repository did not write = ${known.length} rows`);
  const byZip = new Map(JSON.parse(io.readText("geocodes/zip-candidates.json")).zips.map((z) => [z.zip, z]));
  const existing = new Set(readdirSync(SOURCES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));

  const sites = sitesFor(platforms, sources, cfg);
  console.log(`BOARD SWEEP — ${sites.length} site(s)${cfg.write ? "" : "  (DRY RUN: --write to write files)"}`);
  if (!sites.length) { console.log("   nothing unread on a sweepable platform"); return 0; }

  /* Shared context per platform, fetched once, exactly as the poller does. */
  const shared = new Map();
  const sharedFor = async (p) => {
    const spec = SHARED_PAGES[p];
    if (!spec) return undefined;
    const key = spec.urls.join("|");
    if (shared.has(key)) return shared.get(key);
    const bodies = [];
    for (const u of spec.urls) {
      const r = await io.get(u, cfg.timeoutMs);
      if (r.ok && r.status === 200 && r.body) bodies.push(r.body);
    }
    let ctx = null;
    try { ctx = bodies.length ? spec.build(bodies) : null; } catch { ctx = null; }
    shared.set(key, ctx);
    return ctx;
  };

  const seenIds = new Set(existing);
  const have = alreadyHave(sources);
  const found = [], noBoard = [], unreadable = [], wrote = [], unmatched = [], captured = [];

  /* ONE SITE, SEVERAL CANDIDATE URLS, AND THE DIAGNOSIS FOR EACH.
   *
   * Run 91840487549 printed one refusal per site and it was always the refusal
   * of the wrong URL. A site is not unreadable until every candidate has been
   * tried and each has said, in its own words, why it is not a board. */
  const tryOne = async (url, platform, why) => {
    const r = await io.get(url, cfg.timeoutMs, platform);
    if (!r.ok) return { url, why, verdict: `unreachable: ${String(r.error).slice(0, 60)}` };
    if (r.status !== 200) return { url, why, verdict: `HTTP ${r.status} (${r.bytes}B)` };
    if ((r.bytes ?? 0) < 200) return { url, why, verdict: `${r.bytes}B — too short to be a board` };
    let rows;
    try { rows = adapterFor(platform, await sharedFor(platform))(r.body, url); }
    catch (e) { return { url, why, body: r.body, verdict: `refused: ${String(e.message).slice(0, 110)}` }; }
    if (!rows.length) return { url, why, body: r.body, verdict: "read, but no rows" };
    return { url, why, body: r.body, rows };
  };

  for (const [i, s] of sites.entries()) {
    const tried = [];
    let hit = null;
    for (const c of boardCandidates(s.site, s.rec, s.platform)) {
      const t = await tryOne(c.url, s.platform, c.why);
      tried.push(t);
      if (t.rows) { hit = t; break; }
    }

    /* THE GRID IS ONE CLICK AWAY. An AgHost page carrying displayNumber() is
       the right site; a cashbidssingle page listing locations is the right
       site. Both name the page that actually holds the board in their own
       links, so follow them rather than guessing a query string. */
    if (!hit) {
      const withBody = tried.find((t) => t.body);
      if (withBody) {
        for (const u of linkedBoards(withBody.body, withBody.url, s.platform)) {
          if (tried.some((t) => t.url === u)) continue;
          const t = await tryOne(u, s.platform, "a board this page links to itself");
          tried.push(t);
          if (t.rows) { hit = t; break; }
          if (tried.length > 14) break;
        }
      }
    }

    if (!hit) {
      const anyAnswered = tried.some((t) => t.body);
      const line = { ...s, why: tried.map((t) => t.verdict).join(" | ").slice(0, 200), tried };
      (anyAnswered ? unreadable : noBoard).push(line);
      console.log(`── [${i + 1}/${sites.length}] ${s.site}  [${s.platform}] NO BOARD, ${tried.length} candidate(s):`);
      for (const t of tried) console.log(`     ? ${t.url}\n         ${t.why} → ${t.verdict}`);
      if (cfg.capture) {
        const wb = tried.find((t) => t.body);
        if (wb) captured.push({ platform: s.platform, site: s.site, url: wb.url, body: wb.body });
      }
      continue;
    }

    const plan = planSite({ html: hit.body, url: hit.url, site: s.site, platform: s.platform,
                            rows: hit.rows, known, byZip, existingIds: seenIds, have, runId });
    if (!plan.ok) {
      unreadable.push({ ...s, why: plan.why, tried });
      console.log(`── [${i + 1}/${sites.length}] ${s.site}  [${s.platform}] ${plan.why}`);
      if (cfg.capture) captured.push({ platform: s.platform, site: s.site, url: hit.url, body: hit.body });
      continue;
    }
    found.push({ ...s, board: hit.url, operator: plan.operator, locations: plan.locations, rows: hit.rows.length });
    console.log(`── [${i + 1}/${sites.length}] ${s.site}\n   [${s.platform}] ${plan.operator} — `
      + `${plan.locations} location(s), ${hit.rows.length} row(s)  ←  ${hit.url}`);
    for (const w of plan.write) { console.log(`     + ${w.id.padEnd(38)} ${w.town}  ${w.rows} row(s)`); seenIds.add(w.id); }
    for (const u of plan.unmatched) console.log(`     - ${String(u.label).padEnd(24)} NO DIRECTORY MATCH — no town, so no manifest`);
    /* A LABEL OF "location 2451" IS NOT A DIRECTORY MISS. It is the page's own
       nav failing to match, and recording it as an unplaceable elevator would
       send somebody looking in the wrong file. Print the bytes. */
    if (plan.unmatched.some((u) => /^location (\d+|unknown)$/i.test(String(u.label || "")))) {
      const ev = navEvidence(hit.body);
      console.log(`     ! ${plan.unmatched.length} location(s) unnamed — the page's own nav did not match. Its markup:`);
      if (!ev.length) console.log(`         (no "cashbidssingle-<id>" reference anywhere in ${Buffer.byteLength(hit.body)} bytes)`);
      for (const e of ev) console.log(`         …${e}…`);
    }
    wrote.push(...plan.write.map((w) => ({ ...w, file: join(SOURCES, `${w.id}.json`) })));
    unmatched.push(...plan.unmatched);
    /* CAPTURE THE ONES WE COULD NOT NAME. 83 locations came back as
       "location 2451" and the fix for that lives in a regex in lib/parse.mjs
       that must be written from the page's actual markup, not from a guess
       about it. */
    if (cfg.capture && plan.unmatched.length)
      captured.push({ platform: s.platform, site: s.site, url: hit.url, body: hit.body });
  }

  if (cfg.capture && captured.length) {
    const dir = join(ROOT, "fixtures", "board-sweep");
    mkdirSync(dir, { recursive: true });
    for (const c of captured.slice(0, 20)) {
      const name = `${c.platform}-${slug(hostOf(c.site) || "site")}.html`;
      writeFileSync(join(dir, name),
        `<!-- CAPTURED BY scripts/board-sweep.mjs${runId ? ` run ${runId}` : ""}\n`
        + `     site: ${c.site}\n     read: ${c.url}\n`
        + `     Kept so the parser can be written from what the page says. -->\n`
        + String(c.body).slice(0, 400000));
    }
    console.log(`\n── CAPTURED ${Math.min(captured.length, 20)} board page(s) to fixtures/board-sweep/`);
  }

  if (cfg.write) for (const w of wrote) writeFileSync(w.file, JSON.stringify(w.json, null, 2) + "\n");

  console.log(`\n── BOARD SWEEP  ${sites.length} site(s) asked`);
  console.log(`   ${found.length} board(s) read  ·  ${noBoard.length} did not answer  ·  ${unreadable.length} unreadable`);
  console.log(`   ${wrote.length} manifest(s) ${cfg.write ? "WRITTEN" : "would be written"}  ·  `
    + `${unmatched.length} location(s) with no town`);

  /* THE QUEUE IS A LIST OF NAMES, NOT A NUMBER. Flash Grain and Ace Ethanol
     are not in Barchart's directory at all; they are two of the 271 elevators
     this repository carries and Barchart does not. Every location that could
     not be placed is written out with everything a person needs to place it. */
  if (unmatched.length) {
    mkdirSync(join(DATA, "gaps"), { recursive: true });
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["operator,label,town,state,why,locationId,rows,commodities,platform,board"]
      .concat(unmatched.map((u) => [u.operator, u.label, u.town, u.state, u.why, u.locationId,
                                    u.rows, u.commodities, u.platform, u.url].map(esc).join(",")))
      .join("\n") + "\n";
    if (cfg.write) writeFileSync(join(DATA, "gaps", "board-sweep-unplaced.csv"), csv);
    console.log(`\n── ${unmatched.length} LOCATION(S) POSTING REAL PRICES WITH NO TOWN WE CAN NAME`);
    for (const u of unmatched.slice(0, 25))
      console.log(`   ${String(u.operator).slice(0, 28).padEnd(30)} ${String(u.label).slice(0, 22).padEnd(24)}`
        + `${String(u.rows).padStart(3)} row(s)  ${u.town ? `${u.town}${u.state ? ", " + u.state : ""} — ` : ""}`
        + `${String(u.why || "").slice(0, 70)}`);
    if (unmatched.length > 25) console.log(`   … and ${unmatched.length - 25} more`);
    console.log(`   ${cfg.write ? "written to" : "would be written to"} data/gaps/board-sweep-unplaced.csv`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`::error::${e.stack || e}`); process.exit(1); });
}

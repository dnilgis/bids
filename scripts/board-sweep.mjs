#!/usr/bin/env node
/* EVERY PLATFORM WE CAN ALREADY READ, POINTED AT EVERY SITE WE ALREADY KNOW.
 *
 * Measured 2026-09-04 from data/platforms.json, which discover has been
 * filling for three weeks:
 *
 *     platform          sites   read   board page on file
 *     aghost               38      1      38
 *     cashbidssingle       34      1      34
 *     agricharts          211     62     210
 *     bushel               40     24      40
 *     dtn-cs               34     20      34
 *     graindesk            32     27      28
 *
 * aghost and cashbidssingle have a working adapter, a board URL recorded for
 * every site, and ONE SOURCE READ BETWEEN THEM. Nothing was missing but a
 * script that walks the list. agricharts-sweep.mjs does exactly this for one
 * platform; this is that, with the platform as a parameter.
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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, "data");
const SOURCES = join(ROOT, "sources");
const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)";

/* Platforms this sweep may write for. agricharts has its OWN sweep, which
   knows about mobile boards, cashgrid boards and the quote pages they need;
   duplicating that here would be a second writer on one artefact, and this
   repository has been bitten by that three times. */
export const SWEEPABLE = ["aghost", "cashbidssingle", "bushel", "dtn-cs", "graindesk"];

export function parseArgs(argv) {
  const out = { write: false, limit: Infinity, start: 0, timeoutMs: 20000,
                platform: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
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
export function sitesFor(platforms, sources, cfg) {
  /* THE HOST, NOT THE URL. A first version tested both and the URL test was
     dead code: any board URL a source already reads is on a host a source
     already reads, so the host check subsumes it. A mutation that deleted the
     URL line changed nothing, which is how the redundancy showed up. One
     check, and it is the wider one — an operator serving a second board from
     a host we already poll is still a board we can reach through the source
     we have. */
  const readHosts = new Set(sources.map((s) => hostOf(s.url)).filter(Boolean));
  const out = [];
  for (const [site, rec] of Object.entries(platforms.sites ?? {})) {
    const p = rec && rec.platform;
    if (!p || !SWEEPABLE.includes(p)) continue;
    if (cfg.platform && p !== cfg.platform) continue;
    const board = rec.boardPage;
    if (!board) continue;
    if (readHosts.has(hostOf(board))) continue;
    if (cfg.only && !cfg.only.some((o) => site.includes(o) || board.includes(o))) continue;
    out.push({ site, board, platform: p });
  }
  out.sort((a, b) => a.site.localeCompare(b.site));
  return out.slice(cfg.start, cfg.start + cfg.limit);
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
      + `Operator, branch, town, state, ZIP and phone are copied verbatim from `
      + `data/known-elevators.json. The operator name was read from the board's own title.`,
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
    const dir = joinDirectory(known, operator, loc.label, { soleLocation: byLoc.size === 1 });
    if (!dir || !dir.state || !dir.branch) {
      unmatched.push({ operator, label: loc.label ?? "(unnamed)", locationId: loc.locationId,
                       rows: loc.rows, url, platform,
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
                            zipCoord: byZip.get(dir.zip), runId });
    const bad = validateSource(m, new Set());
    if (bad.length) { skip.push({ id, why: bad.join("; ") }); continue; }
    seen.add(id);
    write.push({ id, json: m, rows: loc.rows, town: `${dir.city}, ${dir.state} ${dir.zip}` });
  }
  return { ok: true, operator, locations: byLoc.size, write, skip, unmatched };
}

async function get(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" },
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
  const known = JSON.parse(io.readText("data/known-elevators.json")).elevators;
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
  const found = [], noBoard = [], unreadable = [], wrote = [], unmatched = [];
  for (const [i, s] of sites.entries()) {
    const r = await io.get(s.board, cfg.timeoutMs);
    if (!r.ok || r.status !== 200 || (r.bytes ?? 0) < 300) {
      noBoard.push({ ...s, why: r.ok ? `HTTP ${r.status} (${r.bytes}B)` : `unreachable: ${String(r.error).slice(0, 40)}` });
      console.log(`── [${i + 1}/${sites.length}] ${s.site}  ${noBoard[noBoard.length - 1].why}`);
      continue;
    }
    let rows;
    try { rows = adapterFor(s.platform, await sharedFor(s.platform))(r.body, s.board); }
    catch (e) {
      unreadable.push({ ...s, why: String(e.message).slice(0, 160) });
      console.log(`── [${i + 1}/${sites.length}] ${s.site}  [${s.platform}] BOARD REFUSED: ${String(e.message).slice(0, 100)}`);
      continue;
    }
    if (!rows.length) {
      unreadable.push({ ...s, why: "read, but no rows" });
      console.log(`── [${i + 1}/${sites.length}] ${s.site}  [${s.platform}] read, but no rows`);
      continue;
    }
    const plan = planSite({ html: r.body, url: s.board, site: s.site, platform: s.platform,
                            rows, known, byZip, existingIds: seenIds, have, runId });
    if (!plan.ok) {
      unreadable.push({ ...s, why: plan.why });
      console.log(`── [${i + 1}/${sites.length}] ${s.site}  [${s.platform}] ${plan.why}`);
      continue;
    }
    found.push({ ...s, operator: plan.operator, locations: plan.locations, rows: rows.length });
    console.log(`── [${i + 1}/${sites.length}] ${s.site}\n   [${s.platform}] ${plan.operator} — `
      + `${plan.locations} location(s), ${rows.length} row(s)`);
    for (const w of plan.write) { console.log(`     + ${w.id.padEnd(38)} ${w.town}  ${w.rows} row(s)`); seenIds.add(w.id); }
    for (const u of plan.unmatched) console.log(`     - ${String(u.label).padEnd(24)} NO DIRECTORY MATCH — no town, so no manifest`);
    wrote.push(...plan.write.map((w) => ({ ...w, file: join(SOURCES, `${w.id}.json`) })));
    unmatched.push(...plan.unmatched);
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
    const csv = ["operator,label,locationId,rows,commodities,platform,board"]
      .concat(unmatched.map((u) => [u.operator, u.label, u.locationId, u.rows, u.commodities, u.platform, u.url].map(esc).join(",")))
      .join("\n") + "\n";
    if (cfg.write) writeFileSync(join(DATA, "gaps", "board-sweep-unplaced.csv"), csv);
    console.log(`\n── ${unmatched.length} LOCATION(S) POSTING REAL PRICES WITH NO TOWN WE CAN NAME`);
    for (const u of unmatched.slice(0, 25))
      console.log(`   ${String(u.operator).padEnd(30)} ${String(u.label).padEnd(22)} ${u.rows} row(s)  ${u.platform}`);
    if (unmatched.length > 25) console.log(`   … and ${unmatched.length - 25} more`);
    console.log(`   ${cfg.write ? "written to" : "would be written to"} data/gaps/board-sweep-unplaced.csv`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`::error::${e.stack || e}`); process.exit(1); });
}

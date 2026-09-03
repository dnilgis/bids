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
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseBoard, extract, mergeQuotes, quoteUrls, VERIFIED_BY, cellText }
  from "../lib/adapters/agricharts.mjs";
import { validateSource } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCES = join(ROOT, "sources");
const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)";

/* ---------- flags ---------- */

export function parseArgs(argv) {
  const out = { write: false, limit: Infinity, start: 0, timeoutMs: 20000,
                hosts: null, only: null, map: "data/agricharts-mobile.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--start") out.start = Number(argv[++i]);
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === "--hosts") out.hosts = argv[++i];
    else if (a === "--only") out.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--map") out.map = argv[++i];
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

/* ---------- naming what we found ---------- */

/** "Cash Prices - Legacy Farmers Cooperative mobile site" -> the operator. */
export function operatorFrom(html) {
  const t = (String(html).match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1];
  if (!t) return null;
  let s = cellText(t).replace(/^cash\s*prices\s*[-–—:]\s*/i, "");
  s = s.replace(/\s*[-–—]\s*mobile(\s*site)?$/i, "").replace(/\s+mobile\s*site$/i, "");
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

/* ---------- the directory join ---------- */

/* THE ONLY HONEST SOURCE FOR A TOWN. data/known-elevators.json is Barchart's
   own directory: facility, branch, city, state, ZIP, phone. A board's section
   heading is the operator's own name for the place, and it matches the
   directory's `branch` on most of them. No match means no manifest — a town
   nobody published is a town this project does not know. */
export function joinDirectory(known, operator, label) {
  const o = slug(operator), l = slug(label);
  if (!l) return null;
  const sameOperator = (k) => {
    const f = slug(k.facility);
    return f.includes(o.slice(0, 8)) || o.includes(f.slice(0, 8));
  };
  const rows = known.filter(sameOperator);
  return rows.find((k) => slug(k.branch) === l)
      ?? rows.find((k) => slug(k.city) === l)
      ?? null;
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

export function manifestFor({ id, operator, website, url, loc, dir, zipCoord, runId }) {
  const bands = { corn: [2.0, 12.0], soybean: [6.0, 32.0], wheat: [3.0, 20.0] };
  if ([...loc.commodities].some((c) => /waxy/i.test(c))) bands.waxy = [2.0, 12.0];
  const m = {
    id, operator, location: dir.branch, state: dir.state,
    platform: "agricharts", url, locationId: loc.locationId,
    identityAlternative: VERIFIED_BY,
    bands,
    cadence: "grain-day", provenance: "scraped", enabled: true,
    note: `WRITTEN BY scripts/agricharts-sweep.mjs${runId ? ` (run ${runId})` : ""} from their own `
      + `mobile board at ${url}. locationId ${loc.locationId} is the l= parameter on this `
      + `location's own chart links, which every row of every AgriCharts board carries; it is NOT `
      + `the section heading, which is a display name and can be re-typed. At the time of writing `
      + `this location showed ${loc.rows} row(s) in ${[...loc.commodities].join(", ")}.\n\n`
      + `identityAlternative: this board publishes cash, basis and a futures CHANGE and no futures `
      + `price, so cash - basis = futures can never run on it. lib/board.mjs refuses such a source `
      + `unless it names what it publishes on instead AND every row carries that stamp from the `
      + `adapter. The board was read and both of the adapter's checks passed before this file was `
      + `written: every location on it implies the same futures for one commodity and one delivery `
      + `code, and every row sits within 5c of a real quoted CBOT contract. futuresPriceCents `
      + `publishes as null, because there is no quote to republish.\n\n`
      + `Company, branch, town, state, ZIP and phone are copied verbatim from `
      + `data/known-elevators.json. Website is the "Visit Our Main Website" link on their own `
      + `mobile board.`,
    publicNote: PUBLIC_NOTE,
    address: null,
    zip: dir.zip ?? null,
    lat: zipCoord ? zipCoord.lat : null,
    lon: zipCoord ? zipCoord.lon : null,
    ...(zipCoord ? { latPrecision: "town" } : {}),
    phone: phoneOf(dir.phone),
    email: null,
    website,
    inMerge: true,
    _pending: "cashRounding is NOT set and must not be guessed; it is measured from a real board "
      + "against real futures. "
      + (zipCoord
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
export function planBoard({ html, url, site, rows, known, byZip, existingIds, runId = null }) {
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
    const dir = joinDirectory(known, operator, loc.label);
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
    const m = manifestFor({ id, operator, website, url, loc, dir, zipCoord: byZip.get(dir.zip), runId });
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

export async function main(argv = process.argv.slice(2)) {
  const cfg = parseArgs(argv);
  const runId = process.env.GITHUB_RUN_ID || null;

  const platforms = JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8"));
  let hosts = cfg.hosts
    ? readFileSync(cfg.hosts, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l))
    : agrichartsHosts(platforms);
  if (cfg.only) hosts = hosts.filter((h) => cfg.only.some((o) => h.includes(o)));
  hosts = hosts.slice(cfg.start, cfg.start + cfg.limit);

  console.log(`AGRICHARTS SWEEP — ${hosts.length} site(s)${cfg.write ? "" : "  (DRY RUN: --write to write files)"}`);

  /* The quote pages first: without them no board can be checked and no manifest
     may be written. Seven requests for the whole sweep. */
  const quoteBodies = [];
  for (const u of quoteUrls()) {
    const r = await get(u, cfg.timeoutMs);
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
  const zipRows = JSON.parse(readFileSync(join(ROOT, "geocodes/zip-candidates.json"), "utf8")).zips;
  const byZip = new Map(zipRows.map((z) => [z.zip, z]));
  const existing = new Set(readdirSync(SOURCES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));

  const found = [], noBoard = [], unreadable = [], wrote = [], skipped = [], unmatched = [];
  const seenIds = new Set(existing);

  for (const [i, site] of hosts.entries()) {
    const cands = mobileCandidates(site);
    let hit = null;
    for (const c of cands) {
      const r = await get(c, cfg.timeoutMs);
      if (!r.ok) { continue; }
      if (r.status !== 200 || r.bytes < 400) continue;
      if (!/cash\s*price/i.test(r.body) || !/<table class="cashprices"/.test(r.body)) continue;
      hit = { url: c, body: r.body };
      break;
    }
    if (!hit) { noBoard.push(site); console.log(`── [${i + 1}/${hosts.length}] ${site}  no mobile board (${cands.length} tried)`); continue; }

    /* THE BOARD HAS TO PASS EXACTLY WHAT A POLL WOULD PUT IT THROUGH. A board
       that cannot be read today produces no sources today. */
    let rows;
    try { rows = extract(hit.body, hit.url, { contracts }); }
    catch (e) {
      unreadable.push({ site: hit.url, why: `${e.constructor.name}: ${String(e.message).slice(0, 160)}` });
      console.log(`── [${i + 1}/${hosts.length}] ${site}  BOARD REFUSED: ${String(e.message).slice(0, 120)}`);
      continue;
    }

    const plan = planBoard({ html: hit.body, url: hit.url, site, rows, known, byZip,
                             existingIds: seenIds, runId });
    if (!plan.ok) { unreadable.push({ site: hit.url, why: plan.why }); continue; }
    found.push({ site, url: hit.url, operator: plan.operator, locations: plan.locations, rows: rows.length });
    console.log(`── [${i + 1}/${hosts.length}] ${site}\n   ${plan.operator} — ${hit.url} — `
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
  console.log(`   ${found.length} board(s) found  ·  ${noBoard.length} with no mobile board  ·  ${unreadable.length} refused`);
  console.log(`   ${wrote.length} manifest(s) ${cfg.write ? "WRITTEN" : "would be written"}  ·  `
    + `${skipped.length} skipped  ·  ${unmatched.length} location(s) with no town`);
  if (unreadable.length) {
    console.log(`\n── BOARDS THAT WOULD NOT READ (${unreadable.length})`);
    for (const u of unreadable.slice(0, 20)) console.log(`   ${u.site}  ${u.why}`);
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

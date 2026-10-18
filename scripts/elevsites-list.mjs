#!/usr/bin/env node
/* WHICH UNREAD ELEVATORS HAVE A WEBSITE WE ALREADY HOLD, AND WHICH ONE.
 *
 * 2026-10-18. Input: data/directory.json (rows with no reader). The website
 * is not in the directory for any of them, so it is joined from everywhere the
 * repository keeps a URL beside a business name:
 *
 *   sources/*.json                 the same company already read somewhere (website)
 *   data/roster/*.json             the frozen Barchart roster's website field
 *   probe-lists/*.txt              "url  # Business name; town, ST ..." comments
 *   data/gaps/website-candidates.csv  urlfinder leads (NOT proved by phone)
 *   data/platforms.json            discover's bare sites, matched by host spelling
 *
 * Rows marked duplicateSuspect are counted but do not make a company a target
 * on their own: they are a town where we already read an elevator.
 *
 * Writes:
 *   data/gaps/elevsites.json       one entry per company: names, rows, states,
 *                                  towns, every candidate site and where it came from
 *   probe-lists/elevsites.txt      the pages to capture, Upper Midwest first
 *
 *   node scripts/elevsites-list.mjs [--out data/gaps/elevsites.json] [--list probe-lists/elevsites.txt]
 *
 * A match is a lead for one polite capture, never a claim about a business.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { familyOf, namesMatch, hostMatches, hostOf, isSharedHost, UPPER_MIDWEST } from "../lib/elevsites.mjs";
import { isDenied } from "./urlfinder.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const rd = (p) => readFileSync(join(ROOT, p), "utf8");

export function parseListLine(line) {
  const m = String(line).match(/(https?:\/\/\S+)/i);
  if (!m) return null;
  const url = m[1];
  const after = String(line).slice(String(line).indexOf(url) + url.length);
  let name = "", place = "";
  const hash = after.indexOf("#");
  const pre = (hash >= 0 ? after.slice(0, hash) : after).trim();   // dtn-sites.txt puts the name before the comment
  let c = hash >= 0 ? after.slice(hash + 1) : "";
  c = c.replace(/^\s*\[[^\]]*\]\s*/, "").replace(/^\s*\d+\s*[—-]+\s*/, "").trim();
  const head = c.split(/\s+--\s+|\s+—\s+|;|:/)[0].trim();
  name = pre && !/^\d/.test(pre) ? pre : head;
  const pm = c.match(/;\s*([A-Za-z .'-]+),\s*([A-Z]{2})\b/);
  if (pm) place = `${pm[1].trim()}, ${pm[2]}`;
  if (/^\d+ locations?/i.test(name)) name = "";
  return { url, name: name.slice(0, 120), place };
}

/* Every (url, name) pair the repository holds. */
export function gatherSites(root = ROOT) {
  const R = (p) => readFileSync(join(root, p), "utf8");
  const named = [];   // {url, name, from}
  const bare = [];    // {url, from}
  for (const f of readdirSync(join(root, "sources")).filter((f) => f.endsWith(".json"))) {
    const s = JSON.parse(R(`sources/${f}`));
    const site = s.website || (s.url && !isSharedHost(hostOf(s.url)) ? new URL(s.url).origin + "/" : null);
    if (site && s.operator) named.push({ url: site, name: s.operator, from: `sources/${f}`, read: true });
  }
  const rosterDir = join(root, "data/roster");
  if (existsSync(rosterDir)) for (const f of readdirSync(rosterDir).filter((f) => f.endsWith(".json"))) {
    for (const r of JSON.parse(R(`data/roster/${f}`)).facilities ?? [])
      for (const u of [r.board_url, r.website]) if (u && /^https?:/i.test(u)) named.push({ url: u, name: r.operator, from: `roster:${f}` });
  }
  for (const f of readdirSync(join(root, "probe-lists")).filter((f) => f.endsWith(".txt") && !f.startsWith("elevsites"))) {
    for (const line of R(`probe-lists/${f}`).split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const p = parseListLine(line);
      if (!p) continue;
      if (p.name) named.push({ url: p.url, name: p.name, from: `probe-lists/${f}` });
      else bare.push({ url: p.url, from: `probe-lists/${f}` });
    }
  }
  const wc = join(root, "data/gaps/website-candidates.csv");
  if (existsSync(wc)) {
    const rows = csvRows(R("data/gaps/website-candidates.csv"));
    const h = rows.shift() ?? [];
    const I = (k) => h.indexOf(k);
    for (const r of rows) if (r[I("url")]) named.push({ url: r[I("url")], name: r[I("name")], from: "website-candidates (not proved)", unproved: true });
  }
  const pf = join(root, "data/platforms.json");
  if (existsSync(pf)) for (const [url, s] of Object.entries(JSON.parse(R("data/platforms.json")).sites ?? {}))
    if (s.status !== "unreachable") bare.push({ url, from: `platforms.json:${s.platform ?? s.status}` });
  return { named, bare };
}

function csvRows(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function buildWorklist(directory, sites) {
  const fams = new Map();
  for (const e of directory.elevators.filter((e) => !e.platform)) {
    const k = familyOf(e.operator);
    if (!k) continue;
    if (!fams.has(k)) fams.set(k, { company: k, names: new Set(), rows: 0, dupRows: 0, upperMidwest: 0, states: {}, towns: [], ids: [] });
    const f = fams.get(k);
    f.names.add(e.operator); f.rows++;
    if (e.duplicateSuspect) f.dupRows++;
    if (UPPER_MIDWEST.has(e.state)) f.upperMidwest++;
    f.states[e.state] = (f.states[e.state] ?? 0) + 1;
    if (f.towns.length < 60) f.towns.push(`${e.location}, ${e.state}`);
    f.ids.push(e.id);
  }
  const byFam = new Map();
  for (const s of sites.named) {
    const k = familyOf(s.name);
    if (!byFam.has(k)) byFam.set(k, []);
    byFam.get(k).push(s);
  }
  const out = [];
  for (const f of fams.values()) {
    const cands = new Map();
    const add = (s, how) => {
      const h = hostOf(s.url);
      if (!h || isDenied(h)) return;
      const key = s.url.replace(/#.*$/, "");
      if (!cands.has(key)) cands.set(key, { url: key, host: h, from: [], how, read: false, unproved: true });
      const c = cands.get(key);
      if (!c.from.includes(s.from)) c.from.push(s.from);
      if (s.read) c.read = true;
      if (!s.unproved) c.unproved = false;
    };
    for (const s of byFam.get(f.company) ?? []) add(s, "family");
    if (!cands.size) for (const s of sites.named) if ([...f.names].some((n) => namesMatch(n, s.name))) add(s, "name");
    if (!cands.size) for (const s of sites.bare) if ([...f.names].some((n) => hostMatches(hostOf(s.url), n))) add({ ...s, unproved: false }, "host");
    const real = f.rows - f.dupRows;
    out.push({ company: f.company, names: [...f.names].slice(0, 12), rows: f.rows, realRows: real, dupRows: f.dupRows,
      upperMidwest: f.upperMidwest, states: f.states, towns: f.towns, sites: [...cands.values()].slice(0, 6),
      alsoRead: [...cands.values()].some((c) => c.read) });
  }
  return out.sort((a, b) => (b.upperMidwest > 0) - (a.upperMidwest > 0) || b.realRows - a.realRows || a.company.localeCompare(b.company));
}

/* The pages to capture: for each company with a site, its home page, plus the
   exact board page when a list named one. Companies whose rows are all
   duplicate-suspect are left out. */
export function captureUrls(worklist, max = 3) {
  const urls = [];
  for (const c of worklist) {
    if (!c.realRows || !c.sites.length) continue;
    const mine = new Set();
    for (const s of c.sites) {
      if (isSharedHost(s.host)) { mine.add(s.url); continue; }
      mine.add(new URL(s.url).origin + "/");
      if (new URL(s.url).pathname.length > 1) mine.add(s.url);
    }
    for (const u of [...mine].slice(0, max)) urls.push({ url: u, company: c.company });
  }
  const seen = new Set();
  return urls.filter((u) => !seen.has(u.url) && seen.add(u.url));
}

function main() {
  const a = process.argv.slice(2);
  const flag = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  const out = flag("out", "data/gaps/elevsites.json"), list = flag("list", "probe-lists/elevsites.txt");
  const dir = JSON.parse(rd("data/directory.json"));
  const wl = buildWorklist(dir, gatherSites());
  const urls = captureUrls(wl);
  const withSite = wl.filter((c) => c.realRows && c.sites.length);
  const counts = { companies: wl.length, realRows: wl.reduce((s, c) => s + c.realRows, 0),
    companiesWithSite: withSite.length, rowsWithSite: withSite.reduce((s, c) => s + c.realRows, 0),
    upperMidwestRowsWithSite: withSite.reduce((s, c) => s + c.upperMidwest, 0), pages: urls.length };
  writeFileSync(join(ROOT, out), JSON.stringify({ generated: dir.generated, built: new Date().toISOString(),
    note: "Unread elevators grouped by company, with every website the repository already holds for each. "
      + "A site here is a lead for one capture (scripts/capture-pages.mjs --follow), never a claim that the business posts bids. "
      + "Companies with no site on file keep only their counts (urlfinder.mjs is the tool for those). "
      + "Written by scripts/elevsites-list.mjs.", counts,
    companies: wl.map((c) => c.sites.length ? c : { company: c.company, rows: c.rows, realRows: c.realRows,
      upperMidwest: c.upperMidwest, states: c.states, sites: [] }) }, null, 1) + "\n");
  writeFileSync(join(ROOT, list), "# UNREAD ELEVATORS' OWN SITES, FOR capture.yml (list=probe-lists/elevsites.txt, follow=3).\n"
    + `# Built by scripts/elevsites-list.mjs from data/directory.json of ${dir.generated}. Upper Midwest first.\n`
    + `# ${counts.companiesWithSite} companies with a site on file, ${counts.rowsWithSite} unread rows behind them.\n`
    + urls.map((u) => `${u.url}  # ${u.company}`).join("\n") + "\n");
  console.log(JSON.stringify(counts));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();

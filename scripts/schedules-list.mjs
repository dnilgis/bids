#!/usr/bin/env node
/* WHERE EACH ELEVATOR COMPANY MIGHT POST ITS GRAIN DISCOUNT, SHRINK, DRYING
 * AND STORAGE SCHEDULES: ONE HOME PAGE PER COMPANY TO START FROM.
 *
 * 2026-10-18. For agsist's "which elevator really pays more" work (not
 * published). Two kinds of company:
 *
 *   read     every company we already read (sources/*.json): its website, or
 *            the origin of its bid page when that is the company's own host
 *   unread   the first elevsites round's "posts bids" companies, passed in
 *            with --unread FILE (one "url  # COMPANY" line each, the seed
 *            pages from probe-lists/elevsites.txt), Upper Midwest first
 *
 * Writes probe-lists/schedules.txt ("url  # R:<operator>" or "# U:<company>")
 * and probe-lists/schedules.json (the worklist capture.yml copies beside the
 * captures: per company its names, read or not, locations and states).
 *
 *   node scripts/schedules-list.mjs --unread /path/unread-seeds.txt
 *
 * capture.yml list=probe-lists/schedules.txt pick=schedule follow=6 depth=2
 * save=schedules. A home page here is where to look, never a claim.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostOf, isSharedHost, UPPER_MIDWEST } from "../lib/elevsites.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

export function readCompanies(root = ROOT) {
  const by = new Map();
  for (const f of readdirSync(join(root, "sources")).filter((f) => f.endsWith(".json")).sort()) {
    const s = JSON.parse(readFileSync(join(root, "sources", f), "utf8"));
    if (s.enabled === false) continue;
    let site = s.website || null;
    if (!site && s.url) { try { if (!isSharedHost(hostOf(s.url))) site = new URL(s.url).origin + "/"; } catch { /* no site */ } }
    if (!site || !/^https?:/i.test(site)) continue;
    let origin;
    try { origin = new URL(site).origin + "/"; } catch { continue; }
    const h = hostOf(origin);
    if (!h || isSharedHost(h)) continue;
    if (!by.has(h)) by.set(h, { url: origin, names: new Set(), locations: 0, states: {} });
    const e = by.get(h);
    if (s.operator) e.names.add(String(s.operator).slice(0, 120));
    e.locations++;
    if (s.state) e.states[s.state] = (e.states[s.state] ?? 0) + 1;
  }
  return [...by.values()].map((e) => {
    const names = [...e.names].sort((a, b) => a.length - b.length);
    const um = Object.entries(e.states).reduce((n, [st, k]) => n + (UPPER_MIDWEST.has(st) ? k : 0), 0);
    return { company: `R:${names[0] ?? hostOf(e.url)}`, read: true, names: names.slice(0, 12), url: e.url,
             locations: e.locations, upperMidwest: um, states: e.states };
  });
}

export function unreadCompanies(seedText, readHosts) {
  const by = new Map();
  for (const line of String(seedText).split(/\r?\n/)) {
    const m = line.match(/^\s*(https?:\/\/\S+)\s*#\s*(.+?)\s*$/);
    if (!m) continue;
    let origin;
    try { origin = new URL(m[1]).origin + "/"; } catch { continue; }
    const h = hostOf(origin);
    if (!h || isSharedHost(h) || readHosts.has(h) || by.has(m[2])) continue;
    by.set(m[2], { company: `U:${m[2]}`, read: false, names: [m[2]], url: origin, locations: 0, upperMidwest: 0, states: {} });
  }
  return [...by.values()];
}

export function buildList(read, unread) {
  const rank = (a, b) => (b.upperMidwest > 0) - (a.upperMidwest > 0) || b.locations - a.locations || a.company.localeCompare(b.company);
  const all = [...read.sort(rank), ...unread];
  const seen = new Set();
  return all.filter((c) => { const h = hostOf(c.url); if (seen.has(h)) return false; seen.add(h); return true; });
}

function main() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--unread");
  const read = readCompanies();
  const unread = i >= 0 && existsSync(a[i + 1]) ? unreadCompanies(readFileSync(a[i + 1], "utf8"), new Set(read.map((c) => hostOf(c.url)))) : [];
  const list = buildList(read, unread);
  const hdr = ["# GRAIN DISCOUNT, SHRINK, DRYING AND STORAGE SCHEDULES, FOR capture.yml (list=probe-lists/schedules.txt,",
    "#   pick=schedule, follow=6, depth=2, save=schedules). Built by scripts/schedules-list.mjs on " + new Date().toISOString().slice(0, 10) + ".",
    `# ${list.filter((c) => c.read).length} companies we read (R:) then ${list.filter((c) => !c.read).length} unread companies whose sites post bids (U:).`];
  writeFileSync(join(ROOT, "probe-lists/schedules.txt"), [...hdr, ...list.map((c) => `${c.url}  # ${c.company}`)].join("\n") + "\n");
  writeFileSync(join(ROOT, "probe-lists/schedules.json"), JSON.stringify({ built: new Date().toISOString(),
    note: "One home page per company to look for grain discount, shrink, drying and storage schedules. A lead, not a claim.",
    companies: list.map(({ url, ...c }) => ({ ...c, sites: [{ url }] })) }, null, 1) + "\n");
  console.log(`${list.length} companies (${list.filter((c) => c.read).length} read)`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();

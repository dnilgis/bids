#!/usr/bin/env node
/* WHAT EACH CANDIDATE LIST IS WORTH TODAY.
 *
 * The Run workflow form used to carry these numbers in its input descriptions,
 * and every one of them had gone stale: "national — 487 pages" (475),
 * "sweep-2-wi-mn — 15 still unasked" (34), "discover-candidates — the original
 * 56, spent" (136 entries, 109 of them undecided). A number typed into a form
 * is a number nobody updates.
 *
 * So the form carries no counts and this prints them, from the lists and the
 * ledger, at the top of every run. It reads only; it decides nothing.
 *
 * "owed" uses discover.mjs's own --resume rule, read out of that file rather
 * than copied — the same way sweep-plan.mjs and unfinished_sites.mjs do it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(ROOT, "scripts/discover.mjs"), "utf8");
const pv = /export const PROBE_VERSION\s*=\s*(\d+)/.exec(src);
if (!pv) { console.error("could not read PROBE_VERSION out of scripts/discover.mjs"); process.exit(2); }
const PROBE_VERSION = Number(pv[1]);

const ledgerPath = join(ROOT, "data/platforms.json");
const sites = existsSync(ledgerPath)
  ? (JSON.parse(readFileSync(ledgerPath, "utf8")).sites ?? {}) : {};

const decided = new Set(Object.entries(sites)
  .filter(([, v]) => v?.status === "platform"
                  || (v?.status === "no-platform" && (v?.probeVersion ?? 0) >= PROBE_VERSION))
  .map(([k]) => k));

/** The first whitespace-separated token of each non-comment line, deduplicated. */
export function entriesOf(text) {
  return [...new Set(String(text ?? "").split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map((s) => s.split(/\s+/)[0]))];
}

const rows = [];
for (const f of readdirSync(join(ROOT, "probe-lists")).filter((x) => x.endsWith(".txt")).sort()) {
  const all = entriesOf(readFileSync(join(ROOT, "probe-lists", f), "utf8"));
  rows.push({ list: f, entries: all.length, owed: all.filter((u) => !decided.has(u)).length });
}

const ledgerOwed = Object.entries(sites)
  .filter(([, v]) => v?.status !== "platform"
                  && !(v?.status === "no-platform" && (v?.probeVersion ?? 0) >= PROBE_VERSION)).length;

console.log(`WHAT EACH LIST IS WORTH — against probe v${PROBE_VERSION}, ` +
            `${Object.keys(sites).length} site(s) in the ledger\n`);
console.log(`  ${"list".padEnd(38)} ${"entries".padStart(8)} ${"still owed an ask".padStart(18)}`);
console.log(`  ${"unfinished (the ledger itself)".padEnd(38)} ${String(Object.keys(sites).length).padStart(8)} ${String(ledgerOwed).padStart(18)}`);
for (const r of rows)
  console.log(`  ${r.list.padEnd(38)} ${String(r.entries).padStart(8)} ${String(r.owed).padStart(18)}`);
console.log(`\n"still owed" is discover's own --resume rule: a site is decided only when it ` +
            `runs a\nplatform we named, or when a probe at least this version looked and found ` +
            `none. An\nunreachable page is never decided.`);

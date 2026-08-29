#!/usr/bin/env node
/* WHAT THE SWEEP FOUND, AND HOW MUCH OF IT IS A CONFIG ROW RATHER THAN CODE.
 *
 * This is the question the whole Barchart sweep exists to answer. bushel and
 * dtn-cs carry 97% of everything this project reads, and both have adapters. So
 * every operator the sweep lands on one of those platforms is a SOURCE FILE
 * away from a green pin — no new parser, no new code. An operator on a platform
 * with no adapter is real work, and belongs in a different queue.
 *
 * Grey is honest. Grey is not a bid. This says how many can stop being grey
 * cheaply, which is the only number that decides what gets built next.
 *
 *   node scripts/platform_report.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SIGNATURES } from "./discover.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const LEDGER = join(ROOT, "data/platforms.json");
if (!existsSync(LEDGER)) {
  console.log("no data/platforms.json yet — run the discover sweep first");
  process.exit(0);
}
const sites = JSON.parse(readFileSync(LEDGER, "utf8")).sites || {};
const all = existsSync(join(ROOT, "probe-lists/barchart-sites.txt"))
  ? readFileSync(join(ROOT, "probe-lists/barchart-sites.txt"), "utf8")
      .split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"))
  : [];

const adapterFor = new Map(SIGNATURES.map((s) => [s.platform, s.adapter]));
const decided = Object.entries(sites).filter(([, v]) => v.status !== "unreachable");
const byPlatform = new Map();
let withAdapter = 0, withId = 0, noPlatform = 0, unreachable = 0;

for (const [, v] of Object.entries(sites)) {
  if (v.status === "unreachable") { unreachable++; continue; }
  if (v.status !== "platform" || !v.platform) { noPlatform++; continue; }
  byPlatform.set(v.platform, (byPlatform.get(v.platform) ?? 0) + 1);
  if (adapterFor.get(v.platform)) {
    withAdapter++;
    /* AN ADAPTER WITHOUT THE ID IS NOT A SOURCE FILE. Knowing a board is Bushel
       and not knowing its locationId names the adapter and writes nothing. The
       two are counted apart so "a config row away" means what it says. */
    if ((v.ids || []).some((i) => Object.values(i).some((x) => x && typeof x !== "object"
        && i.platform !== x && i.adapter !== x))) withId++;
  }
}

/* THE DENOMINATOR IS THE LEDGER, NOT ONE LIST -- 2026-08-29.
 *
 * This printed, on the run that finished the sweep:
 *
 *     BARCHART SWEEP — 646 host(s) to ask, 868 asked so far
 *        696 decided (108%), 172 unreachable
 *        -222 not yet asked
 *
 * 108% and a negative count, on the headline number of the whole project.
 *
 * `all` is probe-lists/barchart-sites.txt, which barchart_sites.mjs REBUILDS
 * every run and which SHRINKS as sources get written -- it skips any host we
 * already read. The ledger only grows, and since 2026-08-29 it also holds every
 * host from the national and candidate lists, which were never in `all` at all.
 * Dividing one by the other stopped meaning anything the moment those two
 * populations diverged.
 *
 * So: percentages are against everything ASKED, which is what the ledger is a
 * record of. "not yet asked" is counted by membership, never by subtraction --
 * a subtraction between two different populations is how you get -222. */
const asked = new Set(Object.keys(sites));
const waiting = all.filter((u) => !asked.has(u));
const pct = (n, d) => (d ? ` (${Math.round((100 * n) / d)}%)` : "");
console.log(`DISCOVER LEDGER — ${asked.size} host(s) asked, ${all.length} on the current list`);
console.log(`   ${decided.length} decided${pct(decided.length, asked.size)}, ` +
            `${unreachable} unreachable${pct(unreachable, asked.size)} (they come round again)`);
console.log(`   ${waiting.length} on the list and not yet asked\n`);

console.log("what they run:");
for (const [p, n] of [...byPlatform].sort((a, b) => b[1] - a[1])) {
  const a = adapterFor.get(p);
  console.log(`   ${String(n).padStart(4)}  ${p}${a ? "" : "   <- NO ADAPTER; this is the build queue"}`);
}
if (noPlatform) console.log(`   ${String(noPlatform).padStart(4)}  loaded, nothing recognised`);

console.log(`\n${withAdapter} host(s) run a platform we ALREADY READ` +
            `${pct(withAdapter, decided.length)} — of those, ${withId} also gave up the id ` +
            `a source file needs.`);
console.log(`Those ${withId} are a config row each, not a scraper. That is the cheapest`);
console.log(`grey-to-green there is, and it is why this sweep exists.`);

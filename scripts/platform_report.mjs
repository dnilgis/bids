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

const pct = (n, d) => (d ? ` (${Math.round((100 * n) / d)}%)` : "");
console.log(`BARCHART SWEEP — ${all.length} host(s) to ask, ${decided.length + unreachable} asked so far`);
console.log(`   ${decided.length} decided${pct(decided.length, all.length)}, ` +
            `${unreachable} unreachable (they come round again)`);
console.log(`   ${all.length - decided.length - unreachable} not yet asked\n`);

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

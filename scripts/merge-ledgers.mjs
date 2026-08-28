/* Fold the per-shard discover ledgers back into data/platforms.json.
 *
 * WHY THIS EXISTS
 *
 * discover.mjs is strictly serial: one browser page at a time, 45 seconds of
 * patience each, measured at about 53 seconds a host. That is why one sweep
 * run asks 45 hosts in a 40-minute budget and why 614 hosts took days.
 *
 * The fix is not a longer run. poll.yml already records what that costs: a job
 * that holds a runner for fifty of every sixty minutes looks like a persistent
 * server to Actions and gets throttled, and delivery fell from 81% to 31%. The
 * fix is MORE runners for a SHORT time -- GitHub Free allows 20 concurrent
 * jobs, and this repository is public, so the minutes are unlimited.
 *
 * Twenty shards each take a disjoint slice of the same list. They cannot all
 * commit to data/platforms.json without racing, so each writes its own ledger,
 * uploads it as an artifact, and this script merges them in one job that
 * commits once.
 *
 * THE SLICES ARE DISJOINT BECAUSE EVERY SHARD STARTS FROM THE SAME LEDGER.
 * discover.mjs --resume filters the list against the ledger FIRST and applies
 * --start/--limit to what is left. So every shard must be handed the SAME
 * committed data/platforms.json, or their pools differ, their offsets mean
 * different things, and two shards ask the same host while a third is never
 * asked at all. The workflow copies the committed file into each shard.
 *
 * A SHARD MAY NEVER DOWNGRADE A DECIDED HOST.
 * If the base already knows a host runs bushel and a shard timed out on it
 * this once, keeping the timeout would lose a fact we had. Merge order is
 * newest-wins EXCEPT that `status: platform` is never replaced by anything
 * else. Counted and printed, so a run that loses ground says so.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [, , shardDir = "shard-ledgers", outPath = "data/platforms.json"] = process.argv;

const base = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : { sites: {} };
base.sites ||= {};

const before = Object.keys(base.sites).length;
let added = 0, updated = 0, keptBetter = 0, files = 0;

if (!existsSync(shardDir)) {
  console.log(`no ${shardDir}/ — nothing to merge`);
  process.exit(0);
}

/* actions/download-artifact drops each artifact into its own subdirectory, so
   walk one level down as well as the top. Missing files are not an error: a
   shard that found nothing new uploads nothing, and a shard that failed is
   exactly the case this must survive. */
const candidates = [];
for (const e of readdirSync(shardDir, { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith(".json")) candidates.push(join(shardDir, e.name));
  else if (e.isDirectory())
    for (const f of readdirSync(join(shardDir, e.name)))
      if (f.endsWith(".json")) candidates.push(join(shardDir, e.name, f));
}

for (const path of candidates.sort()) {
  let shard;
  try { shard = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { console.log(`  SKIPPED ${path}: ${e.message}`); continue; }
  if (!shard || typeof shard.sites !== "object") { console.log(`  SKIPPED ${path}: no sites`); continue; }
  files++;
  let a = 0, u = 0, k = 0;
  for (const [url, v] of Object.entries(shard.sites)) {
    const had = base.sites[url];
    if (!had) { base.sites[url] = v; a++; continue; }
    if (had.status === "platform" && v.status !== "platform") { k++; continue; }
    if (JSON.stringify(had) !== JSON.stringify(v)) { base.sites[url] = v; u++; }
  }
  added += a; updated += u; keptBetter += k;
  console.log(`  ${path}: ${Object.keys(shard.sites).length} site(s) — ${a} new, ${u} updated, ${k} kept`);
}

base.generated = new Date().toISOString();
base.note = "What board each operator's own page actually calls. Written by " +
            "scripts/discover.mjs; merged across runs and across shards by " +
            "scripts/merge-ledgers.mjs, never clobbered. status=platform means " +
            "we know what it runs; ids carries the one fact a source file " +
            "cannot be written without.";
writeFileSync(outPath, JSON.stringify(base, null, 1) + "\n");

const after = Object.keys(base.sites).length;
console.log(`\nmerged ${files} shard ledger(s): ${before} -> ${after} decided ` +
            `(+${added} new, ${updated} updated, ${keptBetter} kept because the ` +
            `shard would have downgraded a known platform)`);

/* Work out the slices for the sharded sweep, and write the exact list the
 * shards will read.
 *
 * THIS EXISTS BECAUSE THE ARITHMETIC HAS TO MATCH discover.mjs EXACTLY.
 *
 * discover.mjs --resume builds its pool as "every entry of the list the ledger
 * has not decided", and then applies --start/--limit to THAT. So if this
 * script's idea of the pool differs from discover's by even one entry, every
 * shard offset after that point is wrong: two shards ask the same host and a
 * third is never asked. Three things make them agree.
 *
 * ONE — THE SAME "DECIDED" RULE, and it is not "is in the ledger".
 *   discover.mjs counts a host as decided only when
 *       status === "platform"
 *     OR status === "no-platform" AND probeVersion >= PROBE_VERSION
 *   An `unreachable` comes round again, because that is a fact about the
 *   network and not about the operator, and a `no-platform` written by an
 *   older, weaker probe comes round again too. Counting `Object.keys(sites)`
 *   instead — the obvious thing — under-counts the pool and drifts every
 *   offset. PROBE_VERSION is read out of discover.mjs rather than copied, so
 *   the day it changes this does not quietly disagree.
 *
 * TWO — THE LISTS HAVE DUPLICATE LINES. Measured 2026-08-28:
 *       national-2026-08-26.txt   1119 lines, 1061 unique   58 duplicates
 *       discover-candidates.txt    271 lines,  257 unique   14
 *       agricharts-mobile.txt       98 lines,   80 unique   18
 *       bushel-candidates.txt       97 lines,   82 unique   15
 *       sweep-2-wi-mn.txt          114 lines,  103 unique   11
 *   Only barchart-sites.txt, the one a script regenerates, is clean. A
 *   duplicate inside one shard's slice is a wasted 53 seconds; a duplicate
 *   that straddles two shards is two runners asking the same stranger's server
 *   at the same moment. So the list is deduplicated here, ONCE, and the
 *   deduplicated file is what every shard reads.
 *
 * THREE — ONE FILE, NOT TWENTY REGENERATIONS. barchart-sites.txt is rebuilt
 *   from known-elevators.json and sources/, both of which can change while a
 *   sweep is running. Twenty shards each rebuilding it could get twenty
 *   slightly different lists. This writes it once and the workflow hands the
 *   same bytes to all of them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , listPath, ledgerPath = "data/platforms.json", outPath = "sweep-list.txt",
       shardsArg = "20", perArg = ""] = process.argv;

if (!listPath) {
  console.error("usage: sweep-plan.mjs <list.txt> [ledger.json] [out.txt] [shards] [per]");
  process.exit(2);
}

/* Read the probe version from discover.mjs rather than repeating the number.
   Importing the module would run its main(), so this reads the declaration. */
const src = readFileSync(new URL("./discover.mjs", import.meta.url), "utf8");
const pv = /export const PROBE_VERSION\s*=\s*(\d+)/.exec(src);
if (!pv) { console.error("could not read PROBE_VERSION out of scripts/discover.mjs"); process.exit(2); }
const PROBE_VERSION = Number(pv[1]);

const raw = readFileSync(listPath, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const all = [...new Set(raw)];
const dupes = raw.length - all.length;

let known = {};
if (existsSync(ledgerPath)) {
  try { known = JSON.parse(readFileSync(ledgerPath, "utf8")).sites || {}; }
  catch (e) { console.error(`ledger unreadable (${e.message}); treating as empty`); }
}

/* The rule, copied from discover.mjs --resume and nothing more. */
const done = new Set(Object.entries(known)
  .filter(([, v]) => v.status === "platform"
                  || (v.status === "no-platform" && (v.probeVersion ?? 0) >= PROBE_VERSION))
  .map(([k]) => k));

const pool = all.filter((u) => !done.has(u));
const left = pool.length;

const shards = Math.max(1, Math.min(256, Number(shardsArg) || 20));
const per = perArg ? Math.max(1, Number(perArg)) : Math.max(1, Math.ceil(left / shards));
const need = Math.max(1, Math.min(shards, Math.ceil(left / per)));

writeFileSync(outPath, all.join("\n") + "\n");

/* PROVE THE SLICES BEFORE TWENTY RUNNERS ACT ON THEM. Cheap, and it is the
   difference between finding an off-by-one here and finding it in the logs of
   twenty jobs that asked the wrong hosts. */
const seen = new Map();
for (let s = 0; s < need; s++)
  for (const u of pool.slice(s * per, s * per + per)) seen.set(u, (seen.get(u) ?? 0) + 1);
const overlap = [...seen.values()].filter((v) => v > 1).length;
const missed = pool.filter((u) => !seen.has(u)).length;
if (overlap || missed) {
  console.error(`::error title=slice check failed::${overlap} host(s) in two shards, ${missed} in none`);
  process.exit(1);
}

const out = {
  file: outPath, entries: all.length, duplicatesDropped: dupes,
  decided: done.size, left, shards: need, per, probeVersion: PROBE_VERSION,
};
console.log(JSON.stringify(out, null, 1));
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_OUTPUT,
    `file=${outPath}\nper=${per}\nleft=${left}\nshards=${need}\n` +
    `matrix=${JSON.stringify([...Array(need).keys()])}\n`);
}

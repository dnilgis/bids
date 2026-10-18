#!/usr/bin/env node
/* KEEP THE GENERATED MANIFESTS IN STEP WITH THE EVIDENCE THEY ARE BUILT FROM.
 *
 *     node scripts/regen-manifests.mjs            report only
 *     node scripts/regen-manifests.mjs --write    write new and changed manifests
 *
 * WHY. cih-, own-board- and stonehedge-manifests.mjs read data/known-elevators.json,
 * data/registries.json and the roster, and their tests hold sources/ to exactly
 * what they produce. On 2026-10-18 a dispatched sync_known.yml rewrote
 * data/known-elevators.json and committed it [skip ci]; the next push that ran
 * the tests found twelve yards the generators now identify and two notes that
 * now cite a different row, and main went red with nothing in the sync's own
 * log to say so. Each generator's own --write only ADDS, so the fix had to be
 * done by hand. The jobs that rewrite those inputs run this before they commit.
 *
 * WHAT IT DOES. A manifest the generator produces and sources/ lacks is
 * written. A generated manifest that differs from what the generator now
 * produces is rewritten (the generator owns the file; its test already refuses
 * any hand edit). A manifest on disk that the generator NO LONGER produces is
 * NEVER deleted here: that is a yard leaving the map, and on 2026-10-18 the
 * only one was a real Iowa yard dropped by a bad directory row. It is printed
 * and the exit code is 1, so the job stops and a person looks. */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = ROOT + "sources/";

/* Which files on disk each generator owns: the same selection its test uses. */
export const GENERATORS = [
  { name: "cih", owns: (m) => m.platform === "cih" },
  { name: "own-board", owns: (m) => ["newcoop", "nexus", "landus", "cpicoop", "fivestar"].includes(m.platform) },
  { name: "stonehedge", owns: (m, mod) => new RegExp(`^(${Object.keys(mod.SITES).join("|")})-`).test(m.id) },
];

export function compare(generated, onDisk) {
  const disk = new Map(onDisk.map((m) => [m.id, m]));
  const made = new Set(generated.map((m) => m.id));
  const add = generated.filter((m) => !disk.has(m.id));
  const change = generated.filter((m) => disk.has(m.id) && !isDeepStrictEqual(disk.get(m.id), m));
  const gone = onDisk.filter((m) => !made.has(m.id)).map((m) => m.id);
  return { add, change, gone };
}

async function main() {
  const write = process.argv.includes("--write");
  const all = readdirSync(SRC).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(SRC + f, "utf8")));
  let stuck = 0;
  for (const g of GENERATORS) {
    const mod = await import(ROOT + `scripts/${g.name}-manifests.mjs`);
    const generated = mod.build().manifests.map((x) => x.manifest);
    const { add, change, gone } = compare(generated, all.filter((m) => g.owns(m, mod)));
    console.log(`${g.name}: ${generated.length} generated, ${add.length} new, ${change.length} changed, ${gone.length} no longer produced`);
    for (const m of add) console.log(`  + ${m.id}`);
    for (const m of change) console.log(`  ~ ${m.id}`);
    for (const id of gone) console.log(`  ! ${id}: on disk, and the generator no longer produces it. NOT deleted; a person decides.`);
    stuck += gone.length;
    if (write) for (const m of [...add, ...change]) writeFileSync(SRC + `${m.id}.json`, JSON.stringify(m, null, 2) + "\n");
  }
  if (!write) console.log("\nDRY RUN. Pass --write to apply.");
  return stuck ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());

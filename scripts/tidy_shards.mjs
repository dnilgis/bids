#!/usr/bin/env node
/* MOVE THE SHARDS THAT LANDED IN THE WRONG DIRECTORY.
 *
 * WHY THIS EXISTS. BIDS-FEED-SEQUENCED shipped 323 per-place shards for
 * data/merged/. Uploaded through the GitHub web interface on 2026-09-01, 294
 * went where they belong and 29 landed directly in data/ — a browser upload
 * split a folder, which is a thing browser uploads do and not something anybody
 * did wrong.
 *
 * They are harmless: merge_bids.mjs recognises them by schema and skips them.
 * They are not harmless to READ, because data/ is where the 312 board files
 * live and 29 impostors among them make that directory a worse place to look.
 *
 * DELETING 29 FILES ONE AT A TIME IN A BROWSER IS NOT A THING TO ASK OF
 * ANYBODY. Standing decision: Sig works in the browser. So this runs on the
 * runner and does it in one pass.
 *
 * IT IDENTIFIES BY SCHEMA, NEVER BY NAME. A shard is named
 * <slug>-<8 hex>.json, and so, plausibly, is some future board file. The schema
 * inside the file — "agsist-merged-place/1" — is what it actually is. A guess
 * from a filename could delete a board, and a board is a price.
 *
 * IT MOVES RATHER THAN DELETES where it can: if data/merged/ has no copy, the
 * file is moved there. Only an exact duplicate of one already in data/merged/ is
 * removed. Nothing that is not provably redundant is destroyed.
 *
 * USAGE
 *     node scripts/tidy_shards.mjs            # say what would happen
 *     node scripts/tidy_shards.mjs --write    # do it
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const MERGED = join(DATA, "merged");
const SHARD_SCHEMA = "agsist-merged-place/1";
const WRITE = process.argv.includes("--write");

function main() {
  if (!existsSync(DATA)) { console.error("no data/ directory"); return 1; }
  const strays = [];
  for (const f of readdirSync(DATA)) {
    if (!f.endsWith(".json")) continue;
    let j;
    try { j = JSON.parse(readFileSync(join(DATA, f), "utf8")); } catch { continue; }
    if (j && j.schema === SHARD_SCHEMA) strays.push({ file: f, place: j.place });
  }

  if (!strays.length) { console.log("data/ holds no misplaced shards. Nothing to do."); return 0; }
  console.log(`${strays.length} merged shard(s) are in data/ rather than data/merged/:\n`);

  let moved = 0, removed = 0;
  if (WRITE) mkdirSync(MERGED, { recursive: true });
  for (const s of strays) {
    const src = join(DATA, s.file);
    const dst = join(MERGED, s.file);
    const body = readFileSync(src, "utf8");
    const dup = existsSync(dst) && readFileSync(dst, "utf8") === body;
    const clash = existsSync(dst) && !dup;
    if (clash) {
      /* The copy in data/merged/ differs. The one the merge maintains is the
         one in data/merged/, so the stray is stale — but it is not this
         script's place to decide that silently. Named and left alone. */
      console.log(`  KEPT   ${s.file}  (data/merged/ has a DIFFERENT copy — look before removing)`);
      continue;
    }
    console.log(`  ${dup ? "remove" : "move  "} ${s.file}  ${s.place ?? ""}`);
    if (WRITE) {
      if (!dup) writeFileSync(dst, body);
      unlinkSync(src);
      dup ? removed++ : moved++;
    }
  }

  if (!WRITE) {
    console.log(`\nDry run. Nothing changed. Add --write to move ${strays.length} file(s).`);
  } else {
    console.log(`\n${moved} moved into data/merged/, ${removed} removed as exact duplicates.`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
export { SHARD_SCHEMA };

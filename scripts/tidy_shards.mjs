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
const SOURCES = join(ROOT, "sources");
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

  const rootSrc = strayRootSources();

  if (!strays.length && !rootSrc.length) {
    console.log("data/ holds no misplaced shards and the root holds no stray source files. "
      + "Nothing to do.");
    return 0;
  }
  if (!strays.length) console.log("data/ holds no misplaced shards.\n");
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
  reportRootSources(rootSrc);
  return 0;
}

/* ── SOURCE FILES THAT LANDED IN THE ROOT ───────────────────────────────────
 *
 * A second spill, and a worse one to read than the shards. agricharts-sweep.mjs
 * run 33825545840 wrote its source files into sources/ AND into the repository
 * root: 102 files, 100 of them duplicating an id in sources/ and every
 * duplicate the poorer copy — no coordinate, no country, no currency.
 *
 * Nothing reads them. Nothing enumerates the root. They are inert, and that is
 * the problem: `agmarkllc-claycenter.json` in the root says `enabled: true` for
 * an elevator sources/ retired on 2026-09-06 as a duplicate of another. A file
 * that looks like live config and is not is worse than no file.
 *
 * REMOVED ONLY WHEN sources/ HAS THE SAME ID. A root file with an id sources/
 * has never seen might be the only copy of something, so it is named and left.
 * The content is deliberately NOT compared: the whole point is that the root
 * copy is older and thinner, so requiring them to match byte for byte would
 * refuse to clean exactly the files that need cleaning. The id is the identity. */
function strayRootSources() {
  if (!existsSync(SOURCES)) return [];
  const known = new Set(readdirSync(SOURCES)
    .filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
  const out = [];
  for (const f of readdirSync(ROOT)) {
    if (!f.endsWith(".json") || f === "package.json" || f === "package-lock.json") continue;
    let j;
    try { j = JSON.parse(readFileSync(join(ROOT, f), "utf8")); } catch { continue; }
    /* A source file, by its own shape: an id, a platform and a url. Not by its
       name — the same rule the shard half follows, and for the same reason. */
    if (!j || typeof j.id !== "string" || !j.platform || !j.url) continue;
    out.push({ file: f, id: j.id, inSources: known.has(f.slice(0, -5)) });
  }
  return out;
}

function reportRootSources(rows) {
  if (!rows.length) return;
  const dupes = rows.filter((r) => r.inSources);
  const orphans = rows.filter((r) => !r.inSources);
  console.log(`\n${rows.length} source file(s) are in the repository root rather than sources/:`);
  for (const r of orphans)
    console.log(`  KEPT   ${r.file}  (no sources/${r.file} — this may be the only copy, look)`);
  let n = 0;
  for (const r of dupes) {
    console.log(`  remove ${r.file}  (sources/${r.file} is the live one)`);
    if (WRITE) { unlinkSync(join(ROOT, r.file)); n++; }
  }
  console.log(WRITE
    ? `\n${n} stray root source file(s) removed, ${orphans.length} kept for a look.`
    : `\nDry run. Add --write to remove ${dupes.length} of them (${orphans.length} would be kept).`);
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
export { SHARD_SCHEMA };

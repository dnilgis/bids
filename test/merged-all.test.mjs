/* THE BULK FILE, AND THE TWO WAYS IT CAN LIE.
 *
 * data/merged-all.json exists for one consumer: agsist's fetch_bids.py, which
 * merges this whole network into the feed behind its basis map and its
 * futures-page cash cards, server side, every half hour. Before it existed that
 * build walked data/merged-index.json and fetched all 1,056 shards -- 1,056
 * HTTPS calls a run against a job that already has a 20-minute collision rule.
 *
 * It cannot read the index instead, and the reason is measured rather than
 * argued: `best` in the index is the top CASH bid per crop, deliberately not a
 * comparison across periods, so on 2026-09-22 it was a 2027 contract for 1,467
 * places. A card built from it shows a deferred price as today's cash.
 *
 * So two things must stay true, and neither is visible by reading the file:
 *   1. it is WRITTEN AT ALL -- an edit to merge_bids.mjs that drops the write
 *      leaves a stale copy on disk that looks perfectly fine;
 *   2. it AGREES WITH THE SHARDS -- two files built from one array must not
 *      drift, or one consumer prices a bid the other has never heard of.
 *
 *     node --test test/merged-all.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALL = join(ROOT, "data", "merged-all.json");
const INDEX = join(ROOT, "data", "merged-index.json");

test("merge_bids.mjs still writes the bulk file", () => {
  /* A source check, not a file check: the file on disk survives its own
     deletion from the writer, and then quietly ages. */
  const src = readFileSync(join(ROOT, "scripts", "merge_bids.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /merged-all\.json/,
    "merge_bids.mjs no longer names merged-all.json — agsist's merge would go stale");
  assert.match(code, /writeFileSync\(allPath/,
    "merged-all.json is named but never written");
  assert.match(code, /bids:\s*kept/,
    "the bulk file no longer carries `kept` — the rows every consumer reads");
});

test("THE POLL STAGES IT, or it is built every pass and thrown away", () => {
  /* The bug this test exists for, 2026-09-22: merge_bids.mjs was taught to
     write data/merged-all.json and scripts/one-pass.sh was not taught to stage
     it. The poll rebuilt the file every ten minutes and discarded it, the raw
     URL served a 404 for a day, and agsist's merge fell back to Barchart on
     every run -- silently, because it degrades rather than fails. Writing a
     file and publishing a file are two places; a green merge proves only the
     first. */
  const sh = readFileSync(join(ROOT, "scripts", "one-pass.sh"), "utf8");
  const staged = sh.split("\n").filter((l) => /^\s*git add /.test(l)).join("\n");
  assert.match(staged, /data\/merged-all\.json/,
    "one-pass.sh never stages data/merged-all.json — the poll would build it " +
    "and throw it away, and every consumer would get a 404");
  /* And it must be staged in the same breath as the shards it has to agree
     with, or the two land in different commits and drift. */
  const line = sh.split("\n").find((l) => /^\s*git add .*merged-all\.json/.test(l)) || "";
  assert.match(line, /data\/merged(\s|$)/,
    "merged-all.json is staged without data/merged — the bulk file and the " +
    "shards must land in one commit or they disagree between passes");
});

test("the bulk file is present and well formed", () => {
  assert.ok(existsSync(ALL), "data/merged-all.json is missing");
  const d = JSON.parse(readFileSync(ALL, "utf8"));
  assert.match(String(d.schema), /^agsist-merged-all\//);
  assert.ok(Array.isArray(d.bids) && d.bids.length > 0, "it carries no bids");
});

test("IT AGREES WITH THE SHARDS, row for row", () => {
  const d = JSON.parse(readFileSync(ALL, "utf8"));
  const dir = join(ROOT, "data", "merged");
  const idx = JSON.parse(readFileSync(INDEX, "utf8"));
  const live = new Set((idx.places || []).map((p) => p.shard.replace(/^merged\//, "")));
  let shardRows = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    if (!live.has(f)) continue;               // orphans are named, not deleted
    shardRows += (JSON.parse(readFileSync(join(dir, f), "utf8")).bids || []).length;
  }
  assert.equal(d.bids.length, shardRows,
    `the bulk file has ${d.bids.length} rows and the live shards have ${shardRows} — ` +
    `the two files were built from different arrays`);
  assert.equal(d.bids.length, (idx.counts || {}).rows,
    "the bulk file and the index disagree on how many rows this run merged");
});

test("every field agsist's merge reads is on every row", () => {
  /* Named one by one, because a silently absent field does not throw there --
     it becomes an empty string or a null and the row publishes anyway. The
     freshness gate is the one that matters most: without `stale` and
     `sourceStatus`, an unconfirmed price merges as today's cash. */
  const d = JSON.parse(readFileSync(ALL, "utf8"));
  const need = ["operator", "city", "state", "commodity", "crop", "cash", "basis",
                "period", "delivery", "stale", "sourceStatus", "lat", "lon"];
  for (const f of need) {
    const missing = d.bids.filter((b) => !(f in b)).length;
    assert.equal(missing, 0, `${missing} row(s) have no "${f}" field`);
  }
});

test("a priced row always carries a number, never a string", () => {
  const d = JSON.parse(readFileSync(ALL, "utf8"));
  const bad = d.bids.filter((b) => (b.cash !== null && typeof b.cash !== "number")
                                || (b.basis !== null && typeof b.basis !== "number"));
  assert.equal(bad.length, 0,
    `${bad.length} row(s) carry cash or basis as something other than a number`);
});

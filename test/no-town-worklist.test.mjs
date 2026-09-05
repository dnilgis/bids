/* The locations the sweep cannot place must survive the run.
 *
 * agricharts-sweep printed forty of them and dropped the rest. On 2026-09-05
 * that was 581 real elevators posting real prices, of which 541 existed
 * nowhere afterwards except a run log GitHub deletes in ninety days.
 *
 * It is the same fault that hid the 337 board siblings for weeks — a number
 * produced, printed, and discarded — five times larger, and it is the biggest
 * single number in this repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = readFileSync(ROOT + "scripts/agricharts-sweep.mjs", "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("every unplaceable location is written, not just the printed forty", () => {
  assert.match(code, /board-locations-with-no-town\.csv/,
    "the unmatched list still exists only in the run log");
  /* It must write from the WHOLE array. A slice here would reproduce the bug
     in the file instead of the console, which is worse — it would look fixed. */
  const block = code.match(/board-locations-with-no-town\.csv[\s\S]{0,600}/);
  assert.ok(block, "the write block is unreadable");
  /* ANY slice, not just one named `unmatched`. The first version of this
     guard checked for `unmatched.slice(...)` and missed `rows.slice(0, 40)`
     on the very next line — it was matching one spelling of the bug instead
     of the bug. Proved by mutation, which is the only reason it was found. */
  assert.ok(!/\.slice\(\s*0\s*,/.test(block[0]),
    "the file is written from a slice — the same 40-row truncation, moved into the file");
  assert.match(block[0], /rows\.map\(/,
    "the worklist is not written by mapping the whole sorted array");
});

test("it is written on a DRY RUN too", () => {
  /* The dry run is the one a person reads before deciding to write. A worklist
     that only appears when you commit is a worklist you cannot consult first. */
  const i = code.indexOf("board-locations-with-no-town.csv");
  const before = code.slice(Math.max(0, i - 1200), i);
  assert.ok(!/if \(\s*cfg\.write\s*\)\s*\{[^}]*$/.test(before),
    "the worklist is written only when cfg.write is on");
});

test("each row can be acted on: operator, label, id, rows, board", () => {
  assert.match(code, /"operator,label,location_id,rows,board_url/,
    "the worklist header is missing a column somebody would need to work it");
});

test("a failure to write the worklist never fails the sweep", () => {
  /* The harvest is the valuable part. A disk problem writing a gap list must
     not lose a run that already fetched 211 sites. */
  const block = code.match(/try \{[\s\S]{0,900}?board-locations-with-no-town[\s\S]{0,600}?catch[\s\S]{0,200}?\}/);
  assert.ok(block, "the worklist write is not wrapped in try/catch");
  assert.match(block[0], /::warning::/, "a failed write says nothing at all");
});

test("the file it last wrote is well formed", () => {
  const f = ROOT + "data/gaps/board-locations-with-no-town.csv";
  if (!existsSync(f)) return;                  /* not run yet — not a failure */
  const lines = readFileSync(f, "utf8").trim().split("\n");
  assert.match(lines[0], /^operator,label,location_id,rows,board_url$/);
  for (const line of lines.slice(1)) {
    const c = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]);
    assert.equal(c.length, 5, "malformed row: " + line.slice(0, 80));
    assert.ok(c[2].length, "a row carries no location id, so nothing could address it");
    assert.ok(c[4].startsWith("http"), "a row carries no board url");
  }
});

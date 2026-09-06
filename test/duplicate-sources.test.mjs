/* One elevator, one source.
 *
 * The first `write` ON run of agricharts-sweep wrote AgMark's fifteen
 * locations twice — once from www.agmarkllc.com and once from
 * agmarkresp.agricharts.com. One co-op, one board, two hosts; `existingIds`
 * cannot see it because the id is built from the host slug, so
 * `agmarkllc-clyde` and `agmarkresp-clyde` are different ids for the same
 * concrete elevator in Clyde, Kansas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const code = readFileSync(ROOT + "scripts/duplicate-sources.mjs", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("it groups on operator + location + state, NOT on locationId", () => {
  /* The whole point: two hosts serving one board give the same elevator two
     different location ids. Grouping on the id finds nothing. */
  assert.match(code, /norm\(s\.operator\).*norm\(s\.location\).*norm\(s\.state\)/s,
    "the grouping key is not operator+location+state");
  assert.ok(!/\blocationId\b/.test(code),
    "locationId is in the grouping — that is the one field the duplicates disagree on");
});

test("IT DELETES NOTHING", () => {
  /* \b matters. The first version used /rm\(/ and matched `norm(s.operator)`
     — a guard failing on the word "norm" is the same too-loose regex mistake
     as the basemap scan and the slice check, both today. */
  assert.ok(!/\b(unlinkSync|rmSync|rmdirSync)\b/.test(code),
    "this script removes files. Which copy to keep is a judgement, and a script " +
    "that deletes a reviewed file in sources/ will one day delete the wrong one");
  const writes = [...code.matchAll(/writeFileSync\(([^,]+)/g)].map((m) => m[1]);
  for (const w of writes)
    assert.ok(/data\/gaps/.test(w), "it writes outside data/gaps: " + w);
});

test("a tie is reported as a tie, not resolved by a coin toss", () => {
  assert.match(code, /cannot tell these apart/,
    "there is no tie outcome — so two equally-good copies get one picked arbitrarily");
  const block = code.match(/const tied[\s\S]{0,400}/);
  assert.ok(block && /tied \?/.test(block[0]), "the tie is computed but never used");
});

test("THE PLATFORM HOST OUTRANKS THE OPERATOR'S VANITY DOMAIN", () => {
  /* The first version of this script scored it the other way round, reasoning
     that the operator's own domain is the better record. The repository
     already knew better and said so in test/agricharts-sweep.test.mjs:

         46 CoMark sources were written against ceagrain.com; six hours later
         the poll could not reach it at all — "fetch failed", not an HTTP
         answer — while ceagrain.agricharts.com served the identical board.

     A vanity domain can be repointed or let lapse without the grain desk
     hearing about it. That is a measured lesson costing 46 sources. */
  const fn = code.match(/const score = \(src\)[\s\S]*?\n  \};/);
  assert.ok(fn, "the scorer is not a readable function any more");
  assert.match(fn[0], /agricharts/,
    "nothing in the score distinguishes a platform host from a vanity domain");
  const m = fn[0].match(/agricharts[^\n]*\n?[^\n]*n \+= (\d+)/);
  assert.ok(m && Number(m[1]) > 0,
    "the platform host earns nothing — that is backwards, see above");
  assert.ok(!/h === w/.test(fn[0]),
    "the score still rewards being fetched from the operator's own website");
});

test("the file it last wrote is well formed and honest", () => {
  const f = ROOT + "data/gaps/duplicate-sources.csv";
  if (!existsSync(f)) return;
  const lines = readFileSync(f, "utf8").trim().split("\n");
  assert.match(lines[0],
    /^operator,location,state,copies,id,host,platform,enabled,has_phone,has_coord,suggestion$/);
  const groups = new Map();
  for (const line of lines.slice(1)) {
    const c = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]);
    assert.equal(c.length, 11, "malformed row: " + line.slice(0, 70));
    const k = c[0] + "|" + c[1] + "|" + c[2];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c[10]);
  }
  for (const [k, sugg] of groups) {
    assert.ok(sugg.length > 1, "a group with one member is not a duplicate: " + k);
    const keeps = sugg.filter((s) => s === "KEEP").length;
    const ties = sugg.filter((s) => /cannot tell/.test(s)).length;
    assert.ok(keeps <= 1, `${k} has ${keeps} rows marked KEEP — only one copy can be the keeper`);
    assert.ok(keeps === 1 || ties === sugg.length,
      `${k} has no keeper and is not marked as a tie — every group must resolve or say it cannot`);
  }
});

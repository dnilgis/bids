/* THE READ ORDER IS THE FIX. THE BREAKER IS THE BACKSTOP.
 *
 * Run 91012844641. The breaker tripped on CHS and `coopelev`, seven `michag`
 * and eleven `riceland` sources were skipped — again, by the reprieve built to
 * protect them. The reprieve was inert (see breaker.test.mjs), but even a
 * working reprieve would only have papered over the real cause:
 *
 *     sources are read in id order, id order is alphabetical, and seventeen of
 *     the twenty-five Bushel operators are named `chs*`
 *
 * So the outage was at the front of every pass, spent the strikes every pass,
 * and the trip landed on everything sorting after it — every pass, forever.
 *
 * poll.mjs orders by (operator failure streak, operator last attempted, hash of
 * id). This pins that ordering as a pure function, because the ordering is what
 * decides whether anybody gets starved and it is one line inside a 400-line
 * script that cannot be imported.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nextStreak } from "../lib/breaker.mjs";

/* The same three keys poll.mjs sorts by, kept here as the specification. If
   this and poll.mjs ever disagree, THIS is what the behaviour was meant to be. */
const spread = (id) => parseInt(createHash("sha1").update(id).digest("hex").slice(0, 8), 16);
const operatorOf = (s) => s.operator || String(s.id).split("-")[0];
function readOrder(sources, prevFails = {}, prevSeen = {}) {
  const opFails = new Map(), opSeen = new Map();
  for (const s of sources) {
    const o = operatorOf(s);
    opFails.set(o, Math.max(opFails.get(o) ?? 0, prevFails[s.id] ?? 0));
    opSeen.set(o, Math.max(opSeen.get(o) ?? 0, prevSeen[s.id] ?? 0));
  }
  return [...sources].sort((a, b) => {
    const oa = operatorOf(a), ob = operatorOf(b);
    return (opFails.get(oa) - opFails.get(ob))
        || (opSeen.get(oa) - opSeen.get(ob))
        || (spread(a.id) - spread(b.id));
  });
}

const S = (id, operator) => ({ id, operator, platform: "bushel" });
const CHS = ["chsag-mankato", "chsagservices-ada", "chsbigsky-havre", "chsbrandon-canton",
             "chsherman-herman", "chsillinois-annawan"].map((id) => S(id, id.split("-")[0]));
const GOOD = [S("coopelev-coopelev", "Cooperative Elevator Co."),
              S("michag-blissfield", "Michigan Agricultural Commodities"),
              S("michag-marlette", "Michigan Agricultural Commodities")];

test("an operator that has been failing is read last, not first", () => {
  const fails = Object.fromEntries(CHS.map((s) => [s.id, 3]));
  const order = readOrder([...CHS, ...GOOD], fails).map((s) => s.id);
  const firstChs = order.findIndex((id) => id.startsWith("chs"));
  const lastGood = Math.max(...GOOD.map((g) => order.indexOf(g.id)));
  assert.ok(lastGood < firstChs,
    `every clean source must come before every failing one — got ${order.join(", ")}`);
});

test("the streak is per OPERATOR, so one bad page condemns the whole operator", () => {
  /* A page is per operator. If one michag source failed, every other michag
     source is behind the same page and is about to cost 45 seconds proving it.
     Taking the max across an operator's sources is what makes that true. */
  const order = readOrder([...GOOD, ...CHS], { "michag-blissfield": 5 }).map((s) => s.id);
  assert.ok(order.indexOf("michag-marlette") > order.indexOf("chsag-mankato"),
    "marlette shares blissfield's operator and must sink with it");
});

test("a tie is broken towards whoever has waited longest", () => {
  const seen = { "chsag-mankato": 5000, "coopelev-coopelev": 1000 };
  const order = readOrder([S("chsag-mankato", "A"), S("coopelev-coopelev", "B")], {}, seen);
  assert.equal(order[0].id, "coopelev-coopelev", "least recently attempted goes first");
});

test("the final tiebreak is NOT alphabetical — that is what caused the starvation", () => {
  /* With no history at all, id order puts all six chs* sources ahead of all
     three good ones, the strikes are spent before anything clean is reached,
     and the trip starves them. The hash has to decorrelate that. */
  const order = readOrder([...CHS, ...GOOD]).map((s) => s.id);
  const alphabetical = [...CHS, ...GOOD].map((s) => s.id).sort();
  assert.notDeepEqual(order, alphabetical, "an alphabetical tiebreak reproduces the bug");
  const firstGood = order.findIndex((id) => !id.startsWith("chs"));
  assert.ok(firstGood < CHS.length,
    `at least one clean source must be reached within the first ${CHS.length} — got ${order.join(", ")}`);
});

test("the order is stable and reproducible — same input, same pass", () => {
  const a = readOrder([...CHS, ...GOOD]).map((s) => s.id);
  const b = readOrder([...GOOD, ...CHS]).map((s) => s.id);
  assert.deepEqual(a, b, "the input order must not leak into the read order");
  assert.deepEqual(a, readOrder([...CHS, ...GOOD]).map((s) => s.id), "and it must not drift between calls");
});

test("a source with no operator falls back to its id prefix, and never crashes", () => {
  const odd = [{ id: "boyceville", platform: "cashbidssingle" }, { id: "x-y", operator: null }];
  assert.doesNotThrow(() => readOrder(odd));
  assert.equal(operatorOf(odd[0]), "boyceville");
  assert.equal(operatorOf(odd[1]), "x");
});

test("poll.mjs sorts by these three keys and in this order", () => {
  /* The ordering above is a specification; this is the check that the script
     actually implements it. A spec nothing is held to is a comment. */
  const src = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  const sort = src.slice(src.indexOf("todo.sort("), src.indexOf("todo.sort(") + 400);
  assert.match(sort, /opFails\.get\(oa\) - opFails\.get\(ob\)/, "first key: operator failure streak");
  assert.match(sort, /opSeen\.get\(oa\) - opSeen\.get\(ob\)/, "second key: operator last attempted");
  assert.match(sort, /spread\(a\.id\) - spread\(b\.id\)/, "third key: a hash, never the id");
  assert.doesNotMatch(sort, /localeCompare/, "an alphabetical tiebreak is the bug this file exists for");
});
import { readFileSync } from "node:fs";

/* ── THE STREAK TRANSITION ─────────────────────────────────────────────────
   This is the rule that broke. It lived as one line inside poll.mjs's catch
   block, where a mutation making a skip count as a failure killed no test in
   the suite — so it is a named function now, and these are its cases. */
test("a skip leaves the streak exactly where it was", () => {
  assert.equal(nextStreak(0, "skipped"), 0, "we did not try, so we learned nothing");
  assert.equal(nextStreak(4, "skipped"), 4, "and a skip cannot clear a real streak either");
});

test("a read that worked clears the streak; one that failed adds to it", () => {
  assert.equal(nextStreak(9, "live"), 0);
  assert.equal(nextStreak(0, "broken"), 1);
  assert.equal(nextStreak(3, "broken"), 4);
  assert.equal(nextStreak(3, "refused"), 4, "a refusal cost us a load like any other");
});

test("an absent or nonsense previous streak starts at zero, never NaN", () => {
  for (const bad of [undefined, null, NaN, "3"]) {
    assert.equal(nextStreak(bad, "skipped"), 0, JSON.stringify(bad));
    assert.equal(nextStreak(bad, "broken"), 1, JSON.stringify(bad));
  }
});

test("poll.mjs computes the streak with nextStreak, not by hand", () => {
  const src = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(src, /nextStreak\(prevFails\.get\(s\.id\), r\.health\)/,
    "the failure path must go through the shared rule");
  assert.doesNotMatch(src, /r\.fails = \(prevFails[^\n]*\+ 1/,
    "an inline +1 here is how the skip case gets lost again");
});

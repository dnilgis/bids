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

/* THE ORDER POLL.MJS RUNS, IMPORTED. This file used to carry its own copy of
   the sort "as the specification", which meant the tests passed against the
   copy whatever the script did. Since 2026-10-13 both import
   lib/read-order.mjs, and the last test below checks poll.mjs has no other. */
import { readOrder as order, pageKeyOf, operatorOf, STARVING_MS, REPRIEVE_PAGES }
  from "../lib/read-order.mjs";
const readOrder = (sources, prevFails = {}, prevSeen = {}, now = Date.now(), prevHealth = {}) =>
  order(sources, { prevFails, prevSeen, prevHealth, now }).order;

/* A SHARED PAGE BY DEFAULT: every source of one operator lands on that
   operator's page, which is how all but two operators in the manifest are
   actually laid out. `own` gives a source its own page, the ADM shape. */
const S = (id, operator, own = false) => ({
  id, operator, platform: "bushel",
  url: own ? `https://api.example.test/${id}` : `https://api.example.test/${operator}`,
});
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

test("one bad page condemns everything behind THAT page", () => {
  /* Unchanged in effect, corrected in wording. If one michag source failed,
     every other michag source is behind the same page and is about to cost 45
     seconds proving it. What makes that true is the shared PAGE, not the
     shared operator name -- and for michag the two are the same thing, which
     is why this test read as an operator rule for so long. */
  const order = readOrder([...GOOD, ...CHS], { "michag-blissfield": 5 }).map((s) => s.id);
  assert.ok(order.indexOf("michag-marlette") > order.indexOf("chsag-mankato"),
    "marlette is behind blissfield's page and must sink with it");
});

test("A SOURCE WITH ITS OWN PAGE CANNOT CONDEMN ITS SIBLINGS", () => {
  /* THE ADM CASE, 2026-09-17. 113 ADM sources arrived as one operator with 113
     separate gradable market urls. `adm-enolane` carried a streak of 37 while
     80 of ADM's 87 index rows carried ZERO, and the old per-operator max sorted
     all 87 behind 172 of 185 operators. Unattempted keeps its streak, so it
     never came back: 87 of 88 carried and 62 aged out of the feed.
     Each has its own page, so only the broken one pays. */
  const adm = ["adm-enolane", "adm-jacksontn", "adm-wisnerne", "adm-leotiks"]
    .map((id) => S(id, "ADM", true));
  const other = S("coopelev-coopelev", "Cooperative Elevator Co.");
  const order = readOrder([...adm, other], { "adm-enolane": 37 }).map((s) => s.id);
  assert.equal(order.at(-1), "adm-enolane", "the broken one goes last, and only it");
  for (const id of ["adm-jacksontn", "adm-wisnerne", "adm-leotiks"])
    assert.ok(order.indexOf(id) < order.indexOf("adm-enolane"),
      `${id} has its own page and a clean streak; it must not sink with enolane`);
});

test("and the two rules do not fight: shared sinks together, own page alone", () => {
  /* The same failing streak, the same operator name, the only difference being
     whether the siblings sit behind one page. */
  const shared = readOrder([S("x-a", "X"), S("x-b", "X")], { "x-a": 9 }).map((s) => s.id);
  const own = readOrder([S("y-a", "Y", true), S("y-b", "Y", true)], { "y-a": 9 }).map((s) => s.id);
  assert.deepEqual(new Set(shared), new Set(["x-a", "x-b"]));
  assert.equal(own[0], "y-b", "the clean sibling on its own page is read first");
  assert.equal(own[1], "y-a");
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

test("A CONDEMNED PAGE GETS BACK IN — that is what the three keys never allowed", () => {
  /* THE BUG THIS FILE DID NOT CATCH, 2026-09-18. 107 enabled sources were past
     the 14-hour withdrawal and publishing nothing. Every one of them sat on a
     page with a streak, and 61 of them on a page whose streak was ONE or TWO,
     unattempted for 21 hours. One bad minute was a life sentence. */
  const now = 1_000_000_000_000;
  const old = now - 21 * 3600_000;       // starved
  const fresh = now - 60_000;            // read a minute ago
  const starved = S("starved-a", "Starved");
  const clean = ["c-1", "c-2", "c-3"].map((id) => S(id, id));
  const order = readOrder([...clean, starved],
    { "starved-a": 2 },                                   // only a streak of two
    { "starved-a": old, "c-1": fresh, "c-2": fresh, "c-3": fresh },
    now).map((s) => s.id);
  assert.equal(order[0], "starved-a",
    `a page waiting 21 hours is read FIRST, ahead of its streak — got ${order.join(", ")}`);
});

test("the reprieve is bounded: four pages a pass and no more", () => {
  /* Unbounded, a wall of dead browser pages at 45s each eats the whole budget
     and the healthy majority pays for the suspects. */
  const now = 1_000_000_000_000;
  const many = Array.from({ length: 10 }, (_, i) => S(`starved-${i}`, `Op${i}`));
  const seen = Object.fromEntries(many.map((s, i) => [s.id, now - (30 - i) * 3600_000]));
  const fails = Object.fromEntries(many.map((s) => [s.id, 5]));
  const order = readOrder([...many, S("clean-x", "Clean")], fails, { ...seen, "clean-x": now - 60_000 }, now);
  const front = order.slice(0, REPRIEVE_PAGES).map((s) => s.id);
  assert.equal(front.length, 4);
  assert.deepEqual(front, ["starved-0", "starved-1", "starved-2", "starved-3"],
    "the four longest-waiting, oldest first");
  assert.equal(order[REPRIEVE_PAGES].id, "clean-x",
    "and the clean page is next, ahead of the six still-starving ones");
});

test("a page attempted recently is never reprieved, however bad its streak", () => {
  const now = 1_000_000_000_000;
  const order = readOrder([S("bad", "Bad"), S("good", "Good")],
    { bad: 99 }, { bad: now - 60_000, good: now - 120_000 }, now).map((s) => s.id);
  assert.deepEqual(order, ["good", "bad"], "the streak still decides when nobody is starving");
});

test("a source never attempted at all is new, not starved — it does not spend a slot", () => {
  /* prevSeen has no entry. The old code defaulted it to 0, which is 1970 and
     would have looked like the most starved page in the manifest. */
  const now = 1_000_000_000_000;
  const starved = S("starved-a", "Starved");
  const brandnew = S("new-a", "New");
  const order = readOrder([brandnew, starved], { "starved-a": 4 },
    { "starved-a": now - 20 * 3600_000 }, now).map((s) => s.id);
  assert.equal(order[0], "starved-a", "the reprieve slot goes to the one we have actually neglected");
});

test("poll.mjs sorts with lib/read-order.mjs and has no order of its own", () => {
  /* A spec nothing is held to is a comment. The tests above run the lib
     function, so what is left to check is that the script runs it too, and
     carries no second copy that could drift from it. */
  const src = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\breadOrder\b[^}]*\} from "\.\.\/lib\/read-order\.mjs"/,
    "poll.mjs imports readOrder from lib/read-order.mjs");
  assert.match(src, /readOrder\(todo, \{ prevFails, prevSeen, prevHealth, now: Date\.now\(\) \}\)/,
    "and calls it on the pass's sources with the last index's streaks, stamps and verdicts");
  assert.match(src, /todo\.splice\(0, todo\.length, \.\.\.readFirst\)/, "and reads in the order it returns");
  assert.doesNotMatch(src, /todo\.sort\(/, "no second sort in the script");
  assert.doesNotMatch(src, /const (pageKeyOf|STARVING_MS|REPRIEVE_PAGES|spread) =/,
    "no second copy of the key, the constants or the hash");
  /* ONE definition of the page key. getPage() built the same string inline for
     its cache; two copies of a key is how the sort and the fetch come to
     disagree about what a page is. */
  assert.doesNotMatch(src, /`\$\{s\.browserPage \?\? ""\}\|\$\{s\.url\}`/,
    "nothing in poll.mjs rebuilds the page key by hand");
  const lib = readFileSync(new URL("../lib/read-order.mjs", import.meta.url), "utf8");
  const sort = lib.slice(lib.indexOf("].sort("), lib.indexOf("].sort(") + 500);
  assert.match(sort, /reprieved\.has\(kb\).*reprieved\.has\(ka\)/, "key zero: the way back");
  assert.match(sort, /pageFails\.get\(ka\) - pageFails\.get\(kb\)/, "first key: the page's failure streak");
  assert.match(sort, /seenOf\(ka\) - seenOf\(kb\)/, "second key: the page's last attempt");
  assert.match(sort, /spread\(ka\) - spread\(kb\)/, "third key: a hash of the page");
  assert.match(sort, /spread\(a\.id\) - spread\(b\.id\)/, "last key: a hash, never the id");
  assert.doesNotMatch(sort, /localeCompare/, "an alphabetical tiebreak is the bug this file exists for");
  assert.equal(STARVING_MS, 10 * 3600_000);
  assert.equal(REPRIEVE_PAGES, 4);
});

/* ── 2026-10-13: CENTRAL VALLEY AG ──────────────────────────────────────────
   54 CVA sources on one cashgrid page. Hooper and Bancroft were refused for
   two weeks ("parsed 574 bids but none for location 13901"), streak 1032, and
   the page's streak was the worst of its sources, so all 54 sorted behind
   every clean page. Polk and ADM Columbus were reached at the wall with 230ms
   left and recorded broken. */
const CVA = ["polk", "admcolumbus", "hooper", "bancroft", "tilden", "waco", "utica"]
  .map((l) => S(`cvacoop365-${l}`, "Central Valley Ag"));
const CLEAN = Array.from({ length: 8 }, (_, i) => S(`clean${i}-x`, `Clean${i}`));

test("A REFUSED SOURCE DOES NOT SINK ITS PAGE: the page answered", () => {
  const fails = { "cvacoop365-hooper": 1032, "cvacoop365-bancroft": 1032 };
  const health = { "cvacoop365-hooper": "refused", "cvacoop365-bancroft": "refused" };
  const now = 1_000_000_000_000, t = now - 3600_000;
  const seen = Object.fromEntries([...CVA, ...CLEAN].map((s) => [s.id, t]));
  const got = readOrder([...CLEAN, ...CVA], fails, seen, now, health).map((s) => s.id);
  const lastClean = Math.max(...CLEAN.map((s) => got.indexOf(s.id)));
  const firstCva = Math.min(...CVA.map((s) => got.indexOf(s.id)));
  assert.ok(firstCva < lastClean,
    `CVA has nothing against its page but two refusals; it must mix with the clean pages — got ${got.join(", ")}`);
  /* and the refused rows do not get a pass of their own: the page is read as one */
  const cva = got.filter((id) => id.startsWith("cvacoop365-"));
  assert.equal(got.indexOf(cva.at(-1)) - got.indexOf(cva[0]), cva.length - 1, "the page's sources are read together");
});

test("the same streak, NOT refused, still sinks the page: a page that failed is a page that failed", () => {
  const fails = { "cvacoop365-hooper": 5 };
  const got = readOrder([...CLEAN, ...CVA], fails, {}, Date.now(), { "cvacoop365-hooper": "broken" }).map((s) => s.id);
  const lastClean = Math.max(...CLEAN.map((s) => got.indexOf(s.id)));
  for (const s of CVA) assert.ok(got.indexOf(s.id) > lastClean, `${s.id} sits behind a broken page`);
});

test("THE WALL CUTS ONE PAGE, NOT TWENTY: siblings are contiguous", () => {
  /* With only the id hash after the tie, the seven CVA sources were spread
     through the clean group, and a wall anywhere in it left some read and
     some not although their one page had already been fetched. */
  const all = [...CLEAN, ...CVA, ...["a", "b", "c"].map((x) => S(`other-${x}`, "Other"))];
  const got = readOrder(all).map((s) => s.id);
  for (const prefix of ["cvacoop365-", "other-"]) {
    const idx = got.map((id, i) => (id.startsWith(prefix) ? i : -1)).filter((i) => i >= 0);
    assert.equal(idx.at(-1) - idx[0], idx.length - 1, `${prefix}* must be read as one block — got ${got.join(", ")}`);
  }
});

test("a page is as overdue as its longest-waiting source, not its latest", () => {
  /* Polk and ADM Columbus were attempted at 16:31; the other CVA sources last
     at 13:52. The page is fetched once for all of them, so it is due when the
     13:52 ones are. */
  const now = 1_000_000_000_000;
  const seen = Object.fromEntries(CVA.map((s) => [s.id, now - 4 * 3600_000]));
  seen["cvacoop365-polk"] = seen["cvacoop365-admcolumbus"] = now - 60_000;
  const other = S("other-x", "Other");
  seen["other-x"] = now - 2 * 3600_000;
  const got = readOrder([other, ...CVA], {}, seen, now).map((s) => s.id);
  assert.ok(got.indexOf("other-x") > got.indexOf("cvacoop365-waco"),
    `CVA's page has waited four hours, other-x two — got ${got.join(", ")}`);
  /* and the reprieve sees the same thing */
  const old = Object.fromEntries(CVA.map((s) => [s.id, now - 12 * 3600_000]));
  old["cvacoop365-polk"] = now - 60_000;
  const r = order([other, ...CVA], { prevSeen: old, prevFails: { "cvacoop365-polk": 3 }, now });
  assert.ok(r.reprieved.has(pageKeyOf(CVA[0])), "twelve hours unread is starving, whatever one sibling's stamp says");
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
  assert.match(src, /r\.fails = nextStreak\(prevFails\.get\(s\.id\), r\.health, \{ emptyBoard: e\?\.empty === true \}\);/,
    "the failure path must go through the shared rule, and hand it the empty flag");
  assert.doesNotMatch(src, /r\.fails = \(prevFails[^\n]*\+ 1/,
    "an inline +1 here is how the skip case gets lost again");
});

/* ── AN EMPTY BOARD ─────────────────────────────────────────────────────────
   2026-10-06. Every DTN site posts [] after about 18:30Z. Counting that as a
   failed read gave Kanza, Aurora, Frontier Ag and a dozen more DTN operators
   streaks of 18+ over the weekend, sorted them behind the 360s wall every
   daytime pass hit, and left 149 boards unread through Monday's session. */
import { isRefusal } from "../lib/board.mjs";
import { DtnCsEmptyRefused, DtnCsRefused } from "../lib/adapters/dtn-cs.mjs";

test("an empty board clears the streak: the reader worked, the board posts nothing", () => {
  assert.equal(nextStreak(18, "refused", { emptyBoard: true }), 0);
  assert.equal(nextStreak(undefined, "refused", { emptyBoard: true }), 0);
});

test("the empty flag rescues nothing else", () => {
  assert.equal(nextStreak(3, "broken", { emptyBoard: true }), 4, "a crash is still a crash");
  assert.equal(nextStreak(4, "skipped", { emptyBoard: true }), 4, "a skip still learns nothing");
  assert.equal(nextStreak(3, "refused", { emptyBoard: false }), 4);
  assert.equal(nextStreak(3, "refused", { emptyBoard: "yes" }), 4, "only a real true counts");
});

test("DTN's empty array is a refusal that says it is empty; its other refusals are not", () => {
  const empty = new DtnCsEmptyRefused("the array is empty");
  assert.ok(isRefusal(empty), "still refused, so nothing is published");
  assert.equal(empty.empty, true);
  assert.notEqual(new DtnCsRefused("the response is not JSON").empty, true);
});

test("a weekend of empty boards does not put an operator behind the wall on Monday", () => {
  const dtn = [S("kanzacooperative-pratt", "Kanza Cooperative"), S("kanzacooperative-byers", "Kanza Cooperative")];
  const failing = [S("deadhost-a", "Dead Host"), S("deadhost-b", "Dead Host")];
  let dtnFails = 0, deadFails = 0;
  for (let pass = 0; pass < 18; pass++) {           // Friday close to Monday open
    dtnFails = nextStreak(dtnFails, "refused", { emptyBoard: true });
    deadFails = nextStreak(deadFails, "broken");
  }
  const prev = Object.fromEntries([...dtn.map((s) => [s.id, dtnFails]), ...failing.map((s) => [s.id, deadFails])]);
  const order = readOrder([...failing, ...dtn], prev).map((s) => s.id);
  const lastDtn = Math.max(...dtn.map((s) => order.indexOf(s.id)));
  const firstDead = Math.min(...failing.map((s) => order.indexOf(s.id)));
  assert.ok(lastDtn < firstDead, `a quiet board must be read before a broken one — got ${order.join(", ")}`);
});

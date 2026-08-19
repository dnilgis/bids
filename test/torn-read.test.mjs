/* A lagging futures cell is not a column shift, and the difference is size.
 *
 * On 2026-08-18 three scheduled runs failed with identical numbers hours
 * apart. The log was widened to print every failing row with its contract
 * month, and it answered the question outright:
 *
 *     August     Sep 26   4.1125 - (-0.52) -> 463.25c but quoted 463c
 *     September  Sep 26   4.1725 - (-0.46) -> 463.25c but quoted 463c
 *     5 of 7 row(s) balanced.
 *
 * Every failure on the front month; every deferred month exact, including
 * ones carrying quarter cents of their own. Their Sep 26 cell lags its cash.
 * Refusing the whole board over it meant both sites going dark in fourteen
 * hours because of a quarter of a cent on a column that exists to be checked
 * against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused, TORN_MAX_CENTS, TICK_CENTS, classifyIdentity }
  from "../lib/board.mjs";

const HTML = readFileSync(new URL("../fixtures/bigriver-2121.html", import.meta.url), "utf8");
const build = (html) =>
  buildFile(html, { now: "2026-08-18T21:00:38.000Z", sourceUrl: "https://example.invalid/x" });
/* Their futures column is quoted in eighths: 459-4 is 459 and 4/8, or 459.50c.
   Corn's minimum tick is a quarter cent, which is two eighths. */
const eighths = (n) => HTML.replace("459-4", "459-" + n);

test("the fixture is clean to begin with, and every row keeps its quote", () => {
  const { file } = build(HTML);
  assert.equal(file.count, 7);
  assert.ok(file.bids.every((b) => b.futuresPriceCents != null));
});

test("A LAGGING CELL NO LONGER TAKES THE WHOLE BOARD DOWN", () => {
  const { file } = build(eighths(2));               // one row a tick out
  assert.equal(file.count, 7, "the board still publishes");
  const aug = file.bids.find((b) => b.delivery === "August");
  assert.equal(aug.cash, 4.075, "their cash is untouched");
  assert.equal(aug.basisDollars, -0.52, "and so is their basis");
});

/* ===================================================================
 * READ THIS BEFORE CHANGING THE TWO TESTS BELOW.
 *
 * They used to assert the opposite of what they assert now, and finding that
 * out is the reason this comment exists.
 *
 * Until 2026-08-18 the reader NULLED the futures quote on any row whose
 * identity did not balance, so a figure nobody had verified could not reach a
 * customer. A later upload the same day reversed it -- see the long comment on
 * `futuresPriceCents` in lib/board.mjs -- and published the lagging quote
 * instead. The reversal did not update these two tests.
 *
 * SO THE SUITE WAS RED FROM 2026-08-18 UNTIL 2026-08-19 AND NOBODY SAW IT.
 * test.yml runs on pushes touching lib/, scripts/, test/ or fixtures/, and
 * every push in between was a bot data commit. A gate that only opens when
 * you push code cannot tell you the code you already pushed is broken.
 *
 * These now pin WHAT THE READER ACTUALLY DOES. That is deliberately not the
 * same thing as endorsing it, and the question is open:
 *
 *   FOR PUBLISHING IT (what the code does now). The consumer re-checks every
 *   quote it receives against the same two-tick ruler
 *   (update-prices.mjs IDENTITY_SLACK_CENTS). Stripping the quote on exactly
 *   the rows that failed means the second line of defence never sees the row
 *   that most needed checking. And the figure is Big River's own published
 *   cell, half a cent behind their own cash, not a guess of ours.
 *
 *   FOR NULLING IT (what these tests used to say). Nothing unverified reaches
 *   a customer, full stop. The reason given for the reversal -- that a null
 *   read as a broken feed and took both Emmert sites dark at 21:47 on
 *   2026-08-18 -- had ALREADY been fixed at the other end by then:
 *   update-prices.mjs now carries a null row with no quote and prints a dash.
 *   So the reversal was a second fix for a bug that was already fixed.
 *
 * That is a decision about what two live sites publish, and it is Sig's.
 * Whichever way it goes, change lib/board.mjs and these tests together.
 * =================================================================== */

test("A QUOTE WE COULD NOT VERIFY IS STILL PUBLISHED, AS THEIR OWN CELL", () => {
  const { file } = build(eighths(2));
  const aug = file.bids.find((b) => b.delivery === "August");
  assert.equal(aug.futuresPriceCents, 459.25, "their quote, carried verbatim");
  const derived = Math.round((aug.cash - aug.basisDollars) * 10000) / 10000 * 100;
  assert.ok(Math.abs(derived - aug.futuresPriceCents) <= TORN_MAX_CENTS,
    "and it is within the two ticks that let the board publish at all");
  for (const b of file.bids)
    assert.notEqual(b.futuresPriceCents, null, `${b.delivery} carries a quote`);
});

test("the published shape is unchanged, so nothing downstream has to be told", () => {
  const clean = build(HTML).file.bids[0];
  const marked = build(eighths(2)).file.bids[0];
  assert.deepEqual(Object.keys(clean), Object.keys(marked));
  assert.equal(build(HTML).file.schema, "bigriver-boyceville/2");
});

test("A WIDE GAP IS STILL REFUSED, AT ONCE AND LOUDLY", () => {
  assert.throws(() => build(HTML.replace("459-4", "419-4")), (e) => {
    assert.ok(e instanceof Refused);
    assert.match(e.message, /not a torn read/);
    return true;
  });
});

test("AND THE REFUSAL NO LONGER NAMES A CAUSE IT HAS NOT ESTABLISHED", () => {
  /* It used to end "Columns have moved." on the strength of one number: how
     far the worst row was out. On 2026-08-19 it said that about a board whose
     columns were in the right order and which balanced on every row seven
     minutes later. The gap being too wide for a torn read is established. The
     reason it is wide is not. */
  assert.throws(() => build(HTML.replace("459-4", "419-4")), (e) => {
    assert.doesNotMatch(e.message, /Columns have moved/);
    assert.match(e.message, /does not say what it is/);
    assert.match(e.message, /moved column, a stale futures column and a single bad quote/);
    assert.match(e.message, /Refusing until it balances/);
    return true;
  });
});

test("THE ROWS THAT PASS ARE WHAT DOES THE PROVING, SO THERE MUST BE ENOUGH OF THEM", () => {
  /* This is what stops it being a softening. A tick-sized disagreement is
     only forgiven because a majority of rows agreed to the cent; without
     them nothing has been proved about the columns, and the board is refused
     however small the discrepancy is. */
  const T = TICK_CENTS;
  assert.equal(classifyIdentity([], 7), "ok");
  assert.equal(classifyIdentity([T, T], 7), "lagging", "2 of 7 is a minority");
  assert.equal(classifyIdentity([T, T, T], 7), "lagging", "3 of 7 still is");
  assert.equal(classifyIdentity([T, T, T, T], 7), "unproven", "4 of 7 is not");
  assert.equal(classifyIdentity([T], 2), "unproven", "1 of 2 proves nothing");
  assert.equal(classifyIdentity([T], 1), "unproven", "and neither does 1 of 1");
  assert.equal(classifyIdentity([T], 3), "lagging");
});

test("size beats proportion: one huge row is a shift however many others pass", () => {
  assert.equal(classifyIdentity([40], 7), "unexplained");
  assert.equal(classifyIdentity([TICK_CENTS, 40], 20), "unexplained",
    "a tick-sized row beside a huge one does not launder it");
  assert.equal(classifyIdentity([TORN_MAX_CENTS], 7), "lagging", "the boundary is inclusive");
  assert.equal(classifyIdentity([TORN_MAX_CENTS + 0.01], 7), "unexplained");
});

test("the boundary is two ticks, judged on the worst row", () => {
  assert.doesNotThrow(() => build(eighths(0)));              // 0.50c, accepted and marked
  assert.throws(() => build(HTML.replace("459-4", "458-6")), // 0.75c, refused
    (e) => e instanceof Refused && /not a torn read/.test(e.message));
  assert.equal(TORN_MAX_CENTS, TICK_CENTS * 2);
});

test("a tick-sized row beside a huge one is refused, not treated as a lagging cell", () => {
  const both = HTML.replace("459-4", "459-2").replace("484-0", "444-0");
  assert.throws(() => build(both),
    (e) => e instanceof Refused && /not a torn read/.test(e.message));
});

test("RENAMING THE VERDICT MOVED NOTHING: EVERY BOUNDARY IS WHERE IT WAS", () => {
  /* The whole point of the 2026-08-19 change was that the MESSAGE was wrong,
     not the decision. So pin the decision independently of what it is called:
     refuse or publish, for every case the old rule covered. */
  const refuses = (v) => v === "unexplained" || v === "unproven";
  const T = TICK_CENTS;
  assert.equal(refuses(classifyIdentity([], 7)), false, "a clean board publishes");
  assert.equal(refuses(classifyIdentity([T, T], 7)), false, "2 of 7, a tick out: publishes");
  assert.equal(refuses(classifyIdentity([T, T, T], 7)), false);
  assert.equal(refuses(classifyIdentity([TORN_MAX_CENTS], 7)), false, "two ticks still publishes");
  assert.equal(refuses(classifyIdentity([T, T, T, T], 7)), true, "4 of 7 refuses");
  assert.equal(refuses(classifyIdentity([T], 1)), true, "1 of 1 refuses");
  assert.equal(refuses(classifyIdentity([TORN_MAX_CENTS + 0.01], 7)), true, "past two ticks refuses");
  assert.equal(refuses(classifyIdentity([40], 7)), true);
  assert.doesNotThrow(() => build(HTML));
  assert.doesNotThrow(() => build(eighths(0)));
  assert.throws(() => build(HTML.replace("459-4", "458-6")), Refused);
});

test("THE FAILURE MESSAGE NAMES EVERY ROW AND ITS CONTRACT MONTH", () => {
  /* One example row was enough to say something was wrong and not enough to
     say what. This is the line that identified the front month as the cause. */
  const bad = HTML.replace("459-4", "419-4").replace("484-0", "444-0");
  assert.throws(() => build(bad), (e) => {
    const lines = e.message.split("\n").filter((l) => /cash .* basis .* quoted/.test(l));
    assert.equal(lines.length, 2);
    for (const l of lines) assert.doesNotMatch(l, /\?\s/, "each row must name its contract");
    assert.match(e.message, /Sep 26/);
    return true;
  });
});

test("nothing here lets a wrong number through: EVERY OTHER ROW BALANCES EXACTLY", () => {
  /* This is what stops the tolerance being a hole. Exactly one row may be out,
     it may be out by no more than two ticks, and every other row on the board
     has to agree to the cent -- those are what prove the columns are right. */
  const { file } = build(eighths(2));
  let out = 0;
  for (const b of file.bids) {
    const derived = Math.round((b.cash - b.basisDollars) * 10000) / 10000;
    const off = Math.abs(Math.round(derived * 100 * 100) / 100 - b.futuresPriceCents);
    if (off > 1e-9) {
      out++;
      assert.equal(b.delivery, "August", "only the row we made lag may be out");
      assert.ok(off <= TORN_MAX_CENTS, `${b.delivery} is ${off}c out, past the boundary`);
    }
  }
  assert.equal(out, 1, "one row out, six exact");
});

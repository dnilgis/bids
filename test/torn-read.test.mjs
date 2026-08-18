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

test("A QUOTE WE COULD NOT VERIFY IS NOT PUBLISHED AT ALL", () => {
  /* No new field and no schema change: the one place this belongs is the
     quote itself, and it was already nullable. The Emmert pages show a dash
     for a null, so a figure we could not check cannot reach a customer. */
  const { file } = build(eighths(2));
  assert.equal(file.bids.find((b) => b.delivery === "August").futuresPriceCents, null);
  for (const b of file.bids.filter((x) => x.delivery !== "August"))
    assert.notEqual(b.futuresPriceCents, null, `${b.delivery} balanced and keeps its quote`);
});

test("the published shape is unchanged, so nothing downstream has to be told", () => {
  const clean = build(HTML).file.bids[0];
  const marked = build(eighths(2)).file.bids[0];
  assert.deepEqual(Object.keys(clean), Object.keys(marked));
  assert.equal(build(HTML).file.schema, "bigriver-boyceville/2");
});

test("A REAL COLUMN SHIFT IS STILL REFUSED, AT ONCE AND LOUDLY", () => {
  assert.throws(() => build(HTML.replace("459-4", "419-4")), (e) => {
    assert.ok(e instanceof Refused);
    assert.match(e.message, /Columns have moved/);
    assert.match(e.message, /far more than a tick/);
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
  assert.equal(classifyIdentity([40], 7), "shift");
  assert.equal(classifyIdentity([TICK_CENTS, 40], 20), "shift",
    "a tick-sized row beside a huge one does not launder it");
  assert.equal(classifyIdentity([TORN_MAX_CENTS], 7), "lagging", "the boundary is inclusive");
  assert.equal(classifyIdentity([TORN_MAX_CENTS + 0.01], 7), "shift");
});

test("the boundary is two ticks, judged on the worst row", () => {
  assert.doesNotThrow(() => build(eighths(0)));              // 0.50c, accepted and marked
  assert.throws(() => build(HTML.replace("459-4", "458-6")), // 0.75c, refused
    (e) => e instanceof Refused && /Columns have moved/.test(e.message));
  assert.equal(TORN_MAX_CENTS, TICK_CENTS * 2);
});

test("a tick-sized row beside a huge one is a column shift, not a lagging cell", () => {
  const both = HTML.replace("459-4", "459-2").replace("484-0", "444-0");
  assert.throws(() => build(both),
    (e) => e instanceof Refused && /Columns have moved/.test(e.message));
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

test("nothing here lets a wrong number through: the passing rows still pass exactly", () => {
  const { file } = build(eighths(2));
  for (const b of file.bids.filter((x) => x.futuresPriceCents != null)) {
    const derived = Math.round((b.cash - b.basisDollars) * 10000) / 10000;
    assert.equal(Math.round(derived * 100 * 100) / 100, b.futuresPriceCents,
      `${b.delivery} is marked verified and must balance to the cent`);
  }
});

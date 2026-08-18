/* Told apart by size: a board read mid-tick, versus columns in the wrong place.
 *
 * On 2026-08-18 a scheduled run failed with "August: 4.1125 - (-0.52) =
 * 463.25c but the page quotes 463c, off by 0.25c. Columns have moved." The
 * columns had not moved. Their board recomputes cash and futures in separate
 * cells and the page was fetched between the two writes, so the identity was
 * out by exactly one corn tick. The next run was clean.
 *
 * A column shift cannot be a quarter of a cent. Cash, basis and a futures
 * quote hold numbers of completely different sizes, so reading one out of
 * another's column puts the identity out by tens of cents. That difference in
 * magnitude is the whole test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused, TornRead, TORN_MAX_CENTS, TICK_CENTS } from "../lib/board.mjs";

const HTML = readFileSync(new URL("../fixtures/bigriver-2121.html", import.meta.url), "utf8");
const build = (html) =>
  buildFile(html, { now: "2026-08-18T18:56:41.000Z", sourceUrl: "https://example.invalid/x" });

/* Their futures column is quoted in eighths: 459-4 is 459 and 4/8, or 459.50c.
   Corn's minimum tick is a quarter cent, which is two eighths. */
const eighths = (s, n) => HTML.replace("459-4", `459-${n}`);

test("the fixture is clean to begin with", () => {
  const { file } = build(HTML);
  assert.equal(file.count, 7);
  assert.equal(file.status, "ok");
});

test("A ONE-TICK DISCREPANCY IS A TORN READ, NOT A COLUMN SHIFT", () => {
  /* 459-2 is 459.25c against a cash and basis that come to 459.50c. Exactly
     the shape of the run that failed. */
  assert.throws(() => build(eighths(HTML, 2)), (e) => {
    assert.ok(e instanceof TornRead, "must be classified as a torn read");
    assert.match(e.message, /read while it was updating/);
    assert.match(e.message, /1 tick/);
    assert.doesNotMatch(e.message, /Columns have moved/,
      "the alarming wording is exactly what was wrong with the old message");
    return true;
  });
});

test("...and it is still a Refused, so nothing publishes and old callers still refuse", () => {
  /* The subclass is the safe direction: anything catching Refused keeps
     behaving as it did, and nothing is written either way. */
  assert.throws(() => build(eighths(HTML, 2)), (e) => e instanceof Refused);
  assert.ok(TornRead.prototype instanceof Refused);
});

test("A REAL COLUMN SHIFT IS STILL REFUSED AT ONCE AND STILL SAYS SO", () => {
  const shifted = HTML.replace("459-4", "419-4");     // out by 40 cents
  assert.throws(() => build(shifted), (e) => {
    assert.ok(e instanceof Refused);
    assert.ok(!(e instanceof TornRead), "40c cannot be a board caught mid-tick");
    assert.match(e.message, /Columns have moved/);
    return true;
  });
});

test("the boundary is two ticks, and it is judged inclusively", () => {
  assert.throws(() => build(eighths(HTML, 0)), (e) => e instanceof TornRead);  // 0.50c
  assert.throws(() => build(HTML.replace("459-4", "458-6")), (e) =>            // 0.75c
    e instanceof Refused && !(e instanceof TornRead));
  assert.equal(TORN_MAX_CENTS, TICK_CENTS * 2);
});

test("A TICK-SIZED ROW BESIDE A HUGE ONE IS A COLUMN SHIFT, NOT A TORN READ", () => {
  /* Judged on the worst row, not the first one found. Otherwise a genuine
     shift that happens to list a near-miss first would be waved through as a
     busy board and quietly retried until it timed out. */
  const both = HTML.replace("459-4", "459-2").replace("484-0", "444-0");
  assert.throws(() => build(both), (e) => {
    assert.ok(e instanceof Refused);
    assert.ok(!(e instanceof TornRead));
    assert.match(e.message, /Columns have moved/);
    return true;
  });
});

test("nothing about this weakens the check: a clean board is still required", () => {
  /* The retry re-runs exactly this. The identity has to balance to the cent
     before a single number is written -- the classification only decides
     whether to look again or to shout. */
  for (const n of [0, 1, 2, 3, 5, 6, 7]) {
    assert.throws(() => build(eighths(HTML, n)),
      (e) => e instanceof Refused, `459-${n} must not publish`);
  }
  assert.doesNotThrow(() => build(eighths(HTML, 4)), "only the true value passes");
});

test("A TORN READ LOGS EVERY FAILING ROW AND ITS CONTRACT MONTH", () => {
  /* It has happened twice with identical numbers two hours apart, which a
     random mid-update read would not produce. Whether their front-month cell
     lags its cash, or their board drops the odd quarter cent when printing,
     is answerable from the data -- but only if the log carries all of it.
     One example row was enough to say something was wrong and not enough to
     say what. Do not widen the tolerance on a hunch; let the log decide. */
  const two = HTML.replace("459-4", "459-2").replace("499-6", "499-4");
  assert.throws(() => build(two), (e) => {
    assert.ok(e instanceof TornRead);
    const lines = e.message.split("\n").filter((l) => /cash .* basis .* quoted/.test(l));
    assert.equal(lines.length, 2, "both failing rows, not one example");
    for (const l of lines)
      assert.doesNotMatch(l, /\?\s/, "every row must name its contract month");
    assert.match(e.message, /Sep 26/);
    assert.match(e.message, /5 of 7 row\(s\) balanced/);
    return true;
  });
});

test("a single failing row still prints as one row, not as a list of one", () => {
  assert.throws(() => build(eighths(HTML, 2)), (e) => {
    const lines = e.message.split("\n").filter((l) => /cash .* basis .* quoted/.test(l));
    assert.equal(lines.length, 1);
    assert.match(e.message, /6 of 7 row\(s\) balanced/);
    return true;
  });
});

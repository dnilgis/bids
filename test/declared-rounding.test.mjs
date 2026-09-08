/* A MANIFEST MAY NOT CLAIM SOMETHING THIS REPOSITORY'S OWN BYTES REFUTE.
 *
 * `cashRounding` is a statement about somebody else's spreadsheet, written on
 * the day somebody looked, and until 2026-09-08 nothing ever went back to check
 * it. Nine enabled sources were declaring a mode their own committed capture
 * contradicts — eight of them `floor-cent`, which is the claim that a residual
 * is never negative, on boards carrying -0.25c rows.
 *
 * Nothing was red. A minority of failing rows is classified `lagging`, the file
 * publishes, and those rows carry a futures quote whose identity was never
 * proven. That is the whole reason this file exists: the failure mode is
 * SILENCE, so the check has to be executable and has to run on every push.
 *
 * WHERE THE LINE IS. This fails a source that MAKES A CLAIM its bytes
 * contradict. A source that declares nothing and whose rows do not balance is
 * not a manifest error — it is the strict guard working, and the reader says so
 * at the next poll. Keystone's Scircleville is exactly that case and is
 * deliberately undeclared rather than fitted with a mode one row short of the
 * margin lib/rounding.mjs requires before a mode may be stated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditSources, refuted, siblingDisagreements, declaresRounding, declarationOf,
  mergeResiduals, storedRows, SIBLINGS_CSV, SIBLING_COLS,
} from "../scripts/rounding_audit.mjs";
import { rowsFromCapture } from "../lib/rounding.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const AUDIT = auditSources();

/* --- the rule, and where it is NOT enforced ------------------------------ */

test("the live tree is REPORTED, not asserted — and the audit says so out loud", () => {
  /* THIS TEST USED TO BE AN ASSERTION OVER sources/ AND data/, AND THAT WAS
     WRONG. It shipped that way on the morning of 2026-09-08 and was red by the
     evening of the same day: the poll rewrote four of the nine captures it had
     just been used to correct, each grew a +0.5c row, and `round-cent` wanted
     to be `round-cent-either`. Nothing had been committed. Nothing was broken.
     A cash board simply rounds a little wider on the days its futures land
     badly, and a suite that goes red for that turns every push in the
     repository red for something no change caused — which is how a real red
     tick stops meaning anything.

     So the SUITE tests the rule, which does not drift, and the LIVE TREE is
     reported by scripts/rounding_audit.mjs as a GitHub warning on every poll
     and by the daily read. What is pinned here is that the reporting exists. */
  const src = readFileSync(join(ROOT, "scripts/rounding_audit.mjs"), "utf8");
  assert.match(src, /::warning title=rounding refuted::/,
    "a refuted source must raise an annotation somebody can see on the run");
  assert.match(src, /set "cashRounding": "\$\{a\.ev\.confident/,
    "and the annotation must name the mode to set, not merely complain");
});

test("the corpus is big enough for the audit to mean something", () => {
  /* A band, not a figure: 814 on 2026-09-08 and it moves with every poll. If it
     collapses, the audit is running over an empty set and proving nothing. */
  assert.ok(AUDIT.length >= 600 && AUDIT.length <= 1200,
    `${AUDIT.length} enabled sources have a testable committed capture`);
});

/* --- one capture measures the day, not the board -------------------------- */

test("residuals accumulate, and only ever grow", () => {
  const store = {};
  store.x = mergeResiduals(store, "x", [0, -0.25, -0.25], "t1");
  assert.deepEqual(store.x.residuals, { "0": 1, "-0.25": 2 });
  store.x = mergeResiduals(store, "x", [0.5], "t2");
  assert.deepEqual(store.x.residuals, { "0": 1, "-0.25": 2, "0.5": 1 },
    "the earlier readings survive the later one");
  assert.equal(store.x.reads, 2);
  assert.equal(store.x.firstSeen, "t1");
  assert.equal(store.x.lastSeen, "t2");
});

test("a residual seen before is a fact about the board forever", () => {
  /* The failure this prevents: a quiet day narrows the mode back to something
     a busy day already refuted. */
  let e = mergeResiduals({}, "x", [0.5], "t1");
  e = mergeResiduals({ x: e }, "x", [0, 0, 0], "t2");
  assert.ok("0.5" in e.residuals, "the +0.5c reading is not forgotten by a quiet day");
});

test("the counts survive accumulation, because the margin counts them", () => {
  /* Stored as a plain SET first, and that broke the margin: lib/rounding.mjs
     will not name a mode unless it beats its nearest rival by MIN_MARGIN, and
     ten rows collapsed to four distinct values turned a margin of four into a
     margin of one, so a board with ample evidence read "TOO FEW TO STATE". */
  const e = mergeResiduals({}, "x", [0, 0, 0, 0, 0, -0.25, -0.25], "t1");
  const rows = storedRows(e);
  assert.equal(rows.length, 7, "seven observations, not two distinct values");
  assert.equal(rows.filter((r) => r === 0).length, 5);
});

test("the audit judges against the store, not only against today", async () => {
  /* A board whose capture today is spotless, but which HAS shown a -0.25c row
     before, must still refute floor-cent. */
  const dir = mkdtempSync(join(tmpdir(), "rounding-store-"));
  mkdirSync(join(dir, "sources"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "sources/fake-one.json"), JSON.stringify({
    id: "fake-one", platform: "dtn-cs", enabled: true, cashRounding: "floor-cent",
  }));
  writeFileSync(join(dir, "data/fake-one.json"), JSON.stringify({ bids: [
    { cash: 4.00, basisDollars: -0.10, futuresPriceCents: 410 },
    { cash: 4.10, basisDollars: -0.10, futuresPriceCents: 420 },
  ] }));

  assert.deepEqual(refuted(auditSources(dir, {})), [],
    "with no history, today's spotless capture is not a refutation");

  const store = { "fake-one": { residuals: { "-0.25": 4 }, reads: 3 } };
  const bad = refuted(auditSources(dir, store));
  assert.equal(bad.length, 1, "with the history, floor-cent is refuted");
  assert.equal(bad[0].seenBefore, 4, "and the run says how much of it came from earlier reads");
});

/* --- the trap that broke the first pass of this audit --------------------- */

test("a capture's futuresPriceCents is read as-is, NOT scaled a second time", () => {
  /* Hillsdale declares futuresUnits "dollars": its board prints 5.385 and the
     COMMITTED file — the reader's output — says 538.5. The first pass applied
     the declared scale again on the way back in and reported the five sources
     that declare `dollars` as the worst boards in the repository. */
  const s = JSON.parse(readFileSync(join(ROOT, "sources/hillsdaleelevator-clinton.json"), "utf8"));
  assert.equal(s.futuresUnits, "dollars", "the fixture for this test must be a dollars board");
  const rows = rowsFromCapture(
    JSON.parse(readFileSync(join(ROOT, "data/hillsdaleelevator-clinton.json"), "utf8")));
  assert.ok(rows.length, "the committed capture has rows");
  for (const r of rows)
    assert.ok(Math.abs(r.futuresPrice - (r.cash - r.basis) * 100) < 1,
      `${r.futuresPrice} against ${(r.cash - r.basis) * 100} — a hundredfold error is `
      + `what re-scaling looks like`);
});

test("a zero quote is not counted as a row that balances", () => {
  /* It would satisfy no mode honestly and `exact` dishonestly. */
  const rows = rowsFromCapture({ bids: [
    { cash: 5, basisDollars: -0.1, futuresPriceCents: 0 },
    { cash: 5, basisDollars: -0.1, futuresPriceCents: 510 },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].futuresPrice, 510);
});

/* --- both ways a source can declare rounding ------------------------------ */

test("a raw cashRoundingCents tolerance counts as a declaration", () => {
  /* The reader honours two routes — a named mode, or a tolerance under the
     default `exact` — and explainedByRounding falls through to the second. An
     audit modelling only the first called thirty innocent sources broken. */
  assert.equal(declaresRounding({ cashRounding: "round-cent" }), true);
  assert.equal(declaresRounding({ cashRoundingCents: 0.5 }), true);
  assert.equal(declaresRounding({ cashRoundingCents: 0 }), false);
  assert.equal(declaresRounding({}), false);
  assert.equal(declarationOf({ cashRoundingCents: 0.5 }), "exact +/- 0.5c");
  assert.equal(declarationOf({}), "exact");
});

test("a source that declares NOTHING is never refuted, however badly it balances", () => {
  const undeclared = {
    id: "x", declares: false, unexplained: 99, rows: 99,
    ev: { confident: null, residuals: [] },
  };
  assert.deepEqual(refuted([undeclared]), [],
    "an undeclared source failing the strict guard is the guard working, not a manifest error");
});

/* --- the guard actually goes red ------------------------------------------ */

test("a manifest that claims floor-cent over a negative residual IS caught", () => {
  /* MUTATION. Without this the rule above is a test of today's manifests and
     not of the check. A tree is built in which one source claims the mode the
     eight real ones claimed, over rows that refute it exactly as theirs did. */
  const dir = mkdtempSync(join(tmpdir(), "rounding-"));
  mkdirSync(join(dir, "sources"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "sources/fake-one.json"), JSON.stringify({
    id: "fake-one", operator: "Fake", platform: "dtn-cs",
    enabled: true, cashRounding: "floor-cent",
  }));
  /* FOUR rows below zero, not one. A single disagreeing row is under the
     MIN_MARGIN lib/rounding.mjs requires before a mode may be named, so the
     first draft of this fixture proved the source refuted and got `confident:
     null` back — the same state Keystone's Scircleville is really in. The
     assertion that the audit NAMES the fix is the one worth having, so the
     fixture has to clear the margin the way the eight real boards do. */
  writeFileSync(join(dir, "data/fake-one.json"), JSON.stringify({ bids: [
    { cash: 4.00, basisDollars: -0.10, futuresPriceCents: 410 },      /*  0     */
    { cash: 4.00, basisDollars: -0.10, futuresPriceCents: 409.75 },   /* -0.25  */
    { cash: 4.10, basisDollars: -0.10, futuresPriceCents: 419.75 },   /* -0.25  */
    { cash: 4.20, basisDollars: -0.10, futuresPriceCents: 429.75 },   /* -0.25  */
    { cash: 4.30, basisDollars: -0.10, futuresPriceCents: 439.75 },   /* -0.25  */
    { cash: 4.40, basisDollars: -0.10, futuresPriceCents: 450.25 },   /* +0.25  */
  ] }));

  const bad = refuted(auditSources(dir, {}));
  assert.equal(bad.length, 1, "the refuted source is found");
  assert.equal(bad[0].id, "fake-one");
  assert.equal(bad[0].unexplained, 4, "the four -0.25c rows are what floor-cent cannot explain");
  assert.equal(bad[0].ev.confident, "round-cent", "and the audit names what to set instead");
});

test("the same board with the mode CORRECTED is not caught", () => {
  /* The other half of the mutation: if the check fired on the corrected tree
     too it would be firing on something other than the declaration. */
  const dir = mkdtempSync(join(tmpdir(), "rounding-ok-"));
  mkdirSync(join(dir, "sources"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "sources/fake-one.json"), JSON.stringify({
    id: "fake-one", operator: "Fake", platform: "dtn-cs",
    enabled: true, cashRounding: "round-cent",
  }));
  writeFileSync(join(dir, "data/fake-one.json"), JSON.stringify({ bids: [
    { cash: 4.00, basisDollars: -0.10, futuresPriceCents: 410 },
    { cash: 4.00, basisDollars: -0.10, futuresPriceCents: 409.75 },
    { cash: 4.10, basisDollars: -0.10, futuresPriceCents: 419.75 },
    { cash: 4.20, basisDollars: -0.10, futuresPriceCents: 429.75 },
    { cash: 4.30, basisDollars: -0.10, futuresPriceCents: 439.75 },
    { cash: 4.40, basisDollars: -0.10, futuresPriceCents: 450.25 },
  ] }));
  assert.deepEqual(refuted(auditSources(dir, {})), []);
});

test("a DISABLED source is not audited", () => {
  const dir = mkdtempSync(join(tmpdir(), "rounding-off-"));
  mkdirSync(join(dir, "sources"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "sources/fake-one.json"), JSON.stringify({
    id: "fake-one", enabled: false, cashRounding: "floor-cent",
  }));
  writeFileSync(join(dir, "data/fake-one.json"), JSON.stringify({ bids: [
    { cash: 4.00, basisDollars: -0.10, futuresPriceCents: 409.75 },
  ] }));
  assert.deepEqual(auditSources(dir, {}), []);
});

/* --- the audit measures with the reader's own function -------------------- */

test("the audit calls explainedByRounding rather than carrying its own copy", () => {
  /* The rule this repository keeps relearning: a guard that measures the same
     quantity differently from the thing it guards eventually disagrees with it.
     Pinned on the import, so re-implementing the predicate breaks this. */
  const src = readFileSync(join(ROOT, "scripts/rounding_audit.mjs"), "utf8");
  assert.match(src, /^import \{ explainedByRounding \} from "\.\.\/lib\/board\.mjs";$/m);
  assert.match(src, /^import \{ checkIdentity \} from "\.\.\/lib\/parse\.mjs";$/m);
  assert.ok(!/signedCents\s*=|futuresPrice\s*-\s*\(/.test(src),
    "the audit must not compute a residual of its own");
});

/* --- the worklist --------------------------------------------------------- */

test("siblings reading one board and declaring different modes are listed", () => {
  const sib = siblingDisagreements(AUDIT);
  assert.ok(sib.length > 0, "there is at least one disagreeing group to list");
  for (const r of sib) {
    assert.ok(r.siblings_declare, `${r.id} is listed without saying what its siblings declare`);
    assert.notEqual(r.declared, r.siblings_declare);
  }
});

test("agreeing siblings are NOT listed", () => {
  const same = [
    { id: "op-a", platform: "p", declared: "round-cent", ev: { confident: "round-cent", residuals: [] }, unexplained: 0 },
    { id: "op-b", platform: "p", declared: "round-cent", ev: { confident: "round-cent", residuals: [] }, unexplained: 0 },
  ];
  assert.deepEqual(siblingDisagreements(same), []);
});

test("two operators are not each other's siblings", () => {
  const two = [
    { id: "opa-x", platform: "p", declared: "round-cent", ev: { confident: null, residuals: [] }, unexplained: 0 },
    { id: "opb-y", platform: "p", declared: "floor-cent", ev: { confident: null, residuals: [] }, unexplained: 0 },
  ];
  assert.deepEqual(siblingDisagreements(two), [],
    "grouping on platform alone would have joined these");
});

test("the same operator on two platforms is two boards, not one disagreement", () => {
  const two = [
    { id: "op-x", platform: "dtn-cs", declared: "round-cent", ev: { confident: null, residuals: [] }, unexplained: 0 },
    { id: "op-y", platform: "bushel", declared: "floor-cent", ev: { confident: null, residuals: [] }, unexplained: 0 },
  ];
  assert.deepEqual(siblingDisagreements(two), []);
});

test("the committed worklist is the one this code writes", () => {
  /* It is regenerated by the poll workflow; if it has drifted from what the
     shipped code produces, one of the two is stale. */
  const path = join(ROOT, SIBLINGS_CSV);
  if (!existsSync(path)) return;                 /* first run, before the poll */
  const head = readFileSync(path, "utf8").split("\n")[0];
  assert.equal(head, SIBLING_COLS.join(","));
});

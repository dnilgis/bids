/* THE MEASUREMENT, AND THE BUG IT WAS CARRYING.
 *
 * A probe that measures a board's rounding differently from the guard that
 * enforces it will eventually disagree with it about a board, and the probe is
 * the one that gets believed, because it runs first and writes the manifest.
 * These tests are about keeping the two the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { roundingEvidence, describeEvidence, residualCents } from "../lib/rounding.mjs";
import { CASH_ROUNDING } from "../lib/board.mjs";
import { checkIdentity } from "../lib/parse.mjs";

/* --- the defect ---------------------------------------------------------- */

test("a board that posts cash below the cent and balances EXACTLY reads exact", () => {
  /* THE BUG, 2026-09-07. The old counter did `Math.round(cash * 100)` first, so
     a cash cell of 5.1175 was measured as 512 against an arithmetic of 511.75
     and came out a quarter of a cent off. Twenty-one live DTN boards post cash
     like this. Premier Cooperative's Manchester board balances on all seventeen
     rows and the probe reported two of seventeen and named `round-cent`, which
     went into four live manifests and loosened the identity guard by half a
     cent on boards that never needed it.
     These rows are that shape: cash to four decimals, basis in dollars, futures
     in cents on the eighth-cent grid, and cash - basis = futures exactly. */
  const rows = [
    { cash: 5.1175, basis: -0.25, futuresPrice: 536.75 },
    { cash: 4.7675, basis: -0.60, futuresPrice: 536.75 },
    { cash: 12.5975, basis: -0.50, futuresPrice: 1309.75 },
    { cash: 7.4225, basis: -0.60, futuresPrice: 802.25 },
  ];
  const ev = roundingEvidence(rows);
  assert.equal(ev.testable, 4);
  assert.equal(ev.exact, 4, "every row balances to the last digit");
  assert.deepEqual(ev.residuals, [0], "a board that balances has ONE residual and it is zero");
  assert.equal(ev.mode, "exact");
  assert.equal(ev.confident, "exact");
});

test("the probe's residual is the guard's residual, row for row", () => {
  /* The only thing that stops the two drifting again. checkIdentity reports a
     row only when it is out by more than float noise, so compare where it
     speaks. */
  const rows = [
    { cash: 5.1175, basis: -0.25, futuresPrice: 536.75 },
    { cash: 5.12,   basis: -0.25, futuresPrice: 536.75 },
    { cash: 4.67,   basis: -0.70, futuresPrice: 536.75 },
    { cash: 5.03,   basis: -0.33, futuresPrice: 536.75 },
  ];
  const guard = new Map(checkIdentity(rows).map((r) => [`${r.cash}|${r.basis}`, r.signedCents]));
  for (const r of rows) {
    const mine = residualCents(r);
    const theirs = guard.get(`${r.cash}|${r.basis}`);
    if (theirs === undefined) assert.ok(Math.abs(mine) <= 0.05, `guard is silent on ${r.cash}, so the probe must read it as noise, got ${mine}`);
    else assert.equal(mine, theirs, `${r.cash}: probe and guard must agree`);
  }
});

/* --- the lattice --------------------------------------------------------- */

test("round-cent being inside round-cent-either is not an ambiguity", () => {
  /* Every board explained by round-cent is also explained by round-cent-either.
     Read as "name it only when exactly one rule fits", that would refuse to
     name a mode for any rounding board on earth -- and every one of them would
     be held. The narrower promise is the answer. */
  const rows = [{ cash: 4.29, basis: -0.5, futuresPrice: 478.75 },
                { cash: 4.29, basis: -0.5, futuresPrice: 479 },
                { cash: 4.30, basis: -0.5, futuresPrice: 479.5 }];
  const ev = roundingEvidence(rows);
  assert.ok(ev.modes.includes("round-cent-either"));
  assert.equal(ev.mode, "round-cent", "the narrower window is what the board showed");
});

test("a residual of exactly +0.5 is named, and it is the wider mode", () => {
  /* +0.5 means their cash cell rounded DOWN from a half. round-cent is open at
     the top and refuses it; round-cent-either is closed and does not. Before
     this file the probe could not express that mode at all, so a board with one
     such row came back UNRESOLVED and was held. */
  const rows = [{ cash: 4.30, basis: -0.5, futuresPrice: 480.5 },
                { cash: 4.29, basis: -0.5, futuresPrice: 478.75 },
                { cash: 4.29, basis: -0.5, futuresPrice: 479 },
                { cash: 4.29, basis: -0.5, futuresPrice: 478.5 }];
  const ev = roundingEvidence(rows);
  assert.deepEqual(ev.residuals, [-0.5, -0.25, 0, 0.5]);
  assert.equal(ev.mode, "round-cent-either");
  assert.equal(ev.floor, 2, "the two non-negative residuals, +0.5 and 0, are all floor explains");
  assert.equal(ev.round, 3, "round-cent is open at the top, so +0.5 is the one it refuses");
});

test("floor and round still refuse to be told apart when neither contains the other", () => {
  const rows = [{ cash: 4.29, basis: -0.5, futuresPrice: 479 },
                { cash: 4.29, basis: -0.5, futuresPrice: 479.25 }];
  assert.equal(roundingEvidence(rows).mode, null);
});

/* --- the margin ---------------------------------------------------------- */

test("a mode nothing ruled out is named but not confident", () => {
  /* Two rows both at zero: every mode explains them, exact is the narrowest and
     is named. Two rows both at +0.25: floor, round and round-either all explain
     them, none is narrower than the others, and nothing is named. The margin
     rule only ever has to fire in between. */
  const at = (v) => ({ cash: 4.29, basis: -0.5, futuresPrice: 479 + v });
  assert.equal(roundingEvidence([at(0), at(0)]).confident, "exact");

  /* One row at +0.75 rules out round-cent and round-cent-either; the rest sit
     where both would have worked. One row is not two, so floor-cent is named
     and NOT written into a manifest. */
  const weak = roundingEvidence([at(0), at(0.25), at(0.75)]);
  assert.equal(weak.mode, "floor-cent");
  assert.equal(weak.margin, 1);
  assert.equal(weak.confident, null, "one disagreeing row can be a typo on their board");
  assert.deepEqual(weak.weak, { named: "floor-cent", margin: 1 });

  const strong = roundingEvidence([at(0), at(0.25), at(0.75), at(0.75)]);
  assert.equal(strong.confident, "floor-cent");
  assert.equal(strong.margin, 2);
});

test("a mode the winner is narrower than is not a rival for the margin", () => {
  /* round-cent-either explains every row round-cent does, so counting it as the
     runner-up would make the margin zero on every rounding board and hold all
     of them for ever. */
  const at = (v) => ({ cash: 4.29, basis: -0.5, futuresPrice: 479 + v });
  const ev = roundingEvidence([at(-0.5), at(-0.5), at(-0.25), at(0)]);
  assert.equal(ev.mode, "round-cent");
  assert.equal(ev.either, 4, "the wider mode explains all four and is NOT the runner-up");
  assert.equal(ev.floor, 1, "only the zero row is non-negative");
  assert.equal(ev.margin, 3, "three negative residuals actively ruled floor-cent out");
  assert.equal(ev.confident, "round-cent");
});

/* --- the contract -------------------------------------------------------- */

test("every mode the probe can name is a mode a manifest can declare", () => {
  /* roundingRule() throws Refused on a cashRounding it does not know, so a
     probe that printed "ceil-cent explains ALL 13" would be handing somebody a
     manifest that refuses at the first poll. The names come from the guard. */
  for (const name of ["exact", "floor-cent", "round-cent", "round-cent-either"])
    assert.ok(name in CASH_ROUNDING, `${name} must exist in CASH_ROUNDING`);
  const at = (v) => ({ cash: 4.29, basis: -0.5, futuresPrice: 479 + v });
  for (const rows of [[at(0)], [at(0.75)], [at(-0.5)], [at(0.5)], [at(-0.75)]]) {
    const m = roundingEvidence(rows).mode;
    assert.ok(m === null || m in CASH_ROUNDING, `named "${m}", which no manifest can declare`);
  }
});

test("a row set aside for its unit is reported, never silently dropped", () => {
  const ev = roundingEvidence([
    { cash: 4.29, basis: -0.5, futuresPrice: 479 },
    { cash: 21.4, basis: -0.5, futuresPrice: 479, identityCheckable: false },
  ]);
  assert.equal(ev.testable, 1);
  assert.equal(ev.otherUnit, 1);
  assert.match(describeEvidence(ev), /set aside/);
});

test("no testable row names nothing and says nothing was measured", () => {
  const ev = roundingEvidence([{ cash: 4.29, basis: -0.5, futuresPrice: null }, { cash: null }]);
  assert.equal(ev.testable, 0);
  assert.equal(ev.mode, null);
  assert.match(describeEvidence(ev), /no testable row/);
});

test("the description carries the residuals, which is how the last bug was found", () => {
  const ev = roundingEvidence([{ cash: 4.29, basis: -0.5, futuresPrice: 479.75 },
                               { cash: 4.29, basis: -0.5, futuresPrice: 479 }]);
  assert.match(describeEvidence(ev), /residuals 0c, 0\.75c/);
});

/* WHICH MODE CONTAINS WHICH IS DERIVED, NOT TYPED -- 2026-09-07.
 *
 * NARROWER_THAN was a hand-written table, and adding `round-cent-both` to
 * CASH_ROUNDING without adding a fifth line to it made every board that mode
 * explains come out AMBIGUOUS. The table is now computed from the predicates.
 * These tests pin the derivation, not the answers: a sixth mode must be placed
 * correctly with no edit here at all.
 */
test("the containment table is what the predicates actually say", async () => {
  const { containment, NARROWER_THAN, RESIDUAL_GRID } = await import("../lib/rounding.mjs");
  const { CASH_ROUNDING } = await import("../lib/board.mjs");

  /* The two entries that were typed by hand before this was derived. If the
     derivation ever stops reproducing them, it is wrong and not they. */
  assert.deepEqual(NARROWER_THAN["exact"].sort(),
    ["floor-cent", "round-cent", "round-cent-both", "round-cent-either"]);
  assert.ok(NARROWER_THAN["round-cent"].includes("round-cent-either"));

  /* AND THE NON-CONTAINMENT THIS FILE EXISTS TO PROTECT. floor-cent covers
     +0.75 and round-cent covers -0.5, so neither is inside the other and a
     board explained by both gets no name. */
  assert.ok(!NARROWER_THAN["floor-cent"].includes("round-cent"));
  assert.ok(!NARROWER_THAN["round-cent"].includes("floor-cent"));

  /* NOTHING IS NARROWER THAN ITSELF, and two modes cannot each contain the
     other -- that would be one rule under two names. */
  for (const [a, list] of Object.entries(NARROWER_THAN)) {
    assert.ok(!list.includes(a), `${a} cannot be narrower than itself`);
    for (const b of list)
      assert.ok(!(NARROWER_THAN[b] ?? []).includes(a),
        `${a} and ${b} each claim to contain the other`);
  }

  /* EVERY MODE IS ON THE TABLE. A mode CASH_ROUNDING has and this does not is
     exactly the bug that was here. */
  assert.deepEqual(Object.keys(NARROWER_THAN).sort(), Object.keys(CASH_ROUNDING).sort());

  /* THE GRID IS THE DOMAIN, NOT A SAMPLE. Residuals live on eighths of a cent
     because futures are quoted in eighths, and no mode may reach past the walk
     -- one that did would be a tolerance, not a rounding, and the containment
     computed for it would be a guess. */
  assert.equal(RESIDUAL_GRID[0], -2);
  assert.equal(RESIDUAL_GRID[RESIDUAL_GRID.length - 1], 2);
  for (const [name, rule] of Object.entries(CASH_ROUNDING)) {
    if (!rule) continue;
    assert.equal(rule(2.125), false, `${name} accepts a residual past the grid`);
    assert.equal(rule(-2.125), false, `${name} accepts a residual past the grid`);
  }

  /* AND IT IS A FUNCTION OF ITS INPUT, so a new mode needs no edit here. */
  const made = containment({
    narrow: (s) => s === 0,
    wide: (s) => Math.abs(s) < 1,
  }, [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(made, { narrow: ["wide"], wide: [] });

  /* TWO RULES THAT ACCEPT THE SAME RESIDUALS CONTAIN EACH OTHER, and that is
     not a containment -- it is one rule under two names, and letting either
     "win" would make the verdict depend on the order Object.keys returned.
     Dropping the size test from `containment` passes every other assertion in
     this file, because no two of the five real modes happen to be equal. */
  const twins = containment({
    a: (s) => Math.abs(s) < 1,
    b: (s) => s > -1 && s < 1,
  }, [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(twins, { a: [], b: [] },
    "equal rules are not narrower than one another in either direction");
});

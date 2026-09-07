/* HOW A BOARD ROUNDS ITS CASH CELL — THE MEASUREMENT, ONCE.
 *
 * THE BUG THIS FILE EXISTS TO KILL, FOUND 2026-09-07.
 *
 * `scripts/dtn-probe.mjs` and `scripts/bushel-probe.mjs` each carried their own
 * copy of this arithmetic, and both of them started by rounding the board's
 * cash price to the cent:
 *
 *     const cents = (n) => Math.round(n * 100);      //  <-- here
 *     const derived = cents(r.basis) + r.futuresPrice;
 *     const cash    = cents(r.cash);
 *
 * A board that posts cash to more than two decimals — and twenty-one live DTN
 * boards do — then gets a residual invented for it by the measurement. Premier
 * Cooperative's Manchester reconciles SEVENTEEN OF SEVENTEEN rows to the last
 * digit; the probe read it as two of seventeen and named `round-cent`. Same
 * for Fairbanks (9/9), Mazomanie (11/11), Ossian (16/16), Postville (15/15),
 * Viserion McGregor (18/18), Valero (9/9), Shell Rock (9/9), Country Partners'
 * AGP David City (7/7) and AGP Hastings (7/7), Green America Ord (9/9),
 * Keystone's Union Mills (4/4), Country Visions' Whitelaw (2/2).
 *
 * The invented residuals take exactly four values — 0, +0.25, -0.25, -0.5 —
 * because Math.round of a quarter-cent goes down and of a three-quarter-cent
 * goes up, and half goes up. That is the signature the 2026-08-20 run reported
 * as Premier's rounding mode ("161 of 161 rows, residuals {-0.5,-0.25,0,+0.25}").
 * It was not their rounding mode. It was ours.
 *
 * Two consequences, both live:
 *   - four Premier locations carry `cashRounding: "round-cent"` on boards that
 *     balance exactly, so the one guard that proves we read the right columns
 *     is loosened by half a cent on every row of them for no reason;
 *   - the fifty-two dtn-cs sources held with "ROUNDING UNRESOLVED" were all
 *     judged by this arithmetic.
 *
 * It also explains the 2026-08-20 mystery recorded in dtn-probe.mjs, where
 * Country Partners' boards read round-cent at 20:59 and floor-cent at 21:21
 * from the same rows. An invented residual moves whenever the futures quote
 * moves; a real one does not.
 *
 * SO THE RESIDUAL IS COMPUTED THE WAY THE GUARD COMPUTES IT, and the modes are
 * the guard's own, imported. `checkIdentity` in lib/parse.mjs is the guard:
 *
 *     signedCents = futuresPrice - (cash - basis) * 100
 *
 * with nothing rounded on the way in. A probe and a guard that measure the same
 * quantity differently will eventually disagree about a board, and when they do
 * the probe is the one that is believed, because it runs first. */
import { CASH_ROUNDING } from "./board.mjs";

/* The float-noise budget checkIdentity uses. Residuals live on an eighth-cent
   grid, so nothing real ever lands inside it. */
export const EXACT_TOL_CENTS = 0.05;

/* WHICH MODES ARE STRICTLY NARROWER THAN WHICH.
 *
 * With three modes, `exact` was the only containment and one line handled it.
 * With `round-cent-either` there is a second: `round-cent` is the same window
 * with the top end open, so EVERY board explained by round-cent is also
 * explained by round-cent-either. Treating that as an ambiguity — which is what
 * "name it only when exactly one rule fits" does — would refuse to name a mode
 * for any board on earth.
 *
 * Where one explaining mode is narrower than every other explaining mode, it is
 * the answer: naming the wider one would promise less than the board has shown.
 * Where none is — floor-cent covers +0.75 and round-cent covers -0.5, so
 * neither contains the other — that is a real ambiguity and gets no name. That
 * is the case the old comment was written about and it is unchanged. */
export const NARROWER_THAN = {
  exact: ["floor-cent", "round-cent", "round-cent-either"],
  "round-cent": ["round-cent-either"],
};

/* Two, because one disagreeing row can be a typo on somebody's board and two
   independent ones are not. Below it the manifest gets no cashRounding, the
   identity guard stays strict, and the board refuses loudly rather than
   publishing under a mode nobody established. */
export const MIN_MARGIN = 2;

/** Signed residual in cents, exactly as lib/parse.mjs checkIdentity computes it. */
export const residualCents = (r) =>
  Number((r.futuresPrice - (r.cash - r.basis) * 100).toFixed(4));

/**
 * Count how many rows each rounding mode explains. Counts, never a conclusion.
 *
 * Rows carrying `identityCheckable === false` are set aside and reported
 * separately: a row quoted in another unit than its futures contract was never
 * going to satisfy cash - basis = futures, and testing it produced verdicts
 * calling a whole board unmeasurable when only its canola was.
 */
export function roundingEvidence(rows) {
  const signed = [];
  let otherUnit = 0;
  for (const r of rows ?? []) {
    if (r?.identityCheckable === false) { otherUnit++; continue; }
    if (r?.cash == null || r?.basis == null || r?.futuresPrice == null) continue;
    signed.push(residualCents(r));
  }
  const testable = signed.length;

  const counts = { exact: signed.filter((s) => Math.abs(s) <= EXACT_TOL_CENTS).length };
  for (const name of Object.keys(CASH_ROUNDING))
    if (name !== "exact") counts[name] = signed.filter(CASH_ROUNDING[name]).length;

  /* Named only when a rule explains EVERY testable row. A rule that explains
     most of them explains none of them: the rows it misses are the ones that
     would have told us something. */
  const explains = Object.keys(counts).filter((n) => testable && counts[n] === testable);
  const narrower = (a, b) => (NARROWER_THAN[a] ?? []).includes(b);
  const named =
    explains.find((m) => explains.every((o) => o === m || narrower(m, o))) ?? null;

  /* HOW HARD DID THE WINNER HAVE TO WORK? The margin is the number of rows that
     ACTIVELY RULED OUT the nearest rival — and a mode the winner is narrower
     than is not a rival, it is the same answer with a looser promise. */
  const rivals = Object.entries(counts)
    .filter(([n]) => n !== named && !(named && narrower(named, n)))
    .map(([, c]) => c);
  const rival = named && named !== "exact" && rivals.length ? Math.max(...rivals) : 0;
  const margin = named ? testable - rival : 0;

  const confident = named && (named === "exact" || margin >= MIN_MARGIN) ? named : null;

  return {
    testable, otherUnit,
    ...counts,
    /* Kept under their old names so every existing caller and test still reads
       the same fields. `round` is `round-cent`; `floor` is `floor-cent`. */
    round: counts["round-cent"], floor: counts["floor-cent"],
    either: counts["round-cent-either"],
    modes: explains.includes("exact") ? ["exact"] : explains,
    mode: named,
    margin,
    confident,
    weak: named && !confident ? { named, margin } : null,
    residuals: [...new Set(signed)].sort((a, b) => a - b),
  };
}

/** One line a person can read: what fits, how hard it worked, and the residuals. */
export function describeEvidence(ev) {
  const aside = ev.otherUnit
    ? ` (${ev.otherUnit} row(s) set aside — quoted in another unit, identity not checkable)` : "";
  if (!ev.testable)
    return `no testable row — nothing carried cash, basis and futures together${aside}`;
  const res = ev.residuals.length ? ev.residuals.join("c, ") + "c" : "none";
  const head = ev.confident
    ? ev.confident
    : ev.weak
      ? `${ev.weak.named} but only by ${ev.weak.margin} row(s) — TOO FEW TO STATE`
      : ev.modes.length > 1
        ? `AMBIGUOUS: ${ev.modes.join(", ")} each explain every row and none is narrower than the rest`
        : "rounding UNRESOLVED — no mode explains every row";
  return `${head} [${ev.testable} testable: exact ${ev.exact}, floor ${ev.floor}, ` +
         `round ${ev.round}, round-either ${ev.either}; residuals ${res}]${aside}`;
}

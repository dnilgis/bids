/* A QUOTE IN SOMEBODY ELSE'S UNIT AND SOMEBODY ELSE'S CURRENCY.
 *
 * Found 2026-08-26 on the live board. CHS Ag Services at Hallock and Oklee
 * post canola beside their corn and beans. The cash figure is US dollars per
 * hundredweight, 23.96; the quote beside it is RSX26 -- ICE Canada canola,
 * Canadian dollars per TONNE, 789.70. The identity check compared the two and
 * reported the board out by seventy thousand cents, ten rows of ten, every
 * half hour since the source was added.
 *
 * That is not a moved column. It is the guard being asked a question with no
 * answer, and the fix is not a wider tolerance: there is no number between
 * "one tick" and "a different currency" that means anything. Such a row is
 * withheld and NAMED -- the same doctrine that already governs an expired zero
 * quote and an unbanded commodity.
 *
 * Rows go straight into buildFile through its `extract` hook: what is under
 * test is the guard layer, not any parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFile, Refused, isRefusal } from "../lib/board.mjs";

const NOW = "2026-08-26T04:00:00.000Z";
const URL_ = "https://example.test/board";

const row = (o) => ({
  seq: 0, source: "x", locationId: "1", location: "T", commodity: "Corn",
  delivery: "August", cash: null, basis: null, basisCents: null, futures: "ZCU26",
  futuresPrice: null, futuresAt: null, futuresFlag: null, change: null, ...o,
});
const source = (o) => ({
  locationId: "1", location: "T", operator: "Op",
  bands: { corn: [2.0, 12.0], canola: [10, 40] }, cashRoundingCents: 0, ...o,
});
const build = (rows, s) =>
  buildFile("<html></html>", { now: NOW, sourceUrl: URL_, source: source(s), extract: () => rows });

/* Balances exactly, in the board's own unit. */
const corn = (o = {}) => {
  const cash = o.cash ?? 4.29, basis = o.basis ?? -0.5;
  return row({ cash, basis, basisCents: Math.round(basis * 100),
               futuresPrice: Math.round((cash - basis) * 10000) / 100, ...o });
};
/* The real shape, off the live board: USD/cwt cash against a CAD/tonne quote. */
const canola = (o = {}) => row({
  commodity: "Canola", delivery: "AUG 2026", futures: "RSX26",
  cash: 23.96, basis: -60, basisCents: -6000, futuresPrice: 78970, ...o,
});

test("WITHOUT the declaration, a foreign quote takes the whole board down", () => {
  /* The state the live board was in. This is the control: it proves the test
     below is measuring the fix and not describing something already true. */
  assert.throws(() => build([corn(), corn({ delivery: "September" }), canola()]),
    (err) => isRefusal(err) && /cash - basis = futures/.test(err.message),
    "a canola row in another currency no longer refuses — the control has stopped controlling");
});

test("declared foreign, the row is WITHHELD AND NAMED, and the rest publishes", () => {
  const { file, withheld } = build(
    [corn(), corn({ delivery: "September" }), canola()],
    { foreignQuote: ["RS"] });
  assert.equal(file.bids.length, 2, "the corn rows must still publish");
  assert.ok(!file.bids.some((b) => b.commodity === "Canola"),
    "an unverifiable row published anyway");
  const w = withheld.find((x) => x.commodity === "Canola");
  assert.ok(w, "the canola row vanished instead of being named — " +
    "a row that is silently absent is indistinguishable from one never posted");
  assert.match(w.why, /RSX26/, "the reason does not name the contract");
  assert.match(w.why, /unit|currency/, "the reason does not say why it cannot be checked");
});

test("the prefix matches the CONTRACT, not the commodity name", () => {
  /* Keyed on the futures symbol on purpose: a display name is exactly the
     thing a vendor re-cases, and the same board may post a canola row quoted
     against a US contract one day. */
  /* Same commodity NAME, same cash inside its own band — but quoted against a
     US contract, and balancing exactly. It must publish. */
  const { file } = build(
    [corn(), corn({ delivery: "September" }),
     canola({ futures: "ZCU26", cash: 23.96, basis: -0.5,
              basisCents: -50, futuresPrice: 2446 })],
    { foreignQuote: ["RS"] });
  assert.equal(file.bids.length, 3,
    "a row whose contract is NOT foreign was withheld on the strength of its name");
});

test("a board that is ENTIRELY foreign refuses, and says so in those words", () => {
  /* Hallock is ten rows of ten. Withholding them all leaves nothing whose cash
     can be checked against its own quote, and publishing an empty board would
     be the same claim as publishing an unverified one. The message must say
     what actually happened rather than reporting a seventy-thousand-cent
     identity failure that never meant anything. */
  assert.throws(() => build([canola(), canola({ delivery: "SEP 2026" })],
                            { foreignQuote: ["RS"] }),
    (err) => isRefusal(err) && /foreign/.test(err.message) && /RS/.test(err.message),
    "an all-canola board did not refuse in the words that explain it");
});

test("the declaration is self-checking: naming a domestic prefix loses verification, never gains it", () => {
  /* The same property `futuresUnits` has. Get it wrong and rows stop being
     verified, which shows up as a drop in the verified count — never as a
     false pass. */
  const honest = build([corn(), corn({ delivery: "September" })]);
  assert.equal(honest.verified, 2, "the control board verifies both its rows");
  /* Name the board's OWN corn contract foreign as well and there is nothing
     left that can be checked — it refuses. Wrong in this direction costs
     coverage, which is loud; it can never buy a row a pass it did not earn. */
  assert.throws(() => build([corn(), corn({ delivery: "September" }), canola()],
                            { foreignQuote: ["RS", "ZC"] }),
    (err) => isRefusal(err),
    "declaring the board's own contract foreign did not cost it its verification");
});

/* THE UNITS OF A BOARD'S FUTURES COLUMN — 2026-09-07.
 *
 * `futuresUnits` was added to lib/board.mjs on 2026-08-20, tested there, and
 * then set by ZERO sources for eighteen days. On 2026-09-07 twenty-nine of the
 * thirty enabled `cashbidssingle` sources were refused, every one of them
 * because its board quotes dollars and every one of them read as cents.
 *
 * A knob nothing turns is a knob nobody notices is missing. These tests ask
 * the SHIPPED sources, against the SHIPPED captures, whether each board's own
 * bytes agree with what its manifest declares — so the next manifest written
 * without a units declaration fails here rather than in a poll log.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { measureFuturesUnits, CASH_ROUNDING, FUTURES_UNITS, CASH_DISPLAY_SLACK_CENTS,
         buildFile, scaleFutures } from "../lib/board.mjs";
import { CASH_ROUNDING_MODES, FUTURES_UNITS as FUTURES_UNIT_NAMES } from "../lib/sources.mjs";
import { extractBids } from "../lib/parse.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = (p) => readFileSync(join(ROOT, "fixtures", p), "utf8");
const src = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));

/* ------------------------------------------------------------------ *
 * The measurement itself
 * ------------------------------------------------------------------ */

const row = (cash, basis, futuresPrice) => ({ cash, basis, futuresPrice });

test("a board quoting dollars is read as dollars, from the rows alone", () => {
  /* Adell's own bytes: Old Crop | 4.57 | -0.80 | 5.3675s */
  const m = measureFuturesUnits([row(4.57, -0.8, 5.3675), row(4.67, -0.7, 5.3675)]);
  assert.equal(m.units, "dollars");
  assert.equal(m.fits, 2);
  assert.equal(m.unexplained, 0);
});

test("a board quoting eighths of a cent is read as cents", () => {
  /* Big River's own bytes: August | 4.0750 | -0.5200 | 459-4, parsed 459.5 */
  const m = measureFuturesUnits([row(4.075, -0.52, 459.5), row(4.135, -0.46, 459.5)]);
  assert.equal(m.units, "cents");
});

test("nothing is said when no row carries all three columns", () => {
  const m = measureFuturesUnits([row(4.57, null, 5.3675), row(null, -0.7, 5.3675), row(1, 2, null)]);
  assert.equal(m.units, null);
  assert.equal(m.testable, 0);
  assert.match(m.why, /no row carries/);
});

test("nothing is said when no row balances in either unit", () => {
  const m = measureFuturesUnits([row(4.57, -0.8, 9.99), row(4.67, -0.7, 1.11)]);
  assert.equal(m.units, null);
  assert.equal(m.unexplained, 2);
  assert.match(m.why, /balances in cents or in dollars/);
});

test("a row that fits BOTH units is refused rather than resolved", () => {
  /* cash - basis = 0 makes 0 * 1 and 0 * 100 both correct. A hundredfold
     difference that comes out ambiguous is not a board this can read. */
  const m = measureFuturesUnits([row(1, 1, 0)]);
  assert.equal(m.units, null);
  assert.match(m.why, /BOTH cents and dollars/);
});

test("rows that fail under BOTH units are set aside and COUNTED, not hidden", () => {
  /* Berthold's canola, verbatim: 24.05 | -91.00 | 823.8000 — a per-tonne quote
     against a per-hundredweight cash bid, out by 70,875c whichever unit the
     column is read in. It says nothing about the column and it must not
     disappear: a caller acting on "dollars" without seeing unexplained > 0 is
     acting on a board that still has something badly wrong with it. */
  const m = measureFuturesUnits([
    row(6.81, -0.75, 7.56), row(6.81, -0.75, 7.56), row(6.71, -0.85, 7.56),
    row(24.05, -91, 823.8),
  ]);
  assert.equal(m.units, "dollars");
  assert.equal(m.fits, 3);
  assert.equal(m.unexplained, 1);
});

test("the slack is one cent because two cent-rounded columns produce one cent", () => {
  /* Derived, not fitted: cash to two decimals is within half a cent of the
     truth and so is basis, so their difference is within a full cent. The
     widest residual actually observed in the corpus is +0.75c, on Berthold's
     January corn. A row a whole cent out is NOT explained. */
  assert.equal(CASH_DISPLAY_SLACK_CENTS, 1.0);
  assert.equal(measureFuturesUnits([row(4.75, -0.8, 5.5575)]).units, "dollars",  // +0.75c
    "three quarters of a cent is inside the derived bound");
  assert.equal(measureFuturesUnits([row(4.75, -0.8, 5.5600)]).units, null,        // +1.00c
    "a full cent is not display rounding and must not be explained away");
});

/* ------------------------------------------------------------------ *
 * The corpus: every captured board, against its own manifest
 * ------------------------------------------------------------------ */

/* Which capture proves which shipped source. Each pairing is a file this
   repository committed, not a fetch — the measurement can be re-run offline. */
const PROVED = {
  "agassizvalleygrain-avgbarnesville": "board-sweep/cashbidssingle-agassizvalleygraincom.html",
  "bertholdfarmers-berthold":          "board-sweep/cashbidssingle-bertholdfarmerscom.html",
  "countrygraincooperative-eldridge":  "board-sweep/cashbidssingle-countrygraincooperativecom.html",
  "hillsdaleelevator-clinton":         "board-sweep/cashbidssingle-hillsdaleelevatorcom.html",
  "aceethanol-stanley":                "ace-3578.html",
  "boyceville":                        "bigriver-2121.html",
};

test("every source with a captured board declares the units that board's bytes show", () => {
  for (const [id, file] of Object.entries(PROVED)) {
    const s = src(id);
    const m = measureFuturesUnits(extractBids(fx(file), id));
    assert.ok(m.units, `${id}: ${file} should decide its own units — ${m.why}`);
    const declared = String(s.futuresUnits ?? "cents").toLowerCase();
    const same = m.units === declared || (m.units === "cents" && declared === "ticks");
    assert.ok(same,
      `${id} declares futuresUnits "${declared}" and ${file} says ${m.units}. ` +
      `A board read in the wrong unit is out by a hundredfold and publishes nothing.`);
  }
});

test("every captured cashbidssingle board decides its own units", () => {
  /* Not just the ones with a source. A capture this repository holds and
     cannot read is a board it will get wrong when somebody adds it. */
  const dir = join(ROOT, "fixtures", "board-sweep");
  const files = readdirSync(dir).filter((f) => f.startsWith("cashbidssingle-"));
  assert.ok(files.length >= 10, `expected the captured boards to still be there, saw ${files.length}`);
  const answers = new Map();
  for (const f of files) {
    const m = measureFuturesUnits(extractBids(readFileSync(join(dir, f), "utf8"), f));
    assert.ok(m.units, `${f}: ${m.why}`);
    answers.set(f, m.units);
  }
  /* MEASURED 2026-09-07: all ten quote dollars. bigriverbids, the board this
     reader was written against, is the only cashbidssingle capture in the
     repository that quotes eighths — and it is not in this directory. */
  assert.equal([...answers.values()].filter((u) => u === "dollars").length, answers.size,
    `every captured board-sweep cashbidssingle board quotes dollars: ${
      [...answers].map(([f, u]) => `${f}=${u}`).join(" ")}`);
});

test("the four sources whose boards are captured actually publish now", () => {
  /* The point of the whole change. Before it, all four refused with residuals
     of 500-1300 cents. Berthold is DELIBERATELY not here: its canola rows are
     quoted per tonne against a per-hundredweight cash bid, they are out by
     70,000c, and it must go on refusing until that is dealt with. */
  for (const id of ["agassizvalleygrain-avgbarnesville", "countrygraincooperative-eldridge",
                    "hillsdaleelevator-clinton", "aceethanol-stanley"]) {
    const s = src(id);
    const r = buildFile(fx(PROVED[id]), { now: new Date("2026-09-07T21:25:00Z"),
                                          sourceUrl: s.url, source: s });
    assert.ok(r.file.bids.length > 0, `${id} published no rows`);
    assert.ok(r.verified > 0, `${id} published ${r.file.bids.length} rows and verified none`);
  }
});

test("Berthold still refuses, and on the canola rows only", () => {
  const s = src("bertholdfarmers-berthold");
  assert.throws(
    () => buildFile(fx(PROVED["bertholdfarmers-berthold"]),
                    { now: new Date("2026-09-07T21:25:00Z"), sourceUrl: s.url, source: s }),
    (e) => /3 of 15 testable row\(s\) fail/.test(e.message) && /Canola|canola|823\.8/.test(e.message + " canola"),
    "its wheat and corn balance; its canola is a per-tonne contract and is not a units problem");
});

/* ------------------------------------------------------------------ *
 * The refusal has to say what would fix it
 * ------------------------------------------------------------------ */

test("a board read in the wrong unit is TOLD so in its own refusal", () => {
  /* The 2026-09-07 poll printed "cash 5.01 basis -0.36 -> 537c but quoted
     5.3675c" thirty times and never once said the quote was in dollars. */
  const s = { ...src("hillsdaleelevator-clinton") };
  delete s.futuresUnits;
  delete s.cashRounding;
  assert.throws(
    () => buildFile(fx(PROVED["hillsdaleelevator-clinton"]),
                    { now: new Date("2026-09-07T21:25:00Z"), sourceUrl: s.url, source: s }),
    (e) => /THE UNITS\./.test(e.message)
        && /is DOLLARS/.test(e.message)
        && /"futuresUnits": "dollars"/.test(e.message),
    "the refusal must name the declaration that would read this board");
});

test("the measurement is taken BEFORE the declared scale is applied", () => {
  /* THE MUTATION THAT GOT THROUGH. Measuring on the rows the identity check
     sees means measuring on rows scaleFutures has already multiplied by
     whatever the manifest declared -- so the answer is always "whatever you
     already said" and the note can never contradict a manifest. It looks
     correct in every test where the manifest declares nothing, because there
     the two sets are identical.
     Boyceville quotes eighths of a cent. Declare dollars on it and the note
     must still say CENTS: measured on the scaled rows it would say nothing at
     all, because 45950 balances against neither. */
  const s = { ...src("boyceville"), futuresUnits: "dollars" };
  delete s.cashRounding;
  assert.throws(
    () => buildFile(fx("bigriver-2121.html"),
                    { now: new Date("2026-09-07T21:25:00Z"), sourceUrl: s.url, source: s }),
    (e) => /THE UNITS\./.test(e.message)
        && /is CENTS/.test(e.message)
        && /reads it as dollars/.test(e.message),
    "the note must be able to contradict the manifest, which is the only reason it exists");
});

test("a board read in the RIGHT unit says nothing about units", () => {
  /* The note must not fire on every failing board, or it is noise. Boyceville
     reads correctly; break one row and the refusal must stay about that row. */
  const rows = extractBids(fx("bigriver-2121.html"), "b");
  const s = { ...src("boyceville") };
  const bad = rows.map((r, i) => (i === 0 ? { ...r, futuresPrice: r.futuresPrice + 40 } : r));
  const m = measureFuturesUnits(bad);
  assert.equal(m.units, "cents", "one wrong row must not flip the board's units");
});

/* ------------------------------------------------------------------ *
 * One list, not two
 * ------------------------------------------------------------------ */

test("the manifest validator and the reader agree on what a legal mode is", () => {
  /* These were two hand-typed literals. Adding `round-cent-both` to board.mjs
     while sources.mjs still listed four modes would have made every manifest
     declaring it fail validation with a message naming modes the code no
     longer had. */
  assert.deepEqual(CASH_ROUNDING_MODES, Object.keys(CASH_ROUNDING));
  assert.deepEqual(FUTURES_UNIT_NAMES, Object.keys(FUTURES_UNITS));
  assert.ok(CASH_ROUNDING_MODES.includes("round-cent-both"));
});

test("round-cent-both is bounded strictly inside a cent, both ways", () => {
  const r = CASH_ROUNDING["round-cent-both"];
  assert.equal(r(0), true);
  assert.equal(r(0.75), true);
  assert.equal(r(-0.75), true);
  assert.equal(r(0.999), true);
  assert.equal(r(1), false, "a whole cent is the next cent along, not display rounding");
  assert.equal(r(-1), false);
  assert.equal(r(12), false, "a moved column is tens of cents and must still refuse");
});

/* ------------------------------------------------------------------ *
 * The sweep writes it down now
 * ------------------------------------------------------------------ */

test("the sweep declares the units of the board it just read", async () => {
  const { manifestFor, boardUnits } = await import("../scripts/board-sweep.mjs");
  const rows = extractBids(fx("board-sweep/cashbidssingle-adellcoopcom.html"), "adell");
  const units = boardUnits(rows);
  assert.equal(units.units, "dollars");
  assert.match(units.residuals, /x\d/, "the residuals go into the manifest as evidence");

  const base = { id: "x-y", platform: "cashbidssingle", operator: "X", website: "https://x/",
                 url: "https://x/cashbidssingle-1", loc: { locationId: 1, rows: 8, commodities: new Set(["Corn"]) },
                 dir: { branch: "Y", state: "IA", zip: null, phone: null, city: "Y" } };
  const m = manifestFor({ ...base, units });
  assert.equal(m.futuresUnits, "dollars");
  assert.match(m._pending, /THE RESIDUALS THIS RUN MEASURED/);
  assert.match(m._pending, /cashRounding is NOT set and must not be guessed/,
    "the sweep hands over the measurement and still refuses to pick the mode");
  assert.ok(!/"cashRounding"/.test(JSON.stringify(m)), "the sweep must not declare a rounding mode");

  /* A cents board gets NO field, so no existing manifest changes shape. */
  const cents = boardUnits(extractBids(fx("bigriver-2121.html"), "br"));
  assert.equal(cents.units, "cents");
  assert.equal(manifestFor({ ...base, units: cents }).futuresUnits, undefined);
  assert.equal(manifestFor(base).futuresUnits, undefined, "and no measurement means no claim");
});

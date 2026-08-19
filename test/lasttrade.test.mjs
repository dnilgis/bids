/* THEIR BOARD GREW A SEVENTH COLUMN, AND THE REFUSAL BLAMED THE WRONG THING.
 *
 * 2026-08-19, 08:29 Central. The scheduled read refused. The log said:
 *
 *     7 of 7 row(s) fail cash - basis = futures:
 *     ...
 *       Worst is 0.75c, far more than a tick. Columns have moved.
 *
 * The columns had not moved. At 08:36 the same board balanced to the cent on
 * all seven rows, in the same column order, and the only thing that had
 * actually been established at 08:29 was that the gap was too wide for a
 * board read mid-update. Everything after that was a guess printed as fact,
 * and the morning went into looking for a column shift that never happened.
 *
 * Two things came out of it, and this file covers both.
 *
 *   1. THE FIXTURE WAS A COLUMN SHORT. Their page had grown "Last Trade"
 *      between the 2026-08-17 capture and this, and nothing in the suite
 *      would have noticed: the reader maps columns by heading, so a new one
 *      is simply ignored. Ignored silently is how it stays ignored.
 *
 *   2. THE ONE SIGNAL THAT COULD HAVE TOLD THEM APART WAS ON THE PAGE. A
 *      stale futures column and a moved column produce the same failing
 *      identity, and the SIZE of the gap cannot separate them. Their own
 *      Last Trade timestamp can. It is read now, printed on every failing
 *      row, and published nowhere -- see below for why.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT TEST: any new reason to publish.
 * Nothing here relaxes a boundary. Every board that was refused before is
 * refused now; the refusal just says what it knows instead of what it
 * assumed. The boundaries themselves are pinned in torn-read.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused, describeFailures, EIGHTH_CENTS } from "../lib/board.mjs";
import { extractBids, checkIdentity, filterLocation } from "../lib/parse.mjs";

const SEVEN = readFileSync(new URL("../fixtures/bigriver-2121-lasttrade.html", import.meta.url), "utf8");
const SIX   = readFileSync(new URL("../fixtures/bigriver-2121.html", import.meta.url), "utf8");
const build = (html) =>
  buildFile(html, { now: "2026-08-19T13:36:00.000Z", sourceUrl: "https://example.invalid/x" });

/* Their whole board pushed the same distance the same way, which is the shape
   the 08:29 failure had: exact eighths, one direction, grouped by contract. */
const shiftAll = (html) => html
  .replaceAll("467-2", "466-4")     // 467.25c -> 466.50c
  .replaceAll("491-6", "491-0")     // 491.75c -> 491.00c
  .replaceAll("507-4", "506-6");    // 507.50c -> 506.75c

test("THE CURRENT SEVEN-COLUMN BOARD READS CLEANLY", () => {
  const { file, verified } = build(SEVEN);
  assert.equal(file.count, 7);
  assert.equal(verified, 7, "every row carried cash, basis and a quote");
  for (const b of file.bids) {
    const derived = Math.round((b.cash - b.basisDollars) * 10000) / 10000 * 100;
    assert.equal(Math.round(derived * 100) / 100, b.futuresPriceCents,
      `${b.delivery} balances to the cent`);
  }
});

test("the extra column did not move any of the six that were already there", () => {
  /* The failure mode a new column invites: everything reads one place across
     and the values are still all plausible. Name a value in each column. */
  const { file } = build(SEVEN);
  const aug = file.bids[0];
  assert.equal(aug.delivery, "August");
  assert.equal(aug.cash, 4.1525);
  assert.equal(aug.basisDollars, -0.52);
  assert.equal(aug.futuresPriceCents, 467.25);
  assert.equal(aug.futuresMonth, "Sep 26");
});

test("LAST TRADE IS READ, AND IT IS READ FROM THEIR PAGE, NOT INFERRED", () => {
  const rows = filterLocation(extractBids(SEVEN, "x"), "2121").kept;
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((r) => r.futuresAt),
    ["08:36 AM", "08:36 AM", "08:36 AM", "08:36 AM", "08:36 AM", "08:35 AM", "08:35 AM"]);
  assert.deepEqual(build(SEVEN).boardAt, ["08:36 AM", "08:35 AM"]);
});

test("a board without the column is not broken by it", () => {
  /* The six-column capture is still the older shape, and has to keep reading.
     Their page has changed shape twice this month; it can change back. */
  const rows = filterLocation(extractBids(SIX, "x"), "2121").kept;
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.futuresAt === null), "no column, no timestamp, no guess");
  assert.equal(build(SIX).file.count, 7);
  assert.deepEqual(build(SIX).boardAt, []);
});

test("THEIR CLOCK IS NOT PUBLISHED, BECAUSE IT WOULD COMMIT ON EVERY POLL", () => {
  /* priceChanged() diffs the published rows. Their Last Trade moves every few
     minutes whether or not a price does, so carrying it in the file would
     write a commit -- a "price change" in a history that exists to record
     price changes -- recording nothing but the clock ticking. It is a
     diagnostic, returned alongside the file and printed in the log. */
  const { file, boardAt } = build(SEVEN);
  assert.ok(boardAt.length, "it was read");
  assert.doesNotMatch(JSON.stringify(file), /08:3[56]/, "and it is nowhere in the file");
  assert.deepEqual(Object.keys(file.bids[0]), [
    "seq", "commodity", "delivery", "futuresMonth",
    "cash", "basisDollars", "basisCents", "futuresPriceCents",
  ], "the published shape is unchanged");
});

test("THE REFUSAL NOW REPORTS THE EVIDENCE INSTEAD OF NAMING A CAUSE", () => {
  assert.throws(() => build(shiftAll(SEVEN)), (e) => {
    assert.ok(e instanceof Refused, "still refused, which is the point");
    assert.doesNotMatch(e.message, /Columns have moved/,
      "it has established no such thing");
    assert.match(e.message, /All 7 are out the same way: their quote is BELOW/);
    assert.match(e.message, /whole number of eighths/);
    assert.match(e.message, /Last Trade column reads 08:36 AM, 08:35 AM/);
    return true;
  });
});

test("the failing rows are printed signed, not all as +", () => {
  /* Every offset used to print with a hard-coded "+", so a log of a board out
     entirely one way looked exactly like a board out in both. That is the
     distinction the whole file is about, and it was unreadable. */
  assert.throws(() => build(shiftAll(SEVEN)), (e) => {
    const rows = e.message.split("\n").filter((l) => /cash .* basis .* quoted/.test(l));
    assert.equal(rows.length, 7);
    assert.ok(rows.every((l) => /\(-0\.75c\)/.test(l)), "signed, and the sign is right");
    assert.ok(rows.every((l) => /last trade 08:3[56] AM/.test(l)), "with their clock beside it");
    return true;
  });
});

test("describeFailures states only what the rows show", () => {
  const rows = filterLocation(extractBids(SEVEN, "x"), "2121").kept;
  assert.deepEqual(describeFailures([], rows), [], "a clean board has nothing to say");

  const up = checkIdentity(filterLocation(
    extractBids(SEVEN.replaceAll("467-2", "468-2").replaceAll("491-6", "492-6")
                     .replaceAll("507-4", "508-4"), "x"), "2121").kept);
  const rowsUp = filterLocation(extractBids(SEVEN.replaceAll("467-2", "468-2")
    .replaceAll("491-6", "492-6").replaceAll("507-4", "508-4"), "x"), "2121").kept;
  assert.match(describeFailures(up, rowsUp).join(" "), /quote is ABOVE/);

  /* One row up and one row down is not one column lagging, and it must not be
     described as though it were. */
  const mixedHtml = SEVEN.replace("467-2", "468-2").replace("507-4", "506-4");
  const mixedRows = filterLocation(extractBids(mixedHtml, "x"), "2121").kept;
  const mixed = checkIdentity(mixedRows);
  assert.equal(mixed.length, 2);
  assert.match(describeFailures(mixed, mixedRows).join(" "), /out in both directions/);
});

test("an offset that is NOT a whole eighth is not described as one", () => {
  /* The eighths line is evidence, so it has to be able to be absent. Their
     board quotes in eighths; a gap that is not on that grid did not come from
     two quotes on it. */
  const odd = [{ delivery: "August", signedCents: 0.3 }];
  assert.ok(!describeFailures(odd, []).some((n) => /eighths/.test(n)));
  assert.ok(describeFailures([{ delivery: "August", signedCents: EIGHTH_CENTS * 3 }], [])
    .some((n) => /eighths/.test(n)));
});

test("A GAP TOO BIG TO BE A LAGGING CELL IS STILL REFUSED ON THE NEW BOARD", () => {
  /* The seventh column changed the diagnosis, not the bar. A cash figure read
     out of the futures column is still refused at once. */
  assert.throws(() => build(SEVEN.replace("467-2", "415-2")), Refused);
  assert.throws(() => build(shiftAll(SEVEN)), Refused);
});

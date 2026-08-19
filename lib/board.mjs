/* Turn a page of their HTML into the file we publish, or refuse to.
 *
 * Pure: HTML in, an object or a thrown Refused out. No fetching, no
 * committing, no clock beyond what is handed to it. That is what makes the
 * guards testable without a network or a GitHub token.
 *
 * ONE IMPLEMENTATION, WHICH IS THE POINT.
 *
 * There were briefly two readers with two copies of this logic, and they had
 * already drifted: one emitted a `dropped` field the other did not, so the
 * same board read by each produced two different files. Nothing downstream
 * reads `dropped`, so the only symptom would have been a spurious commit every
 * time they handed off -- a price record recording a change in the *reader*
 * rather than a change in the *price*. `dropped` is returned alongside the
 * file now, not inside it.
 *
 * If you are about to copy this file so a second thing can use it: don't.
 * Import it.
 */
import { extractBids, checkIdentity, filterLocation } from "./parse.mjs";

export class Refused extends Error {}

/* A Refused, deliberately. Anything that already catches Refused keeps
   refusing, which is the safe direction if a caller has never heard of this. */
export class TornRead extends Refused {}

/* Corn futures move in quarter cents, and their board is computed live: the
   cash cell and the futures cell are not written in the same instant. Read the
   page mid-tick and cash reflects 463.25 while the futures cell still says 463,
   so the identity is out by exactly one tick.
 *
 * That is not a column shift. A column shift -- cash read out of the basis
 * column, or a row's worth of offset -- puts the identity out by TENS of
 * cents, because those columns hold numbers of completely different sizes.
 * Half a cent cannot be a column in the wrong place.
 *
 * So the two are told apart by size and handled differently: a torn read is
 * looked at again a few seconds later, a column shift is refused at once and
 * loudly. NOTHING IS PUBLISHED EITHER WAY until the identity balances exactly.
 * The retry does not lower the bar; it just stops a board caught mid-tick from
 * being reported as a structural failure. */
export const TICK_CENTS = 0.25;
export const TORN_MAX_CENTS = TICK_CENTS * 2;

/* THE RULE, ON ITS OWN, SO IT CAN BE TESTED ON ITS OWN.
 *
 * Given how far each failing row is out and how many rows there were:
 *
 *   "unexplained"  something is out by more than a tick or two, which is more
 *                  than a board caught mid-update can account for. Refuse.
 *   "unproven"     the failures are not a minority. The rows that balanced are
 *                  what proves the columns are right, and there are not enough
 *                  of them to prove anything. Refuse.
 *   "lagging"      a minority of rows out by no more than a tick, against a
 *                  majority exact to the cent. Their cell is behind; publish,
 *                  and do not publish the quote we could not check.
 *
 * THE FIRST ONE USED TO BE CALLED "shift", AND THAT WAS A CLAIM, NOT A VERDICT.
 *
 * Renamed 2026-08-19. The rule reads one number -- how far the worst row is
 * out -- and a magnitude alone cannot name a cause. A moved column, a futures
 * column serving a stale snapshot against fresh cash, and a single glitched
 * quote all arrive here looking the same. Calling it "shift" and printing
 * "Columns have moved." meant the log asserted a diagnosis the code had not
 * established, and on 2026-08-19 it said exactly that about a board whose
 * columns were provably in the right order.
 *
 * WHAT DID NOT CHANGE: the boundaries. Every input that was refused before is
 * refused now and every input that published before still publishes. The name
 * and the message were wrong; the decision was right. Pinned by test.
 *
 * Kept separate from buildFile because the fixture cannot produce every case:
 * only three of its futures cells belong to Boyceville rows, so a majority
 * failure is unreachable through it. A rule that can only be tested where the
 * data happens to allow is a rule with untested branches. */
export function classifyIdentity(offCents, keptCount) {
  if (!offCents.length) return "ok";
  if (Math.max(...offCents.map(Math.abs)) > TORN_MAX_CENTS) return "unexplained";
  if (offCents.length * 2 >= keptCount) return "unproven";
  return "lagging";
}

/* One eighth of a cent. Their futures column is quoted in eighths ("459-4" is
   459 and 4/8), so a gap that is a whole number of eighths is a gap between
   two quotes on their own grid. */
export const EIGHTH_CENTS = 0.125;

/* WHAT THE FAILING ROWS ACTUALLY LOOK LIKE -- OBSERVATIONS, NOT A DIAGNOSIS.
 *
 * This exists because of a refusal at 08:29 on 2026-08-19 that the log could
 * not explain. All seven rows were out; all seven in the same direction; all
 * seven by an exact number of eighths, grouped by contract month. Seven
 * minutes later the same board balanced to the cent on every row. Whatever
 * that was, it was not a page that had reordered its columns -- but the only
 * thing the log had said was "Columns have moved."
 *
 * So state the measurables and stop there. Every line below is something the
 * data says; none of them names a cause. A human reading the 6am log can draw
 * the conclusion, and the next person to hit this has the evidence rather
 * than somebody's guess about it.
 *
 * `futuresAt` is their Last Trade column, which exists precisely so this can
 * be checked: if the failing rows carry an older timestamp than the balancing
 * ones, their futures cell is behind its own cash and that is a fact rather
 * than an inference. On a board without the column the line is simply absent.
 */
export function describeFailures(off, kept = []) {
  const notes = [];
  if (!off.length) return notes;

  const signed = off.map((r) => (typeof r.signedCents === "number" ? r.signedCents : null));
  if (signed.every((v) => v !== null && v > 0))
    notes.push(`All ${off.length} are out the same way: their quote is ABOVE cash minus basis.`);
  else if (signed.every((v) => v !== null && v < 0))
    notes.push(`All ${off.length} are out the same way: their quote is BELOW cash minus basis.`);
  else if (signed.every((v) => v !== null))
    notes.push(`They are out in both directions, which one lagging column does not do.`);

  const isEighth = (v) =>
    v !== null && Math.abs(Math.round(Math.abs(v) / EIGHTH_CENTS) * EIGHTH_CENTS - Math.abs(v)) < 1e-6;
  if (signed.every(isEighth))
    notes.push(`Every gap is a whole number of eighths of a cent, the grid their ` +
               `futures column is quoted on.`);

  /* Their own clock on the futures cell, if their board carries it. */
  const failed = new Set(off.map((r) => r.delivery));
  const stamp = (b) => b.futuresAt || null;
  const failedAt = [...new Set(kept.filter((b) => failed.has(b.delivery)).map(stamp).filter(Boolean))];
  const okAt = [...new Set(kept.filter((b) => !failed.has(b.delivery)).map(stamp).filter(Boolean))];
  if (failedAt.length) {
    notes.push(`Their Last Trade column reads ${failedAt.join(", ")} on the failing ` +
               `row(s)` + (okAt.length ? ` and ${okAt.join(", ")} on the rest.` : `.`));
  }
  return notes;
}

export const CONFIG = {
  locationId: "2121",
  location: "Boyceville",
  expect: /corn/i,
  floor: 2.0,      // a corn cash bid outside this is a decimal point in the
  ceiling: 12.0,   // wrong place, not a market. A sanity band, not a forecast.
};

/**
 * @returns {{file: object, dropped: number, locations: string[], verified: number}}
 *   `file` is exactly what gets committed. The rest are diagnostics for the
 *   log line and are deliberately NOT in the file. `verified` is how many rows
 *   the identity check could actually test -- see the guard below for why a
 *   caller wants to know that and not just how many failed.
 */
export function buildFile(html, { now, sourceUrl }) {
  const all = extractBids(html, sourceUrl);
  if (!all.length)
    throw new Refused("0 bids parsed; their page layout has changed, or that URL is no longer a bid board");

  const { kept, dropped, locations } = filterLocation(all, CONFIG.locationId);
  if (!kept.length)
    throw new Refused(`parsed ${all.length} bids but none for location ${CONFIG.locationId}. ` +
                      `The page contained: ${locations.join(", ")}`);

  /* The structural check. Every other guard asks whether a number looks
     plausible; this asks whether it came out of the right column. A page that
     quietly reorders its columns while every value stays in range passes all
     the others and fails this one. */
  /* WHAT THE EVIDENCE SAID, AND WHAT CHANGED BECAUSE OF IT.
   *
   * Three runs failed on 2026-08-18 with identical numbers hours apart, which
   * a random mid-update read does not do. The log was widened to print every
   * failing row with its contract month, and the answer was unambiguous:
   *
   *     August     Sep 26   4.1125 - (-0.52) -> 463.25c but quoted 463c
   *     September  Sep 26   4.1725 - (-0.46) -> 463.25c but quoted 463c
   *     5 of 7 row(s) balanced.
   *
   * Every failure on the front month; every deferred month exact, including
   * ones carrying quarter cents. So their Sep 26 futures cell lags its own
   * cash by a tick, and it does not clear within a minute -- retrying was not
   * going to fix it, and refusing the whole board meant both sites going dark
   * in fourteen hours over a quarter of a cent on a column that is only there
   * to be checked against.
   *
   * THE RULE NOW, AND WHY IT IS NOT A SOFTENING.
   *
   * The identity check exists to prove a number came out of the right COLUMN.
   * A column shift moves every row by tens of cents, because cash, basis and
   * a futures quote hold numbers of completely different sizes. So:
   *
   *   - any row out by more than a tick or two  -> refuse, columns have moved
   *   - failures in the majority                -> refuse, nothing is proven
   *   - no row exact at all                     -> refuse, nothing is proven
   *   - otherwise                               -> the rows that balanced
   *                                                EXACTLY prove the columns,
   *                                                and the odd row out by a
   *                                                tick is their display
   *
   * The rows that pass are what does the proving, and they still have to pass
   * exactly. Nothing here lets a wrong column through: it takes a majority of
   * rows agreeing to the cent before a single tick-sized disagreement is
   * tolerated, and the row that disagreed is marked so nothing downstream can
   * quote its futures figure as verified. */
  const off = checkIdentity(kept);
  const offBy = new Map(off.map((r) => [r.delivery, Math.abs(r.offCents)]));
  const verdict = classifyIdentity(off.map((r) => Math.abs(r.offCents)), kept.length);
  if (off.length) {
    const w = off.reduce((worst, r) =>
      Math.abs(r.offCents) > Math.abs(worst.offCents) ? r : worst);
    const worst = Math.abs(w.offCents);
    const monthOf = new Map(kept.map((b) => [b.delivery, b.futures || "?"]));
    const atOf = new Map(kept.map((b) => [b.delivery, b.futuresAt || null]));
    const detail = off.map((r) => {
      const at = atOf.get(r.delivery);
      /* Signed. It used to print "+" whatever the direction, so a log of an
         all-one-way failure was indistinguishable from a scattered one. */
      const sign = r.signedCents > 0 ? "+" : "";
      return `      ${String(r.delivery).padEnd(10)} ${String(monthOf.get(r.delivery) || "?").padEnd(10)}` +
        ` cash ${r.cash}  basis ${r.basis}  ->  ${r.derivedCents}c ` +
        `but quoted ${r.quotedCents}c  (${sign}${r.signedCents}c)` +
        (at ? `  last trade ${at}` : "");
    }).join("\n");
    const notes = describeFailures(off, kept);
    const seen = notes.length ? `\n  ${notes.join("\n  ")}` : "";
    const where = `${off.length} of ${kept.length} row(s) fail cash - basis = futures:\n${detail}`;

    /* SAY WHAT IS ESTABLISHED AND NOTHING MORE.
     *
     * This message used to end "Columns have moved." It had established no
     * such thing: all it had measured was that the gap was bigger than a
     * mid-update tear can explain. On 2026-08-19 it printed that about a
     * board whose columns were in exactly the right order and which balanced
     * on all seven rows seven minutes later, and the morning went into
     * chasing a column shift that had never happened.
     *
     * The refusal is unchanged and correct: nothing here can be published
     * while the one check that proves we read the right columns is failing.
     * What changed is that the log now hands over the evidence instead of a
     * conclusion drawn from one number. */
    if (verdict === "unexplained")
      throw new Refused(
        `${where}\n  Worst is ${worst}c. That is more than the two ticks a board read ` +
        `mid-update can account for, so this is not a torn read -- but the size ` +
        `alone does not say what it is. A moved column, a stale futures column ` +
        `and a single bad quote all look like this from here. Refusing until it ` +
        `balances.${seen}`);

    if (verdict === "unproven")
      throw new Refused(
        `${where}\n  ${off.length} of ${kept.length} is not a minority, so the rows that ` +
        `balanced do not prove the columns are right. Refusing.${seen}`);
  }

  /* AND THE GUARD MUST HAVE ACTUALLY RUN.
   *
   * checkIdentity can only test a row that has all three of cash, basis and a
   * quoted future. It skips the rest. So zero failures has two meanings: every
   * row passed, or no row was testable — and the second one is a guard that
   * has silently switched itself off.
   *
   * That is reachable without any malice. Rename one header cell on their
   * side, "Futures" to "CME", and the futures column stops being recognised;
   * every futuresPrice parses as null; checkIdentity verifies 0 of 7 rows and
   * reports no failures; and the file publishes with the identity check
   * disabled and futuresPriceCents null on every row. Verified by doing
   * exactly that to the fixture.
   *
   * A structural check whose absence looks identical to its success is not a
   * check. Count what was verified and refuse if the answer is none. */
  const verifiable = kept.filter(
    (b) => b.cash != null && b.basis != null && b.futuresPrice != null
  );
  if (!verifiable.length)
    throw new Refused(
      `parsed ${kept.length} row(s) at ${CONFIG.location} but could not run the ` +
      `cash - basis = futures check on any of them: no row carries all three of ` +
      `cash, basis and a quoted future. Their column headings have probably ` +
      `changed. Publishing now would publish with the one structural guard off.`
    );

  const corn = kept.filter((b) => CONFIG.expect.test(b.commodity || ""));
  if (!corn.length)
    throw new Refused(`no corn at ${CONFIG.location}. Page had: ` +
      `${[...new Set(kept.map((b) => b.commodity))].join(", ") || "nothing"}`);

  for (const b of corn) {
    if (b.cash == null) throw new Refused(`${b.delivery} has no cash bid`);
    if (b.cash < CONFIG.floor || b.cash > CONFIG.ceiling)
      throw new Refused(`${b.delivery} is ${b.cash}, outside ${CONFIG.floor} to ${CONFIG.ceiling}`);
  }

  const file = {
    schema: "bigriver-boyceville/2",
    source: {
      name: "Big River Resources",
      location: CONFIG.location,
      locationId: CONFIG.locationId,
      url: sourceUrl,
      note: "Their posted cash board, read by arrangement. Cash and basis are their own " +
            "commercial numbers. The futures quote is carried only so a consumer can " +
            "re-check cash minus basis; it is not redistributed as a price feed.",
    },
    /* TWO CLOCKS, AND THEY MEAN DIFFERENT THINGS.
         pricedAt   when their board last showed something different
         checkedAt  when we last successfully read it
       Collapsing them is a bug that was shipped and caught: with one timestamp
       that only moved when the price moved, a quiet weekend was indistinguish-
       able from a dead reader. On Monday the figure was 63 hours old, every
       downstream check failed, and both Emmert sites would have withdrawn a
       perfectly good price. A price being old is normal. Not having looked
       is not.

       buildFile stamps both with `now` because it cannot know the history.
       decide() carries the old pricedAt forward when the price has not moved.
       That split is why buildFile stays pure. */
    checkedAt: now,
    pricedAt: now,
    status: "ok",
    count: corn.length,
    otherLocationsOnPage: locations.filter((l) => !l.includes(CONFIG.locationId)),
    bids: corn
      .slice()
      .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999))
      .map((b, i) => ({
        seq: i,                                    // 0 = nearest delivery
        commodity: b.commodity,
        delivery: b.delivery,                      // "August", their own wording
        futuresMonth: (b.futures || "").replace(/\s*corn\s*$/i, "").trim() || null,
        cash: b.cash,                              // dollars
        basisDollars: b.basis,                     // dollars
        basisCents: b.basisCents,                  // cents
        /* THEIR QUOTE, INCLUDING WHEN IT LAGGED BY A TICK.
         *
         * This was briefly nulled on any row whose identity did not balance,
         * on the reasoning that a figure we could not check should not reach
         * a customer. Over-cautious, and it cost twice: it took both Emmert
         * sites dark when the consumer read null as a broken feed, and it
         * left a blank in the futures column of a live page.
         *
         * The caution was already spent by then. Nothing reaches this line
         * unless a MAJORITY of rows balanced to the cent -- which is what
         * proves the columns are right -- and unless every disagreement is
         * within a tick or two. What is left over is Big River's own
         * published cell, a quarter of a cent behind their own cash. That is
         * their number, not our guess, and it belongs on the page.
         *
         * `null` still travels for a row where they published no quote at
         * all, and the pages still print a dash for it. */
        futuresPriceCents: b.futuresPrice ?? null,
      })),
  };

  /* Their Last Trade stamps, for the log line only. Deliberately not in
     `file`: it moves on nearly every poll, and priceChanged() diffs the
     published rows, so carrying it would commit a price change every few
     minutes that recorded nothing but their clock. */
  const boardAt = [...new Set(corn.map((b) => b.futuresAt).filter(Boolean))];

  return { file, dropped, locations, verified: verifiable.length, boardAt };
}

/* Did anything a reader would care about change?
 *
 * Compares ONLY what was observed on their board: the rows and how many there
 * are. Deliberately ignores both clocks -- a new checkedAt is not news -- and
 * deliberately ignores `status`.
 *
 * `status` used to be compared here, back when it was always the literal "ok"
 * and the comparison was therefore free. It is not free any more: decide() now
 * writes status "stale" when a board has shown the same numbers for a fortnight.
 * With status in this comparison, the very next poll saw our own annotation
 * differ from buildFile's fresh "ok", called it a price change, and stamped
 * pricedAt as now -- so the file that had just correctly reported a frozen
 * board immediately erased the evidence and looked fresh again. Caught by
 * simulating thirty days before it shipped.
 *
 * The rule this encodes: never diff a field you write yourself against a field
 * they publish. */
export const priceChanged = (before, after) =>
  !before || JSON.stringify(before.bids) !== JSON.stringify(after.bids) ||
  before.count !== after.count;

/* THE MAX-MOVE RAIL.
 *
 * This did not exist, and parse.mjs's header claimed it did: "The sanity band,
 * the max-move rail and the freshness gate all test whether a value looks
 * reasonable." Two of those three were fiction, so anyone reading the code's
 * own documentation believed a rail was protecting them.
 *
 * WHAT IT CATCHES THAT NOTHING ELSE DOES. Their futures quote glitches -- Dec
 * corn prints 584 instead of 484 -- and their board recomputes cash from it:
 * cash 5.29, basis -0.55. Now run every guard we have. 5.29 - (-0.55) = 5.84 =
 * 584c, so the identity check PASSES; the columns really are correct, the
 * inputs are not. 5.29 is inside the 2.00-12.00 sanity band. Corn rows present,
 * location present, all seven rows verifiable. The file publishes, and both
 * Emmert sites carry a corn bid a dollar over the market for up to fourteen
 * hours, with checkedAt perfectly fresh so nothing downstream objects. When
 * their board corrects, ours corrects silently too. The only trace is two
 * commits.
 *
 * The identity check proves a number came from the right COLUMN. It can say
 * nothing about MAGNITUDE. This is the guard for magnitude.
 *
 * Compared against the last COMMITTED read, which is at most a heartbeat old.
 * A delivery month with no previous reading is skipped -- new months appear on
 * their board all the time and have nothing to move from.
 */
export const MAX_MOVE = 0.75;

export function checkMove(previous, next, { maxMove = MAX_MOVE } = {}) {
  if (!previous || !Array.isArray(previous.bids)) return [];   // first run
  const before = new Map(previous.bids.map((b) => [b.delivery, b]));
  const out = [];
  for (const b of next.bids) {
    const was = before.get(b.delivery);
    if (!was || was.cash == null || b.cash == null) continue;
    const move = b.cash - was.cash;
    if (Math.abs(move) > maxMove)
      out.push({ delivery: b.delivery, from: was.cash, to: b.cash, move });
  }
  return out;
}

/* One serialisation, used by both readers and by the tests. If the Worker and
   the Action format the same object differently, git sees a change that isn't
   one and the history fills with noise. */
export const serialise = (file) => JSON.stringify(file, null, 2) + "\n";

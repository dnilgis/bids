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
  const off = checkIdentity(kept);
  if (off.length) {
    const w = off.reduce((worst, r) =>
      Math.abs(r.offCents) > Math.abs(worst.offCents) ? r : worst);
    const worst = Math.abs(w.offCents);
    const where = `${off.length} row(s) fail cash - basis = futures. ` +
      `e.g. ${w.delivery}: ${w.cash} - (${w.basis}) = ${w.derivedCents}c but the page ` +
      `quotes ${w.quotedCents}c, off by ${w.offCents}c.`;

    /* Judged on the WORST row, not the first. One row off by a tick beside one
       off by forty cents is a column shift with a tick-sized coincidence in
       it, and must not be excused as a torn read. */
    if (worst <= TORN_MAX_CENTS) {
      /* EVERY failing row, not just an example.
       *
       * This has now happened twice with identical numbers two hours apart,
       * which a random mid-update read would not produce. The question it
       * raises -- is their front-month futures cell lagging its cash, or does
       * their board drop the odd quarter cent when it prints -- is answerable
       * from the data, but only if the log carries all of it. Printing one
       * example row was enough to say something was wrong and not enough to
       * say what. So: all of them, with the contract month, because the
       * hypothesis worth testing is that it is confined to the front month.
       *
       * Do not widen the tolerance on a hunch. Let the next failure decide. */
      /* checkIdentity reports the arithmetic, not the row it came from, so
         the contract month is looked back up here. It is the field the
         hypothesis turns on: if every failure is on the front month and none
         on the deferred ones, their front-month cell is lagging its cash. */
      const monthOf = new Map(kept.map((b) => [b.delivery, b.futures || "?"]));
      const rows = off.map((r) =>
        `      ${String(r.delivery).padEnd(10)} ${String(monthOf.get(r.delivery) || "?").padEnd(10)}` +
        ` cash ${r.cash}  basis ${r.basis}  ->  ${r.derivedCents}c ` +
        `but quoted ${r.quotedCents}c  (${r.offCents > 0 ? "+" : ""}${r.offCents}c)`
      ).join("\n");
      throw new TornRead(`${where} That is within ${TORN_MAX_CENTS}c -- ` +
        `${(worst / TICK_CENTS).toFixed(0)} tick(s) -- which is their board being ` +
        `read while it was updating, not their columns moving. Looking again.\n` +
        `  Every row that failed, so a pattern can be seen across runs:\n${rows}\n` +
        `  ${kept.length - off.length} of ${kept.length} row(s) balanced.`);
    }

    throw new Refused(`${where} Columns have moved.`);
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
        futuresPriceCents: b.futuresPrice ?? null, // cents
      })),
  };

  return { file, dropped, locations, verified: verifiable.length };
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

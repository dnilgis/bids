/* Turn a page of their HTML into the file we publish, or refuse to.
 *
 * Pure: HTML in, an object or a thrown Refused out. No fetching, no
 * committing, no clock beyond what is handed to it. That is what makes the
 * guards testable without a network, a GitHub token, or a Cloudflare account.
 *
 * SHARED BY BOTH READERS, WHICH IS THE POINT.
 *
 *   scripts/fetch.mjs    the GitHub Actions poller
 *   worker/src/index.js  the Cloudflare Worker
 *
 * They used to be separate implementations. `scripts/parse.mjs` and
 * `worker/src/parse.js` were byte-identical 504-line copies, and the two file
 * builders had drifted: the Worker's emitted a `dropped` field the Actions
 * one did not, so the same board read by the two readers produced two
 * different files. Nothing downstream reads `dropped`, so the only symptom
 * would have been a spurious commit every time the two handed off to each
 * other -- a price record that recorded a change in the reader rather than a
 * change in the price. `dropped` is returned alongside the file now, not
 * inside it, and there is one implementation.
 *
 * If you are about to copy this file: don't.
 */
import { extractBids, checkIdentity, filterLocation } from "./parse.mjs";

export class Refused extends Error {}

export const CONFIG = {
  locationId: "2121",
  location: "Boyceville",
  expect: /corn/i,
  floor: 2.0,      // a corn cash bid outside this is a decimal point in the
  ceiling: 12.0,   // wrong place, not a market. A sanity band, not a forecast.
};

/**
 * @returns {{file: object, dropped: number, locations: string[]}}
 *   `file` is exactly what gets committed. `dropped` and `locations` are
 *   diagnostics for the log line and are deliberately NOT in the file.
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
    const w = off[0];
    throw new Refused(`${off.length} row(s) fail cash - basis = futures. ` +
      `e.g. ${w.delivery}: ${w.cash} - (${w.basis}) = ${w.derivedCents}c but the page ` +
      `quotes ${w.quotedCents}c, off by ${w.offCents}c. Columns have moved.`);
  }

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

  return { file, dropped, locations };
}

/* Did anything a reader would care about change? Deliberately ignores both
   clocks: a new checkedAt is not news. */
export const priceChanged = (before, after) =>
  !before || JSON.stringify(before.bids) !== JSON.stringify(after.bids) ||
  before.count !== after.count || before.status !== after.status;

/* One serialisation, used by both readers and by the tests. If the Worker and
   the Action format the same object differently, git sees a change that isn't
   one and the history fills with noise. */
export const serialise = (file) => JSON.stringify(file, null, 2) + "\n";

/* A BOARD THE OPERATOR LEFT OFF ITS OWN FEED -- 2026-10-30.
 *
 * Country Partners' Midway (DTN site E0149201), and CHS Farmers Elevator's
 * Circle and Richey (Bushel), were refused on all 40 passes from 2026-10-29
 * 18:08Z to 2026-10-30 00:24Z as "parsed N bids but none for location X". In
 * each case the operator's own feed answered, listed its other yards (177 bids
 * on 12 Country Partners yards; 26 bids on Glasgow, Glendive and Macon at CHS)
 * and had no entry for this one. The operator is not posting a bid there.
 *
 * That is the same thing as a listed yard with no price cell (the empty yards
 * of 2026-10-30, lib/board.mjs `present`), except that the yard is not even in
 * the list. A feed can drop a yard for a reason on our side (an id changed), so
 * this is NEVER inferred: a person writes `notPostedSince` (YYYY-MM-DD, the day
 * the yard was first seen missing from a feed that otherwise parsed) into the
 * manifest, and only then does a missing yard read as "not posted by the
 * operator" (counted with the other boards posting nothing) instead of as a
 * fault on our side.
 *
 * THE 30-DAY RULE (Sig's lead, 2026-10-30). A board that has been missing from
 * its operator's feed for 30 days is retired, with that reason and the date.
 * Its id is kept in the ledger and is never reused (docs/ELEVATOR-IDS.md rule
 * 1). If the yard comes back before then, its rows publish as usual and the
 * flag is cleared by hand. `retireDue` says which boards are due;
 * scripts/retire-not-posted.mjs writes the retirement. */

export const RETIRE_AFTER_DAYS = 30;
const DAY = 86_400_000;

export const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

/** Whole days from the day it was first missed to `now`. */
export const daysMissing = (since, now = new Date()) =>
  isDay(since) ? Math.floor((now.getTime() - Date.parse(since + "T00:00:00Z")) / DAY) : null;

/** The enabled sources whose notPostedSince is RETIRE_AFTER_DAYS or more days old. */
export const retireDue = (sources, now = new Date()) =>
  sources.filter((s) => s.enabled !== false && !s.retired && isDay(s.notPostedSince)
    && daysMissing(s.notPostedSince, now) >= RETIRE_AFTER_DAYS);

/** The manifest, retired. Nothing else changes and the id stays. */
export const retired = (s, now = new Date()) => ({
  ...s,
  enabled: false,
  retired: `${now.toISOString().slice(0, 10)}: not posted by the operator. ${s.location} has been missing from ${s.operator}'s own feed since ${s.notPostedSince} (${daysMissing(s.notPostedSince, now)} days; the rule retires a board after ${RETIRE_AFTER_DAYS}). The id is kept and never reused.`,
});

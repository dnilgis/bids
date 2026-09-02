/* HOW OLD IS TOO OLD. ONE DEFINITION, BECAUSE THERE WERE TWO.
 *
 * 2026-09-02, run 91003295176. The status board said 153 sources were broken.
 * Twenty-three were: every one of them CHS, every one answering nothing. The
 * other 127 were never attempted at all -- the platform breaker skipped them --
 * and were then stamped `broken` on the way out.
 *
 * That mislabel would have been cosmetic. It was not, because merge_bids.mjs
 * withdrew a source from the feed the instant its status stopped being "ok":
 *
 *     if (s.status !== "ok") { tally.drop(...); continue; }
 *
 * So 151 sources holding 1,706 good bids -- aged 6.2 to 6.7 hours, well inside
 * the fourteen-hour window every other consumer in this repository honours --
 * were dropped out of the merged feed in one pass. 149 shards orphaned. The
 * feed published 1,814 bids with 3,520 sitting on disk.
 *
 * THE POLICY ALREADY EXISTED. It was written down in three places and
 * implemented in one:
 *
 *   - scripts/status.mjs   LATE_H = 6, WITHDRAW_H = 14, with the comment
 *                          "Matches the consumers ... past withdrawal the
 *                          consumers drop the price entirely"
 *   - worker/src/index.js  FEED_MAX_AGE_H of 14 hours -- the Emmert Worker,
 *                          which does honour it
 *   - test/decide.test.mjs asserts the poll cadence stays inside it
 *
 * merge_bids.mjs -- the newest consumer, and the one agsist will pull from --
 * never got it. A constant documented as shared and defined in one script that
 * another script cannot import is not shared; it is two numbers that happen to
 * agree until one of them doesn't. So it lives here, in lib/, where every
 * consumer can import the same one.
 *
 * WHY HOLD AT ALL. A failed read is not a missing price. The elevator posted a
 * number this morning and it is still the number until it changes or goes
 * stale. poll.mjs has said so since it was written -- "HOLD, THEN WITHDRAW ...
 * a refused source keeps its last good file exactly as it is" -- and the whole
 * mechanism depends on a consumer that withdraws on AGE. Withdrawing on status
 * instead is the "withdraw" half without the "hold" half.
 */

/** Read successfully but older than this: late. The poll heartbeat is 10min. */
export const LATE_H = 6;

/** Past this the price is withdrawn outright. FEED_MAX_AGE_H in the Worker. */
export const WITHDRAW_H = 14;

/* A clock more than this far ahead of ours is not fresh, it is wrong. Runner
   clocks drift by seconds; a quarter of an hour is slack, not skew. */
export const MAX_SKEW_H = 0.25;

/* THE THREE WAYS A READ CAN FAIL, AND WHY THEY LAND IN ONE BUCKET HERE.
 *
 *   refused  we read a page and it was not the board we wanted
 *   broken   an unexpected throw -- the site is down, or changed
 *   skipped  we did not try, because the platform was tripped this pass
 *
 * They mean very different things to a human, and the board prints them
 * differently. They mean the SAME thing to a freshness rule: no new price
 * arrived, so the held one ages. Keeping them apart here would be inventing a
 * distinction the age does not have. */
export const HELD = new Set(["refused", "broken", "skipped"]);

export function ageHours(iso, now) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 3.6e6 : Infinity;
}

/** live | late | down. Three, because three is what stays distinguishable. */
export function stateOf(s, now) {
  /* `health` ONLY. No fallback to `state`.
     The manifest's `state` is the US state ("WI"), and poll.mjs emits the read
     result as `health` with the place preserved as `usState`. A tolerant
     fallback here was written first and was UNFALSIFIABLE -- no US state
     equals a health word, so reverting it changed no behaviour and the test
     covering it could not fail. A guard whose mutation is a no-op is not a
     guard. Strict, so the contract is one field with one meaning. */
  const h = s.health;
  if (HELD.has(h)) {
    /* A held source is not down until its last good price goes stale. Up to
       then the site is still serving a real number and the failure is a
       warning; past withdrawal it is an outage. */
    return ageHours(s.checkedAt, now) >= WITHDRAW_H ? "down" : "late";
  }
  const age = ageHours(s.checkedAt, now);
  /* A CLOCK AHEAD OF OURS IS BROKEN, NOT FRESH.
     A negative age sails past every "older than" test and lands on "live" --
     the freshest possible verdict handed to the one file we have most reason
     to distrust. The old dashboard test asserted this and was deleted with the
     script it covered; status.mjs shipped without it. */
  if (age < -MAX_SKEW_H) return "down";
  if (age >= WITHDRAW_H) return "down";
  if (age >= LATE_H) return "late";
  return "live";
}

/** Should a consumer publish this source's held price? AGE decides, and it
 *  decides for every status -- including "ok".
 *
 *  A source last read successfully is not thereby fresh. If the poll workflow
 *  itself stops -- a runner outage, a bad cron, a red run all night -- every
 *  source keeps status "ok" and nothing anywhere flips to broken. The age is
 *  the only field that still moves. Gating on `status === "ok"` alone would
 *  publish yesterday's corn as today's, silently, for exactly as long as the
 *  reader was down. stateOf() above has always applied the age test to a
 *  healthy source for this reason; so does this.
 *
 *  Returns {publish, stale, ageH, why} so the caller can flag rather than guess.
 */
export function feedVerdict(status, checkedAt, now) {
  const ageH = ageHours(checkedAt, now);
  const known = status === "ok" || HELD.has(status);
  if (!known)
    return { publish: false, stale: false, ageH, why: `unknown source status "${status}"` };
  if (!Number.isFinite(ageH))
    return { publish: false, stale: status !== "ok", ageH,
             why: "no readable checkedAt on the held file" };
  /* A clock ahead of ours is not fresh, it is wrong. Same reasoning as stateOf. */
  if (ageH < -MAX_SKEW_H)
    return { publish: false, stale: status !== "ok", ageH,
             why: "file is stamped in the future" };
  if (ageH >= WITHDRAW_H)
    return { publish: false, stale: true, ageH,
             why: `price is ${ageH.toFixed(1)}h old, past the ${WITHDRAW_H}h withdrawal` };
  /* Inside the window. A successful read is current; a held one is publishable
     but must say so, because a consumer that cannot tell them apart will show a
     stale price with the same confidence as a live one. */
  return { publish: true, stale: status !== "ok", ageH, why: null };
}

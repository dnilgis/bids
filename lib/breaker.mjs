/* ONE PLATFORM'S OUTAGE MUST NOT TAKE DOWN THE READER.
 *
 * 2026-09-02, run 33580292481. Every Bushel-hosted page began answering with
 * "The page did make 0 request(s)" — the page loads nothing at all — so each one
 * burned its full 45-second browser timeout. 150 Bushel sources sit behind 25
 * distinct pages:
 *
 *     25 x 45s = 18.8 MINUTES, in a pass the workflow kills at 8.
 *
 * The log shows the kill exactly: pass one started 01:40:20Z, the retry started
 * 01:48:20Z, having reached nine of the twenty-five. Then it was killed again.
 * Every source alphabetically after "chsfarmersalliance" went unread for hours —
 * including every board that was working perfectly.
 *
 * The fault to fix is not Bushel. Bushel will come back, and something else will
 * break on another Tuesday. The fault is that one platform's outage cost every
 * other platform its reading.
 *
 * This is a small amount of state and one decision, kept here rather than in
 * poll.mjs so it can be tested without running a pass.
 */

/* THE SIGNATURE OF AN ABSENT PAGE, NOT A SLOW ONE.
 *
 * lib/cdp.mjs reports how many requests the page made before it gave up. Zero
 * means the page never loaded — a site that is down, or gone. A timeout where
 * the page DID make requests is a completely different animal: the site works
 * and we missed the one call we wanted, which is a selector or endpoint problem
 * on one source and says nothing about the platform.
 *
 * Only the first kind trips the breaker. Getting this wrong in the generous
 * direction would let one bad source switch off a working platform. */
export const loadedNothing = (msg) => /did make 0 request\(s\)/.test(String(msg ?? ""));

/* NOT ATTEMPTED IS NOT BROKEN.
 *
 * 2026-09-02, run 91003295176. The board said 153 sources were broken. 23 were.
 * The other 127 were skipped by this breaker and then stamped `broken` on the
 * way out, because poll.mjs classified anything that was not a Refused as a
 * crash. The message it threw said, in its own words, "Nothing about this
 * source is known to be wrong" -- and then it was recorded as wrong.
 *
 * That is not cosmetic. merge_bids.mjs withdrew every non-ok source from the
 * feed, so the mislabel cost 1,706 published bids in one pass. Both halves are
 * fixed -- the merge withdraws on age now (lib/freshness.mjs) -- but the label
 * has to be right on its own account, because a status board that cannot tell
 * "we tried and it failed" from "we did not try" is not a status board.
 *
 * A distinct class, so the classification is a type test and not a regex over
 * a human-readable string. */
export class Skipped extends Error {}
export const isSkip = (e) =>
  e instanceof Skipped || /(^|[a-z])Skipped$/.test(e?.constructor?.name ?? "");

/* HOW A FAILURE STREAK MOVES. THREE CASES, AND THE MIDDLE ONE IS THE BUG.
 *
 * The streak is what decides read order, and read order is what decides who
 * gets starved — so getting this wrong is not a detail. The rule that failed on
 * run 91012844641 treated "we did not try" as a black mark and could then never
 * take it back: a skipped source stayed disqualified for as long as the outage
 * lasted, which is precisely the sources the mechanism exists to rescue.
 *
 *   live                 -> 0        it worked; there is no case against it
 *   skipped              -> unchanged we did not try, so we learned NOTHING
 *   refused | broken     -> +1       we tried and it cost us
 *
 * A pure function, exported, because when it lived inside poll.mjs's catch block
 * a mutation that made a skip increment the streak killed no test at all. */
export function nextStreak(prev, health) {
  const n = Number.isFinite(prev) ? prev : 0;
  if (health === "live") return 0;
  if (health === "skipped") return n;
  return n + 1;
}

export class Breaker {
  /* THREE, NOT ONE. A single empty load is a bad minute — a runner hiccup, a
     DNS blip — and a platform that is genuinely up deserves better than being
     written off for it. Three in a row, on different pages, is a platform. */
  constructor({ strikes = 3 } = {}) {
    this.limit = strikes;
    this.count = new Map();
    this.tripped = new Set();
    /* Who actually failed, so the trip can say so. The first version of this
       announced "bushel is not answering" while 193 Bushel sources had just
       been read successfully -- every one of the 23 real failures was CHS.
       A reason with the wrong subject sends the next person to the wrong
       place, which is worse than no reason at all. */
    this.blame = new Map();
  }

  /** Should this source be attempted at all?
   *
   *  WHAT THE TRIP STOPS, AND WHAT IT MUST NOT.
   *
   *  The first version of this asked "did this source read cleanly LAST pass?"
   *  and was measured inert on run 91012844641: the previous pass had labelled
   *  every skipped source `broken`, so nobody qualified -- and a skipped source
   *  is not `live` either, so nobody would ever qualify again. It poisoned its
   *  own input, and `coopelev` and seven `michag` boards were starved a second
   *  time by the fix meant to protect them.
   *
   *  What separates `coopelev` from `chsagservices` is not last pass's verdict.
   *  It is EVIDENCE:
   *
   *    the operator spent the strikes   -> stop. We watched it return nothing.
   *    the operator has a failure streak-> stop. It has been failing for passes,
   *                                        and each attempt costs 45 seconds.
   *    anything else                    -> go. There is nothing against it, and
   *                                        the pass budget is the wall.
   *
   *  No separate reprieve counter: poll.mjs reads in failure-streak order, so an
   *  operator with no history is attempted BEFORE the trip can happen, and one
   *  with history is excluded here. Measured, a platform-wide outage decays from
   *  360s to about 90s a pass on its own as the streaks accumulate -- the budget
   *  and the evidence between them are the bound, and neither is a number I
   *  invented for this.
   *
   *  @param platform     the platform key the strikes are counted against
   *  @param operator     who this source belongs to, matched against the culprits
   *  @param priorFails   that operator's failure streak coming into this pass
   */
  allows(platform, operator = null, priorFails = 0) {
    if (!this.tripped.has(platform)) return true;
    /* No operator to judge by is no evidence of innocence. */
    if (operator == null) return false;
    if (this.blame.get(platform)?.has(operator)) return false;
    return !(priorFails > 0);
  }

  /** A page load failed. Returns true if this is the failure that trips it. */
  fail(platform, message, who = null) {
    if (!loadedNothing(message)) return false;      // a real site, a wrong call
    /* Already tripped: this was a load we let through on the evidence, and it
       failed. It is recorded against the operator by poll.mjs, which is what
       excludes it next pass. Never re-announce the trip. */
    if (this.tripped.has(platform)) return false;
    if (who) {
      const b = this.blame.get(platform) ?? new Set();
      b.add(who); this.blame.set(platform, b);
    }
    const n = (this.count.get(platform) ?? 0) + 1;
    this.count.set(platform, n);
    if (n >= this.limit) { this.tripped.add(platform); return true; }
    return false;
  }

  /** A page loaded. THE COUNT RESETS — the strikes must be CONSECUTIVE, or a
      platform with three scattered failures over a healthy hour gets switched
      off for no reason. A successful reprieved load resets the reprieve too:
      the platform is demonstrably serving somebody. */
  ok(platform) { this.count.set(platform, 0); }

  /** Who the strikes were spent on, for the trip message. */
  culprits(platform) { return [...(this.blame.get(platform) ?? [])]; }

  get down() { return [...this.tripped]; }
}

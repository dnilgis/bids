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
   *  THE REPRIEVE, AND WHY IT IS NOT OPTIONAL.
   *
   *  Sources are read in id order, so one operator's outage takes down
   *  everything alphabetically after it on the same platform -- and keeps
   *  taking it down, every pass, for as long as the outage lasts. Measured on
   *  the 02:11 run: CHS failed, and `coopelev` plus seven `michag` sources --
   *  all `ok` at 19:59, all healthy -- were skipped for sorting after `chs*`.
   *  Nothing in the design would ever have let them back.
   *
   *  So a tripped platform still attempts the sources that read successfully
   *  LAST pass. They are the ones with evidence behind them, and if the
   *  platform really is down they will fail and spend their own strikes: the
   *  reprieve runs on a second counter with the same limit, so a genuine
   *  platform-wide outage costs `strikes` more page loads and then stops for
   *  good. A single-tenant outage costs nothing, because each reprieved load
   *  succeeds and resets the count.
   *
   *  @param platform  the platform key the strikes are counted against
   *  @param wasOk     did this source read successfully on the previous pass?
   */
  allows(platform, wasOk = false) {
    if (!this.tripped.has(platform)) return true;
    if (!wasOk) return false;
    return (this.count.get(`reprieve:${platform}`) ?? 0) < this.limit;
  }

  /** A page load failed. Returns true if this is the failure that trips it. */
  fail(platform, message, who = null) {
    if (!loadedNothing(message)) return false;      // a real site, a wrong call
    if (this.tripped.has(platform)) {
      /* Already tripped: this was a reprieved load, and it failed. Spend a
         strike on the reprieve counter. Never re-announce the trip. */
      const r = `reprieve:${platform}`;
      this.count.set(r, (this.count.get(r) ?? 0) + 1);
      return false;
    }
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
  ok(platform) {
    this.count.set(platform, 0);
    this.count.set(`reprieve:${platform}`, 0);
  }

  /** Who the strikes were spent on, for the trip message. */
  culprits(platform) { return [...(this.blame.get(platform) ?? [])]; }

  get down() { return [...this.tripped]; }
}

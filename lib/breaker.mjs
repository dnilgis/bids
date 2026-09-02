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

export class Breaker {
  /* THREE, NOT ONE. A single empty load is a bad minute — a runner hiccup, a
     DNS blip — and a platform that is genuinely up deserves better than being
     written off for it. Three in a row, on different pages, is a platform. */
  constructor({ strikes = 3 } = {}) {
    this.limit = strikes;
    this.count = new Map();
    this.tripped = new Set();
  }

  /** Should this source be attempted at all? */
  allows(platform) { return !this.tripped.has(platform); }

  /** A page load failed. Returns true if this is the failure that trips it. */
  fail(platform, message) {
    if (!loadedNothing(message)) return false;      // a real site, a wrong call
    const n = (this.count.get(platform) ?? 0) + 1;
    this.count.set(platform, n);
    if (n >= this.limit && !this.tripped.has(platform)) {
      this.tripped.add(platform);
      return true;
    }
    return false;
  }

  /** A page loaded. THE COUNT RESETS — the strikes must be CONSECUTIVE, or a
      platform with three scattered failures over a healthy hour gets switched
      off for no reason. */
  ok(platform) { this.count.set(platform, 0); }

  get down() { return [...this.tripped]; }
}

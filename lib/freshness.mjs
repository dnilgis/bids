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

/* ONE SOURCE MAY ASK FOR A SHORTER LINE. NEVER A LONGER ONE. 2026-10-19.
 *
 * Flash Grain's own page withholds cash once its harvester has been silent two
 * hours (dnilgis/flashgrain), and Sig decided this repository stops
 * republishing its price at the same line. Before this, a Flash Grain feed
 * whose workflow had stopped kept status "ok" and an old `observed`, and the
 * feed here went on holding that price to fourteen hours: twelve hours longer
 * than the elevator itself would show it.
 *
 * That is NOT a second policy. WITHDRAW_H stays the one number every consumer
 * shares. A manifest may carry `maxAgeH`, and the line for that source is the
 * SMALLER of the two: a source can be held to a stricter standard than
 * everyone else, and nothing a manifest says can stretch a price past the
 * fourteen hours the rest of the system (the Emmert Worker included) assumes.
 * Anything that is not a positive finite number is ignored, so a typo falls
 * back to the shared line rather than to something invented.
 *
 * Every consumer that withdraws on age goes through this, never through the
 * field directly: merge_bids.mjs, stateOf below (status.mjs and
 * build_directory.mjs), and the emmert adapter. */
export function withdrawHFor(source) {
  const m = source?.maxAgeH;
  if (source?.pasted === true) return PASTED_WITHDRAW_H;
  return typeof m === "number" && Number.isFinite(m) && m > 0 && m < WITHDRAW_H ? m : WITHDRAW_H;
}

/* A BOARD SIG PASTED BY HAND IS HELD FOR SEVEN DAYS -- 2026-10-20, Sig.
 * NEW Cooperative's site puts a Cloudflare bot check in front of our reader, so
 * Sig opens their public bid page in his own browser and pastes it into the
 * elevator desk (agsist elev-admin.html, subs worker /elev/admin/paste). That
 * price is as old as the paste, and the paste time ages it (`observedAt`), not
 * our clock. Sig: show it well past 14 hours with a "last updated" mark, and
 * never past 7 days (168 h), the same grace the town pages give a board off the
 * feed, so a forgotten week never shows a month-old price.
 *
 * ONLY A ROW THE READER MARKED `pasted: true` GETS THIS LINE. It is not a
 * manifest field: no manifest can stretch a live read past WITHDRAW_H, and a
 * board that is read live again goes back to the shared line on that pass. */
export const PASTED_WITHDRAW_H = 168;

/* WHICH CLOCK AGES. Our `checkedAt` says when WE last read a source. For a
 * feed that stamps its own `observed` (the emmert-cash-bids schema), that
 * stamp says when THEY last looked at the board behind the price, and it is
 * the only one that stops moving when their harvester stops: a frozen file
 * that still answers every poll keeps our checkedAt current forever. So when
 * both are known the OLDER one ages the price. An unreadable `observedAt` is
 * ignored (checkedAt alone decides, as it always has); an unreadable checkedAt
 * is returned as it is, so ageHours still reads it as Infinity. */
export function agingStamp(checkedAt, observedAt) {
  const c = Date.parse(checkedAt ?? "");
  const o = Date.parse(observedAt ?? "");
  if (!Number.isFinite(c) || !Number.isFinite(o)) return checkedAt;
  return o < c ? observedAt : checkedAt;
}

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
  /* The source's own line (withdrawHFor) and the older of its two clocks
     (agingStamp). A row without maxAgeH or observedAt reads exactly as before. */
  const line = withdrawHFor(s);
  const age = ageHours(agingStamp(s.checkedAt, s.observedAt), now);
  if (HELD.has(h)) {
    /* A held source is not down until its last good price goes stale. Up to
       then the site is still serving a real number and the failure is a
       warning; past withdrawal it is an outage. */
    return age >= line ? "down" : "late";
  }
  /* A CLOCK AHEAD OF OURS IS BROKEN, NOT FRESH.
     A negative age sails past every "older than" test and lands on "live" --
     the freshest possible verdict handed to the one file we have most reason
     to distrust. The old dashboard test asserted this and was deleted with the
     script it covered; status.mjs shipped without it. */
  if (age < -MAX_SKEW_H) return "down";
  if (age >= line) return "down";
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
 *  `withdrawH` is the source's own line from withdrawHFor(); it is passed
 *  through withdrawHFor again here, so a caller cannot hand in a longer one.
 *
 *  Returns {publish, stale, ageH, why} so the caller can flag rather than guess.
 */
export function feedVerdict(status, checkedAt, now, withdrawH = WITHDRAW_H, { pasted = false } = {}) {
  const line = withdrawHFor({ maxAgeH: withdrawH, pasted: pasted === true });
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
  if (ageH >= line)
    return { publish: false, stale: true, ageH,
             why: `price is ${ageH.toFixed(1)}h old, past the ${line}h withdrawal` +
                  (line < WITHDRAW_H ? " this source sets for itself (maxAgeH)" : "")
                  + (pasted === true ? " for a board pasted by hand" : "") };
  /* Inside the window. A successful read is current; a held one is publishable
     but must say so, because a consumer that cannot tell them apart will show a
     stale price with the same confidence as a live one. */
  return { publish: true, stale: status !== "ok", ageH, why: null };
}

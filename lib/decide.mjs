/* Should this read be written down, and what should its pricedAt say?
 *
 * Pure, and shared by both readers, so the Cloudflare Worker and the GitHub
 * Action cannot disagree about what counts as news. Every input is an
 * argument; there is no clock and no I/O in here.
 *
 * THE RULE
 *
 *   price moved      -> write, stamp pricedAt now
 *   price unchanged  -> carry the old pricedAt forward, and write ONLY if
 *                       the last successful check is older than HEARTBEAT_H
 *
 * WHY NOT JUST WRITE EVERY POLL
 *
 * The schedule reads their board roughly every 10 minutes through the trading
 * day. Writing each time would put around 4,300 commits a month in the repo
 * and turn a price record into polling noise. `git log --oneline` is supposed
 * to read as a price history.
 *
 * WHY NOT ONLY WRITE ON A CHANGE
 *
 * Because then `checkedAt` ages exactly like a dead reader's. A quiet weekend
 * and a Worker that has been throwing since Friday afternoon look identical
 * from downstream, and the downstream response to "too old" is to withdraw the
 * price and show "Call for today's price" on two live sites. The heartbeat is
 * what makes those two states distinguishable: if the file is fresh and the
 * price is old, the board is quiet; if the file itself is stale, we have
 * stopped looking, and that is a different problem with a different fix.
 *
 * So the heartbeat caps how old `checkedAt` can get at roughly HEARTBEAT_H
 * plus one poll gap, and the consumers' thresholds are set against that:
 * the Emmert Worker's FEED_MAX_AGE_H is 14, comfortably more than 6 plus slack
 * even if GitHub drops a scheduled run or two.
 */

export const HEARTBEAT_H = 6;

import { priceChanged } from "./board.mjs";

/**
 * @param {object|null} previous  the file currently committed, or null
 * @param {object} next           the file just built (both clocks = now)
 * @returns {{write: boolean, reason: string, file: object, changed: boolean}}
 */
export function decide(previous, next, { heartbeatHours = HEARTBEAT_H } = {}) {
  if (!previous)
    return { write: true, changed: true, reason: "first run", file: next };

  if (priceChanged(previous, next))
    return { write: true, changed: true, reason: "price moved", file: next };

  /* The price has not moved, so neither has pricedAt. `observed` is the
     schema/1 spelling; it is read here only so a file written before the two
     clocks were split still upgrades cleanly instead of resetting its own
     price age to now. Nothing writes `observed` any more. */
  const file = {
    ...next,
    pricedAt: previous.pricedAt ?? previous.observed ?? next.pricedAt,
  };

  const sinceCheck = (Date.parse(next.checkedAt) - Date.parse(previous.checkedAt ?? 0)) / 36e5;

  /* A previous file with a missing or unparseable checkedAt gives NaN. NaN
     fails the comparison, so we fall through and WRITE. That is the safe
     direction: an unreadable clock should refresh the file, not silently
     suppress it forever. */
  if (Number.isFinite(sinceCheck) && sinceCheck < heartbeatHours)
    return {
      write: false, changed: false, file,
      reason: `no change (checked ${sinceCheck.toFixed(1)}h ago, heartbeat at ${heartbeatHours}h)`,
    };

  return {
    write: true, changed: false, file,
    reason: Number.isFinite(sinceCheck)
      ? `heartbeat (last checked ${sinceCheck.toFixed(1)}h ago)`
      : "heartbeat (previous file had no readable checkedAt)",
  };
}

/* The commit subject. A heartbeat and a price change must not read the same in
   `git log`, or the history stops being a price record and becomes a list of
   identical lines. */
export function commitMessage({ changed, file }) {
  const b = file.bids[0];
  if (!changed) return `boyceville: heartbeat, no change (${file.count} rows)`;
  if (!b) return `boyceville: ${file.count} rows`;
  return `boyceville: ${b.delivery} ${b.cash} basis ${b.basisDollars}`;
}

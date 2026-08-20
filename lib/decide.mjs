/* Should this read be written down, and what should its pricedAt say?
 *
 * Pure: every input is an argument, and there is no clock and no I/O in here.
 * That is what lets the write-or-skip rule be tested against a simulated
 * calendar rather than by waiting three days to see what happens.
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

/* How long a price may sit unchanged before the file marks itself `stale`.
   Ten trading days. Deliberately far longer than a quiet weekend -- that is 63
   hours and is entirely normal -- so this only fires on a source that has
   genuinely stopped moving. */
export const STALE_PRICE_H = 24 * 14;

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
  const carried = previous.pricedAt ?? previous.observed ?? null;
  if (carried === null) {
    /* Neither spelling present. There is no honest value to carry, so this
       falls through to `now` -- which republishes a price that may be days old
       stamped as set this second. Say so rather than doing it quietly. */
    console.warn("WARNING: the previous file carries neither pricedAt nor observed. " +
                 "Stamping pricedAt as now, which may overstate how fresh this price is.");
  }
  const file = { ...next, pricedAt: carried ?? next.pricedAt };

  /* A CEILING ON HOW OLD A CARRIED PRICE MAY BE.
   *
   * The carry-forward had no upper bound. A source board that freezes -- their
   * CMS stops updating, the page keeps serving -- polls fine forever:
   * checkedAt stays current, Emmert's 14-hour gate never trips, and both sites
   * publish a three-week-old bid as today's price. Simulated 21 days: 84
   * heartbeats, status still "ok".
   *
   * `pricedAt` is a good frozen-board signal, better than it looks -- priceChanged()
   * compares the whole bids array including futuresPriceCents, so during CME
   * hours a live board moves it on nearly every poll. Nothing ALARMED on it.
   * Now the file says so itself, and the consumer that is told to ignore
   * pricedAt can act on `status` instead. */
  const priceAge = (Date.parse(next.checkedAt) - Date.parse(file.pricedAt)) / 36e5;
  if (Number.isFinite(priceAge) && priceAge > STALE_PRICE_H) {
    file.status = "stale";
    file.staleReason =
      `their board has shown the same numbers for ${Math.floor(priceAge / 24)} days ` +
      `(since ${file.pricedAt}). The reader is healthy; the source is not moving.`;
  }

  /* `?? 0` used to be here, and it was not the no-op it looked like:
     Date.parse(0) is Date.parse("0") which is 2000-01-01, not NaN. So a file
     with no checkedAt at all logged "heartbeat (last checked 233428.0h ago)" --
     a twenty-six-year figure printed as an observation, in a project whose
     first rule is never to invent a number. The write direction was still
     safe; the number was fiction. */
  const prev = previous.checkedAt == null ? NaN : Date.parse(previous.checkedAt);
  const sinceCheck = (Date.parse(next.checkedAt) - prev) / 36e5;

  /* A previous file with a missing or unparseable checkedAt gives NaN. NaN
     fails the comparison, so we fall through and WRITE. That is the safe
     direction: an unreadable clock should refresh the file, not silently
     suppress it forever.

     A NEGATIVE sinceCheck is a clock going backwards -- someone typed a future
     date into the file in the web editor. That is finite and less than the
     heartbeat, so it used to suppress every write until the wall clock caught
     up: tested with a 30-day-future stamp, thirty days of silence. And because
     nothing was ever written, the future timestamp persisted, so every consumer
     computing now - checkedAt got a negative number and read the feed as
     perpetually fresh. That is precisely the state the two clocks exist to make
     visible, so it must write, not skip. */
  if (Number.isFinite(sinceCheck) && sinceCheck >= 0 && sinceCheck < heartbeatHours)
    return {
      write: false, changed: false, file,
      reason: `no change (checked ${sinceCheck.toFixed(1)}h ago, heartbeat at ${heartbeatHours}h)`,
    };

  return {
    write: true, changed: false, file,
    reason: !Number.isFinite(sinceCheck)
      ? "heartbeat (the previous file had no readable checkedAt)"
      : sinceCheck < 0
        ? `heartbeat (the previous file is stamped ${Math.abs(sinceCheck).toFixed(1)}h in the FUTURE)`
        : `heartbeat (last checked ${sinceCheck.toFixed(1)}h ago)`,
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

/* WHICH SOURCES ACTUALLY MOVED THIS RUN — 2026-08-20.
 *
 * poll.mjs writes data/index.json on every run, and index.json carries
 * `generated: now`, so EVERY run produces a commit. That makes "did we commit"
 * useless as a signal that a price changed, and it is the signal the Emmert
 * sites need: they rebuild their page from data/boyceville.json and there is no
 * point rebuilding when nothing moved.
 *
 * A heartbeat is not a move either. decide() already tells them apart —
 * `changed` is true only when priceChanged() said so — and this is just that
 * answer, per source, in a form a shell step can read.
 *
 * WHY IT MATTERS: on 2026-08-20 GitHub was delivering one to two scheduled runs
 * an hour against a cron asking for six, on every one of these repositories at
 * once. The sites' ten-minute schedule is not a promise anybody can keep. So
 * the sites are told when their price moves instead of being left to ask.
 */
export function movedSources(results) {
  return (results ?? [])
    .filter((r) => r && r.wrote === true && r.changed === true && r.id)
    .map((r) => r.id);
}

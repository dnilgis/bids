/* THE LIVE READER WAS THE ONLY FETCHER IN THIS REPOSITORY WITH NO DEADLINE.
 *
 * Measured 2026-09-16 across scripts/ and lib/: probe.mjs, urlfinder.mjs,
 * board-sweep.mjs and agricharts-sweep.mjs all pass a signal. scripts/poll.mjs
 * did not — so every offline tool was bounded and the one thing that runs each
 * hour inside a six-minute budget was not.
 *
 * Node's fetch has no request timeout. What it has is a connect timeout of
 * about ten seconds and a HEADERS timeout of three hundred, so what one bad
 * host costs depends on HOW it is bad:
 *
 *     refuses the connection      fails at once and costs nothing
 *     black-holes the packets     ~10s per url, and urlsFor() yields two
 *     accepts and never answers   UP TO 300s — most of the budget, on one host
 *
 * The third case has never shown up in a run log because the pass dies first
 * and the log ends. It does not have to have happened to be worth closing.
 *
 * MEASURED on the live feed, data/index.json of 2026-09-16: 29 sources were
 * failing with "could not read their page", behind 8 distinct urls — the page
 * cache already collapses the other 21. At the two connect timeouts a dead
 * site costs today that is 8 x ~21s = ~168s of a 360s budget. At one 12-second
 * deadline it is 96s. The ~72s saved is about 33 more sources reached, at the
 * 2.2s an ADM browser read measures.
 *
 * MEASURED IN PRODUCTION, run of 2026-09-16T12:57:51Z, the first pass to carry
 * this file. Six dead sites, each costing EXACTLY 12.0 seconds --
 * 12:58:01.485 -> 12:58:13.486, 13:00:28.886 -> 13:00:40.884, and four more
 * within 4ms of the same figure. Unreached sources fell from 211 to 177 and
 * carried from 185 to 151. The bound holds, and it is the bound that was set.
 *
 * Here rather than in poll.mjs for the reason lib/breaker.mjs gives for itself:
 * a guard inside the script that runs a pass cannot be tested without running
 * a pass, and this repository has found guards with no test behind them four
 * times in a fortnight.
 */

/** Node's own default headers timeout, stated so the comparison is not folklore. */
export const NODE_HEADERS_TIMEOUT_MS = 300_000;

/** What one source's whole url list is allowed to cost. */
export const SOURCE_FETCH_MS_DEFAULT = 12_000;

/* WHAT A BROWSER READ HAS ACTUALLY BEEN MEASURED TO NEED.
 *
 * The fetch branch of poll.mjs can be clamped to whatever is left of the pass
 * and a short deadline simply fails fast. The BROWSER branch cannot: a page
 * load handed three seconds fails, and poll.mjs records a failure as `broken`
 * and counts it against the operator's streak -- which decides read order.
 * Clamping without a floor would manufacture evidence against sources nobody
 * tested, and then sort them to the back of the pass for it.
 *
 * So below this floor a browser source is SKIPPED, which lib/breaker.mjs
 * already defines as "we did not try, so we learned NOTHING" and which leaves
 * the streak where it was.
 *
 * MEASURED, not chosen: the fourteen consecutive ADM gradable reads in the run
 * of 2026-09-16T12:57:51Z, from the log's own timestamps --
 *
 *     13:03:00.623  02.194  04.048  05.732  08.377  10.319  12.004
 *           13.742  15.361  16.952  19.705  21.307  22.926  24.468
 *
 * Thirteen intervals, fastest 1.542s, slowest 2.753s, every one of them a
 * successful read. Three seconds is above the slowest read observed, so
 * nothing that would have answered is cut; anything under it was going to
 * fail on the clock rather than on the board. */
export const BROWSER_FLOOR_MS = 3_000;

/** An absolute epoch-millisecond mark, never past the pass budget.
 *
 *  CLAMPED, because the budget is checked BEFORE each source and not during
 *  it: a fetch that starts with four seconds left would otherwise carry the
 *  pass over the wall anyway, and a pass that commits what it read beats a
 *  pass that is killed holding everything.
 *
 *  Never negative. A budget already spent yields `now`, and fetchWithin turns
 *  that into an immediate, explained refusal rather than an unbounded call. */
export function deadlineFrom(now, budgetLeftMs, sourceFetchMs = SOURCE_FETCH_MS_DEFAULT) {
  return now + Math.max(0, Math.min(sourceFetchMs, budgetLeftMs));
}

/** The slice of a shared deadline that one of several attempts may have.
 *
 *  THE SAME RUN SHOWED THE OTHER HALF OF THIS. Every dead site logged
 *
 *      https://farmerswin.com/...     -> fetch failed
 *      https://www.farmerswin.com/... -> no answer within 1513ms
 *
 *  12000 - 1513 = 10487ms, which is NODE'S OWN CONNECT TIMEOUT of about ten
 *  and a half seconds firing before this file's abort ever could. So the first
 *  hostname spent 87% of the deadline and the www twin -- the entire reason
 *  urlsFor() returns two -- was left a second and a half.
 *
 *  That is not a bound, it is a queue: whoever is asked first takes the lot.
 *  The twin exists BECAUSE sometimes only one of the pair is served, and a
 *  twin given 1.5s cannot answer for a site that is merely slow. Each attempt
 *  gets what is left divided by the attempts still to make, so two urls on a
 *  12s mark get 6s each and the TOTAL IS UNCHANGED.
 *
 *  An attempt that returns early hands its unused time to the next one,
 *  because the divisor is applied to what is actually left at the time. */
export function shareOf(deadline, attemptsLeft, now = Date.now()) {
  const left = deadline - now;
  if (left <= 0 || attemptsLeft <= 0) return now;
  return now + left / attemptsLeft;
}

/** fetch(), bounded by an absolute deadline, in the shape the sweeps use.
 *
 *  The deadline is ABSOLUTE and shared, so a caller can hand the same mark to
 *  every url one source is allowed to try and bound the LIST rather than each
 *  attempt. urlsFor() returns a host and its www twin — the same site written
 *  two ways — so charging each of them a full timeout bills one dead site
 *  twice for one answer.
 *
 *  AbortError is renamed on the way out. "This operation was aborted" says
 *  nothing about whose page it was or how long anyone waited, and that string
 *  would be committed into an error field for somebody to read later. */
export async function fetchWithin(url, opts, deadline, { now = Date.now, impl = fetch } = {}) {
  const left = deadline - now();
  if (left <= 0)
    throw new Error("gave up before asking: this source's deadline had already passed");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), left);
  try {
    return await impl(url, { ...opts, signal: ac.signal });
  } catch (e) {
    if (e?.name === "AbortError" || e?.name === "TimeoutError")
      throw new Error(`no answer within ${Math.round(left)}ms`);
    throw e;
  } finally { clearTimeout(t); }
}

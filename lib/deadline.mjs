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
 * Here rather than in poll.mjs for the reason lib/breaker.mjs gives for itself:
 * a guard inside the script that runs a pass cannot be tested without running
 * a pass, and this repository has found guards with no test behind them four
 * times in a fortnight.
 */

/** Node's own default headers timeout, stated so the comparison is not folklore. */
export const NODE_HEADERS_TIMEOUT_MS = 300_000;

/** What one source's whole url list is allowed to cost. */
export const SOURCE_FETCH_MS_DEFAULT = 12_000;

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

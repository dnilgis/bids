/* TWO LANES, SO A BROWSER BOARD AND A PLAIN FETCH NEVER WAIT ON EACH OTHER -- 2026-10-20.
 *
 * THE PASS DID NOT REACH A THIRD OF THE BOARDS, EVERY PASS.
 *
 * One queue of 2,281 sources (590 distinct pages: 263 read in a browser, 327
 * fetched) drained by three workers against a 360-second wall. Counted over the
 * 288 committed passes from Oct 17 to Oct 20 (data/index.json in git, every
 * pass writes it): a median 620 sources were not reached at all and were carried
 * ("pass budget spent" annotation; run 39450565852 printed 1040), and 204 of the
 * 288 passes ended with browser boards skipped as "not attempted: N ms of the
 * pass budget were left" -- 2,432 such skips, NEW Cooperative's 66 among them on
 * most passes. A median pass reached about 450 of the 590 pages.
 *
 * The three workers were shared: a browser read (a Chromium per page, CPU on
 * two cores) and a plain fetch (a socket waiting on someone's server) took
 * turns in one line, and whichever sorted last ran out of clock.
 *
 * So the read is two lanes that run AT THE SAME TIME, each against the same
 * wall, each with its own workers:
 *
 *   browser  every browser page, READ_CONCURRENCY workers (3, the measured
 *            limit for Chromium on a two-core runner -- see poll.mjs). Each
 *            source is its own job; getPage() still caches per page.
 *   fetch    every other source, FETCH_CONCURRENCY workers, and ONE HOST AT A
 *            TIME: a host's sources are one job, read in order by one worker,
 *            so the extra workers never put two requests on one server at
 *            once. A fetch mostly waits on a network, not on the CPU, so it
 *            does not compete with Chromium for the cores the way a fourth
 *            browser would.
 *
 * Each lane keeps the read order it is handed (reprieve, streak, last
 * attempted, hash), so within a lane nothing about who goes first changes. */

/** The host a source's own url is on, without a leading www. */
export function hostKey(url) {
  try { return new URL(url).host.replace(/^www\./, "").toLowerCase(); }
  catch { return String(url ?? ""); }
}

/** Split an ordered source list into lanes. Each lane is a list of JOBS, and a
 *  job is a list of sources one worker reads in order. Order is kept: browser
 *  jobs in source order, fetch jobs in order of each host's first source. */
export function planLanes(sorted, { transportOf, hostOf = (s) => hostKey(s.url) }) {
  const browser = [];
  const hosts = new Map();
  for (const s of sorted) {
    if (transportOf(s.platform) === "browser") { browser.push([s]); continue; }
    const h = hostOf(s);
    if (!hosts.has(h)) hosts.set(h, []);
    hosts.get(h).push(s);
  }
  return { browser, fetch: [...hosts.values()] };
}

/** Drain `jobs` with at most `n` workers, front first. Every source of every job
 *  is handed to `work` exactly once, and a job's sources one after another.
 *  Resolves to { sources, ms } where ms is when the lane went idle. */
export async function drain(jobs, n, work, now = Date.now) {
  const started = now();
  let cursor = 0, sources = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length || 1)) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      for (const s of job) { sources++; await work(s); }
    }
  }));
  return { jobs: jobs.length, sources, ms: now() - started };
}

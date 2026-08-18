/* Cloudflare Worker: read Big River's Boyceville board, commit it when it moves.
 *
 * The same job as .github/workflows/poll.yml, on a schedule Cloudflare
 * actually honours. GitHub does not promise scheduled workflows run on time;
 * ten to twenty minute lags at busy times are normal and occasional runs are
 * dropped entirely. Cron triggers here fire when they say they will, which is
 * the whole reason for this second reader.
 *
 * Everything that decides anything lives in ../../lib, shared with the Action:
 *
 *   lib/parse.mjs   the table parser
 *   lib/board.mjs   buildFile()  — the guards, and the file we publish
 *   lib/decide.mjs  decide()     — write or skip, and which pricedAt
 *
 * This file is only the parts that need a runtime: fetching their page,
 * talking to GitHub, and the cron entry point. That split is what lets the
 * test suite cover the reader without a Cloudflare account.
 *
 *
 * THREE CRON EXPRESSIONS, AND THAT IS THE CEILING
 *
 * The Workers free plan allows three cron triggers per Worker. The Actions
 * version happens to use three as well, and that is not a coincidence — the
 * cadence was designed against this limit. If you want a fourth window, you
 * are buying a plan, not editing a file.
 *
 * The three live in worker/wrangler.toml, not here -- a cron expression
 * contains a slash-star sequence, which cannot appear inside a block comment
 * without ending it. (It did, and the whole module failed to parse. Left as a
 * note because the next person to paste a crontab into a comment deserves the
 * warning.) In words: every ten minutes through the weekday trading day,
 * hourly the rest of the weekday, every four hours at weekends.
 *
 * Cron triggers are UTC. The 12:00-21:59 UTC window covers 7am-4pm Central in
 * both standard and daylight time, so the clocks changing cannot quietly walk
 * the poll out of market hours.
 *
 *
 * WHEN THIS FAILS, IT FAILS LOUDLY HERE AND QUIETLY EVERYWHERE ELSE
 *
 * A refused read throws. Cloudflare records the cron invocation as errored and
 * it shows in the dashboard and in `wrangler tail`. Nothing is written, so the
 * committed file holds its last good price — a stale file is safe, a wrong one
 * is not.
 *
 * But nobody watches a dashboard. The real detection is downstream and it is
 * deliberate: `checkedAt` stops advancing, and the Emmert Worker's
 * FEED_MAX_AGE_H of 14 hours withdraws the price and shows "Call for today's
 * price". That is the alarm. It is worth being honest that it is a fourteen-
 * hour alarm, not a fourteen-second one, and that between the failure and the
 * withdrawal the sites publish a price that is correct but ageing.
 *
 * This is the same shape as the crop tour bug of 2026-08-15: a silent refusal
 * plus a stale artifact reads exactly like a successful run. The difference is
 * that here the staleness is load-bearing and checked, rather than invisible.
 * `GET /health` below exists so a human can ask directly instead of inferring.
 */

import { buildFile, Refused, serialise } from "../../lib/board.mjs";
import { decide, commitMessage } from "../../lib/decide.mjs";
import { makeRepo, GitHubError } from "./github.js";

const USER_AGENT =
  "agsist-bidreader/1.0 (+https://agsist.com; posted bid, by arrangement)";

/* Both spellings. Their apex has redirected to www and back at least once, and
   a redirect that lands on an error page is indistinguishable from a layout
   change if you only try one. */
const DEFAULT_URLS = [
  "https://bigriverbids.com/cashbidssingle-2121",
  "https://www.bigriverbids.com/cashbidssingle-2121",
];

function config(env) {
  return {
    urls: (env.SOURCE_URLS || "").split(",").map((s) => s.trim()).filter(Boolean).length
      ? env.SOURCE_URLS.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_URLS,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    branch: env.GITHUB_BRANCH || "main",
    path: env.DATA_PATH || "data/boyceville.json",
    token: env.GITHUB_TOKEN,
  };
}

export async function getPage(urls, { fetchImpl = fetch } = {}) {
  const problems = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "follow",
        cache: "no-store",
      });
      if (!res.ok) { problems.push(`${url} -> HTTP ${res.status}`); continue; }
      const html = await res.text();
      /* A short body is a redirect stub, an error page, or a WAF challenge.
         The parser would find no tables and report "layout has changed", which
         would send the next reader hunting the wrong bug. */
      if (html.length < 500) { problems.push(`${url} -> ${html.length} bytes, too short`); continue; }
      return { html, url };
    } catch (e) {
      problems.push(`${url} -> ${e.message}`);
    }
  }
  throw new Refused(`could not read their page. ${problems.join(" | ")}`);
}

/**
 * The whole job. Returns a summary; throws Refused or GitHubError on failure.
 * `dryRun` builds and decides but commits nothing.
 */
export async function run(env, { now, fetchImpl = fetch, dryRun = false } = {}) {
  const cfg = config(env);
  const stamp = now || new Date().toISOString();

  const { html, url } = await getPage(cfg.urls, { fetchImpl });
  const { file, dropped } = buildFile(html, { now: stamp, sourceUrl: cfg.urls[0] });

  const gh = makeRepo({ ...cfg, userAgent: USER_AGENT, fetchImpl });
  const { json: previous, sha } = await gh.read();

  const verdict = decide(previous, file);
  const summary = {
    ok: true,
    readFrom: url,
    rows: file.count,
    dropped,
    changed: verdict.changed,
    wrote: false,
    pricedAt: verdict.file.pricedAt,
    checkedAt: verdict.file.checkedAt,
    reason: verdict.reason,
  };

  if (verdict.write && !dryRun) {
    // The sha comes from the read above, so a normal poll is one GET and, when
    // there is news, one PUT.
    await gh.commit({
      content: serialise(verdict.file),
      message: commitMessage(verdict),
      sha,
    });
    summary.wrote = true;
  }
  return summary;
}

export default {
  /* Awaited, not passed to ctx.waitUntil: a throw here has to mark the cron
     invocation as failed. waitUntil would let it resolve green. */
  async scheduled(event, env, ctx) {
    const s = await run(env);
    console.log(
      `boyceville ${s.rows} rows, ${s.wrote ? "wrote" : "skipped"} — ${s.reason}`
    );
  },

  /* GET /health — read their board and report, WITHOUT writing anything.
   *
   * Guarded by a secret because it makes an outbound request to someone
   * else's site on demand, and an open endpoint that does that is an open
   * proxy. Absent CHECK_KEY, the route does not exist.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/health") return new Response("not found", { status: 404 });
    if (!env.CHECK_KEY || url.searchParams.get("key") !== env.CHECK_KEY)
      return new Response("not found", { status: 404 });
    try {
      const s = await run(env, { dryRun: true });
      return Response.json(s);
    } catch (e) {
      return Response.json(
        { ok: false, kind: e instanceof Refused ? "refused" : e instanceof GitHubError ? "github" : "error",
          message: e.message },
        { status: 502 }
      );
    }
  },
};

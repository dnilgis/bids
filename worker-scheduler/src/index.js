/*
 * worker-scheduler — the thing that actually makes the reader run every ten
 * minutes, because GitHub's cron scheduler measurably will not.
 *
 * THE MEASUREMENT THAT FORCED THIS
 *
 * poll.yml asked for six fires an hour through the trading day from
 * 2026-08-18 to 2026-08-26. Counted over every commit in the repository — a
 * commit happens on every pass, so this is an exact record of whether the
 * reader ran — and with both of GitHub's own Actions incidents that week
 * excluded from the count:
 *
 *     380 fires asked, 66 delivered = 17.4%
 *     mean 1.7 reads per trading hour, median gap 36 minutes
 *
 * Replacing that with one fire an hour and a fifty-minute loop inside it was
 * worse still: weekday hours producing any read at all fell from 81% to 31%,
 * and on 2026-08-27 the repository went nine hours with nothing, then six
 * more, with no queued runs, no cancelled runs and nothing red.
 *
 * GitHub cron is a best-effort queue and this repository is near the back of
 * it. Nothing written inside the repository can change that, because every
 * layer of retry, backup and watchdog built there is started by the same
 * scheduler that is not starting anything.
 *
 * SO THE TRIGGER MOVES OUT, AND ONLY THE TRIGGER.
 *
 * Cloudflare's cron triggers are a different system with a different queue.
 * This Worker holds no scraping logic, no adapters, no parsing and no data: it
 * wakes up and asks GitHub to run poll.yml. A workflow_dispatch made with a
 * personal access token DOES create a run — the recursion guard that blocks
 * GITHUB_TOKEN does not apply — and a dispatched run is not subject to cron
 * scheduling at all.
 *
 * This is deliberately not the 2026-08-17 Worker that was removed. That one
 * read the boards itself, which meant a second implementation of the thing
 * that matters, a second runtime to keep in step, and adapters in two places.
 * This one is thirty lines and knows one URL. If it dies, the GitHub crons
 * still fire at whatever rate they manage and the watchdog still covers; the
 * system degrades to exactly what it is today rather than breaking.
 *
 * WHAT IT COSTS: nothing. Cron triggers are on the Workers free plan.
 *
 * SECRETS: GH_PAT only, set with `wrangler secret put GH_PAT`, never in a
 * file. A fine-grained token scoped to this one repository with Actions:
 * read and write and nothing else. FIRE_KEY is optional and only guards the
 * manual URL below.
 */

const OWNER = "dnilgis";
const REPO = "bids";
const REF = "main";

/* WHICH CRON FIRES WHICH WORKFLOW.
 *
 * ADDED 2026-08-28. This Worker was written to rescue poll.yml, and it did:
 * GitHub cron delivered 66 of 380 asked over 18-26 August, 17.4%, while the
 * Worker delivered 47 of 48 in the trading window on the 28th, 97.9%.
 *
 * But `discover-sweep.yml` was left on GitHub cron, and that is the workflow
 * that turns a grey pin into a green one: it asks each operator's own site
 * what board it runs, 45 hosts a run, six runs a day. 614 hosts are still
 * unasked. At the six fires a day it asks for, that queue is empty in under
 * three days. At the one in six GitHub actually delivers, it is a fortnight.
 * On 2026-08-28, of five scheduled discover fires due, exactly one arrived.
 *
 * So the cheapest single thing that moves national coverage is four lines
 * here, not new scraper code.
 *
 * Cloudflare hands `event.cron` back as the exact string from wrangler.toml,
 * so routing on it is an equality test and cannot drift.
 *
 * DOUBLE FIRING IS SAFE, and on discover it is useful. Both schedulers are
 * armed on purpose -- GitHub stays as the fallback the README describes. Both
 * workflows hold a `concurrency` group with `cancel-in-progress: false`, so a
 * duplicate queues rather than running twice; and because discover keeps a
 * ledger and resumes past every URL already decided, the queued run does the
 * NEXT 45 hosts instead of repeating the last 45. */
const ROUTES = {
  "*/10 12-21 * * 1-5":        "poll.yml",
  "20 0-11,22-23 * * 1-5":     "poll.yml",
  "20 */3 * * 6,0":            "poll.yml",
  "35 1,4,7,16,19,22 * * *":   "discover-sweep.yml",
};
const DEFAULT_WORKFLOW = "poll.yml";
const WORKFLOWS = [...new Set(Object.values(ROUTES))];

/* An unrecognised cron falls back to the reader rather than throwing.
 * A typo in wrangler.toml then costs one wasted poll, which is cheap and
 * idempotent, instead of silently dropping every fire in that slot. The log
 * line carries `unmatchedCron` so it is still findable. */
function routeFor(cron) {
  const workflow = ROUTES[cron];
  return { workflow: workflow ?? DEFAULT_WORKFLOW, unmatchedCron: !workflow };
}
const UA = "agsist-bid-scheduler (+https://agsist.com; sig@farmers1st.com)";

async function dispatch(env, why, workflow = DEFAULT_WORKFLOW) {
  if (!env.GH_PAT) return { ok: false, status: 0, why, workflow, detail: "GH_PAT is not set on this Worker" };
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/dispatches`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      "Content-Type": "application/json",
    },
    /* No inputs: loop_minutes stays blank so the run is a single short pass,
       which is the whole point of moving the trigger rather than the work. */
    body: JSON.stringify({ ref: REF }),
  });
  /* 204 is success and carries no body. Anything else, keep the text: a 403
     here is almost always the token missing Actions: write, and a 404 is
     almost always the token not being scoped to this repository. Those two
     mistakes look identical from the outside unless the reason is printed. */
  const detail = r.status === 204 ? "" : (await r.text()).slice(0, 300);
  return { ok: r.status === 204, status: r.status, why, workflow, detail };
}

export default {
  async scheduled(event, env, ctx) {
    const { workflow, unmatchedCron } = routeFor(event.cron);
    const r = { ...(await dispatch(env, event.cron, workflow)), unmatchedCron };
    /* A Worker's log is the only place this is visible, so say enough to
       diagnose it from the log alone. */
    console.log(JSON.stringify({ at: new Date(event.scheduledTime).toISOString(), ...r }));
    if (!r.ok) throw new Error(`dispatch failed: ${r.status} ${r.detail}`);
  },

  /* A URL to fire it by hand, for proving the token works without waiting for
     a cron. Guarded by FIRE_KEY when one is set; refuses rather than firing
     when it is not, because an open trigger on a public URL is an invitation.
     GET /health says whether the token is present without using it. */
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/health")
      return new Response(JSON.stringify({ ok: true, hasToken: Boolean(env.GH_PAT), repo: `${OWNER}/${REPO}`, routes: ROUTES }, null, 1),
        { headers: { "content-type": "application/json" } });
    if (u.pathname !== "/fire") return new Response("not found", { status: 404 });
    if (!env.FIRE_KEY) return new Response("FIRE_KEY is not set; refusing to expose an unauthenticated trigger", { status: 403 });
    if (u.searchParams.get("key") !== env.FIRE_KEY) return new Response("forbidden", { status: 403 });
    /* ?workflow= is checked against the route table's own values, never passed
       through: this endpoint can fire the two workflows this Worker schedules
       and nothing else in the repository. */
    const asked = u.searchParams.get("workflow");
    if (asked && !WORKFLOWS.includes(asked))
      return new Response(`workflow must be one of: ${WORKFLOWS.join(", ")}`, { status: 400 });
    const r = await dispatch(env, "manual", asked || DEFAULT_WORKFLOW);
    return new Response(JSON.stringify(r, null, 1), { status: r.ok ? 200 : 502, headers: { "content-type": "application/json" } });
  },
};

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
const WORKFLOW = "poll.yml";
const REF = "main";
const UA = "agsist-bid-scheduler (+https://agsist.com; sig@farmers1st.com)";

async function dispatch(env, why) {
  if (!env.GH_PAT) return { ok: false, status: 0, why, detail: "GH_PAT is not set on this Worker" };
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
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
  return { ok: r.status === 204, status: r.status, why, detail };
}

export default {
  async scheduled(event, env, ctx) {
    const r = await dispatch(env, event.cron);
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
      return new Response(JSON.stringify({ ok: true, hasToken: Boolean(env.GH_PAT), target: `${OWNER}/${REPO}/${WORKFLOW}` }, null, 1),
        { headers: { "content-type": "application/json" } });
    if (u.pathname !== "/fire") return new Response("not found", { status: 404 });
    if (!env.FIRE_KEY) return new Response("FIRE_KEY is not set; refusing to expose an unauthenticated trigger", { status: 403 });
    if (u.searchParams.get("key") !== env.FIRE_KEY) return new Response("forbidden", { status: 403 });
    const r = await dispatch(env, "manual");
    return new Response(JSON.stringify(r, null, 1), { status: r.ok ? 200 : 502, headers: { "content-type": "application/json" } });
  },
};

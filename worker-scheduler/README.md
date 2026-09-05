# worker-scheduler

Fires `poll.yml` and `discover-sweep.yml` on a schedule Cloudflare keeps,
because GitHub cron does not.

Measured, 2026-08-18 to 08-26, GitHub incidents excluded: **380 fires asked,
66 delivered, 17.4%** — a mean of 1.7 reads per trading hour against six asked.
Nothing inside the repository can fix that, because every retry, backup and
watchdog there is started by the scheduler that is not starting anything.

This Worker holds no scraping logic and no data. It wakes up and asks GitHub to
run the workflow. If it dies, the GitHub crons still fire at whatever rate they
manage and the watchdog still covers.

## Setup, once

1. **Make a fine-grained personal access token.**
   GitHub → Settings → Developer settings → Personal access tokens → Fine-grained.
   - Resource owner: `dnilgis`
   - Repository access: **Only select repositories** → `dnilgis/bids`
   - Permissions → Repository → **Actions: Read and write**. Nothing else.
   - Expiry: set a reminder for the day before it lapses.

2. **Deploy.**
   ```
   cd worker-scheduler
   npx wrangler login
   npx wrangler secret put GH_PAT      # paste the token; it never touches a file
   npx wrangler secret put FIRE_KEY    # any long random string, for the manual URL
   npx wrangler deploy
   ```

3. **Prove it before trusting it.**
   ```
   curl https://agsist-bid-scheduler.<your-subdomain>.workers.dev/health
   curl "https://agsist-bid-scheduler.<your-subdomain>.workers.dev/fire?key=<FIRE_KEY>"
   curl "https://agsist-bid-scheduler.<your-subdomain>.workers.dev/fire?key=<FIRE_KEY>&workflow=discover-sweep.yml"
   ```
   `/fire` returns `{"ok":true,"status":204}` and the run appears in the
   Actions tab within seconds. `workflow=` is checked against the route
   table's own values, so this endpoint can fire the two workflows the Worker
   schedules and nothing else in the repository. A **403** almost always means the
   token is missing Actions: write; a **404** almost always means it is not
   scoped to this repository. Those two mistakes look identical from the
   outside, which is why the Worker prints the reason.

## What runs where, after this

| trigger | cadence | what it does |
|---|---|---|
| this Worker | 10 min trading, hourly nights, 3-hourly weekends | dispatches `poll.yml` |
| this Worker | 35 past 01, 04, 07, 16, 19, 22 | dispatches `discover-sweep.yml` |
| `poll.yml` cron | the same, best effort | the same, when GitHub delivers it |
| `discover-sweep.yml` cron | the same, best effort | the same, when GitHub delivers it |
| `watchdog.yml` | :13 and :43 | reads the board itself if the last pass is over 25 minutes old |
| `alert-email.mjs` | on total failure | mail, immediately |

Both schedules hitting at once is harmless. Each workflow holds a concurrency
group with `cancel-in-progress: false`, so the second run waits for the first.
`poll.yml` then finds nothing to do; `discover-sweep.yml` resumes past every
URL already decided, so it does the NEXT 45 hosts rather than repeating the
last 45.

## Which cron fires which workflow

`src/index.js` holds a `ROUTES` map keyed by the exact cron string Cloudflare
hands back in `event.cron`, so routing is an equality test and the table cannot
drift from the schedule. **Every cron in `wrangler.toml` must appear in
`ROUTES`.** An unrecognised cron falls back to `poll.yml` and logs
`unmatchedCron: true` rather than throwing, so a typo costs one cheap poll
instead of silently dropping a slot.

`GET /health` returns the whole route table, which is the fastest way to see
what a deployed Worker believes it is scheduling.

## ONE WRITER FOR THE SCHEDULE

The cron triggers live in `wrangler.toml` **or** in the Cloudflare dashboard,
never usefully in both: `wrangler deploy` replaces the deployed trigger list
with whatever is in the file, so a cron added by hand in the dashboard is
deleted by the next deploy, and silently. Pick the file, keep it in the repo,
and make every schedule change there.
## Deploying

This Worker deploys itself. Cloudflare Workers Builds is connected to
`dnilgis/bids`, root directory `worker-scheduler`, and builds only when a file
in this folder changes. Push here and it deploys; there is no manual step, and
the cron triggers come from `wrangler.toml` rather than being typed into the
dashboard.

Wired 2026-09-05, after the Worker and the repository had drifted seven days
apart with nothing to notice it.

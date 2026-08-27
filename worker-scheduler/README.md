# worker-scheduler

Fires `poll.yml` on a schedule Cloudflare keeps, because GitHub cron does not.

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
   ```
   `/fire` returns `{"ok":true,"status":204}` and a `read boyceville` run
   appears in the Actions tab within seconds. A **403** almost always means the
   token is missing Actions: write; a **404** almost always means it is not
   scoped to this repository. Those two mistakes look identical from the
   outside, which is why the Worker prints the reason.

## What runs where, after this

| trigger | cadence | what it does |
|---|---|---|
| this Worker | 10 min trading, hourly nights, 3-hourly weekends | dispatches `poll.yml` |
| `poll.yml` cron | the same, best effort | the same, when GitHub delivers it |
| `watchdog.yml` | :13 and :43 | reads the board itself if the last pass is over 25 minutes old |
| `alert-email.mjs` | on total failure | mail, immediately |

Both schedules hitting at once is harmless: `poll.yml` holds a concurrency
group, so the second run waits for the first and then finds nothing to do.

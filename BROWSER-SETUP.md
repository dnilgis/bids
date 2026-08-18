# Setting this up in a browser

No command line. About fifteen minutes. This gets the **GitHub Actions** reader running,
which is the half that needs no Cloudflare account and no wrangler.

The repo also contains `worker/`, the Cloudflare version of the same reader. Upload it with
everything else — it sits inert until somebody deploys it, and it costs nothing to carry.
Deploying it needs a command line once; `README.md` has the three commands. Run one reader
or the other, not both: see the note at the end of Step 3.

## What you cannot break

**Nothing here touches the Emmert websites or any DNS.** The worst outcome is a repo that
does not update, which shows up as a red X and an email rather than a wrong price anywhere.

**A bad read never overwrites a good price.** The job exits with an error and leaves the
file alone. Stale is safe here; every consumer checks the timestamp.

---

## Step 1 — Make the repo

github.com → **New repository**

- Name: `bigriver-bids`
- **Public** — see the note on the schedule at the bottom; this is what makes a 10-minute cadence free
- Do **not** add a README — you want it empty

> **Checkpoint.** An empty repo page offering you an upload link.

## Step 2 — Upload the files

Click **uploading an existing file**. Open the `bigriver-bids` folder, select
**everything inside it**, drag it on. Not the folder — the contents. Commit.

> **Checkpoint.** The front page lists `README.md`, `package.json`, and folders `lib`,
> `scripts`, `worker`, `test`, `fixtures`, `data`. If you see one folder called
> `bigriver-bids`, you dragged the folder — delete and redo.

## Step 3 — Add the two workflows

GitHub's uploader cannot create workflow files, so do this twice:

1. **Actions** tab → **set up a workflow yourself**
2. rename the box at the top to **`poll.yml`**
3. delete the sample
4. open `.github/workflows/poll.yml` from the folder in a text editor, copy all, paste
5. **Commit changes**

Then repeat for **`test.yml`**, pasting `.github/workflows/test.yml`.

They are separate on purpose: `poll.yml` reads their board every ten minutes and runs no
tests, because the code has not changed between polls. `test.yml` runs the suite when the
code actually changes.

> **Checkpoint.** Actions → two workflows in the left sidebar, **read boyceville** and
> **test**.

## Step 4 — Let it write

**Settings** → **Actions** → **General** → scroll to **Workflow permissions** → choose
**Read and write permissions** → **Save**.

Without this the job runs, reads their page perfectly, and fails at the commit. It is the
single most common way this goes wrong.

## Step 5 — Run it

Actions → **read boyceville** → **Run workflow** → **Run workflow**. Wait a minute, refresh.

> **Checkpoint.** Green tick. Open `data/boyceville.json` in the repo — it should have
> today's Boyceville prices in it, seven rows, August first.

**Now open bigriverbids.com/cashbidssingle-2121 and compare.** This is the step no test can
do for you. The numbers in the file must match the Boyceville tab on their page, line for
line. If they show Dyersville's numbers, or nothing, stop and send me the file.

For reference, this is what their page showed when it was captured:

```
August 4.0750 -52 · September 4.1350 -46 · October 4.2900 -55 · November 4.2900 -55
December 4.3400 -50 · January 4.3975 -60 · February 4.4175 -58
```

Yours will differ — prices move. What must match is their page and your file, right now.

## Step 6 — Leave it alone

It runs every half hour through the trading day and every three hours otherwise, and
commits only when the price actually moves. `git log` becomes your price history.

---

## About the schedule

Every **10 minutes** through the trading day, hourly at night, every 4 hours at weekends.
It commits only when the price actually moves, plus a heartbeat every 6 hours so the file
can prove the reader is still alive.

**Public is what pays for that.** Actions minutes are unmetered on public repos. On a
private repo this schedule would be about 1,650 runs a month against a 2,000-minute
allowance — 83%, or 165% if a run ever crept past 60 seconds. **If you ever switch this
repo to private, cut the cadence first.**

**GitHub does not promise scheduled runs happen on time.** Delays of 10 to 20 minutes at
busy periods are normal and not a fault. If the timing ever has to be dependable rather
than typical, the poll moves to a Cloudflare cron and nothing else changes.

## When it goes wrong

**Red X, "0 bids parsed".** Their page changed shape. Send me the run log; it is a small
parser fix, not a rebuild.

**Red X, "none for location 2121".** They renamed or re-numbered Boyceville. The log prints
every location the page did contain, so the fix is usually one line.

**Red X, "fail cash - basis = futures".** Their columns moved. This is the check doing its
job — do not disable it to get a green run.

**Green tick but nothing commits.** Either the price genuinely has not moved, which is
normal and common, or step 4 was missed.

# bigriver-bids

Reads Big River Resources' posted **Boyceville** cash board and commits it as JSON.

**The git history of this repo is the record.** Every commit to `data/boyceville.json` is a
number their board actually showed, with the time it was read. Nothing is stored anywhere
else. Same doctrine as the Emmert sites: publishing is committing.

```
lib/parse.mjs         the table parser. Their markup, no I/O.
lib/board.mjs         buildFile() - the guards, and the file we publish. Pure.
lib/decide.mjs        decide()    - write or skip, and which pricedAt. Pure.

scripts/fetch.mjs     reader A: the GitHub Actions poller.
worker/src/index.js   reader B: the Cloudflare Worker. Same job, honoured schedule.
worker/src/github.js  the commit path - contents API, sha, one retry on conflict.
worker/wrangler.toml  Worker config and the three cron triggers.

data/boyceville.json  the output. This is the file everything else consumes.
fixtures/             a REAL capture of their page, values verbatim
test/                 57 tests. Run before anything else.
```

## Two readers, one core

Both readers do the same job. Everything that *decides* anything lives in `lib/` and is
shared byte for byte, so they cannot disagree about what a valid board is, what counts as a
change, or which timestamp to carry forward.

That sharing is not tidiness. Before it, `scripts/parse.mjs` and `worker/src/parse.js` were
byte-identical 504-line copies, and the two file builders had already drifted: the Worker's
emitted a `dropped` field the Action's did not. Nothing downstream reads `dropped`, so the
only symptom would have been a spurious commit every time the two handed off — a price
record recording a change in the *reader* rather than a change in the *price*.

**Run one, not both.** They cannot corrupt each other, but running both doubles the request
rate on someone else's site for no gain. Either keep `poll.yml`'s `schedule:` block, or
deploy the Worker and delete it, leaving `workflow_dispatch` as the manual fallback.

| | GitHub Actions | Cloudflare Worker |
|---|---|---|
| Schedule kept? | best effort, 10-20 min lags are normal, runs are sometimes dropped | fires when it says it will |
| Cost | free, but only on a **public** repo | free tier, 3 cron expressions max |
| Setup | nothing, it just runs | `wrangler deploy` plus two secrets |
| Commits via | `git push` from the runner | contents API |

## Who reads this file

**The Emmert Worker** — it applies each site's spread and publishes to badgergrain.com and
midwestcommodity.com. It reads through the GitHub API with a token it already has. That
means this repo *could* be private as far as the Emmert side is concerned — but see the
cadence section, because the Actions poller's economics say otherwise.

**AGSIST** — `merge_bids.py` folds these rows into the cash-bid map.

## What the file guarantees

**`bids` is in delivery order, nearest first.** That is `seq`, taken from the position on
their page. It is deliberately **not** sorted by the delivery label: Boyceville writes
deliveries as month names, so alphabetical order puts April first, and anything taking
`bids[0]` off a label-sorted list would price the wrong month in ten months of the year.
April and August are the two it would get right, which is exactly how that bug hides.

**Units are in the field names.** `cash` and `basisDollars` are dollars. `basisCents` and
`futuresPriceCents` are cents. Both forms ship so a consumer cannot quietly pick the wrong
one.

**Two clocks, and they are not the same fact.** `pricedAt` is when their board last
showed something different — it is allowed to be days old, because a price that has not
moved has not moved. `checkedAt` is when the reader last successfully looked, and it gets a
heartbeat commit every 6 hours so it cannot age without meaning it.

**Consumers must check `checkedAt`.** Checking `pricedAt` treats a quiet weekend as a dead
reader: on Monday morning the figure is 63 hours old and every threshold fails, which would
withdraw a perfectly good price from both Emmert sites. Every Monday. (`observed` was the
schema/1 spelling of `checkedAt`. Nothing writes it any more; `decide()` still *reads* it
so an old file upgrades cleanly instead of resetting its own price age.)

## What it refuses to do

A bad read **writes nothing**. On Actions it exits non-zero, which fails the run and emails
you. In the Worker it throws, which marks the cron invocation as errored. Either way
`data/boyceville.json` is left exactly as it was. It never overwrites a good price with a
bad one. Worst case the file goes stale, and every consumer checks `checkedAt` for
precisely that.

It refuses when: their page cannot be fetched from either URL · the response is under 500
bytes (a redirect stub or a challenge page, not a board) · the parser returns nothing · no
rows carry Boyceville's location id · **cash minus basis does not equal the quoted futures
on any row** · no corn rows · a cash bid outside $2.00 to $12.00.

That middle one is the important one. Every other check asks whether a number looks
plausible. That one asks whether it came out of the right column, and a page that quietly
reorders its columns while every value stays in range passes all the others and fails it.

**Be honest about the alarm.** A refusal is loud where nobody is looking — a dashboard, an
email — and quiet where it matters. The real detection is downstream and deliberate:
`checkedAt` stops advancing and the Emmert Worker's `FEED_MAX_AGE_H` of 14 hours withdraws
the price. That is a fourteen-hour alarm, not a fourteen-second one, and in between the
sites publish a price that is correct but ageing. `GET /health?key=...` on the Worker exists
so a human can ask directly instead of inferring.

## One page, seven locations

`/cashbidssingle-2121` is the Boyceville URL and it **also serves Dyersville, Galva, West
Burlington, Monmouth, Aledo and Biddles** as tab panels, all in the same HTML. The filter is
not optional. It keys on the numeric `CashBidsLocationID` rather than the display name,
because an id survives them renaming a location.

Known ids: 2121 Boyceville · 2162 Dyersville · 2163 Galva · 2164 West Burlington ·
2165 Monmouth · 2166 Aledo/Edgington · 2167 Biddles Feedmill.

## Cadence

Every **10 minutes** through the trading day, hourly at night, every 4 hours at weekends.
Their footer says prices are delayed 10 minutes and the page self-refreshes every 5, so 10
is matched to the source rather than to a wish.

The Worker uses **three cron expressions**, which is the free plan's ceiling. The Actions
version uses three too, and that is not a coincidence — the cadence was designed against
that limit. A fourth window means buying a plan, not editing a file.

**If you run the Actions poller, this repo must be public.** Actions minutes are unmetered
on public repos. On a private repo this schedule is about 1,650 runs a month against a
2,000-minute allowance: 83%, or 165% if a run ever creeps past 60 seconds. **If you ever
make this repo private, cut the cadence first — or move to the Worker, whose schedule costs
nothing either way.**

Tests do not run on the poll — the code has not changed between polls, so it would prove
nothing and double each run. They run on push, in `test.yml`.

## Running it

```
npm test                  # 57 tests, all against the real capture
npm run dry               # parse the capture, print the JSON, write nothing
node scripts/fetch.mjs    # read their live page (Actions reader)

cd worker && npx wrangler deploy    # deploy the Worker
cd worker && npx wrangler tail      # watch it run
```

Worker secrets, set once, never in a file:

```
cd worker
npx wrangler secret put GITHUB_TOKEN   # fine-grained PAT, this repo, Contents: read+write
npx wrangler secret put CHECK_KEY      # any long random string; guards /health
```

`BROWSER-SETUP.md` sets the Actions half up with no command line at all.

## The platform, for whoever comes next

Their site runs on **FarmCentric** — the page loads `portal.farmcentric.com` and its classes
are `fcControls*`. Not AgriCharts and not Barchart, though an earlier note in this project
claimed AgriCharts on nothing better than co-occurrence in search results, and the header
comment in `lib/parse.mjs` went on claiming it for weeks after the rest of the kit was
corrected. Do not put a vendor name in this repo that has not been read off the page itself.

The same `cashbidssingle-####` template serves Tempel Grain, Skyland Grain, Encompass Grain,
Smithfield Grain, Wheaton Grain and others, so this parser is worth more than one elevator.

The rows are **column-lists, not tables** — `<ul class='sixColumnsBigFirst fcControls1'>`
with `<li class='c1'>` cells, single-quoted. A table-based scraper finds exactly zero bids
here, and one that looks for `sevenColumns` finds zero too. Both were tried.

**The fixture rule.** `fixtures/bigriver-2121.html` is a real captured page. An earlier
session reconstructed a fixture from assumptions and 54 tests passed against a fiction.
Never test this parser against a page you wrote yourself.

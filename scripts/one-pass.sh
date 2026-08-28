#!/usr/bin/env bash
# ONE PASS OF THE READER: read every source, commit if anything moved, tell the
# two Emmert sites.
#
# WHY THIS IS A SCRIPT AND NOT THREE WORKFLOW STEPS ANY MORE -- 2026-08-26.
#
# It was three steps, and three steps can only happen once per workflow run.
# That was fine while a cron fired every ten minutes. It does not, and the
# measurement is not close: on 2026-08-26 the ten-minute cron in the trading
# window delivered 3, 2, 1 and 1 run against six asked per hour, while the
# HOURLY cron outside the window delivered every single one. Same repository,
# same day. GitHub's scheduler is best effort and it is far better at a low
# frequency than a high one.
#
# So the shape changed: take the one hourly fire that does arrive, and read
# repeatedly inside it. That needs the whole pass callable in a loop, which
# means it has to be one thing. Everything below is moved VERBATIM from the
# steps it replaces, comments included, because those comments are the record
# of why each line is the way it is.
#
# Exit non-zero if the pass failed. The caller decides what to do about it.
set -euo pipefail

echo "── pass starting $(date -u +%H:%M:%SZ)"

# ---- READ EVERY ENABLED SOURCE -------------------------------------------
# poll.mjs SUPERSEDES fetch.mjs. Both write data/boyceville.json, so only one
# may ever be scheduled -- two writers on one artefact has bitten this system
# three times.
#
# NO SOURCE NEEDS A KEY TODAY. The only platform with a credential -- DTN
# Content Services -- is read through a BROWSER, on the customer's own page,
# because DTN answered a direct call with "The api key is valid, but it is
# valid to be used within a browser only". Their page carries their key in the
# clear, as it must for a browser widget to work, so we hold none.
node scripts/poll.mjs

# ---- COMMIT IF THE PRICE MOVED, AND REBAKE THE DASHBOARD ------------------
git config user.name  "agsist-bot"
git config user.email "bot@agsist.com"
# EVERY SOURCE'S FILE, NOT ONE HARDCODED PATH.
# This said `git add data/boyceville.json`. With a second source that
# is a silent outage: poll.mjs writes data/<id>.json and
# data/index.json, the log says "3 ok, wrote 3", and only Boyceville
# ever reaches the repo. The dashboard reads index.json, so it would
# have gone stale while reporting everything healthy.
git add data/
git diff --cached --quiet && { echo "nothing moved"; exit 0; }

# THE DEEP FETCH HAPPENS HERE, NOT AT CHECKOUT.
#
# The dashboard's basis chart is drawn from this repo's git history,
# so baking it needs the full log. But checkout runs on every poll --
# about 1,650 a month -- while a commit happens only on a price
# change or a six-hourly heartbeat, a few dozen times a month. Doing
# the unshallow here means the expensive clone is paid on the runs
# that need it and no others.
git fetch --deepen=1000 --quiet || true

# THE DASHBOARD MUST NEVER BLOCK THE PRICE.
#
# This block runs under `bash -e`. A non-zero bake used to abort the
# step before `git commit`, and because the runner is ephemeral the
# price fetch.mjs had already written to the working tree was thrown
# away with it. Worse, a deterministic bake failure -- one bad
# basisDollars anywhere in the history the chart reads -- fails every
# subsequent poll identically, so `checkedAt` freezes and fourteen
# hours later both Emmert sites drop to "Call for today's price".
# Over a chart.
#
# READ-ME-FIRST calls the dashboard optional and deletable. This makes
# the workflow agree with that.
# status.mjs SUPERSEDES dashboard.mjs -- both write index.html.
if node scripts/status.mjs; then
  git add index.html
else
  echo "::warning::dashboard bake failed; committing the price without it"
fi

# THE DIRECTORY, REBUILT EVERY PASS THAT COMMITS.
# data/directory.json is what map.html draws: who we know about, where they
# are, and why the ones with no pin have no pin. It is pure local computation
# over files already in the checkout -- no network, milliseconds -- so it costs
# nothing to keep exact. Same fail-open rule as the dashboard: a map that
# cannot be rebuilt must never stop a price reaching the repo.
if node scripts/build_directory.mjs; then
  git add data/directory.json
else
  echo "::warning::directory bake failed; committing the price without it"
fi
# The message carries the front month, so `git log --oneline` reads
# as a price history rather than a list of identical commits, and a
# heartbeat says so instead of impersonating a price change.
# Written by poll.mjs via lib/decide.mjs.
# PUSH, THEN REBASE AND PUSH AGAIN IF SOMEBODY GOT THERE FIRST.
# This used to be a bare `git push` and that was fine while one run existed at
# a time. The hourly run now loops, so a hand-fired run and a scheduled one can
# be minutes apart, and a rejected push would have thrown away a price that was
# already read and written.
#
# It lived here as six lines, and the two workflows that needed it most never
# got them — the registries run of 2026-08-28 lost 581 businesses to exactly
# this. It is scripts/commit-and-push.sh now, so there is one copy to fix.
bash "$(dirname "$0")/commit-and-push.sh" .commit-message

# ---- TELL THE TWO SITES, INSTEAD OF LEAVING THEM TO ASK ------------------
set -u
# A WAY TO PROVE THE TOKEN WORKS WITHOUT WAITING FOR THE MARKET.
# Without this the only test is a real price move, which may be an
# hour away and which fails at the moment you are not watching. Run
# the workflow by hand with ping_sites ticked and the answer is
# immediate: both sites rebuild, or this step goes red and says why.
# EVERY RUN, NOT ONLY WHEN THE PRICE MOVED.
#
# This used to exit here unless boyceville had changed, and that was
# right while the page showed one fact. It now shows two: "as of
# 1:40pm" is when THEIR board moved, and "checked 4:49pm" is that
# somebody is still looking. The second one is the answer to Sig's
# question on 2026-08-20 -- at five o'clock nineteen of the twenty
# boards in this feed still read 1:40pm, correctly, because futures
# settle at 1:20pm Central and cash boards freeze after it.
#
# A "checked" stamp is only worth printing if it moves, and the sites
# only rebuild when they are told to. So they are told every run, and
# the rebuild is timed to the scrape rather than to the price. THAT
# COSTS A COMMIT AND A PAGES DEPLOY PER RUN on each site, which is
# the trade Sig chose knowingly: "if we are scraping the data i want
# it timed with the scraper".
#
# The payload still says whether the price actually moved, so the
# run log on the other side can tell the two kinds of rebuild apart.
FORCE="${PING_SITES:-false}"      # was ${{ inputs.ping_sites }} inline; a script reads the environment
MOVED=false
grep -qx boyceville .changed-sources 2>/dev/null && MOVED=true

if [ -z "${TOKEN:-}" ]; then
  echo "::error title=EMMERT_DISPATCH_TOKEN is not set::neither site was told. Add a fine-grained token with Contents: write on           midwestagsupply/badgergrain and midwestagsupply/midwestcommodity as the repository           secret EMMERT_DISPATCH_TOKEN. Until then both sites wait for their own cron."
  exit 1
fi

[ "$FORCE" = "true" ] && echo "ping_sites was ticked"
echo "boyceville moved this run: $MOVED"
PRICED=$(node -e "process.stdout.write(require('./data/boyceville.json').pricedAt||'')" || true)
CHECKED=$(node -e "const i=require('./data/index.json');const s=(i.sources||[]).find(x=>x.id==='boyceville');process.stdout.write(s&&s.checkedAt||'')" || true)
fail=""
for repo in midwestagsupply/badgergrain midwestagsupply/midwestcommodity; do
  code=$(curl -sS -o /tmp/dispatch-resp -w '%{http_code}' -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$repo/dispatches" \
    -d "{\"event_type\":\"price-moved\",\"client_payload\":{\"source\":\"boyceville\",\"pricedAt\":\"$PRICED\",\"checkedAt\":\"$CHECKED\",\"moved\":$MOVED,\"from\":\"$GITHUB_REPOSITORY\",\"run\":\"$GITHUB_RUN_ID\"}}" ) || code=000
  if [ "$code" = "204" ]; then
    echo "told $repo (pricedAt $PRICED, checkedAt $CHECKED, moved $MOVED)"
  else
    echo "::error title=could not tell $repo::HTTP $code $(head -c 300 /tmp/dispatch-resp 2>/dev/null)"
    fail=1
  fi
done
[ -z "$fail" ] || exit 1

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

# THE SWITCH-OFF SCOREBOARD, EVERY RUN.
# Barchart goes off region by region on a measured figure, and a figure nobody
# publishes is a figure nobody acts on. It reads the directory this step just
# wrote, so it runs after it. It must never fail the pass: a coverage number is
# a report, and a report that can stop the prices going out has the priority
# backwards.
if node scripts/coverage.mjs; then
  git add data/coverage.json 2>/dev/null || true
else
  echo "::warning title=coverage::the coverage figure did not compute; prices are unaffected"
fi

# WHAT EACH BOARD'S OWN ROWS SAY ABOUT HOW IT ROUNDS, EVERY PASS THAT COMMITS.
#
# `cashRounding` is a claim about somebody else's spreadsheet, written on the
# day somebody looked, and until 2026-09-08 nothing ever went back to check it.
# Nine enabled sources were found declaring a mode their own committed capture
# refutes -- eight of them `floor-cent`, which is the claim that a residual is
# never negative, on boards carrying -0.25c rows. Nothing was red: a MINORITY of
# failing rows is classified `lagging`, the file publishes, and those rows carry
# a futures quote whose identity was never proven.
#
# The hard half of that rule is test/declared-rounding.test.mjs and runs on every
# push. This is the soft half: siblings of one operator, reading ONE board on ONE
# platform, that declare DIFFERENT modes. That is a question and not a verdict --
# a co-op can genuinely run two site configurations -- so it is a worklist row.
#
# It runs here because this is the job that rewrites the captures it measures,
# and it costs 0.13s over 814 of them. Same fail-open rule as the three blocks
# above: a worklist must never stop a price reaching the repo.
if node scripts/rounding_audit.mjs --write; then
  # The residual store too. It is what makes the verdict stable: one capture
  # measures the day, not the board, and four of the nine manifests corrected
  # from a single capture on the morning of 2026-09-08 were refuted again by
  # the evening from captures this same loop had rewritten.
  git add data/gaps/rounding-disagreement.csv data/rounding-residuals.json 2>/dev/null || true
else
  echo "::warning title=rounding::the rounding worklist did not build; prices are unaffected"
fi
# THE MERGED FEED, REBUILT EVERY PASS THAT COMMITS — AND HERE IS WHY IT MOVED.
#
# It was built four times a weekday in barchart.yml, alongside the Barchart
# fetch that needs a schedule because it costs API calls. But the merge needs
# nothing: it reads data/*.json, geocodes/places.json and data/barchart.json off
# the checkout and writes an index and its shards. No network, about a second.
#
# Leaving it on the fetch's clock meant the one file AGSIST reads was HOURS
# BEHIND the boards feeding it, all day. This job refreshes 336 boards every ten
# minutes; a consumer reading a four-times-a-day merge of them is reading a
# stale copy of data that is sitting right there, correct, in the same
# repository. That is the worst kind of staleness because nothing is broken.
#
# Cost, measured before moving it: the index is about 2.3 MB at 2,500 places and
# deltas to 19 KB per commit once packed — 1.1 MB a day at this cadence. A shard
# is only rewritten when its own bids change, which is the same reason 356 board
# files are affordable here.
#
# SAME FAIL-OPEN RULE as the dashboard and the directory above: a merge that
# cannot be rebuilt must never stop a price reaching the repo.
if node scripts/merge_bids.mjs; then
  # EVERY FILE THE MERGE WRITES, NOT JUST THE ONES IT USED TO WRITE.
  # merge_bids.mjs gained data/merged-all.json on 2026-09-22 and this line did
  # not, so the poll built the bulk file every ten minutes and threw it away:
  # raw.githubusercontent.com served a 404, and agsist's merge -- the whole
  # point of the file -- fell back to Barchart only on every run, silently,
  # because it is written to degrade rather than fail. The writer and the
  # thing that stages the writer's output are two places; both change together.
  # test/merged-all.test.mjs now asserts this line names the file.
  git add data/merged-index.json data/merged data/merged-all.json
else
  echo "::warning::merge failed; committing the prices without refreshing the feed"
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
#
# EXIT 3 WHEN THIS FAILS, NOT 1. 2026-09-20: scripts/pass-with-retries.sh
# retries a pass that failed to READ and does not retry one that read
# everything and then could not push, because reading 1,094 boards again cannot
# fix a refusal in this repository. Before this line said which was which, every
# rebase conflict cost three full re-reads and a 33-minute red run.
bash "$(dirname "$0")/commit-and-push.sh" .commit-message || exit 3

# ---- AND THAT IS THE PASS -----------------------------------------------
#
# IT USED TO TELL THE TWO EMMERT SITES, AND IT NO LONGER DOES. 2026-09-21.
#
# Everything from here to the end of the file was a repository_dispatch of
# `price-moved` into midwestagsupply/badgergrain and midwestagsupply/
# midwestcommodity, on every pass, so their pages would reprint their "checked"
# stamp with the scrape rather than on their own cron.
#
# That job moved out of this repository. midwestagsupply/emmertadmin reads Big
# River's board for those sites now, and since 2026-09-20 it also checks each
# page's published stamp and tells whichever one has fallen behind. Two callers
# doing the same thing meant every pass here started a build on both sites --
# twelve site runs an hour on top of their own schedules -- and neither half
# counted the other.
#
# Sig, 2026-09-21: "bids has nothing to do with feeding the emmert site anything
# at all. they have their own scrapers and so forth."
#
# So this repository reads their board as one of its own 1,094 elevators and
# publishes it in the feed, and that is all. data/boyceville.json is still
# written, still committed, and still there for anything that wants to read it;
# nothing is pushed at anybody.
#
# What went with it: the EMMERT_DISPATCH_TOKEN secret is no longer used here,
# the `ping_sites` input on poll.yml and watchdog.yml is gone, and a pass can no
# longer end in the "published, but the sites were not told" state that
# scripts/pass-with-retries.sh called exit 4.
echo "── pass done $(date -u +%H:%M:%SZ)"

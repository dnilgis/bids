#!/usr/bin/env bash
# ONE PASS OF THE READER, RETRIED ONLY WHEN A RETRY CAN HELP, AND ONLY WHEN IT
# FITS.
#
#   bash scripts/pass-with-retries.sh <label> <seconds this caller can spend>
#
# Exit: 0 the pass published
#       1 reading failed on every attempt that fitted
#       3 the pass read the boards but the push was refused
#       4 the pass published, but the Emmert sites were not told
#
# WHY THIS FILE EXISTS, 2026-09-20.
#
# The same three-attempt loop was written out three times -- the read job and
# the backup job in poll.yml, and the watchdog -- and all three had the same two
# faults, which between them turned every failed pass into a 33-minute red run.
#
# 1. THE ATTEMPTS DID NOT FIT THEIR OWN CEILINGS. Three attempts of `timeout 8m`
#    is 24 minutes of attempts. The read job's ceiling is 20, the backup's and
#    the watchdog's are 12. So the last attempt could never finish, GitHub
#    killed the job instead, and a job killed by its ceiling runs none of its
#    remaining steps. The backup job's email and its "Say so, out loud" issue
#    come after its recovery step: on every one of the ~20 red runs a day since
#    09-07 the backup was killed at 12m0s first, so neither ever fired. Measured
#    from the run pages: read 15m18s-19m21s, then backup 12m14s-12m17s,
#    "The job has exceeded the maximum execution time of 12m0s", every time.
#
# 2. EVERY FAILURE WAS TREATED AS A FAILED READ. A pass reads 1,094 boards in
#    about six minutes (median 6.6 minutes start to commit over 174 passes,
#    09-19 to 09-20), then commits and pushes. When the PUSH was refused -- a
#    rebase conflict, which is deterministic -- the loop threw the committed
#    work away and read all 1,094 boards again, to hit the same conflict again.
#    Every red run in the two days to 09-20 was that: "rebase failed", three
#    times, then the ceiling. Re-reading other people's boards cannot fix a
#    conflict in our own repository.
#
# So this asks two questions before every attempt: did the last one fail in a
# way another attempt can fix, and is there time for a whole one. A read failure
# (a hang, a network fault) is retried, immediately the first time. A publish
# failure is not. And an attempt that cannot finish inside the caller's budget
# is not started, so the caller always gets its remaining steps back.
set -uo pipefail

label="${1:-pass}"
available="${2:?seconds available is required}"
PASS_TIMEOUT="${PASS_TIMEOUT:-480}"   # 8 minutes: a pass measures 6.5 to 7.3
SLACK="${PASS_SLACK:-30}"             # what `timeout` and a clean exit need
here="$(cd "$(dirname "$0")" && pwd)"

deadline=$(( $(date +%s) + available ))
rc=1
for attempt in 1 2 3; do
  left=$(( deadline - $(date +%s) ))
  if [ "$left" -lt $(( PASS_TIMEOUT + SLACK )) ]; then
    if [ "$attempt" -eq 1 ]; then
      echo "::error title=$label not started::${left}s available and a pass is allowed ${PASS_TIMEOUT}s; the caller's budget is too small to read at all"
    else
      echo "::warning title=$label attempt $attempt not started::${left}s left and a pass is allowed ${PASS_TIMEOUT}s; stopping here so the steps after this one still run"
    fi
    break
  fi

  timeout "${PASS_TIMEOUT}s" bash "$here/one-pass.sh"
  rc=$?

  case "$rc" in
    0)
      [ "$attempt" -gt 1 ] && echo "$label recovered on attempt $attempt"
      exit 0 ;;
    3)
      echo "::error title=$label published nothing::the boards were read, but the push was refused. Not retried: reading 1,094 boards again cannot fix a refusal in this repository. commit-and-push.sh said why, in the annotation above this one."
      exit 3 ;;
    4)
      echo "::error title=$label published, sites not told::the prices are on the remote; the dispatch to the Emmert sites failed. Not retried: the price is already out, and emmertadmin and the sites' own crons also cover this."
      exit 4 ;;
    124)
      echo "::warning title=$label attempt $attempt timed out::killed at ${PASS_TIMEOUT}s" ;;
    *)
      echo "::warning title=$label attempt $attempt failed::exit $rc" ;;
  esac

  if [ "$attempt" -lt 3 ]; then
    # IMMEDIATELY on the first retry. That is the whole point of it.
    back=$(( (attempt - 1) * 20 ))
    [ "$back" -gt 0 ] && sleep "$back"
  fi
done

exit 1

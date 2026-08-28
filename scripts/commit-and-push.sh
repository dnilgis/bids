#!/usr/bin/env bash
# Commit whatever is staged and get it onto the remote, even when somebody
# pushed first.
#
# WHY THIS IS A FILE AND NOT SIX LINES IN A WORKFLOW
#
# It was six lines in one-pass.sh, and the two workflows that needed it most
# never got them. The registries run of 2026-08-28 read all 251 Iowa dealers,
# all 102 warehouses, geocoded 481 addresses over 171 seconds, committed 581
# businesses — and then:
#
#     ! [rejected]  main -> main (fetch first)
#     ##[error]Process completed with exit code 1
#
# The bid poller had pushed during the seven minutes the job was running. It
# does that every ten minutes through the trading day. Everything the run
# learned died on the runner, and the only sign was a red tick on a workflow
# whose own summary said it had succeeded.
#
# A single retry is not enough either: the poller can push again during the
# rebase. It tries a few times, with a wait, and fails loudly if it truly
# cannot land.
#
# Usage:  git add <paths...>;  scripts/commit-and-push.sh "the message"
#         git add <paths...>;  scripts/commit-and-push.sh .commit-message
# An argument naming an existing file is used as the message FILE, so a
# multi-line message keeps its exact bytes. Exits 0 with no commit when nothing
# is staged.
set -uo pipefail

msg="${1:?commit message required}"
tries="${PUSH_TRIES:-4}"

git config user.name  "${GIT_AUTHOR_NAME:-agsist-bot}"
git config user.email "${GIT_AUTHOR_EMAIL:-bot@agsist.com}"

if git diff --cached --quiet; then
  echo "nothing staged; no commit"
  exit 0
fi

if [ -f "$msg" ]; then
  git commit -F "$msg" || { echo "::error::commit failed"; exit 1; }
else
  git commit -m "$msg" || { echo "::error::commit failed"; exit 1; }
fi

for i in $(seq 1 "$tries"); do
  if git push; then
    [ "$i" -gt 1 ] && echo "pushed on attempt $i"
    exit 0
  fi
  echo "::warning title=push was rejected::somebody pushed first (attempt $i of $tries); rebasing"
  # --autostash so an unstaged file left by a later step cannot block the rebase.
  if ! git pull --rebase --autostash; then
    git rebase --abort 2>/dev/null || true
    echo "::error title=rebase failed::the work is committed locally and NOT on the remote"
    exit 1
  fi
  sleep $(( i * 5 ))
done

echo "::error title=could not push after $tries attempts::the work is committed locally and NOT on the remote"
exit 1

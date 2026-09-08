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

# A REGENERATED FILE HAS NO MERGE, ONLY A LATEST — 2026-09-07.
#
# The registries run of 23:19 read twelve state rolls, surveyed sixty-seven
# pages and geocoded 894 addresses. Thirty-six minutes. The barchart job pushed
# while it worked; both jobs run build_directory.mjs; the rebase below hit
#
#     CONFLICT (content): Merge conflict in data/directory.json
#
# and every record of that run died on the runner.
#
# The two paragraphs above this one are the same lesson twice — a rejected push
# in August, an untracked file in August — and both were fixed. Neither covered
# a CONTENT conflict, because until two workflows regenerated the same derived
# file there had never been one to cover.
#
# .gitattributes names the paths the pipeline rewrites wholesale and marks them
# `merge=generated`. This is the driver behind that name, and it is installed
# HERE rather than committed in a config file because a merge driver is a
# per-clone setting that .gitattributes cannot carry: a fresh checkout that
# names a driver git does not know silently falls back to the ordinary
# three-way merge, which is exactly the failure. Installing it in the script
# that does the rebasing is the one place it cannot be forgotten.
#
# `cp %B %A` takes the version being replayed — during a rebase git calls the
# upstream side "ours" (%A, the file to write) and the commit being applied
# "theirs" (%B), which reads backwards and is why this line has a test:
# test/commit-and-push.test.py drives a real rebase and asserts which bytes
# survive. WHAT IT COSTS is stated in .gitattributes and is real: the other
# job's contribution to that derived file is dropped until something rebuilds
# it from its own committed inputs. Those inputs are not in the list.
git config merge.generated.name "a file the pipeline regenerates; keep the replayed run's build"
git config merge.generated.driver "cp %B %A"

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
  #
  # AUTOSTASH DOES NOT COVER UNTRACKED FILES, and that lost a run.
  # 2026-08-28: a job untracked two stale files with `git rm --cached`, which
  # left them sitting in the working tree. The remote had those same paths.
  # The rebase refused before it started --
  #     error: The following untracked working tree files would be overwritten
  #     by checkout: data/gaps/no-board-published.csv
  # -- and thirty minutes of work across twenty runners was committed locally
  # and never pushed. autostash stashes tracked modifications; an untracked
  # file is invisible to it.
  #
  # So untracked files are stashed explicitly first and restored after. Nothing
  # is deleted: a job that meant to leave a file behind still gets it back.
  UNTRACKED_STASHED=0
  if [ -n "$(git ls-files --others --exclude-standard)" ]; then
    if git stash push --include-untracked --quiet -m "commit-and-push untracked"; then
      UNTRACKED_STASHED=1
      echo "stashed untracked files so the rebase can check out"
    fi
  fi
  if ! git pull --rebase --autostash; then
    # SAY WHICH FILES. The 2026-09-07 loss printed "the work is committed
    # locally and NOT on the remote" and one stray line of git's own output;
    # working out that data/directory.json was the file, and that two jobs
    # regenerate it, took reading the whole log. A conflict that survives the
    # generated-file driver above is a real disagreement and the next person
    # needs its name.
    conflicts="$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
    [ -n "$conflicts" ] &&
      echo "::error title=conflicting files::$conflicts -- these are NOT declared generated in .gitattributes, so this is a real disagreement, not a rebuild"
    [ "$UNTRACKED_STASHED" = "1" ] && git stash pop --quiet 2>/dev/null || true
    git rebase --abort 2>/dev/null || true
    echo "::error title=rebase failed::the work is committed locally and NOT on the remote"
    exit 1
  fi
  # The rebase worked; put the untracked files back. `|| true` because a file
  # the rebase itself introduced makes the pop conflict, and by then the pop no
  # longer matters -- the remote's copy is the one we want.
  [ "$UNTRACKED_STASHED" = "1" ] && { git stash pop --quiet 2>/dev/null || git stash drop --quiet 2>/dev/null || true; }
  sleep $(( i * 5 ))
done

echo "::error title=could not push after $tries attempts::the work is committed locally and NOT on the remote"
exit 1

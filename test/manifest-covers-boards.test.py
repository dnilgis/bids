#!/usr/bin/env python3
"""EVERY BOARD WE FETCHED MUST REACH THE FEED, OR SOMETHING MUST GO RED.

WHAT HAPPENED (measured 2026-09-13, on the live tree)

    data/index.json            666 rows
    enabled sources            935
    board files on disk        920
    merge dropped, reason "board file with no entry in index.json"   286
    bid rows in those boards   3,340
    bid rows the feed published 6,923

Another 48% of the feed had been fetched from other people's servers, parsed,
validated and committed to git, and was thrown away at merge time.

Nothing was broken in a way anybody could see. poll.mjs has a six-minute wall;
sources it does not reach are skipped with `continue` and never become results,
and the manifest was `results.map(...)` — so an unreached source vanished from
the file rather than being marked. merge_bids then drops any board with no
manifest row. Both halves logged what they did. Neither said the two numbers
were the same 266 sources, and `dropped` counted it correctly in a nested
object nobody reads.

    THE COUNT EXISTED. NOTHING ACTED ON IT.

That is what this file is for. poll.mjs now carries an unreached source's last
row forward — and rebuilds one from its board file if it has already fallen
out — so the feed leaves on AGE, which is the policy, rather than on which
sources a given six minutes happened to fit.

This guard is the thing that notices if that ever regresses. It reads the
committed tree only: no network, no fetch, under a second.

    python3 test/manifest-covers-boards.test.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# A pass that misses a handful is normal — a source added since the last poll
# has no board yet, and a board written between the poll and the merge has no
# row yet. 286 is not a handful. The ceiling is deliberately low: this reason
# means the poller and the merger disagree about the source list, and that is
# always a bug, never a data condition.
CEILING = 20
REASON = ("board file with no entry in index.json — the poller did not "
          "reach this source and its bids are being dropped")
# The other half of the split. A retired source leaving its last board behind
# is correct and is counted apart, so this guard cannot be tripped by tidiness.
RETIRED_REASON = "leftover board file from a retired or disabled source"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


def main():
    idx_p = ROOT / "data" / "index.json"
    mi_p = ROOT / "data" / "merged-index.json"
    if not idx_p.exists() or not mi_p.exists():
        # A tree the fetch has never run in. See test/prefetch-guards.test.py:
        # a guard that cannot run must say so, not pass quietly.
        print("no data/index.json or data/merged-index.json — nothing fetched in this tree")
        return 0

    idx = json.loads(idx_p.read_text())
    mi = json.loads(mi_p.read_text())
    man = {s["id"] for s in idx.get("sources", []) if s.get("id")}

    enabled = set()
    for p in (ROOT / "sources").glob("*.json"):
        try:
            d = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if d.get("enabled") and d.get("inMerge") is not False and not d.get("retired"):
            enabled.add(d["id"])

    boards = {p.stem for p in (ROOT / "data").glob("*.json")}
    orphans = sorted(b for b in boards if b in enabled and b not in man)

    print("manifest rows %d | enabled sources %d | boards on disk %d"
          % (len(man), len(enabled), len(boards & enabled)))
    check(len(orphans) <= CEILING,
          "%d enabled sources have a board file and NO manifest row (ceiling %d). "
          "Their bids are fetched and then dropped at merge. e.g. %s"
          % (len(orphans), CEILING, ", ".join(orphans[:5])))

    # And the merge's own tally must agree — if it ever stops reporting this
    # reason the check above has nothing to stand on.
    dropped = (mi.get("dropped") or {}).get("scrape") or {}
    n = dropped.get(REASON, 0)
    print("merge dropped for %r: %d" % (REASON, n))
    check(n <= CEILING,
          "the merge dropped %d rows under %r (ceiling %d) — the poller and the "
          "merger disagree about which sources exist" % (n, REASON, CEILING))

    # The reason string is the join between the two halves. If it is renamed,
    # this guard silently stops watching anything.
    merge_src = (ROOT / "scripts" / "merge_bids.mjs").read_text()
    for r in (REASON, RETIRED_REASON):
        check(r.split(" — ")[0] in merge_src,
              "merge_bids.mjs no longer emits %r — this guard is watching a "
              "string that does not exist and would pass for ever" % r[:60])
    print("merge dropped as retired leftovers: %d (correct, not counted above)"
          % dropped.get(RETIRED_REASON, 0))

    # The carry-forward itself, by name: without it an unreached source falls
    # out of the manifest again on the very next wall.
    poll_src = (ROOT / "scripts" / "poll.mjs").read_text()
    # THE CALL, NOT THE DEFINITION. Checking only that the function exists
    # passes a tree where somebody removed the call and left the body behind —
    # which is exactly the mutation this was written to catch, and it survived
    # the first version of this check.
    check("sources: withCarried(" in poll_src,
          "poll.mjs builds the manifest without withCarried() — an unreached "
          "source falls out of the file again on the next six-minute wall")
    check("carriedFrom" in poll_src,
          "poll.mjs no longer rebuilds a manifest row from a board file, so a "
          "source already out of the manifest can never climb back in")

    if fails:
        for f in fails:
            print("FAIL: %s" % f)
        return 1
    print("every fetched board reaches the merge")
    return 0


if __name__ == "__main__":
    sys.exit(main())

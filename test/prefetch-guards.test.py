#!/usr/bin/env python3
"""
A GUARD THAT RUNS BEFORE THE FETCH MUST NOT NEED WHAT THE FETCH WRITES.

THE LATCH — 2026-09-07.

.github/workflows/registries.yml runs its python guards in a step called "Test
the readers this run is about to use", deliberately BEFORE the fetch, with a
paragraph explaining why: a regression should be caught before an hour of
geocoding is spent on data it would mangle. That is right and it stays.

But one of those guards read `data/registries.json` — the fetch's own output —
and required more than 1500 records in it. On 2026-09-07 at 20:46 a
`--states WI` run narrowed that file to 210. The guard went red. The step is
`bash -e`. So the fetch step was SKIPPED, and the fetch is the only thing that
could have put the other eleven states back.

Run 91957xxx at 22:42 is the proof: exit 1 in the guard step,
`steps.fetch.outcome == skipped`, and every step below it carrying `if:
always()` cheerfully re-committed the same 210 records and printed a report
about them. The pipeline could not repair itself, and nothing said so — the job
just failed in a place that looked like an ordinary test failure.

THE RULE, AND WHY IT IS RUN AND NOT GREPPED.

The property is not "no guard mentions registries.json" — a comment saying so
is fine, and this file is full of them. The property is that EVERY PRE-FETCH
GUARD STILL PASSES WITH THE FETCH'S OUTPUTS ABSENT. That is exactly the state
of a first checkout, and it is exactly the state a latch cannot survive.

So this runs them, for real, against a repository whose `data/registries.json`
and `data/registry-survey.json` are not there. A guard that needs them fails
here, loudly, at the moment somebody writes it — not four weeks later when a
narrowed harvest bolts the door.

    python3 test/prefetch-guards.test.py

No network.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "registries.yml")

# What the fetch step writes. A pre-fetch guard may not depend on any of it.
FETCH_OUTPUTS = ["data/registries.json", "data/registry-survey.json"]

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


def prefetch_commands(text):
    """Every `python test/...` line that runs above the step whose id is fetch.

    Read off the workflow rather than listed here, so a guard added to that
    step is covered the day it is added and a guard moved below the fetch stops
    being covered — which is the correct answer for a guard moved below the
    fetch."""
    m = re.search(r"^\s*id:\s*fetch\s*$", text, re.M)
    if not m:
        return None
    above = text[:m.start()]
    return re.findall(r"^\s*python3?\s+(test/\S+\.py)\s*$", above, re.M)


def main():
    text = open(WORKFLOW).read()
    cmds = prefetch_commands(text)
    check(cmds is not None, "registries.yml still has a step with `id: fetch`")
    if cmds is None:
        return 1
    check(len(cmds) >= 4, "the pre-fetch step still runs the python guards", "%d" % len(cmds))
    print("    pre-fetch guards: " + ", ".join(os.path.basename(c) for c in cmds))

    # A REPOSITORY WITHOUT THE FETCH'S OUTPUTS, built out of symlinks so this
    # costs nothing and cannot touch the real tree. `data/` is the one real
    # directory, holding links to everything in it EXCEPT what the fetch writes.
    print("\nevery pre-fetch guard passes with the fetch's outputs absent")
    tmp = tempfile.mkdtemp(prefix="prefetch-")
    try:
        withheld = set(os.path.basename(p) for p in FETCH_OUTPUTS)
        for entry in os.listdir(ROOT):
            if entry == "data":
                continue
            os.symlink(os.path.join(ROOT, entry), os.path.join(tmp, entry))
        os.mkdir(os.path.join(tmp, "data"))
        for entry in os.listdir(os.path.join(ROOT, "data")):
            if entry in withheld:
                continue
            os.symlink(os.path.join(ROOT, "data", entry), os.path.join(tmp, "data", entry))

        for p in FETCH_OUTPUTS:
            check(not os.path.exists(os.path.join(tmp, p)),
                  "%s is genuinely missing from the stand-in tree" % p)

        for cmd in cmds:
            if os.path.basename(cmd) == os.path.basename(__file__):
                continue          # this file is the rule, not a subject of it
            r = subprocess.run([sys.executable, os.path.join(tmp, cmd)],
                               capture_output=True, text=True, cwd=tmp)
            tail = (r.stdout or r.stderr or "").strip().splitlines()
            check(r.returncode == 0, "%s survives a tree the fetch has never run in"
                  % os.path.basename(cmd),
                  "exit %d — %s" % (r.returncode, (tail[-1] if tail else "")[:110]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nand the workflow still puts them before the fetch")
    # The ordering itself, which is the other half of the rule. If the guards
    # ever move BELOW the fetch, this file has nothing left to say and should
    # be deleted rather than quietly passing on an empty list.
    check(bool(cmds), "there is at least one guard above the fetch to check")

    print("")
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("pre-fetch guards: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
THE PUSH THAT LOST THIRTY-SIX MINUTES.

2026-09-07 23:40, registries run. Twelve state rolls, sixty-seven candidate
pages surveyed, 894 addresses geocoded, 2,111 businesses committed — and:

    ! [rejected]        main -> main (fetch first)
    somebody pushed first (attempt 1 of 4); rebasing
    Auto-merging data/directory.json
    CONFLICT (content): Merge conflict in data/directory.json
    ##[error]the work is committed locally and NOT on the remote

The barchart job had pushed during those thirty-six minutes. Both run
build_directory.mjs, both rewrite data/directory.json in full, and three-way
merging two independently regenerated JSON files conflicts every time.

.gitattributes now marks the regenerated paths `merge=generated` and
commit-and-push.sh installs the driver. Everything here DRIVES A REAL REBASE in
a throwaway repository and reads the bytes that came out, because the direction
of a merge driver's %A and %B inverts under rebase and no amount of reading the
manual is evidence about what git actually wrote.

    python3 test/commit-and-push.test.py

No network.
"""
import os
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SCRIPT = ROOT / "scripts" / "commit-and-push.sh"

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


ENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
           GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t",
           GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null")


def git(cwd, *a, check_rc=True):
    r = subprocess.run(("git",) + a, cwd=cwd, env=ENV, capture_output=True, text=True)
    if check_rc and r.returncode != 0:
        raise RuntimeError("git %s -> %s\n%s%s" % (" ".join(a), r.returncode, r.stdout, r.stderr))
    return r


def build_race(tmp, path, mine, theirs, attributes=True):
    """A bare remote, two clones, and a push that lost the race.

    `theirs` is already on the remote. `mine` is committed locally and staged
    for the push that will be rejected. Returns the working clone."""
    bare = os.path.join(tmp, "origin.git")
    git(tmp, "init", "--bare", "-q", "-b", "main", bare)

    seed = os.path.join(tmp, "seed")
    git(tmp, "clone", "-q", bare, seed)
    git(seed, "checkout", "-q", "-b", "main")
    if attributes:
        shutil.copy(ROOT / ".gitattributes", os.path.join(seed, ".gitattributes"))
    os.makedirs(os.path.join(seed, os.path.dirname(path)), exist_ok=True)
    Path(seed, path).write_text("base\n")
    os.makedirs(os.path.join(seed, "scripts"), exist_ok=True)
    shutil.copy(SCRIPT, os.path.join(seed, "scripts", "commit-and-push.sh"))
    git(seed, "add", "-A")
    git(seed, "commit", "-qm", "seed")
    git(seed, "push", "-q", "origin", "main")

    # Somebody else pushes first.
    other = os.path.join(tmp, "other")
    git(tmp, "clone", "-q", bare, other)
    Path(other, path).write_text(theirs)
    git(other, "add", "-A")
    git(other, "commit", "-qm", "theirs")
    git(other, "push", "-q", "origin", "main")

    # Our run finishes and stages its own rebuild.
    Path(seed, path).write_text(mine)
    git(seed, "add", "-A")
    return seed


def run_script(repo, msg="mine"):
    return subprocess.run(["bash", "scripts/commit-and-push.sh", msg],
                          cwd=repo, env=ENV, capture_output=True, text=True)


def main():
    print("a regenerated file: the run's own build survives and the push lands")
    tmp = tempfile.mkdtemp(prefix="cap-")
    try:
        repo = build_race(tmp, "data/directory.json",
                          mine='{"elevators":4696}\n', theirs='{"elevators":850}\n')
        r = run_script(repo)
        check(r.returncode == 0, "the push lands despite the conflict",
              (r.stdout + r.stderr).strip().splitlines()[-1][:120] if (r.stdout + r.stderr).strip() else "")
        got = Path(repo, "data/directory.json").read_text()
        check(got == '{"elevators":4696}\n',
              "and the surviving bytes are THIS run's build, not the other job's",
              repr(got))
        check("<<<<<<<" not in got and ">>>>>>>" not in got,
              "with no conflict markers written into a file the pipeline reads")
        # And it really is on the remote, which is the whole point.
        out = git(repo, "log", "--oneline", "origin/main", "-1").stdout
        check("mine" in out, "the remote has it", out.strip())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nthe same race on a HAND-EDITED file still stops and asks")
    tmp = tempfile.mkdtemp(prefix="cap-")
    try:
        # sources/ is deliberately not in .gitattributes: two jobs disagreeing
        # about one manifest is a real disagreement.
        repo = build_race(tmp, "sources/boyceville.json",
                          mine='{"lat":45.1}\n', theirs='{"lat":44.9}\n')
        r = run_script(repo)
        out = r.stdout + r.stderr
        check(r.returncode != 0, "it refuses rather than silently picking a side")
        # OUR ANNOTATION, NOT GIT'S OWN OUTPUT. Asserting the bare filename
        # passed even with the annotation deleted, because git prints
        # "sources/boyceville.json: needs merge" by itself — and that line is
        # not a GitHub annotation, so it does not surface anywhere a person
        # looking at a red tick will see it. That is precisely what happened on
        # 2026-09-07. Pin the annotation.
        check("::error title=conflicting files::" in out,
              "and raises a GitHub annotation naming them, which the 2026-09-07 "
              "log did not", out.strip()[-160:])
        line = next((l for l in out.splitlines()
                     if "::error title=conflicting files::" in l), "")
        check("sources/boyceville.json" in line,
              "and the file is named IN that annotation", line[:160])
        check("real disagreement" in line, "and it says why that file is different")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nwithout .gitattributes the driver does nothing — the file is what names it")
    tmp = tempfile.mkdtemp(prefix="cap-")
    try:
        repo = build_race(tmp, "data/directory.json",
                          mine='{"elevators":4696}\n', theirs='{"elevators":850}\n',
                          attributes=False)
        r = run_script(repo)
        check(r.returncode != 0,
              "a repository with no .gitattributes gets the old behaviour, "
              "so the attributes file is doing the work and not a coincidence")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nthe script installs the driver, and before it rebases")
    src = SCRIPT.read_text()
    drv = src.find("merge.generated.driver")
    reb = src.find("git pull --rebase")
    check(drv > 0, "commit-and-push.sh configures merge.generated.driver")
    check(reb > 0, "and still rebases")
    check(drv < reb, "and configures it BEFORE the rebase, or the rebase sees no driver")
    # THE CONFIG LINE, NOT THE STRING ANYWHERE IN THE FILE. First written as
    # `"cp %B %A" in src`, which the paragraph ABOVE the config line satisfies
    # on its own — so a mutation that broke the driver and left the comment
    # intact went unnoticed. A guard that a comment can satisfy is a guard that
    # tests the comment.
    import re as _re
    check(_re.search(r'^git config merge\.generated\.driver "cp %B %A"$', src, _re.M) is not None,
          "%B is the commit being replayed under rebase — asserted by the real "
          "rebase above, not by the manual, and pinned to the config line itself")

    print("\n.gitattributes covers what two workflows both regenerate")
    attrs = (ROOT / ".gitattributes").read_text()
    for p in ("data/*.json", "geocodes/*.json", "data/gaps/*"):
        check(p in attrs and "merge=generated" in attrs.split(p)[1].split("\n")[0],
              "%s is declared generated" % p)
    check("sources/" not in [l.split()[0] for l in attrs.splitlines()
                             if l.strip() and not l.startswith("#")],
          "and sources/ is NOT — a manifest conflict is a real one")

    print("")
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("commit and push: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
THE SMOKE ALARM FOR THE 2026-09-07 DELETION.

`--states WI` rewrote data/registries.json from its filtered result and took
eleven states with it: 173,521 deletions in one commit. merge_with_committed()
stops that at the source and test/registry-merge.test.py proves it against
fixtures. scripts/registries_not_shrunk.py is the second line — it compares the
file this run produced against the one git already holds and refuses the commit
if the count went backwards.

Everything here calls the SHIPPED functions. A test that retypes the comparison
tests the retyping.

    python3 test/registries-not-shrunk.test.py

No network. No git required — `verdict` is pure.
"""
import os
import subprocess
import sys
import tempfile
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "scripts"))

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


def doc(n):
    return {"businesses": [{"name": "B%d" % i} for i in range(n)]}


def main():
    import registries_not_shrunk as S

    print("the verdict, on the numbers that actually occurred")
    # The real event: 1939 records committed, a WI-only run producing 210.
    ok, msg = S.verdict(doc(1939), doc(210), "['WI']")
    check(not ok, "a run that drops 1939 to 210 is refused")
    check("1729 of 1939" in msg, "and it says how many records would go", msg[:90])

    ok, _ = S.verdict(doc(1939), doc(1939), None)
    check(ok, "an unchanged count is fine")
    ok, _ = S.verdict(doc(210), doc(1939), None)
    check(ok, "and a run that ADDS records is obviously fine")
    ok, _ = S.verdict(doc(1939), doc(1938), None)
    check(not ok, "one record short is still short — there is no slack here")

    print("\nand the cases that are not failures")
    ok, msg = S.verdict(None, doc(210), None)
    check(ok, "no committed copy at all is a first run, not a deletion")
    ok, msg = S.verdict(doc(1939), None, None)
    check(ok, "no file written is the fetch's problem, reported by the fetch")
    ok, _ = S.verdict({}, {}, None)
    check(ok, "two empty documents do not deceive it")
    ok, _ = S.verdict(doc(5), {"counts": {"businesses": 900}}, None)
    check(not ok,
          "it counts the RECORDS, never the `counts` header — a header is a claim "
          "and this is the check that the claim is true")

    print("\nthe script runs, and its exit code is the verdict")
    # END TO END, in a throwaway git repo, because the comparison is against
    # `git show HEAD:` and a pure-function test never touches that path.
    tmp = tempfile.mkdtemp(prefix="shrunk-")
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    run = lambda *a, **k: subprocess.run(a, cwd=tmp, env=env, capture_output=True, text=True, **k)
    run("git", "init", "-q")
    os.makedirs(os.path.join(tmp, "data"))
    p = os.path.join(tmp, "data", "registries.json")
    Path(p).write_text(json.dumps(doc(1939)))
    run("git", "add", "-A"); run("git", "commit", "-qm", "first")

    script = str(ROOT / "scripts" / "registries_not_shrunk.py")
    r = run(sys.executable, script)
    check(r.returncode == 0, "unchanged file: exit 0", r.stdout.strip()[:90])

    Path(p).write_text(json.dumps(doc(2500)))
    r = run(sys.executable, script)
    check(r.returncode == 0, "a bigger file: exit 0", r.stdout.strip()[:90])

    Path(p).write_text(json.dumps(doc(210)))
    r = run(sys.executable, script)
    check(r.returncode == 1, "the WI-only shape: exit 1", r.stdout.strip()[:90])
    check("::error::" in r.stdout, "and it annotates the run, not just the log")

    os.remove(p)
    r = run(sys.executable, script)
    check(r.returncode == 0, "a missing file is not this step's failure",
          r.stdout.strip()[:90])

    print("\nthe workflow calls the script rather than carrying its own copy")
    wf = (ROOT / ".github" / "workflows" / "registries.yml").read_text()
    check("python scripts/registries_not_shrunk.py" in wf,
          "registries.yml invokes the shipped script")
    step = wf[wf.index("- name: Did this run take records away"):][:400]
    check("<<'PY'" not in step,
          "and does NOT inline the comparison — an inline heredoc is a copy no "
          "test can reach, which is how this repository gets two answers")

    print("")
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("registries not shrunk: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

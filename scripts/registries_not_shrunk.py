#!/usr/bin/env python3
"""
DID THIS RUN TAKE RECORDS AWAY?

On 2026-09-07 at 20:46 a `--states WI` run rewrote data/registries.json from
its filtered result:

    [main 6fb1f95] registries: 210 businesses, plus the state survey
     5 files changed, 40628 insertions(+), 173521 deletions(-)

Eleven states in one commit. Nothing caught it, because every guard in this
repository asked whether a SOURCE came back short and none asked whether the
FILE did.

`merge_with_committed()` in fetch_registries.py is the fix and it is tested
against fixtures. This is the check that the fix is WORKING, on the real file,
on every run — the difference between a unit test and a smoke alarm.

WHERE IT RUNS, AND WHY THAT IS THE WHOLE POINT. After the fetch, before the
commit. Above the fetch it would be reading the fetch's own output before the
fetch had run, which is the latch that cost 2026-09-07: a guard requiring 1500
records in that file went red at 210, the pre-fetch step is `bash -e`, and the
fetch — the only thing that could restore it — was skipped from then on. See
test/prefetch-guards.test.py.

Exit 0 when the file grew, held, or there is nothing to compare against.
Exit 1 when it shrank, which blocks the commit and leaves the good file on main.

    python3 scripts/registries_not_shrunk.py [path]

No network.
"""
import json
import subprocess
import sys
from pathlib import Path

PATH = "data/registries.json"


def committed(path=PATH, ref="HEAD"):
    """The version git already holds, or None when there is not one.

    None is not a failure: a first run, a new file, or a checkout with no
    history all land here and all of them mean "nothing was taken away"."""
    try:
        out = subprocess.run(["git", "show", "%s:%s" % (ref, path)],
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out)
    except Exception:
        return None


def count(doc):
    return len(((doc or {}).get("businesses")) or [])


def verdict(before, after, asked=None):
    """(ok, message). `before` is None when there is nothing to compare to."""
    if after is None:
        return True, "no file was written; nothing to compare"
    n = count(after)
    if before is None:
        return True, "no committed copy to compare against — first run (%d records)" % n
    b = count(before)
    head = "committed %d -> this run %d   (states asked: %s)" % (b, n, asked)
    if n >= b:
        return True, head + "\nnothing was taken away"
    return False, head + (
        "\n::error::this run would DELETE %d of %d records. A partial run must MERGE "
        "with the committed file, not replace it — see merge_with_committed() in "
        "scripts/fetch_registries.py. Refusing to commit; the good file stays on main."
        % (b - n, b))


def main(argv):
    path = argv[1] if len(argv) > 1 else PATH
    p = Path(path)
    after = json.loads(p.read_text()) if p.exists() else None
    asked = ((after or {}).get("counts") or {}).get("statesAsked")
    ok, msg = verdict(committed(path), after, asked)
    print(msg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

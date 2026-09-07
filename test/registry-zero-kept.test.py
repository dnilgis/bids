#!/usr/bin/env python3
"""
A SOURCE THAT KEPT NOTHING, AND THE SUMMARY THAT SAID NOTHING WAS WRONG.

`INCOMPLETE` was only ever set when a document published its own total and the
parse fell short of it. So a source that fetched NOTHING AT ALL sailed past it,
and data/registries.json shipped

    "incompleteSources": []

while Wisconsin contributed zero records. Not once: the runs of 2026-09-06 at
02:18 and at 07:43 both recorded {"state": "WI", "errors": ["URLError:
<urlopen error timed out>"], "kept": 0}, and both summaries were clean.

Zero is the loudest signal a source can give and it was the one shape the
summary could not see.

    python3 test/registry-zero-kept.test.py
"""
import importlib.util
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fr", ROOT / "scripts" / "fetch_registries.py")
fr = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(fr)
except SystemExit:
    pass

fails = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  -- " + detail) if detail and not cond else ""))
    if not cond:
        fails.append(name)


def offline():
    """Every network call times out, exactly as the runner saw Wisconsin."""
    def boom(*a, **k):
        raise TimeoutError("timed out")
    fr.urllib.request.urlopen = boom
    urllib.request.urlopen = boom


print("A SOURCE THAT KEPT NOTHING IS INCOMPLETE")
offline()

# --- the snapshot -----------------------------------------------------------
wi = next(s for s in fr.SOURCES if s["state"] == "WI")
check("Wisconsin names a committed snapshot", bool(wi.get("snapshot")))
check("and the snapshot is in the repository", (ROOT / wi["snapshot"]).exists(), wi.get("snapshot", ""))

diag = {}
recs = fr.fetch_file(wi, 1, diag, None)
check("a dead server does not cost the state its roster", len(recs) == 210, "got %d" % len(recs))
check("the run records which file it fell back to",
      (diag.get("usedSnapshot") or {}).get("path") == wi["snapshot"])
check("the live error is kept, not swallowed by the fallback",
      any("timed out" in e for e in diag.get("errors") or []))

# THE FALLBACK MUST NOT MAKE THE RUN LOOK GREEN. This is the whole objection to
# a committed copy, so it is the assertion that matters most here.
check("a run on the snapshot is still INCOMPLETE", bool(diag.get("INCOMPLETE")))
check("and says so in words a person can act on",
      "snapshot" in str(diag.get("INCOMPLETE", "")) and "live fetch failed" in str(diag.get("INCOMPLETE", "")))

# --- and a source with no snapshot still fails -------------------------------
tx = next(s for s in fr.SOURCES if s["state"] == "TX")
d2 = {}
r2 = fr.fetch_file(tx, 1, d2, None)
check("a source with no snapshot recovers nothing", r2 == [])
check("and its error is recorded", any("timed out" in e for e in d2.get("errors") or []))

# --- the summary the bug lived in -------------------------------------------
# THE SHIPPED FUNCTION, NOT A COPY OF IT. The first version of this file
# reimplemented the rule here to test it, so deleting the real one in
# fetch_registries.py left every assertion below green. Measured: the mutation
# `if not recs and not diag.get("INCOMPLETE"):` -> `if False:` was NOT CAUGHT.
summarise = fr.mark_incomplete_if_empty

silent = summarise([], {"errors": ["URLError: <urlopen error timed out>"], "state": "WI"})
check("kept 0 with an error is INCOMPLETE", bool(silent.get("INCOMPLETE")))
check("and the error is what it reports", "timed out" in silent["INCOMPLETE"])

quiet = summarise([], {"state": "XX"})
check("kept 0 with NO error is INCOMPLETE too", bool(quiet.get("INCOMPLETE")),
      "a source that returns nothing and raises nothing is the worst case, not the safe one")

good = summarise([{"name": "somebody"}], {"state": "XX"})
check("a source that kept records is left alone", not good.get("INCOMPLETE"))

# --- and main() has to actually call it -------------------------------------
# The rule being right is half of it. A named function nobody calls is the same
# bug with better documentation, and no test here can run main() -- it would go
# to the network for sixteen states -- so this reads the source, the way
# test/workflows.test.mjs does for the probe version.
src_text = (ROOT / "scripts" / "fetch_registries.py").read_text()
# THE CALL, NOT THE DEFINITION. `"mark_incomplete_if_empty(recs, diag)" in
# src_text` was true with the call deleted, because the `def` line contains the
# same substring — so the check passed on a file where nothing called it.
# Measured: deleting the call was NOT CAUGHT.
import re as _re
check("main() calls mark_incomplete_if_empty on every source",
      _re.search(r"^\s+mark_incomplete_if_empty\(recs, diag\)", src_text, _re.M) is not None,
      "a guard nobody calls is the same bug with better documentation")

# --- the source table's own claims ------------------------------------------
for state in ("ILLINOIS", "KANSAS", "MINNESOTA"):
    check("the three biggest holes are documented: %s" % state, state in src_text)
check("Illinois is recorded as closed to robots, not as unreachable",
      "robots.txt disallows it" in src_text)

print()
if fails:
    print("FAILED: %d" % len(fails))
    for f in fails:
        print("   " + f)
    sys.exit(1)
print("all checks passed")

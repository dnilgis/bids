#!/usr/bin/env python3
"""--states MUST UPDATE PART OF THE FILE, NOT NARROW IT.

2026-09-07 20:46. `--states "WI"` rewrote data/registries.json from Wisconsin
alone and the commit read

    5 files changed, 40628 insertions(+), 173521 deletions(-)

Eleven states' licence rolls left the repository in that one commit, and every
guard in fetch_registries.py stayed green, because they all ask whether a
SOURCE came back short and none of them asks whether the FILE did.

These call the shipped functions. Nothing is reimplemented here: the merge
under test is the one main() runs.
"""
import importlib.util
import json
import pathlib
import re
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "scripts" / "fetch_registries.py"
spec = importlib.util.spec_from_file_location("fr", SRC)
fr = importlib.util.module_from_spec(spec)
sys.modules["fr"] = fr
spec.loader.exec_module(fr)

fails = []


def ok(cond, label):
    print("  %s   %s" % ("ok " if cond else "FAIL", label))
    if not cond:
        fails.append(label)


def committed(businesses, diagnostics=None):
    """A committed file on disk, the way main() would have left one."""
    fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"businesses": businesses, "diagnostics": diagnostics or []}, fh)
    fh.close()
    return fh.name


WI_ROLL = [
    {"name": "A Wisconsin elevator", "state": "WI", "source": "registry-wi"},
    {"name": "Pilgrim's Pride Corporation", "state": "CO", "source": "registry-wi"},
    {"name": "A Minnesota licensee of Wisconsin", "state": "MN", "source": "registry-wi"},
]
IA_ROLL = [
    {"name": "An Iowa elevator", "state": "IA", "source": "registry-ia"},
]

print("\nthe roll a record came off, not the state it sits in")
ok(fr.source_state({"source": "registry-wi"}) == "WI", "registry-wi is Wisconsin")
ok(fr.source_state({"source": "registry-wi", "state": "CO"}) == "WI",
   "a Colorado business off the Wisconsin roll is still Wisconsin's row")
ok(fr.source_state({"source": "barchart"}) is None, "a non-registry source is not a state")
ok(fr.source_state({}) is None, "no source at all is not a state")
ok(fr.source_state(None) is None, "and None does not throw")

print("\na run that asks for one state keeps the states it did not ask for")
path = committed(WI_ROLL + IA_ROLL)
fresh = [{"name": "A fresh Iowa elevator", "state": "IA", "source": "registry-ia"}]
out, diags, carried = fr.merge_with_committed(fresh, [], {"IA"}, path)
ok(carried == 3, "the three Wisconsin-roll records are carried (got %d)" % carried)
ok(len(out) == 4, "and the file is 4 records, not 1 (got %d)" % len(out))
names = {e["name"] for e in out}
ok("Pilgrim's Pride Corporation" in names,
   "THE COLORADO BUSINESS OFF THE WISCONSIN ROLL SURVIVES AN IOWA RUN")
ok("A Minnesota licensee of Wisconsin" in names,
   "so does the Minnesota one — merging on `state` would have dropped both")
ok("A fresh Iowa elevator" in names, "and the fresh Iowa record is there")
ok("An Iowa elevator" not in names, "while the stale Iowa record is gone, having been re-asked")

print("\na run that asks for a state replaces that state, and only that state")
out, diags, carried = fr.merge_with_committed(
    [{"name": "A new Wisconsin elevator", "state": "WI", "source": "registry-wi"}],
    [], {"WI"}, path)
ok(carried == 1, "only the Iowa record is carried (got %d)" % carried)
ok({e["name"] for e in out} == {"A new Wisconsin elevator", "An Iowa elevator"},
   "all three old Wisconsin-roll records are replaced by the fresh answer")

print("\na run over every state is authoritative and merges nothing")
out, diags, carried = fr.merge_with_committed(fresh, [], set(), path)
ok(carried == 0, "nothing carried (got %d)" % carried)
ok(out == fresh, "and the run's own answer is the whole file")

print("\nno committed file is not a crash, and not a silent merge either")
out, diags, carried = fr.merge_with_committed(fresh, [], {"IA"}, "/nonexistent/registries.json")
ok(carried == 0 and out == fresh, "a missing file carries nothing")
bad = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
bad.write("{ this is not json")
bad.close()
out, diags, carried = fr.merge_with_committed(fresh, [], {"IA"}, bad.name)
ok(carried == 0 and out == fresh, "an unreadable file carries nothing and does not throw")

print("\ndiagnostics follow the same rule as the records")
path2 = committed(WI_ROLL, [{"state": "WI", "url": "u1", "kept": 210},
                            {"state": "IA", "url": "u2", "kept": 853}])
out, diags, carried = fr.merge_with_committed([], [{"state": "WI", "url": "u1b"}], {"WI"}, path2)
states = [d.get("state") for d in diags]
ok(states.count("IA") == 1, "the Iowa diagnostic is carried")
ok(states.count("WI") == 1, "and the stale Wisconsin one is replaced, not duplicated")

print("\nthe shipped main() calls it, on the line that writes the file")
text = SRC.read_text()
ok(re.search(r"^\s+out, diags, carried = merge_with_committed\(out, diags, want, OUT\)",
             text, re.M) is not None,
   "main() merges before it counts — a `def` line alone would not satisfy this")
ok('"statesAsked": sorted(want) if want else "all"' in text,
   "and the file records which states the run actually asked")
ok('"carriedFromCommitted": carried' in text,
   "and how many records it carried, so a narrowed file can never look like a full one")

print("\nregistry merge: %s" % ("all passed" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)

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

print("\na run over every state where every state answered is authoritative and merges nothing")
out, diags, carried = fr.merge_with_committed(fresh, [], set(), path)
ok(carried == 0, "nothing carried (got %d)" % carried)
ok(out == fresh, "and the run's own answer is the whole file")

print("\na state whose every source kept 0 on an all-states run keeps its committed rows (SD, 2026-11-05/06)")
SD_ROLL = [{"name": "A South Dakota elevator %d" % i, "state": "SD", "source": "registry-sd"} for i in range(3)]
path3 = committed(WI_ROLL + SD_ROLL)
sd_diag = fr.mark_incomplete_if_empty([], {"state": "SD", "url": "sd.pdf", "errors": ["TimeoutError: timed out"]})
wi_diag = {"state": "WI", "url": "u1", "kept": 3}
out, diags, carried = fr.merge_with_committed(WI_ROLL, [wi_diag, sd_diag], set(), path3)
ok(carried == 3, "the three committed South Dakota rows are carried (got %d)" % carried)
ok(sum(1 for b in out if fr.source_state(b) == "SD") == 3 and sum(1 for b in out if fr.source_state(b) == "WI") == 3,
   "South Dakota is back and Wisconsin is not doubled")
ok(sd_diag.get("INCOMPLETE", "").startswith("kept 0 records") and sd_diag.get("carriedFromCommitted") == 3,
   "the source stays flagged INCOMPLETE and says how many rows it carried")
ok("carriedFromCommitted" not in wi_diag, "a state that answered carries nothing")
# a state with two sources where one kept records answered: nothing carried
two = [fr.mark_incomplete_if_empty([], {"state": "SD", "url": "a", "errors": ["timed out"]}), {"state": "SD", "url": "b", "kept": 5}]
out, diags, carried = fr.merge_with_committed(WI_ROLL, two, set(), path3)
ok(carried == 0, "one South Dakota source answering means South Dakota answered (carried %d)" % carried)
# a source short of its own published total (not kept 0) is not carried: the run's partial answer stands, flagged
short = {"state": "SD", "url": "sd.pdf", "INCOMPLETE": "parsed 25 of 251"}
out, diags, carried = fr.merge_with_committed(WI_ROLL, [short], set(), path3)
ok(carried == 0, "a short source is flagged, not carried")
ok(fr.failed_states([sd_diag, wi_diag]) == {"SD"}, "failed_states names only the state that kept nothing")
# a document that states its own total and parsed 0 is "kept 0" too (fetch_registries.py: "the document says N and this parse found 0")
total0 = {"state": "SD", "url": "sd.pdf", "kept": 0, "INCOMPLETE": "the document says 358 and this parse found 0"}
out, diags, carried = fr.merge_with_committed(WI_ROLL, [wi_diag, total0], set(), path3)
ok(carried == 3, "a stated total with nothing parsed is carried too (got %d)" % carried)
# a --states SD run that times out keeps South Dakota as well
sd_diag2 = fr.mark_incomplete_if_empty([], {"state": "SD", "url": "sd.pdf", "errors": ["TimeoutError: timed out"]})
out, diags, carried = fr.merge_with_committed([], [sd_diag2], {"SD"}, path3)
ok(sum(1 for b in out if fr.source_state(b) == "SD") == 3 and sum(1 for b in out if fr.source_state(b) == "WI") == 3,
   "a timed-out --states SD keeps South Dakota's rows and carries the rest")
ok(sd_diag2.get("carriedFromCommitted") == 3, "and its diagnostic says so")
# a --states SD run that answers replaces South Dakota, as before
fresh_sd = [{"name": "New SD", "state": "SD", "source": "registry-sd"}]
out, diags, carried = fr.merge_with_committed(fresh_sd, [{"state": "SD", "url": "sd.pdf", "kept": 1}], {"SD"}, path3)
ok(sum(1 for b in out if fr.source_state(b) == "SD") == 1, "an answering --states SD replaces the old South Dakota rows")

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

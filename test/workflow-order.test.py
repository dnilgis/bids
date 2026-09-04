#!/usr/bin/env python3
"""A TEST STEP MUST NOT NEED A PACKAGE A LATER STEP INSTALLS.

registries.yml runs its guards, then fetches, then installs `zipcodes` for the
step that places the records. One of those guards —
test/geocode-precision.test.py — imports scripts/build_geocodes.py, which exits
2 with "FATAL: pip install zipcodes" when the package is missing. The guard
step is `bash -e`, so it stopped there and THE FETCH STEP NEVER RAN.

Three runs in a row went that way: 91926780177, 91931213387 and 91935391548.
Each reported "1939 businesses, 8 states scraped" and I read it as a baseline
every time, because every step after the fetch carries `if: always()` and
describes the committed file whether or not the run touched it. Texas and
Wisconsin sat in the source table for two of those runs and were never fetched.

Two rules, and the second matters more than the first:

  1. Every package a step's scripts import must be installed by an EARLIER
     step.
  2. A step that reports on committed data must say when the step that
     produces it did not run.

    python test/workflow-order.test.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF = ROOT / ".github" / "workflows"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


# What each script needs, measured by reading its imports rather than listed
# here — a hand-kept list is the thing that goes stale.
def third_party_imports(path):
    if not path.exists():
        return set()
    src = path.read_text(errors="replace")
    found = set()
    for m in re.finditer(r"^\s*(?:import|from)\s+([a-zA-Z_][\w]*)", src, re.M):
        found.add(m.group(1))
    stdlib = {
        "re", "sys", "os", "io", "json", "csv", "time", "math", "urllib", "http",
        "pathlib", "argparse", "collections", "itertools", "functools", "typing",
        "datetime", "subprocess", "shutil", "tempfile", "threading", "socketserver",
        "importlib", "unicodedata", "string", "textwrap", "hashlib", "base64",
        "warnings", "traceback", "random", "difflib", "decimal", "statistics",
        "html", "xml", "zipfile", "gzip", "sqlite3", "copy", "glob", "operator",
        "contextlib", "dataclasses", "enum", "abc", "types", "struct", "binascii",
    }
    return {f for f in found if f not in stdlib and not f.startswith("_")}


def steps_of(text):
    """(name, run-body) in file order."""
    out = []
    for m in re.finditer(r"^      - name: (.+?)$(.*?)(?=^      - |\Z)", text, re.M | re.S):
        out.append((m.group(1).strip(), m.group(2)))
    return out


for wf in sorted(WF.glob("*.yml")):
    text = wf.read_text()
    installed = set()
    for name, body in steps_of(text):
        for m in re.finditer(r"pip install[^\n]*", body):
            for word in re.findall(r"[A-Za-z][\w.-]+", m.group(0)):
                if word not in ("pip", "install", "quiet", "run", "break", "system",
                                "packages", "upgrade", "python", "m", "no", "cache", "dir"):
                    installed.add(word)
        # Which repository scripts does this step run?
        for m in re.finditer(r"python3?\s+(scripts/[\w./-]+\.py|test/[\w./-]+\.py)", body):
            script = ROOT / m.group(1)
            needs = third_party_imports(script)
            # A test that imports a repository script inherits its needs.
            for m2 in re.finditer(r'spec_from_file_location\([^,]+,\s*[^"\']*["\']?([\w/.]+\.py)',
                                  script.read_text(errors="replace") if script.exists() else ""):
                needs |= third_party_imports(ROOT / m2.group(1))
            if script.name == "geocode-precision.test.py":
                needs |= third_party_imports(ROOT / "scripts" / "build_geocodes.py")
            for pkg in sorted(needs - installed):
                # Only complain about packages this workflow installs SOMEWHERE
                # — anything else is either preinstalled or a genuine miss the
                # runner would report the same way on day one.
                if re.search(r"pip install[^\n]*\b%s\b" % re.escape(pkg), text):
                    fails.append(
                        "%s: step %r runs %s, which needs %r — and %r is not installed "
                        "until a LATER step. This is exactly how three runs skipped the fetch."
                        % (wf.name, name, m.group(1), pkg, pkg))

# ── and the reports must not pass off committed data as this run's ────────
reg = (WF / "registries.yml").read_text()
# THE STEP ITSELF, NOT ANY MENTION OF IT. A first cut checked that the strings
# "id: fetch" and "steps.fetch.outcome" appeared somewhere in the file, and
# both survived deletion — the id because my edit had written it twice, and the
# outcome because the comment above the check quotes it. Sixth time today.
check(re.search(r"- name: Fetch the state registries\s*\n\s*id: fetch\b", reg),
      "the fetch step has no id, so nothing downstream can ask whether it ran")
check(reg.count("id: fetch") == 1,
      "id: fetch appears %d times — a duplicate key is a step with no id at all"
      % reg.count("id: fetch"))
check(re.search(r'if \[ "\$\{\{ steps\.fetch\.outcome \}\}" != "success" \]', reg),
      "no step BRANCHES on whether the fetch ran — every report below it carries "
      "if: always() and will describe the committed file regardless")
check("THE FETCH DID NOT RUN" in reg,
      "a skipped fetch produces a report that reads exactly like a successful one")

if fails:
    for f in fails:
        print("FAIL: %s" % f)
    sys.exit(1)
print("workflow order: no step needs a package a later step installs; a skipped fetch says so")

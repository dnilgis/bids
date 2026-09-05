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


# ══════════════════════════════════════════════════════════════════════════
#  RULE 3: THE HARVEST IS FIRST, AND NOTHING ABOVE IT CAN SPEND ITS BUDGET
# ══════════════════════════════════════════════════════════════════════════
#
# Run 25, 2026-09-04. Every step green until:
#
#     Survey what the other states publish     19m 15s
#     Install the PDF and spreadsheet readers      1s
#     Test the readers this run is about to use    2s
#     Fetch the state registries                  51s
#     Error: The operation was canceled.
#
# The job's ceiling was 20 minutes. A DISCOVERY step spent 19 of them and the
# runner killed the harvest 51 seconds in. Nothing failed; nothing was even
# red until the very end. That is the fifth distinct way "the fetch did not
# run" has happened in this workflow, and the only one where the fetch was
# correct, installed, guarded, and simply not given the time.
#
# The survey had grown from 10 candidates to 51, each with up to three
# attempts and a slow retry, and no bound of any kind.
#
# Two invariants, and the arithmetic is done here rather than trusted.
import yaml  # noqa: E402

# AND EVERY WORKFLOW THAT RUNS THIS FILE MUST INSTALL WHAT THIS FILE IMPORTS.
#
# The import above is the fifth time a guard in this repository has needed a
# package no step installed. schedule-guard.yml went red with "No module named
# 'yaml'" on 2026-08-31; test.yml went red with zipcodes on 2026-09-01, in the
# very file added to stop guards from never running; and registries.yml carries
# a pypdf install for the same reason. The pattern is always the same — the
# guard is written on a machine that already has the package.
#
# So the guard checks the line itself, for every workflow that runs it.
# COMMENTS ARE NOT INVOCATIONS EITHER. The first cut of this matched the bare
# string and immediately accused registries.yml, whose only mention of this
# file is the comment explaining what it checks. Strip the comments first, so
# the question asked is "does a step RUN it", not "is it spoken of".
def _uncommented(text):
    return "\n".join(l for l in text.splitlines()
                     if not l.lstrip().startswith("#"))


for _wf in sorted(WF.glob("*.yml")):
    _t = _uncommented(_wf.read_text())
    if "test/*.test.py" not in _t and "workflow-order.test.py" not in _t:
        continue
    check(re.search(r"run:\s*pip install[^\n]*\bpyyaml\b", _t, re.I),
          "%s runs this guard and installs no pyyaml — it imports yaml to read "
          "registries.yml and will die on the runner with ModuleNotFoundError"
          % _wf.name)

_JOB = yaml.safe_load((WF / "registries.yml").read_text())["jobs"]["fetch"]
_STEPS = _JOB["steps"]
_NAMES = [s.get("name", "") for s in _STEPS]


def _at(fragment):
    for i, n in enumerate(_NAMES):
        if fragment in n:
            return i
    return None


_fetch = _at("Fetch the state registries")
_survey = _at("Survey what the other states publish")
_guards = _at("Test the readers")

check(_fetch is not None and _survey is not None,
      "the fetch or the survey step has been renamed and this guard is now "
      "measuring nothing: %s" % _NAMES)

if _fetch is not None and _survey is not None:
    check(_fetch < _survey,
          "the survey runs BEFORE the fetch (positions %d and %d). It is "
          "discovery; the fetch is the point of the workflow. On run 25 the "
          "survey took 19m 15s of a 20-minute job and the harvest was "
          "cancelled at 51 seconds." % (_survey, _fetch))

if _guards is not None and _fetch is not None:
    check(_guards < _fetch,
          "the readers are no longer tested before they are used")

# EVERY LONG STEP HAS A CEILING. A step with no timeout-minutes inherits the
# job's, which means it can take the whole thing down with it — which is
# exactly what the survey did.
for _n in ("Fetch the state registries",
           "Survey what the other states publish",
           "Place them and rebuild the directory"):
    _i = _at(_n)
    if _i is None:
        check(False, "step '%s' is gone" % _n)
        continue
    check(isinstance(_STEPS[_i].get("timeout-minutes"), int),
          "step '%s' has no timeout-minutes of its own, so it inherits the "
          "job's and can spend all of it" % _n)

# AND THEY MUST FIT. A ceiling on each step means nothing if they add up to
# more than the job is allowed to run — the last step in the list would still
# be the one that gets cancelled, which is how this failed in the first place.
_job_cap = _JOB.get("timeout-minutes")
check(isinstance(_job_cap, int), "the job has no timeout-minutes at all")
if isinstance(_job_cap, int):
    _sum = sum(s.get("timeout-minutes", 0) for s in _STEPS)
    # checkout, setup-node, setup-python, pip, the guards and the commit are
    # the unbudgeted remainder; they measured well under three minutes on
    # run 25, and five is the allowance kept for them.
    check(_sum + 5 <= _job_cap,
          "the step budgets total %d minutes and the job allows %d — the last "
          "step to run is the one that gets cancelled, which is how the "
          "harvest was lost on run 25" % (_sum, _job_cap))


# ══════════════════════════════════════════════════════════════════════════
#  RULE 4: A STEP MUST BE ALLOWED MORE TIME THAN THE SCRIPT INSIDE IT SPENDS
# ══════════════════════════════════════════════════════════════════════════
#
# Run 26, 2026-09-05. The fetch worked — Texas 139, Wisconsin 210, 2,293
# businesses committed. Then:
#
#     ##[error]The action 'Place them and rebuild the directory the map reads'
#              has timed out after 5 minutes.
#
# Nothing written. No geocodes/places.json and no data/directory.json in the
# commit. 2,293 businesses landed in the data file and the map did not move —
# the exact outcome that step was added to prevent.
#
# build_geocodes.py budgets CENSUS_BUDGET_S = 420 seconds of Census lookups,
# and its own comment says why: "a slow morning at their end is 96 minutes,
# which is not a degraded build — it is a job killed by its own timeout with
# nothing written." Seven minutes of geocoding in a five-minute step.
#
# I had sized that 5 from run 25's measured 1m 26s — a run whose fetch was
# CANCELLED, so the step had no new addresses and never called the Census at
# all. Measuring a degraded run is not measuring.
#
# So the ceiling is READ OFF THE SCRIPT, for every workflow that runs it:
# barchart.yml and sync_known.yml run the same one under job ceilings of their
# own, and neither has a step budget, so the job's is what they get.
_GEO = (ROOT / "scripts" / "build_geocodes.py").read_text()
_m = re.search(r'CENSUS_BUDGET_S\s*=\s*float\(os\.environ\.get\(\s*"CENSUS_BUDGET_S"\s*,\s*"(\d+)"',
               _GEO)
check(_m is not None,
      "CENSUS_BUDGET_S is no longer readable from build_geocodes.py, so no "
      "workflow ceiling can be checked against it")

if _m:
    _budget_min = int(_m.group(1)) / 60.0
    for _wf in sorted(WF.glob("*.yml")):
        try:
            _d = yaml.safe_load(_wf.read_text())
        except Exception:
            continue
        for _jn, _j in (_d.get("jobs") or {}).items():
            for _st in _j.get("steps") or []:
                if "build_geocodes" not in str(_st.get("run", "")):
                    continue
                # an override in the step's own env changes the answer
                _env = {**(_d.get("env") or {}), **(_j.get("env") or {}),
                        **(_st.get("env") or {})}
                _b = float(_env.get("CENSUS_BUDGET_S", _m.group(1))) / 60.0
                _cap = _st.get("timeout-minutes") or _j.get("timeout-minutes")
                _name = _st.get("name") or "(unnamed)"
                check(_cap is not None,
                      "%s: step '%s' runs build_geocodes.py and neither it nor "
                      "its job has any ceiling at all" % (_wf.name, _name))
                if _cap is None:
                    continue
                # two minutes for pip, the ZIP shards and build_directory.mjs
                check(_cap >= _b + 2,
                      "%s: step '%s' is allowed %g minutes and build_geocodes.py "
                      "may spend %g of them on the Census alone. It will be "
                      "killed mid-geocode and write nothing — which is how run "
                      "26 committed 2,293 businesses and left the map unmoved."
                      % (_wf.name, _name, _cap, _b))

if fails:
    for f in fails:
        print("FAIL: %s" % f)
    sys.exit(1)
print("workflow order: the harvest runs first, inside a budget that fits; "
      "no step needs a package a later step installs; a skipped fetch says so")

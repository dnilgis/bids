#!/usr/bin/env python3
"""THE DENOMINATOR OF REGISTRIES, AND THE ARITHMETIC THAT HAS TO CLOSE.

Sig, repeatedly: "what about the rest of the elevators in the country". The
answer is a number, and the number is only honest if nothing in it is
hand-maintained prose that has drifted.

The National Agricultural Law Center's state compilation (read 2026-09-04)
says THIRTY states regulate grain warehouses. survey_registries.py splits
those thirty three ways -- harvested, has a candidate URL, nobody has found
the list yet -- and the three must add up to thirty with no state counted
twice and none missing.

That summary used to be a hand-typed sentence, and it had already gone wrong:
it named MN, SD, ND, OH, IN, AR and TX as "no candidate URL" when five of them
were either harvested or in the candidate list. A summary edited by hand is a
summary that lies. This is why it is derived, and this is what keeps it
derived.

    python test/registry-denominator.test.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "scripts" / "survey_registries.py").read_text()

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


def listed(name):
    m = re.search(name + r"\s*=\s*\[(.*?)\]", SRC, re.S)
    assert m, "%s is not defined in survey_registries.py" % name
    return [x for x in re.findall(r"\"([A-Z]{2})\"", m.group(1))]


HARVESTED = listed("HARVESTED")
NEEDS = listed("NEEDS_A_URL")
cand = re.search(r"^CANDIDATES = \[(.*?)^\]", SRC, re.S | re.M)
assert cand, "CANDIDATES is not defined"
CAND_STATES = sorted({s for s in re.findall(r"\(\"([A-Z]{2})\",", cand.group(1))} - {"US"})

# ── the three buckets are disjoint ────────────────────────────────────────
check(not (set(HARVESTED) & set(NEEDS)),
      "a state is both harvested and needing a URL: %s" % (set(HARVESTED) & set(NEEDS)))
check(not (set(NEEDS) & set(CAND_STATES)),
      "a state has a candidate URL and is also listed as needing one: %s"
      % (set(NEEDS) & set(CAND_STATES)))
check(not (set(HARVESTED) & set(CAND_STATES) - {"IA", "MO", "NE", "IL"}),
      "a harvested state reappears as an unharvested candidate: %s"
      % (set(HARVESTED) & set(CAND_STATES)))

# ── and together they are the thirty ──────────────────────────────────────
REGULATED = set(HARVESTED) | set(NEEDS) | set(CAND_STATES)
check(len(REGULATED) == 30,
      "the three buckets cover %d states, not the 30 that regulate grain "
      "warehouses: %s" % (len(REGULATED), " ".join(sorted(REGULATED))))

# ── the twenty that do not regulate must not appear as work ───────────────
# Michigan, California, New York and Pennsylvania have real elevators and no
# licence roll. Putting one of them on a registry worklist sends somebody to
# look for a document that does not exist.
UNREGULATED = set("AK AZ CA CT FL HI ME MD MA MI NV NH NJ NY NC PA RI UT VT VA".split())
check(not (REGULATED & UNREGULATED),
      "a state that does not regulate grain warehouses is on the worklist: %s"
      % (REGULATED & UNREGULATED))
check(len(UNREGULATED) == 20, "the unregulated list is %d, not 20" % len(UNREGULATED))

# ── every candidate carries a URL and how far it has been believed ────────
rows = re.findall(r'\(\"([A-Z]{2})\",\s*\"([^\"]+)\",\s*\"([^\"]+)\",\s*\"([^\"]+)\"\)',
                  cand.group(1))
check(len(rows) >= 20, "only %d candidates parsed" % len(rows))
for st, what, url, conf in rows:
    check(url.startswith("http"), "%s: %r is not a URL" % (st, url))
    check(len(conf) > 12, "%s %s: no note on how far this URL has been believed" % (st, url))

# A URL nobody has opened must SAY so. Every one of these was found by search
# from a sandbox that cannot reach the hosts, and a candidate that reads as
# confirmed when it is not is how a 404 becomes a missing state.
unopened = [c for _, _, _, c in rows if re.search(r"unopened|search result|search 20", c)]
check(unopened, "no candidate admits to being unopened, which cannot be true")

# ── the summary is derived, not typed ─────────────────────────────────────
check("MN WI SD ND OH IN MI TX OK CO MT WA AR KY TN MS NC SC PA NY" not in SRC,
      "the hand-typed state list is back; it was wrong about five states")
check("len(regulated)" in SRC, "the summary no longer derives its own count")

if fails:
    for f in fails:
        print("FAIL: %s" % f)
    sys.exit(1)
print("registry denominator: %d regulated — %d harvested, %d with a candidate URL, "
      "%d still to find" % (len(REGULATED), len(HARVESTED), len(CAND_STATES), len(NEEDS)))
print("ok")

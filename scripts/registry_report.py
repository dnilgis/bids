#!/usr/bin/env python3
"""
registry_report.py — the four questions that decide whether to write scraper two.

Sig asked for Iowa first and for the numbers before the other nineteen states.
These are those numbers, and none of them is a guess:

  1. how many of these do we already hold, matched by PHONE;
  2. how many place cleanly on the map as a town centroid;
  3. how many are plausibly a place a farmer can sell grain -- a HEURISTIC on
     the business name, labelled as one, never presented as a count;
  4. how much the grey population would actually grow.

Question 3 is the one that decides the project. A grain DEALER licence is held
by feed mills, ethanol plants, processors and farm operations as well as by
country elevators. If most of Iowa's 251 are not places a farmer can walk into,
then nineteen more scrapers buy a longer list and not a better map, and it is
worth knowing that before writing them.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / "data" / "registries.json"
KNOWN = ROOT / "data" / "known-elevators.json"
DIRECTORY = ROOT / "data" / "directory.json"

# Words that say "this is not a place you drive a load of corn to", and words
# that say it probably is. Both are hints, not evidence: a co-op can be called
# anything, and "Feed" appears in the name of plenty of real elevators.
NOT_AN_ELEVATOR = ("ethanol", "biodiesel", "renewable", "energy", "processing",
                   "processors", "soy processing", "wet mill", "pet food",
                   "pork", "beef", "cattle", "dairy", "hatchery", "trucking",
                   "transport", "logistics", "seed company", "farms", "farm llc")
LOOKS_LIKE_ONE = ("elevator", "grain", "coop", "co-op", "cooperative", "ag ",
                  " ag", "agri", "farmers", "feed & grain", "warehouse")


def digits(p):
    d = re.sub(r"\D", "", str(p or ""))
    return d[-10:] if len(d) >= 10 else ""


def main():
    if not REG.exists():
        print("no %s — run scripts/fetch_registries.py first" % REG.name)
        return 1
    reg = json.loads(REG.read_text())
    biz = reg.get("businesses") or []
    if not biz:
        print("the registry file holds no businesses")
        return 1

    only = (sys.argv[1].upper() if len(sys.argv) > 1 else "")
    if only:
        biz = [b for b in biz if (b.get("state") or "").upper() == only]
    states = {(b.get("state") or "").upper() for b in biz if b.get("state")}

    known = json.loads(KNOWN.read_text()).get("elevators", []) if KNOWN.exists() else []
    ours = json.loads(DIRECTORY.read_text()).get("elevators", []) if DIRECTORY.exists() else []

    have_phones = {digits(e.get("phone")) for e in known if digits(e.get("phone"))}
    have_phones |= {digits(e.get("phone")) for e in ours if digits(e.get("phone"))}
    town = lambda st, c: (st or "").upper() + "|" + re.sub(r"[^a-z]", "", (c or "").lower())
    have_towns = {town(e.get("state"), e.get("location") or e.get("city"))
                  for e in ours} | {town(e.get("state"), e.get("city")) for e in known}

    try:
        import zipcodes
        places = set()
        for z in zipcodes.list_all():
            if z.get("lat") is None or z.get("state") not in states:
                continue
            if abs(float(z["lat"])) < 0.001:
                continue
            for nm in [z.get("city")] + list(z.get("acceptable_cities") or []):
                places.add(re.sub(r"[^a-z]", "", (nm or "").lower()))
    except ImportError:
        places = None

    by_phone = sum(1 for b in biz if digits(b.get("phone")) and digits(b.get("phone")) in have_phones)
    in_known_town = sum(1 for b in biz if town(b.get("state"), b.get("city")) in have_towns)
    geocodable = (sum(1 for b in biz if re.sub(r"[^a-z]", "", (b.get("city") or "").lower()) in places)
                  if places is not None else None)

    def plausible(name):
        n = " " + (name or "").lower() + " "
        if any(w in n for w in NOT_AN_ELEVATOR):
            return False
        return any(w in n for w in LOOKS_LIKE_ONE)

    looks = [b for b in biz if plausible(b.get("name"))]
    excluded = [b for b in biz if not plausible(b.get("name"))]
    c = reg.get("counts", {})

    print("STATE REGISTRIES — %d businesses across %s" % (len(biz), ", ".join(sorted(states)) or "nowhere"))
    print("   by state %s | holding both licences %s | with a phone %s"
          % (json.dumps(c.get("byState", {})), c.get("both_licences"), c.get("with_phone")))
    print()
    print("1. already ours, matched by ten-digit phone : %d of %d  (%.0f%%)"
          % (by_phone, len(biz), 100 * by_phone / len(biz)))
    print("   in a town we already have something in   : %d  (weaker evidence, town is not identity)"
          % in_known_town)
    print("2. town resolves to a ZIP centroid          : %s"
          % ("%d of %d  (%.0f%%)" % (geocodable, len(biz), 100 * geocodable / len(biz))
             if geocodable is not None else "zipcodes not installed"))
    print("3. name looks like somewhere you can sell   : %d of %d  (%.0f%%)  -- HEURISTIC"
          % (len(looks), len(biz), 100 * len(looks) / len(biz)))
    print("   excluded by name, a sample:")
    for b in excluded[:8]:
        print("      %s" % b.get("name"))
    net = len(looks) - by_phone
    print("4. grey pins this would add, net of what we already hold: about %d" % max(0, net))
    print()
    print("   Twenty states at this rate would be roughly %d new elevators." % int(max(0, net) / max(1, len(states)) * 20))
    print("   Question 3 is a name heuristic and nothing more; the real test is whether")
    print("   a sample of them actually post a bid anywhere, which is the next measurement.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

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


# The fifty, for the one line that says which of them nothing has reached yet.
ALL_STATES = set(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO "
    "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split())


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
    # THE DIVISOR IS THE STATES WE ASKED, NOT THE STATE CODES THAT CAME BACK.
    # Missouri's list carries the licensee's head office, so eleven businesses
    # in it are registered in Arkansas, Illinois, Kansas, Louisiana, Minnesota,
    # Nebraska, Ohio, Pennsylvania, South Carolina, Texas and Wisconsin. Counting
    # those as states we have scraped turned two into thirteen and cut the
    # national estimate from roughly two thousand elevators to three hundred —
    # an argument for not bothering with the other twenty, built out of eleven
    # mailing addresses.
    scraped = {(d.get("state") or "").upper()
               for d in (reg.get("diagnostics") or []) if d.get("state")}
    if only:
        scraped &= {only}
    scraped = scraped or states

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
    # AND "NET" MEANS NETTED BY PHONE, WHICH ONE ROLL CANNOT ANSWER.
    # by_phone is the only thing subtracted above, and USDA's national roll
    # carries no phone column at all — 0 of its 4,613 records have one — so its
    # duplicates of what we already hold are all still in that figure. What
    # actually decides them is the state-town-operator key in
    # scripts/build_directory.mjs, and the answer is printed in
    # data/directory.json under counts.registryMergedByName. This file counts
    # licence rows; that one counts pins.
    print("   \"net\" here means netted by TEN-DIGIT PHONE and nothing else. The rows with")
    print("   no phone are netted by name and town in scripts/build_directory.mjs; read")
    print("   counts.registryMergedByName and registryMergedByPhone in data/directory.json.")
    print()
    # ── A NATIONAL ROLL IS NOT A STATE, AND IT ENDS THE EXTRAPOLATION ─────
    #
    # This printed "13 states scraped (…, WCMD, …), so about 351 net new each.
    # Twenty more at that rate would be roughly 7,027 new elevators." Both
    # figures were nonsense the day USDA's list landed. WCMD is ONE roll
    # covering 38 states, so dividing the whole harvest by thirteen understates
    # what a state roll adds, and then multiplying by "twenty more states"
    # counts states the national list has already covered.
    #
    # The estimate existed to answer "is it worth writing nineteen more
    # scrapers". That question is now largely answered by measurement rather
    # than by extrapolation, so what is printed is what was measured: what the
    # state rolls add between them, what the national roll adds, and which
    # states are still covered by nothing at all.
    NATIONAL = {"WCMD"}
    national_rolls = scraped & NATIONAL
    state_rolls = scraped - NATIONAL
    src_of = lambda b: (b.get("source") or "")[len("registry-"):].upper()
    nat_looks = [b for b in looks if src_of(b) in NATIONAL]
    nat_net = len(nat_looks)          # NOT netted: see the note above — no phones
    state_net = max(0, net - nat_net)
    per_state = state_net / max(1, len(state_rolls))
    print("   %d state roll%s scraped (%s), about %d net new each."
          % (len(state_rolls), "" if len(state_rolls) == 1 else "s",
             ", ".join(sorted(state_rolls)) or "none", per_state))
    if national_rolls:
        covers = sorted({(b.get("state") or "").upper() for b in biz
                         if src_of(b) in NATIONAL and b.get("state")})
        nat_all = sum(1 for b in biz if src_of(b) in NATIONAL)
        print("   plus USDA's national roll: %d of its %d warehouses pass question 3, "
              "across %d states.\n   NOT netted against the state rolls or against what we "
              "read — it carries no phone to net\n   on, so its duplicates are still in both "
              "figures." % (nat_net, nat_all, len(covers)))
        reached = state_rolls | set(covers)
        left = sorted(ALL_STATES - reached)
        print("   states no roll of any kind has reached (%d): %s"
              % (len(left), " ".join(left) or "none"))
    else:
        print("   Twenty more at that rate would be roughly %d new elevators."
              % int(per_state * 20))
    print("   Question 3 is a name heuristic and nothing more; the real test is whether")
    print("   a sample of them actually post a bid anywhere, which is the next measurement.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

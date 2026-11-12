#!/usr/bin/env python3
"""South Dakota locations with a bracket or a site number in the town (Nov 6, 2026).

The Oct 23, 2026 PUC list names locations "FAULKTON (TOWN)-340" and "KIMBALL (PARAGON)".
The pattern took only plain words for a town, so those two records were dropped. Calls the shipped SOURCES pattern
against a frozen copy of that list, no network.

Nov 12: the count read the live capture in debug/registries/, which the registries run rewrites. The Nov 10 run
committed the Nov 9 list, which adds one real licensee location (KAYLOR AGRISERVICES INC, state warehouse, PARKER),
so the count moved to 345 with no code change. The Oct 23 text is now pinned in test/fixtures/registries/.
"""
import importlib.util, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fr", ROOT / "scripts" / "fetch_registries.py")
fr = importlib.util.module_from_spec(spec); sys.modules["fr"] = fr; spec.loader.exec_module(fr)
fails = []
def ok(c, m):
    print(("  ok   " if c else "  FAIL ") + m)
    if not c: fails.append(m)
sd = next(s for s in fr.SOURCES if s["state"] == "SD")
pat = re.compile(sd["pattern"])
for line, name, lic, city in [
        ("AGTEGRA COOPERATIVE FFAULKTON (TOWN)-340 A+VCS", "AGTEGRA COOPERATIVE", "F", "FAULKTON (TOWN)-340"),
        ("PHARMCO INDUSTRIES, INC BKIMBALL (PARAGON) A+VCS", "PHARMCO INDUSTRIES, INC", "B", "KIMBALL (PARAGON)"),
        ("ADVANCED SUNFLOWER LLC BHURON A+VCS", "ADVANCED SUNFLOWER LLC", "B", "HURON"),
        ("AGREX, INC BOVERLAND PARK, KS A+VCS", "AGREX, INC", "B", "OVERLAND PARK"),
        ("KAYLOR AGRISERVICES INC SPARKER A+VCS", "KAYLOR AGRISERVICES INC", "S", "PARKER")]:
    m = pat.match(line)
    ok(bool(m) and (m["name"], m["licence"], m["city"]) == (name, lic, city), f"{city}: {m and (m['name'], m['licence'], m['city'])}")
ok(not pat.match("FREDERICK FARMERS ELEVATOR "), "a wrapped name half is still not a record")
ok(not pat.match("AGTEGRA COOPERATIVE FBOWDLE WEST -316 A+VCS"), "BOWDLE WEST -316 stays unread rather than misread as permit W at EST -316")
text = (ROOT / "test/fixtures/registries/sd-puc-grain-licenses-2026-10-23.txt").read_text()
ok(text.split("\n")[1].startswith("Friday, October 23, 2026"), "the pinned text is the Oct 23 list")
n = sum(1 for l in text.split("\n") if pat.match(l.strip()))
ok(n == 344, f"the committed Oct 23 text: 344 single-line records match (342 before this change), got {n}")
print("\nsd brackets: %s" % ("all passed" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)

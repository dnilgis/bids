#!/usr/bin/env python3
"""
A STREET PIN IS NOT RE-EARNED EVERY MORNING.

2026-10-27, the registries run at 07:33 UTC (commit a1fe36c): the Census
geocoder was slow, its 420s budget ran out, and build_geocodes.py dropped 392
registry yards from the street point they held the day before (commit beb5671)
to their ZIP centroid. Every one of the 392 had the same address both days.
One of them was Premier Grain, Leesburg OH, 116 South Fairfield Street
(39.34302, -83.55363 by the Census, 39.3458, -83.5481 as a ZIP centroid), and
test/qtmarket.test.mjs went red because its manifest still carried the street
pin the generator could no longer read.

So the answer the previous file holds for the SAME key at the SAME address is
kept, and the Census is asked only about addresses it has not answered.

    python3 test/registry-street-kept.test.py

No network.
"""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location("bg", os.path.join(ROOT, "scripts", "build_geocodes.py"))
BG = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BG)

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


KEY = "OH|premiergrainllc|leesburg"
ADDR = "116 SOUTH FAIRFIELD STREET"
# The row as beb5671 (2026-10-26 07:30 UTC) wrote it.
STREET = {"lat": 39.34302, "lon": -83.55363, "precision": "street", "via": "census", "address": ADDR}
# The row as a1fe36c (2026-10-27 07:33 UTC) wrote it after the budget ran out.
CENTROID = {"lat": 39.3458, "lon": -83.5481, "precision": "town", "via": "zip-centroid", "address": ADDR}

print("\nthe Leesburg row from 2026-10-27")
check(BG.carried_pin({KEY: STREET}, KEY, ADDR) == (39.34302, -83.55363),
      "a Census street pin at the same address is kept", str(BG.carried_pin({KEY: STREET}, KEY, ADDR)))
check(BG.carried_pin({KEY: STREET}, KEY, "  " + ADDR + " ") == (39.34302, -83.55363),
      "whitespace around the address is not a change of address")

print("\nwhat is not carried")
check(BG.carried_pin({KEY: CENTROID}, KEY, ADDR) is None, "a ZIP centroid is never promoted to a street pin")
check(BG.carried_pin({KEY: STREET}, KEY, "120 SOUTH FAIRFIELD STREET") is None,
      "a changed address is asked again")
check(BG.carried_pin({KEY: STREET}, KEY, "") is None, "no address, nothing carried")
check(BG.carried_pin({KEY: STREET}, "OH|premiergrainllc|melvin", ADDR) is None, "another key's pin is not borrowed")
check(BG.carried_pin({KEY: dict(STREET, via="source-file")}, KEY, ADDR) is None,
      "only a Census answer is carried")
check(BG.carried_pin({KEY: dict(STREET, lat=None)}, KEY, ADDR) is None, "a row with no coordinate is not carried")
check(BG.carried_pin({}, KEY, ADDR) is None and BG.carried_pin(None, KEY, ADDR) is None,
      "no previous file, nothing carried")

print("\nreading the previous file never fails the build")
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "places.json")
    check(BG.previous_registry_pins(p) == {}, "a missing file is {}")
    open(p, "w").write("{not json")
    check(BG.previous_registry_pins(p) == {}, "an unreadable file is {}")
    open(p, "w").write(json.dumps({"registry": {KEY: STREET}}))
    check(BG.previous_registry_pins(p) == {KEY: STREET}, "a good file gives its registry section")

print("\nthe file on disk")
row = json.load(open(os.path.join(ROOT, "geocodes", "places.json")))["registry"].get(KEY) or {}
check(row.get("precision") == "street" and row.get("via") == "census"
      and (row.get("lat"), row.get("lon")) == (39.34302, -83.55363),
      "Leesburg is back on its street pin", json.dumps({k: row.get(k) for k in ("lat", "lon", "precision", "via")}))

print()
if FAILED:
    print("registry street kept: %d FAILED -- %s" % (len(FAILED), ", ".join(FAILED)))
    sys.exit(1)
print("registry street kept: all passed")

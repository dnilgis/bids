#!/usr/bin/env python3
"""
A TOWN CENTROID MUST NOT COME BACK OUT AS A ROOFTOP.

geocodes/README.md is unambiguous: "'street' is where the elevator is; 'town'
is the centroid of its town's ZIPs and can be miles off. The map must say
which."

build_geocodes.py wrote "street" for every coordinate a manifest carried,
whatever the manifest said about it. Measured 2026-09-03: 93 manifests declare
latPrecision "town" -- most of them written by geocode-fill.mjs from THIS
file's own town centroids -- and 92 came back out as "street". A round trip
through the geocoder promoted a ZIP centroid to a yard, and data/directory.json
showed 571 street-precise pins of which at least 92 were the middle of a ZIP.

The second rule here is the ZIP fallback. A source's `location` is whatever the
operator calls the place, and on plenty of boards that is a facility name and
not a town: "Adm Fkt" is in Frankfort, "Belstra Milling" is in DeMotte, "West
Findlay" is in Findlay. Seven of the 45 unplaced on 2026-09-03 were exactly
that, every one of them with a ZIP on file.

    python3 test/geocode-precision.test.py

No network. The ZIP table is offline.
"""
import importlib.util
import os
import sys

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


TOWNS, BOXES, COUNTIES, ZIPS = BG.build_tables()

print("\nthe tables")
check(len(ZIPS) > 30000, "the ZIP table is built", "%d ZIPs" % len(ZIPS))
check("46911" in ZIPS, "a ZIP the directory uses is in it")
check(ZIPS["46911"][3] == "IN", "and it carries its state", str(ZIPS.get("46911")))
check((BG.slug("Amboy"), "IN") in TOWNS, "the town table is unchanged")

print("\na coordinate the manifest already carries")
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "lat": 40.6105, "lon": -85.9497, "latPrecision": "town"}, TOWNS, ZIPS)
check(prec == "town", "a manifest that says town comes back town", str(prec))
check(via == "source-file", "and still says where it came from", str(via))

lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "lat": 40.6105, "lon": -85.9497}, TOWNS, ZIPS)
check(prec == "street", "a manifest that says nothing is still street", str(prec))

print("\nthe ZIP fallback")
# "Adm Fkt" is Kokomo Grain's name for a facility in Frankfort, Indiana. It is
# not a town in any ZIP table and it has a ZIP on file.
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Adm Fkt", "zip": "46041"}, TOWNS, ZIPS)
check(lat is not None, "a facility name with a ZIP is placed", str(note))
check(prec == "town", "at TOWN precision, because a ZIP centroid is a town answer", str(prec))
check(via == "zip-code", "and says the ZIP resolved it, not the town", str(via))
check("46041" in str(note), "the note names the ZIP", str(note))

# The town must still win when the location IS a town, or the fallback would
# quietly replace a better answer with a coarser one.
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "zip": "46911"}, TOWNS, ZIPS)
check(via == "zip-centroid", "a real town still resolves by name, not by ZIP", str(via))

# A ZIP in the wrong state is a typo, and a typo must not put a pin two states
# away just because the digits parse.
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Nowhere At All", "zip": "67510"}, TOWNS, ZIPS)
check(lat is None, "a ZIP from another state is refused", "%s %s" % (lat, note))

lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Nowhere At All"}, TOWNS, ZIPS)
check(lat is None, "no town and no ZIP places nothing", str(lat))

print("\nthe order of preference is not an accident")
# A manifest coordinate beats a derived one; without this a hand-corrected pin
# would be overwritten by a centroid on every rebuild.
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "zip": "46911",
     "lat": 41.0, "lon": -86.0}, TOWNS, ZIPS)
check(via == "source-file" and lat == 41.0, "the manifest wins over both derivations", str(via))

print()
if FAILED:
    print("geocode precision: %d FAILED -- %s" % (len(FAILED), ", ".join(FAILED)))
    sys.exit(1)
print("geocode precision: all passed")

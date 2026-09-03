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

# A manifest that says nothing about its precision is a hand-placed pin
# until the coordinate itself says otherwise. Measured 2026-09-03 across the
# 82 such manifests: 70 sit a median 2.10 km off their own town centroid.
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "lat": 40.7000, "lon": -86.0500},
    TOWNS, ZIPS)
check(prec == "street", "a manifest that says nothing, away from the centroid, is street", str(prec))

# ...AND THE COORDINATE DOES SAY OTHERWISE FOR SEVEN OF THEM.
# 40.6105,-85.9497 IS the Amboy centroid this build derives. A coordinate
# identical to the answer we would have derived is that answer, whatever label
# it arrived with -- that is the only check that does not have to believe the
# label. Seven manifests on 2026-09-03 were exactly this, all seven with no
# street address: farmerscoopassociationkeota-ainsworth and -keota,
# flashgrain-granton, keystonecooperative-hagerstown, -pershing and -reynolds,
# and niewohnerfarms-spalding.
amboy = TOWNS[(BG.slug("Amboy"), "IN")]
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "lat": amboy[0], "lon": amboy[1]},
    TOWNS, ZIPS)
check(prec == "town", "a coordinate that IS the centroid is demoted to town", str(prec))
check(via == "source-file", "and still says the manifest carried it", str(via))
check("centroid" in str(note), "and the note says why it was demoted", str(note))

# A PIN THAT ALREADY SAYS TOWN WAS NOT DEMOTED, AND MUST NOT CLAIM IT WAS.
# `resolvedFrom` is a provenance line a human reads. "matches the centroid
# this build derives" is a true sentence about the seven mislabelled pins and
# a false one about the 206 that declared town honestly in the first place.
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "lat": amboy[0], "lon": amboy[1],
     "latPrecision": "town"}, TOWNS, ZIPS)
check(prec == "town", "a declared-town pin on the centroid is still town", str(prec))
check("centroid this build derives" not in str(note),
      "and does not claim to have been demoted", str(note))

# The demotion is ONE-DIRECTIONAL. A manifest that says town must never be
# promoted by this check, and a coordinate 2 km out must never be demoted.
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "lat": 40.6300, "lon": -85.9497,
     "latPrecision": "street"}, TOWNS, ZIPS)
check(prec == "street", "2 km from the centroid stays street", "%s (%.2f km)"
      % (prec, BG.km(40.6300, -85.9497, amboy[0], amboy[1])))

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

print("\na town centroid with a street address is an upgrade waiting to happen")
# THE BUG THIS SECTION EXISTS FOR. Step 1 took the manifest coordinate and
# returned, so a source whose manifest coordinate was a TOWN CENTROID could
# never reach the geocoder however good its address was. Measured 2026-09-03:
# 58 sources declare latPrecision "town" and carry a street address, and every
# one of them kept the centroid for ever -- each rebuild wrote it back.
calls = []


def fake_census(addr):
    calls.append(addr)
    return (40.6500, -85.9600, "301 N MAIN ST, AMBOY, IN, 46911")


amboy = TOWNS[(BG.slug("Amboy"), "IN")]
town_pin = {"id": "x", "state": "IN", "location": "Amboy", "zip": "46911",
            "address": "301 N Main St", "lat": amboy[0], "lon": amboy[1],
            "latPrecision": "town"}
lat, lon, prec, via, note = BG.locate(dict(town_pin), TOWNS, ZIPS,
                                      use_census=True, census_fn=fake_census)
check(prec == "street", "a town-precision manifest pin WITH an address is upgraded", str(prec))
check(via == "census", "and says the geocoder did it", str(via))
check(lat == 40.65, "and the coordinate is the geocoder's, not the centroid", str(lat))
check(len(calls) == 1, "the geocoder was asked exactly once", str(calls))
check("IN" in calls[0], "and asked with the state on the end", str(calls[0]))

# A STREET-PRECISION MANIFEST PIN IS NOT RE-GEOCODED.
# It is already the better answer, and a hand-corrected pin that gets
# overwritten by a geocoder on every rebuild is the bug this repo started with.
calls.clear()
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "address": "301 N Main St",
     "lat": 40.7, "lon": -86.05, "latPrecision": "street"},
    TOWNS, ZIPS, use_census=True, census_fn=fake_census)
check(via == "source-file" and lat == 40.7, "a street-precision pin is left alone", str(via))
check(not calls, "and the geocoder is not called at all", str(calls))

# A GEOCODER THAT ANSWERS THE WRONG STATE MUST NOT COST US THE PIN.
# The upgrade REPLACES a coordinate we already believe. If the replacement is
# wrong it fails near_its_town() downstream and the source falls off the map
# entirely -- it would place today and stop placing tomorrow. So the answer has
# to agree with what we have, and disagreement keeps the centroid.
calls.clear()
lat, lon, prec, via, note = BG.locate(dict(town_pin), TOWNS, ZIPS, use_census=True,
                                      census_fn=lambda a: (32.3913, -90.8939, "somewhere in Mississippi"))
check(prec == "town", "a geocoder answer 1000 km away is refused", str(prec))
check(lat == amboy[0], "and the centroid is kept, not discarded", str(lat))
check("kept the centroid" in str(note), "and the note says the geocoder was overruled", str(note))

# A geocoder that finds nothing is not an error either.
lat, lon, prec, via, note = BG.locate(dict(town_pin), TOWNS, ZIPS, use_census=True,
                                      census_fn=lambda a: None)
check(prec == "town" and lat == amboy[0], "no match keeps the centroid", str(prec))

# ...and with no geocoder reachable at all, nothing changes.
lat, lon, prec, via, note = BG.locate(dict(town_pin), TOWNS, ZIPS, use_census=False)
check(prec == "town" and via == "source-file", "NO_CENSUS=1 keeps the centroid", str(via))

# THE DEMOTED SEVEN GET THE SAME UPGRADE PATH, IF THEY EVER GET AN ADDRESS.
# The demotion in the section above sets prec to "town", which is what step 1b
# tests -- so a mislabelled centroid with an address upgrades too, and the two
# fixes compose rather than sitting next to each other.
calls.clear()
lat, lon, prec, via, note = BG.locate(
    {"id": "x", "state": "IN", "location": "Amboy", "address": "301 N Main St",
     "lat": amboy[0], "lon": amboy[1]},
    TOWNS, ZIPS, use_census=True, census_fn=fake_census)
check(via == "census", "a demoted centroid with an address is upgraded too", str(via))

print("\nthe state is a word, not a substring")
asked = []
seen = lambda a: (asked.append(a), (40.65, -85.96, "m"))[1]

for state, address, why in [
        ("KS", "301 N Ricksecker St", "Ric-KS-ecker"),
        ("IN", "110 N Clinton St", "Cl-IN-ton"),
        ("IL", "Earlville Coop", "Earlv-IL-le"),
        ("OR", "1 North Rd", "N-OR-th")]:
    asked.clear()
    BG.locate({"id": "x", "state": state, "location": "Amboy", "address": address,
               "lat": None, "lon": None}, TOWNS, ZIPS, use_census=True, census_fn=seen)
    check(asked and asked[0].endswith(", " + state),
          "%s survives %s" % (state, why), str(asked))

# ...and an address that really does name its state is not given it twice.
asked.clear()
BG.locate({"id": "x", "state": "IN", "location": "Amboy", "address": "110 N Clinton St, Amboy, IN"},
          TOWNS, ZIPS, use_census=True, census_fn=seen)
check(asked == ["110 N Clinton St, Amboy, IN"], "a state already named is not appended", str(asked))

print("\nderived_centroid has one implementation, not two")
# locate() asks it twice -- to place a source with no coordinate, and to ask
# whether a coordinate a manifest carries is one of these. Two copies of this
# would stop matching and the demotion would quietly stop firing.
d = BG.derived_centroid({"state": "IN", "location": "Amboy"}, TOWNS, ZIPS)
check(d is not None and d[2] == "town" and d[3] == "zip-centroid", "it resolves a town", str(d))
d = BG.derived_centroid({"state": "IN", "location": "Adm Fkt", "zip": "46041"}, TOWNS, ZIPS)
check(d is not None and d[3] == "zip-code", "it falls back to the ZIP", str(d))
check(BG.derived_centroid({"state": "IN", "location": "Nowhere At All"}, TOWNS, ZIPS) is None,
      "and it says None rather than guessing")

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

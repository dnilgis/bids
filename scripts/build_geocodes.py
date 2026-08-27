#!/usr/bin/env python3
"""
build_geocodes.py — put every elevator on the map, and say how sure we are.

WHY THIS EXISTS

Sig, 2026-08-27: "it would be nice to have a national map with a pin on every
elevators location ... every elevator that we dont have i want greyed out or
something like that to indicate that i know you are out there, i just havent
gotten to your data yet."

A pin needs a coordinate, and on 2026-08-27 only 35 of 255 sources had one --
14%. The other 220 had a town, and 222 of the 255 had a street address that
nobody had ever turned into a point.

TWO PRECISIONS, NEVER BLURRED TOGETHER

  street   the address geocoded to a rooftop or street segment. This is where
           the elevator IS.
  town     the centroid of the town's ZIP. This is where the elevator's TOWN
           is, which can be a mile or three off, and on a national map is
           indistinguishable from the truth at a glance.

They are not the same claim and the map must not present them as one. Every
entry carries `precision`, and the map is expected to say so on hover. A town
centroid is honest for "we know this elevator exists, somewhere here"; it is
not honest for "drive to this dot".

WHY THE ZIP TABLE AND NOT A GEOCODER FOR EVERYTHING

Street geocoding needs a service. The US Census geocoder is free, needs no key
and is the right one -- but it is a network call, and a build step that cannot
run without the network is a build step that will one day quietly produce an
empty map. The ZIP centroid path uses a dataset bundled inside the `zipcodes`
package, so it works with the network unplugged, which is also how it was
developed and tested. Census refines; ZIP guarantees.

THE GUARD THAT MATTERS

Every coordinate, whatever produced it, must land inside its own state's
bounding box or it is thrown away. A wrong pin is worse than no pin: a missing
elevator reads as "not done yet", which is true, while a misplaced one reads as
a fact and is false. The boxes are derived from the ZIP dataset itself, so
there is no second source to keep in step.

Stdlib plus `zipcodes`. No key, no secret, no network required.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import zipcodes
except ImportError:
    print("FATAL: pip install zipcodes", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources"
OUT = ROOT / "geocodes" / "places.json"
# Elevators somebody else told us about — today, the directory extracted from
# the Barchart feed before that subscription lapses. We do not read their
# boards; we know they exist, which is the whole point of a grey pin.
KNOWN = ROOT / "data" / "known-elevators.json"

CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
UA = "agsist-bidreader (+https://agsist.com; sig@farmers1st.com)"


def slug(t):
    return re.sub(r"[^a-z]", "", (t or "").lower())


def town_variants(name):
    """The ladder, widest match last, so the most literal reading wins.

    Real names that failed a plain lookup on 2026-08-27:
      "Crookston Terminal", "Kindred Terminal"    -> a facility suffix
      "Fergus Falls South (8c Dump fee)"          -> a fee note in the name
      "Carrollton/White Hal"                      -> two towns, one bid label
    Each rung is a rule about how these feeds write names, not a guess about
    which town was meant; anything still unresolved stays unresolved.
    """
    n = (name or "").strip()
    out = [n]
    no_paren = re.sub(r"\s*\([^)]*\)", "", n).strip()
    out.append(no_paren)
    for suffix in ("Terminal", "Elevator", "Shuttle", "Grain", "Annex"):
        out.append(re.sub(r"\s+%s$" % suffix, "", no_paren, flags=re.I).strip())
    if "/" in no_paren:
        out.append(no_paren.split("/")[0].strip())
    # "Fergus Falls South" -> "Fergus Falls": a compass word on the end is a
    # site within a town, not a different town.
    out.append(re.sub(r"\s+(north|south|east|west)$", "", no_paren, flags=re.I).strip())
    seen, uniq = set(), []
    for v in out:
        if v and slug(v) not in seen:
            seen.add(slug(v))
            uniq.append(v)
    return uniq


def usable(lat, lon):
    """NULL ISLAND IS NOT A PLACE, AND THIS DATASET IS FULL OF IT.

    872 of the 42,789 ZIP records carry lat/long 0,0 -- 539 of them military
    APO/FPO, but also one in North Dakota, one in Iowa, one in Michigan and a
    scattering of others. Two things went wrong before this guard existed:

      * a town whose ZIPs included a 0,0 had its centroid dragged towards the
        Atlantic by however many of them there were, and
      * the North Dakota bounding box, taken as min/max over its ZIPs, ran from
        latitude 0 to 49 and longitude -104 to 0 because of ZIP 58803. A point
        at 40.21,-81.86 -- Ohio -- passed as North Dakota. That is exactly the
        basis1st bad row this repository already documents, sailing straight
        through the check meant to catch it.
    """
    return not (abs(lat) < 0.001 and abs(lon) < 0.001)


def build_tables():
    """(town, state) -> centroid, and state -> bounding box, from one dataset."""
    by_town, pts = {}, {}
    for z in zipcodes.list_all():
        lat, lon, st = z.get("lat"), z.get("long"), z.get("state")
        if lat is None or lon is None or not st:
            continue
        lat, lon = float(lat), float(lon)
        if not usable(lat, lon):
            continue
        p = pts.setdefault(st, [[], []])
        p[0].append(lat)
        p[1].append(lon)
        names = [z.get("city")] + list(z.get("acceptable_cities") or [])
        for nm in names:
            k = (slug(nm), st)
            if not k[0]:
                continue
            by_town.setdefault(k, []).append((lat, lon))

    # A TRIMMED BOX, NOT MIN/MAX. Dropping 0,0 fixes the case we found; the
    # percentile trim is what stops the NEXT bad record -- a transposed sign, a
    # typo'd decimal -- from quietly widening a state to continental size. One
    # percent off each end costs a handful of genuinely remote ZIPs, and the
    # pad in in_state() gives those back.
    boxes = {}
    for st, (la, lo) in pts.items():
        la, lo = sorted(la), sorted(lo)
        if len(la) < 20:                      # too few to trim meaningfully
            boxes[st] = [la[0], la[-1], lo[0], lo[-1]]
            continue
        i = max(1, len(la) // 100)
        boxes[st] = [la[i], la[-i - 1], lo[i], lo[-i - 1]]

    return {k: (sum(a for a, _ in v) / len(v), sum(b for _, b in v) / len(v))
            for k, v in by_town.items()}, boxes


def in_state(lat, lon, st, boxes, pad=0.35):
    """Inside the state's own bounding box, with a small pad for the coasts and
    for towns whose ZIP centroid sits just over a line."""
    b = boxes.get(st)
    if not b:
        return False
    return (b[0] - pad) <= lat <= (b[1] + pad) and (b[2] - pad) <= lon <= (b[3] + pad)


def km(a_lat, a_lon, b_lat, b_lon):
    """Great-circle distance. Only ever used to ask 'is this absurd', so the
    spherical earth is plenty."""
    from math import radians, sin, cos, asin, sqrt
    dlat, dlon = radians(b_lat - a_lat), radians(b_lon - a_lon)
    h = sin(dlat / 2) ** 2 + cos(radians(a_lat)) * cos(radians(b_lat)) * sin(dlon / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(h))


# How far a real elevator may sit from the middle of the town it is named for.
# Rural facilities are routinely a few miles out on a rail spur; 50 km is far
# beyond that and still an order of magnitude tighter than the errors this is
# built to catch.
MAX_KM_FROM_TOWN = 50.0


def near_its_town(lat, lon, s, towns):
    """(ok, detail). The state box catches a coordinate in the wrong REGION.
    This catches one in the wrong TOWN, which is the failure this repository
    has actually seen: of the four bad basis1st rows documented in
    geocodes/README.md, two -- West Burlington IA and Lena IL -- sit inside
    their own state and would sail through a box check while being 100 to 200
    kilometres from the elevator they claim to be.

    Silent when the town is unknown to the ZIP table: no reference point, no
    opinion. Better to place a pin unchecked than to reject one for lack of
    evidence, because the unplaced list is the thing Sig is going to work
    through and it must mean 'no data', not 'no lookup'.
    """
    st = (s.get("state") or "").upper()
    for v in town_variants(s.get("location")):
        c = towns.get((slug(v), st))
        if not c:
            continue
        d = km(lat, lon, c[0], c[1])
        return d <= MAX_KM_FROM_TOWN, "%.0f km from %s" % (d, v)
    return True, "town not in the ZIP table, no distance check possible"


def census(address, timeout=20):
    """One address, or None. Never raises: a geocoder having a bad day must
    degrade this build to town precision, not fail it."""
    q = urllib.parse.urlencode({"address": address, "benchmark": "Public_AR_Current",
                                "format": "json"})
    try:
        req = urllib.request.Request(CENSUS + "?" + q, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            m = json.loads(r.read().decode())["result"]["addressMatches"]
        if not m:
            return None
        c = m[0]["coordinates"]
        return float(c["y"]), float(c["x"]), m[0].get("matchedAddress")
    except Exception:
        return None


def main():
    use_census = os.environ.get("NO_CENSUS", "") != "1"
    towns, boxes = build_tables()
    print("ZIP table: %d town keys, %d state boxes" % (len(towns), len(boxes)))

    srcs = []
    for f in sorted(SOURCES.glob("*.json")):
        try:
            s = json.loads(f.read_text())
        except Exception as ex:
            print("  skip %s (%s)" % (f.name, type(ex).__name__))
            continue
        if s.get("enabled") is False:
            continue
        srcs.append(s)

    places, stats = {}, {"scraped": 0, "street": 0, "town": 0, "unplaced": 0,
                         "rejected_out_of_state": 0, "rejected_far_from_town": 0}
    unplaced = []
    for s in srcs:
        sid, st = s["id"], (s.get("state") or "").upper()
        lat, lon, prec, via, note = None, None, None, None, None

        # 1. A coordinate the source file already carries beats anything derived.
        if s.get("lat") and s.get("lon"):
            lat, lon, prec, via = float(s["lat"]), float(s["lon"]), "street", "source-file"

        # 2. The street address, if a geocoder is reachable.
        if lat is None and use_census and (s.get("address") or "").strip():
            hit = census(s["address"] if st.lower() in s["address"].lower()
                         else "%s, %s" % (s["address"], st))
            time.sleep(0.2)          # their service, our manners
            if hit:
                lat, lon, prec, via = hit[0], hit[1], "street", "census"
                note = hit[2]

        # 3. The town centroid, which always works and always says so.
        if lat is None:
            for v in town_variants(s.get("location")):
                hit = towns.get((slug(v), st))
                if hit:
                    lat, lon, prec, via, note = hit[0], hit[1], "town", "zip-centroid", v
                    break

        if lat is None:
            # THE REASON IS THE DELIVERABLE. Sig asked for a list of the ones we
            # cannot get; a list that says "not resolved" about every row tells
            # him nothing about which are work and which are waiting on a
            # network call. Six of the eight unplaced on 2026-08-27 had a
            # perfectly good street address and were unplaced only because this
            # build ran with no route to the geocoder.
            if not (s.get("address") or "").strip():
                why = "no street address on file, and the town is not in the ZIP table"
            elif not use_census:
                why = "has a street address; no geocoder was reachable when this table was built"
            else:
                why = "the geocoder could not match its street address, and the town is not in the ZIP table"
            stats["unplaced"] += 1
            unplaced.append((s, why))
            continue
        if not in_state(lat, lon, st, boxes):
            stats["rejected_out_of_state"] += 1
            unplaced.append((s, "coordinate rejected: %.4f,%.4f is outside %s" % (lat, lon, st)))
            print("  REJECTED %-28s %.4f,%.4f is outside %s" % (sid, lat, lon, st))
            continue
        ok, why = near_its_town(lat, lon, s, towns)
        if not ok:
            stats["rejected_far_from_town"] += 1
            unplaced.append((s, "coordinate rejected: %s" % why))
            print("  REJECTED %-28s %s (%s)" % (sid, why, via))
            continue

        stats["scraped" if via == "source-file" else prec] += 1
        places[sid] = {"lat": round(lat, 5), "lon": round(lon, 5),
                       "precision": prec, "via": via}
        if note:
            places[sid]["resolvedFrom"] = note

    # ── the ones we only know about ────────────────────────────────────────
    # Same guards, same table, same two precisions. A grey pin that is in the
    # wrong place is exactly as wrong as a green one.
    known, kstats = {}, {"town": 0, "unplaced": 0, "rejected": 0}
    if KNOWN.exists():
        try:
            kd = json.loads(KNOWN.read_text())
        except Exception as ex:
            kd = {}
            print("could not read %s (%s)" % (KNOWN.name, type(ex).__name__))
        for e in (kd.get("elevators") or []):
            st = (e.get("state") or "").upper()
            # THE PRICE ENDPOINT AND THE LOCATIONS ENDPOINT NAME THE SAME
            # THINGS DIFFERENTLY. A bid row calls the business `facility`; a
            # locations row calls it `company`. Reading only one of them made
            # the operator empty for every price-derived entry, which collapsed
            # three distinct facilities into their neighbours' keys and dropped
            # the operator count from 66 to 37 without a word.
            if not e.get("operator"):
                e["operator"] = e.get("company") or e.get("facility")
            if not e.get("location"):
                e["location"] = e.get("city")
            # Barchart's own facility id is the identity when it sent one;
            # a name tuple only otherwise. Same rule as the harvester.
            kid = (str(e.get("elevatorId") or e.get("locationId") or "").strip() or
                   "%s|%s|%s|%s" % (e.get("operator") or "", e.get("branch") or "",
                                    e.get("location") or "", st))
            lat = lon = None
            prec, via = "town", "zip-centroid"
            # BARCHART'S OWN COORDINATE IF IT SENT ONE. The locations response
            # carries lat/lng and a street address, so most of these need no
            # geocoding at all -- and a point Barchart holds for the facility
            # beats any centroid we could derive. Null island is refused here
            # for the same reason it is refused everywhere else in this file.
            try:
                blat, blon = float(e.get("lat")), float(e.get("lng"))
                if usable(blat, blon):
                    lat, lon, prec, via = blat, blon, "street", "barchart"
            except (TypeError, ValueError):
                pass
            # A ZIP is a tighter centroid than a town, so try it next.
            z = str(e.get("zip") or "")[:5]
            if lat is None and z:
                for rec in zipcodes.filter_by(zip_code=z) or []:
                    if rec.get("lat") is not None and usable(float(rec["lat"]), float(rec["long"])):
                        lat, lon = float(rec["lat"]), float(rec["long"])
                        break
            if lat is None:
                hit = towns.get((slug(e.get("location")), st))
                if hit:
                    lat, lon = hit
            if lat is None:
                kstats["unplaced"] += 1
                continue
            if not in_state(lat, lon, st, boxes):
                kstats["rejected"] += 1
                continue
            kstats[prec] = kstats.get(prec, 0) + 1
            known[kid] = {"lat": round(lat, 5), "lon": round(lon, 5),
                          "precision": prec, "via": via,
                          "address": e.get("address"), "url": e.get("url"),
                          "operator": e.get("operator"), "branch": e.get("branch"),
                          "location": e.get("location"), "state": st,
                          "phone": e.get("phone"), "source": e.get("source") or "unknown"}
        print("\nknown-but-not-read: %d at a street point, %d at a ZIP or town centroid, "
              "%d unplaced, %d rejected"
              % (kstats.get("street", 0), kstats.get("town", 0),
                 kstats["unplaced"], kstats["rejected"]))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": ("precision 'street' is where the elevator is; 'town' is the centroid "
                 "of its town's ZIPs and can be miles off. The map must say which."),
        "counts": stats,
        "places": dict(sorted(places.items())),
        "unplaced": {s["id"]: w for s, w in sorted(unplaced, key=lambda x: x[0]["id"])},
        "known": dict(sorted(known.items())),
    }, indent=1) + "\n")

    print("\nplaced %d of %d" % (len(places), len(srcs)))
    for k, v in stats.items():
        print("   %-22s %3d" % (k, v))
    if unplaced:
        print("\nunplaced (%d) — these get no pin at all, which is the honest answer:" % len(unplaced))
        for s, w in unplaced:
            print("   %-26s %-3s %-28s %s" % (s.get("location")[:26], s.get("state"),
                                              (s.get("operator") or "")[:28], w))
    print("\nwrote %s" % OUT)


if __name__ == "__main__":
    main()

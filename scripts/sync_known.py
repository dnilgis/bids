#!/usr/bin/env python3
"""
sync_known.py — pull the elevator directory across from agsist.

WHY

Sig, 2026-08-27: "why dont we export our barchart api to our bids and mark all
locations with a different color pin that are currently being served by
barchart."

That is what the grey pins are, and the only thing standing between them and
being current was a human copying a file between two repositories. The
directory is written in agsist -- that is where the Barchart key and the full
pull live, and pulling a licensed feed into this public repository would
republish it from a second place. But the DIRECTORY agsist writes carries no
prices at all, agsist is public, and raw.githubusercontent serves it with no
token. So this fetches it.

IT REFUSES TO REPLACE GOOD DATA WITH BAD. A 404 page, a truncated body, a file
that parses but holds no elevators, or one that has lost more than a third of
what we already had -- each of those overwrites hundreds of real facilities
with nothing, and the map would simply show fewer grey pins with no
explanation. Every one of them exits non-zero and leaves the existing file
exactly where it is. A stale directory is safe; a silently emptied one is not.
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "known-elevators.json"
SRC = "https://raw.githubusercontent.com/dnilgis/agsist/main/data/elevator-directory.json"
UA = "agsist-bidreader (+https://agsist.com; sig@farmers1st.com)"

# Below this we assume something went wrong upstream rather than that a
# hundred co-ops shut in a week.
SHRINK_FLOOR = 0.66


def main():
    try:
        req = urllib.request.Request(SRC, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=45) as r:
            body = r.read().decode("utf-8")
    except Exception as ex:
        print("FATAL: could not fetch the directory (%s: %s)" % (type(ex).__name__, str(ex)[:140]))
        return 1

    try:
        new = json.loads(body)
    except Exception as ex:
        print("FATAL: what came back is not JSON (%s). First 120 characters: %r"
              % (type(ex).__name__, body[:120]))
        return 1

    got = new.get("elevators")
    if not isinstance(got, list) or not got:
        print("FATAL: the fetched file holds no elevators — refusing to overwrite")
        return 1

    had = 0
    if OUT.exists():
        try:
            had = len(json.loads(OUT.read_text()).get("elevators") or [])
        except Exception:
            had = 0
    if had and len(got) < had * SHRINK_FLOOR:
        print("FATAL: the directory would shrink from %d to %d, which is a bad upstream run, "
              "not a hundred co-ops closing. Keeping what we have." % (had, len(got)))
        return 1

    if OUT.exists() and OUT.read_text() == body:
        print("the directory is unchanged at %d facilities" % len(got))
        return 0

    OUT.write_text(body if body.endswith("\n") else body + "\n")
    c = new.get("counts") or {}
    print("directory: %d -> %d facilities (%d with coordinates, %d with an address, %d with a website)"
          % (had, len(got), c.get("with_coords", 0), c.get("with_address", 0), c.get("with_url", 0)))
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

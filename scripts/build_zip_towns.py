#!/usr/bin/env python3
"""
ZIP -> the town its post office is in, so the merge can name a town for a place
whose `city` is an elevator's name.

WHY THIS EXISTS
    About 150 places carry the vendor's location label in `city`: "Walsh Grain",
    "Melrose Farm Service", "Cadott Grain", "Cushing Coop". `city` is part of the
    place key and the shard filename, so it is not rewritten. merge_bids.mjs adds
    a separate `town` beside it, and it may only come from a real table. The
    geocoder's own note covers some ("54642 (Melrose)"); the rest have a ZIP on
    file and no note, because their coordinate came from the manifest.

WHERE IT COMES FROM
    The same `zipcodes` package that builds geocodes/places.json and data/zips/,
    so a town named here is the town the geocoder would have named. `city` is the
    ZIP's primary city in that table, never an "acceptable" alias.

IT IS STATIC, like build_zip_shards.py. Run it when `zipcodes` is updated.

    python3 scripts/build_zip_towns.py          writes geocodes/zip-towns.json
    python3 scripts/build_zip_towns.py --dry    counts, writes nothing
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "geocodes", "zip-towns.json")


def build(rows):
    """{'54642': ['Melrose', 'WI'], ...} and how many records had no town."""
    out, dropped = {}, 0
    for z in rows:
        code, city, st = z.get("zip_code"), (z.get("city") or "").strip(), z.get("state")
        if not code or len(code) != 5 or not city or not st:
            dropped += 1
            continue
        out.setdefault(code, [city, st])
    return out, dropped


def main():
    try:
        import zipcodes
    except ImportError:
        print("::error title=zipcodes is not installed::pip install zipcodes", file=sys.stderr)
        return 1
    table, dropped = build(zipcodes.list_all())
    print("%d ZIP(s) with a town; %d record(s) without one" % (len(table), dropped))
    if "--dry" in sys.argv:
        return 0
    with open(OUT, "w") as fh:
        json.dump({
            "schema": "zip-towns/1",
            "note": "ZIP -> [primary city, state] from the `zipcodes` package, the table "
                    "geocodes/places.json is built from. Read by merge_bids.mjs to name a "
                    "display `town` for a place whose `city` is an elevator's name.",
            "zips": table,
        }, fh, separators=(",", ":"), sort_keys=True)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(OUT, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
ZIP centroids, sharded, so a page can turn a farmer's ZIP into a coordinate.

WHY THIS EXISTS
    agsist.com/cash-bids.html asks a farmer for his ZIP and shows elevators
    near it. To rank OUR 349 places by distance from him the page needs his
    coordinate, and it had no way to get one: data/zip-grid.json over there is
    a 590-point national polling grid, geocodes/zip-candidates.json here holds
    only the 745 ZIPs our own sources sit in, and neither can place an
    arbitrary ZIP somebody types.

WHY IT IS SHARDED
    The whole table is 41,917 ZIPs -- 1.1 MB, 334 KB gzipped. That is a lot to
    push down a phone on a gravel road to answer one question, and this
    audience is exactly that. Split on the first two digits: 99 shards, the
    largest 5 KB gzipped and the median 3. A Wisconsin farmer typing 54728
    fetches data/zips/54.json and pays 4 KB.

WHY IT IS HERE AND NOT ON THE SITE
    Because this repository already owns the placement discipline -- the same
    `zipcodes` table builds geocodes/places.json and every pin on the map -- and
    because GitHub Pages already serves this repo with
    Access-Control-Allow-Origin, so the site fetches it directly and nothing
    has to be mirrored.

IT IS STATIC. ZIP centroids do not move. Run it when the `zipcodes` package is
updated, not on a schedule.

    python3 scripts/build_zip_shards.py            writes data/zips/
    python3 scripts/build_zip_shards.py --dry      counts, writes nothing
"""
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "zips")


def usable(lat, lon):
    """872 of the 42,789 ZIP records carry 0,0 -- military and territories
    mostly. A pin at 0,0 is in the Atlantic and this repository has refused
    them everywhere else since 2026-08-27; the same rule applies here."""
    return not (abs(lat) < 0.001 and abs(lon) < 0.001)


def build(rows):
    """{'54': {'54728': [45.06, -91.49], ...}, ...} and a count of what was
    dropped, so the run can say so rather than quietly shrinking."""
    shards, kept, dropped = defaultdict(dict), 0, 0
    for z in rows:
        code = z.get("zip_code")
        lat, lon = z.get("lat"), z.get("long")
        if not code or len(code) != 5 or lat is None or lon is None:
            dropped += 1
            continue
        lat, lon = float(lat), float(lon)
        if not usable(lat, lon):
            dropped += 1
            continue
        shards[code[:2]][code] = [round(lat, 4), round(lon, 4)]
        kept += 1
    return shards, kept, dropped


def main():
    try:
        import zipcodes
    except ImportError:
        print("::error title=zipcodes is not installed::pip install zipcodes", file=sys.stderr)
        return 1
    shards, kept, dropped = build(zipcodes.list_all())
    print("%d ZIP(s) in %d shard(s); %d dropped for no usable coordinate"
          % (kept, len(shards), dropped))
    if "--dry" in sys.argv:
        return 0
    os.makedirs(OUT, exist_ok=True)
    index = {}
    for prefix, table in sorted(shards.items()):
        body = json.dumps(table, separators=(",", ":"), sort_keys=True) + "\n"
        with open(os.path.join(OUT, prefix + ".json"), "w") as fh:
            fh.write(body)
        index[prefix] = len(table)
    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump({
            "schema": "agsist-zip-centroids/1",
            "note": "ZIP -> [lat, lon]. Sharded on the first two digits: fetch "
                    "data/zips/<first two digits of the ZIP>.json. Centroids, not "
                    "rooftops -- good to a few miles, which is what ranking elevators "
                    "by distance needs and is not what a delivery address needs.",
            "zips": kept, "shards": index,
        }, fh, indent=1)
        fh.write("\n")
    print("wrote data/zips/index.json and %d shard(s)" % len(index))
    return 0


if __name__ == "__main__":
    sys.exit(main())

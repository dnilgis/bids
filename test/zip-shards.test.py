#!/usr/bin/env python3
"""
A FARMER'S ZIP HAS TO BECOME A COORDINATE, OR THE PAGE CANNOT RANK ANYTHING.

agsist.com/cash-bids.html asks for a ZIP and shows elevators near it. It had no
way to place an arbitrary ZIP: data/zip-grid.json over there is a 590-point
polling grid and geocodes/zip-candidates.json here holds only the 745 ZIPs our
own sources sit in.

    python3 test/zip-shards.test.py

No network. Does not require the `zipcodes` package: build() is pure and is
tested against rows written here.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location(
    "bz", os.path.join(ROOT, "scripts", "build_zip_shards.py"))
BZ = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BZ)

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


def row(z, lat, lon):
    return {"zip_code": z, "lat": lat, "long": lon}


print("\nsharding")
shards, kept, dropped = BZ.build([
    row("54728", 45.317, -91.6542),
    row("54701", 44.7, -91.5),
    row("50001", 41.3, -93.4),
])
check(sorted(shards) == ["50", "54"], "shards are the first two digits", str(sorted(shards)))
check(kept == 3 and dropped == 0, "everything usable is kept", "%d/%d" % (kept, dropped))
check(shards["54"]["54728"] == [45.317, -91.6542], "the coordinate survives to 4 decimals",
      str(shards["54"].get("54728")))

print("\nwhat is refused")
# 872 of the 42,789 ZIP records carry 0,0 -- military and territories. A pin at
# 0,0 is in the Atlantic, and this repository has refused those everywhere else
# since 2026-08-27.
shards, kept, dropped = BZ.build([row("09001", 0.0, 0.0), row("54728", 45.317, -91.6542)])
check(kept == 1 and dropped == 1, "a 0,0 coordinate is dropped, not published", "%d/%d" % (kept, dropped))
check("09" not in shards, "and takes its shard with it")

check(BZ.usable(0.0, 0.0) is False, "usable() names that rule")
check(BZ.usable(45.317, -91.6542) is True, "and passes a real one")

shards, kept, dropped = BZ.build([
    row("5472", 45.0, -91.0),      # four digits
    row("54728", None, -91.0),     # no latitude
    row(None, 45.0, -91.0),        # no code
])
check(kept == 0 and dropped == 3, "a short code, a missing coordinate and a missing code all drop",
      "%d/%d" % (kept, dropped))

print("\nthe shipped table, if it has been built")
OUT = os.path.join(ROOT, "data", "zips")
if not os.path.isdir(OUT):
    print("  --    data/zips/ is not built in this checkout; skipping")
else:
    idx = json.load(open(os.path.join(OUT, "index.json")))
    check(idx["schema"] == "agsist-zip-centroids/1", "the index names its schema", idx.get("schema"))
    check(idx["zips"] > 40000, "it covers the country", str(idx["zips"]))
    files = [f for f in os.listdir(OUT) if f != "index.json" and f.endswith(".json")]
    check(len(files) == len(idx["shards"]),
          "the index counts the shards that are actually there",
          "%d files, %d in the index" % (len(files), len(idx["shards"])))
    # THE TALLY IS CHECKED AGAINST THE SUM OF THE PARTS, not against itself.
    total = 0
    for f in files:
        total += len(json.load(open(os.path.join(OUT, f))))
    check(total == idx["zips"], "and the count is the sum of the shards",
          "%d in files, %d claimed" % (total, idx["zips"]))
    # Chetek, Wisconsin. If this moves, something is wrong with the source table.
    wi = json.load(open(os.path.join(OUT, "54.json")))
    ok = "54728" in wi and abs(wi["54728"][0] - 45.3) < 0.3 and abs(wi["54728"][1] + 91.65) < 0.3
    check(ok, "54728 lands in Wisconsin", str(wi.get("54728")))
    # No shard may hold a ZIP that belongs to another.
    stray = [(f, z) for f in files for z in json.load(open(os.path.join(OUT, f)))
             if not z.startswith(f[:2])]
    check(not stray, "no ZIP is filed under the wrong prefix", str(stray[:3]))

print()
if FAILED:
    print("zip shards: %d FAILED -- %s" % (len(FAILED), ", ".join(FAILED)))
    sys.exit(1)
print("zip shards: all passed")

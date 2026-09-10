#!/usr/bin/env python3
"""
THE NATIONAL LIST, AND THE FOUR THINGS ABOUT IT THAT ARE NOT LIKE A STATE ROLL.

USDA's Warehouse Capacity Management Data is the first source in this
repository that is not one state's roll of licensees. It is 4,801 grain
warehouses across 38 states, and four of its properties break assumptions every
source before it was allowed to make:

  1. IT IS NEVER FETCHED. The export comes out of a Tableau session download,
     which no runner can drive, so the document is committed and read from
     disk. That is the source's shape, not a fallback, and it must not mark the
     run INCOMPLETE the way a snapshot does.
  2. A ROW IS A FUNCTIONAL UNIT, NOT A SITE. A licence numbers its units as
     high as 197, and one licence holds 141 of them, each with its own town and
     its own bushels. Reading the first unit's capacity as the site's
     understates the 153 sites that hold more than one unit in one town.
  3. THE ROLL SPANS 38 STATES, so the merge key (roll, name, town) collapses
     CHS at Morris ILLINOIS into CHS at Morris MINNESOTA. Five real pairs do
     this.
  5. IT PRINTS A LICENCE TYPE AND A LICENCE STATUS PER ROW. 52 rows say
     Unlicensed and 17 say suspended, pending or pending cancellation. A source
     that declares one `kind` for the whole roll would publish all of them as
     holding a current warehouse licence.
  4. ITS NAMES COME OUT OF CSV CELLS, so the run-together backstop — which
     exists because a PDF has no field boundaries — must not be applied to
     them. It refused HI LINE FARMERS UNION GRAIN CO of Peak, North Dakota, a
     real licensee, for containing HI and CO.

Every figure below was measured on fixtures/registry-wcmd-grain.csv, the file
as USDA served it on 2026-09-09. No network — and one of the checks proves it,
by breaking the network first.

    python3 test/registry-wcmd.test.py
"""
import importlib.util
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location(
    "fr", os.path.join(ROOT, "scripts", "fetch_registries.py"))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


def offline():
    """Every network call raises. A source that reads a committed document must
    not notice."""
    def boom(*a, **k):
        raise AssertionError("this source went to the network")
    R.urllib.request.urlopen = boom
    urllib.request.urlopen = boom


def main():
    src = next((s for s in R.SOURCES if s.get("state") == "WCMD"), None)
    print("THE SOURCE")
    check(src is not None, "WCMD is a source")
    if not src:
        return 1
    check(src.get("route") == "csv", "it is read by the csv route, not a route of its own")
    check(bool(src.get("file")), "it names a committed file")
    check(os.path.exists(os.path.join(ROOT, src["file"])),
          "and that file is in the repository", src.get("file", ""))
    check(not src.get("snapshot"),
          "it does NOT declare a snapshot — a snapshot means the live fetch failed, "
          "and this source has no live fetch to fail")
    check(src["url"].startswith("http"),
          "it still records where the export came from, so the provenance can be followed")

    print("\nIT IS READ WITH THE NETWORK BROKEN")
    offline()
    recs, diag = R.scrape(src, 20, 45, verbose=False)
    check(len(recs) == 4613, "4,801 rows become 4,613 sites", "%d" % len(recs))
    check((diag.get("committedFile") or {}).get("path") == src["file"],
          "the run records which committed file it read")
    check(not diag.get("INCOMPLETE"),
          "and does NOT call itself incomplete — that word belongs to a source that "
          "published a total it fell short of, or one that came back empty")
    check(not diag.get("errors"), "no errors", str(diag.get("errors"))[:120])

    print("\nTHE ROLL SAYS HOW OLD IT IS")
    # The one thing a source nobody can re-fetch has to say out loud.
    check(diag.get("ingested") == "9 September 2026",
          "the ingest date is read off the document's own three columns",
          repr(diag.get("ingested")))

    print("\nA ROW IS A FUNCTIONAL UNIT AND A SITE IS THE SUM OF ITS UNITS")
    fu = diag.get("functionalUnits") or {}
    check(fu.get("rowsIn") == 4801, "4,801 rows in", str(fu.get("rowsIn")))
    check(fu.get("sites") == 4613, "4,613 sites out", str(fu.get("sites")))
    check(fu.get("rowsFolded") == 188, "188 rows folded", str(fu.get("rowsFolded")))
    check(fu.get("sitesWithSeveralUnits") == 153, "153 sites hold more than one unit",
          str(fu.get("sitesWithSeveralUnits")))
    # A SUM THAT IS MISSING ONE OF ITS PARTS IS STILL SHORT, AND SAYS SO.
    # The Arthur Companies at Anamoose and at Harvey, CenDak at Hamberg: each
    # folds a unit the export gives no capacity for into one it does.
    check(fu.get("sitesSummedOverABlankUnit") == 3,
          "3 sites are summed over a unit with no capacity printed, and are counted",
          str(fu.get("sitesSummedOverABlankUnit")))
    by = {((r.get("st") or ""), (r.get("city") or "").lower(), (r.get("name") or "").lower()): r
          for r in recs}
    # HAND-WORKED, from the two rows the file prints for Gering:
    #   NE Gering  Western Cooperative Company  unit 1  475,000
    #   NE Gering  Western Cooperative Company  unit 2  679,000
    g = by.get(("NE", "gering", "western cooperative company"))
    check(g is not None and g.get("capacity") == "1,154,000",
          "Gering NE: 475,000 + 679,000 = 1,154,000",
          (g or {}).get("capacity", "missing"))
    # And where the two units carry different warehouse names, both are kept.
    w = by.get(("MN", "winona", "chs inc."))
    check(w is not None and w.get("capacity") == "965,000",
          "Winona MN: 611,000 + 354,000 = 965,000", (w or {}).get("capacity", "missing"))
    check(w is not None and " / " in (w.get("facility") or ""),
          "and both warehouse names survive", (w or {}).get("facility", "missing"))

    print("\nTHE COMPANY'S NAME AND THE YARD'S NAME ARE BOTH KEPT")
    adm = by.get(("GA", "valdosta", "archer-daniels-midland company"))
    check(adm is not None and adm.get("facility") == "ADM Processing Plant Elevator",
          "Valdosta GA is ADM's Processing Plant Elevator under Archer-Daniels-Midland",
          (adm or {}).get("facility", "missing"))
    check(adm is not None and adm.get("county") == "Lowndes",
          'the county arrives as "Lowndes, GA" and the state is taken back off',
          (adm or {}).get("county", "missing"))
    check(all(r.get("county", "").count(",") == 0 for r in recs),
          "no county keeps a state tail")

    print("\nEVERY ROW SAYS WHICH STATE IT IS IN")
    check(all(r.get("st") in R.US_STATES for r in recs),
          "all 4,613 carry a valid two-letter state")
    d2 = {}
    kept = R.require_us_state([{"name": "A", "city": "B", "st": "IA"},
                               {"name": "C", "city": "D", "st": ""},
                               {"name": "E", "city": "F", "st": "ZZ"}], d2)
    check(len(kept) == 1, "a blank state and a made-up one are both refused", "%d kept" % len(kept))
    check((d2.get("refusedNoState") or {}).get("rows") == 2,
          "and the refusal is counted rather than swallowed")

    print("\nONE TOWN NAME, TWO STATES, TWO ELEVATORS")
    # THE BUG THIS CAUGHT. The merge key was (roll, name, town), which is unique
    # while every roll is one state. This roll is 38 states, and these four
    # pairs — measured on the committed export — hashed to one record each:
    #   CHS Inc.                       Morris IL / Morris MN
    #   Bunge North America, Inc.      Decatur IN / Decatur AL
    #   Archer-Daniels-Midland Company Columbus OH / Columbus NE
    #   Bartlett Grain Company, LLC    Kansas City KS / Kansas City MO
    for name, town, a, b in (("CHS Inc.", "Morris", "IL", "MN"),
                             # THE FIFTH PAIR, found by re-counting after the
                             # first four were written down: the towns are spelt
                             # "ST PAUL" and "ST. PAUL", and the key strips the
                             # stop, which is what it is for.
                             ("Bunge USA Grain, LLC", "ST PAUL", "MN", "NE"),
                             ("Bunge North America, Inc.", "Decatur", "IN", "AL"),
                             ("Archer-Daniels-Midland Company", "Columbus", "OH", "NE"),
                             ("Bartlett Grain Company, LLC", "Kansas City", "KS", "MO")):
        # ON THE KEY'S OWN NORMALISATION, not on the literal cell: the fifth
        # pair is spelt "ST PAUL" in Minnesota and "ST. PAUL" in Nebraska.
        key = re.sub(r"[^a-z]", "", town.lower())
        got = sorted(r["st"] for r in recs
                     if r["name"] == name
                     and re.sub(r"[^a-z]", "", r["city"].lower()) == key)
        check(got == sorted([a, b]), "%s at %s is in both %s and %s" % (name, town, a, b),
              str(got))
    # THROUGH THE SHIPPED MERGE, not a copy of it.
    two = R.merge_records([
        {"state": "WCMD", "st": "OH", "name": "Archer-Daniels-Midland Company",
         "city": "Columbus", "kind": "warehouse"},
        {"state": "WCMD", "st": "NE", "name": "Archer-Daniels-Midland Company",
         "city": "Columbus", "kind": "warehouse", "capacity": "3,200,000"}])
    check(len(two) == 2, "and merge_records keeps them apart", "%d record(s)" % len(two))
    check(sorted(e["state"] for e in two) == ["NE", "OH"],
          "each filed in its own state", str([e.get("state") for e in two]))
    one = R.merge_records([
        {"state": "IA", "st": "IA", "name": "Same Co", "city": "Alta", "kind": "dealer"},
        {"state": "IA", "st": "IA", "name": "Same Co.", "city": "ALTA", "kind": "warehouse"}])
    check(len(one) == 1 and one[0]["licences"] == ["dealer", "warehouse"],
          "while one business on two lists is still one record holding both licences",
          str(one))

    print("\nTHE LICENCE A ROW ACTUALLY HOLDS")
    # 52 rows are printed "Unlicensed" with an empty licence number. They are
    # kept — an unlicensed warehouse is still a building with grain in it — and
    # they may not claim a licence, so their `kind` is empty and merge_records
    # gives them no `licences` at all.
    unl = [r for r in recs if (r.get("licence") or "") == "Unlicensed"]
    check(len(unl) == 50, "50 sites are printed Unlicensed", "%d" % len(unl))
    check(diag.get("unlicensed") == 50, "and the run says so", str(diag.get("unlicensed")))
    check(all(r.get("kind") == "" for r in unl),
          "none of them carries the roll's warehouse kind")
    check(all(r.get("kind") == "warehouse" for r in recs if r not in unl),
          "and every licensed row still does")
    merged_unl = [e for e in R.merge_records([dict(r, state="WCMD") for r in unl])
                  if e.get("licenceClass") == "Unlicensed"]
    check(merged_unl and all(e["licences"] == [] for e in merged_unl),
          "so no unlicensed warehouse reaches the file holding a warehouse licence",
          str([e["licences"] for e in merged_unl[:2]]))
    # And the status, which the export prints separately from the type.
    st = {}
    for r in recs:
        st[r.get("status") or ""] = st.get(r.get("status") or "", 0) + 1
    check(st.get("S - Suspended") == 6 and st.get("P - Pending") == 10
          and st.get("Q - Pending Cancellation") == 1,
          "6 suspended, 10 pending and 1 pending cancellation are read, not dropped",
          str({k: v for k, v in st.items() if k}))
    one = R.merge_records([{"state": "WCMD", "st": "IA", "name": "Hansen-Mueller Co.",
                            "city": "SIOUX CITY", "kind": "warehouse",
                            "licence": "Federal", "status": "S - Suspended"}])
    check(one and one[0].get("licenceStatus") == "S - Suspended",
          "and the status reaches the record", str(one and one[0].get("licenceStatus")))

    print("\nA CSV CELL IS NOT A RUN-TOGETHER PDF LINE")
    # HI LINE FARMERS UNION GRAIN CO, of Peak, North Dakota. A real licensee,
    # thrown away by the backstop on the first WCMD run for containing two
    # strings that are also state codes: HI at the front, CO at the end.
    check(R._run_together("HI LINE FARMERS UNION GRAIN CO"),
          "the rule itself still reads that name as suspect — it is unchanged")
    kept_names = {r["name"] for r in R.merge_records(
        [dict(r, state="WCMD") for r in recs if "HI LINE" in r["name"]])}
    check(kept_names == {"HI LINE FARMERS UNION GRAIN CO"},
          "and the run keeps it anyway, because a CSV states its own field boundaries",
          str(kept_names))
    # And the backstop is still armed where it belongs: a South Dakota PDF row.
    mashed = R.merge_records([{
        "state": "SD", "st": "SD", "kind": "dealer",
        "name": "BOMAHA, NE B SCHMITZ GRAIN INC BCURRIE, MN A+VCS",
        "city": "SOMEWHERE"}])
    check(mashed == [], "eleven licensees on one PDF line are still refused", str(mashed)[:80])

    print("\nAND THE ONE STALENESS SIGNAL DOES NOT FAIL OPEN")
    # `ingested` is only set when all three columns agree. An export drawn
    # across two days would otherwise have produced no date and no complaint —
    # a silent gap in the one thing a hand-pulled roll can say about its age.
    d3 = {}
    R.read_csv("State,City,Business Entity,Year of Ingest Date,Month of Ingest Date,"
               "Day of Ingest Date\nIA,Alta,A Co,2026,September,9\n"
               "IA,Boone,B Co,2026,September,10\n", d3)
    check(not d3.get("ingested"), "a two-day export records no single date")
    check((d3.get("ingestSpans") or {}).get("day") == ["10", "9"],
          "it records the days it actually spans", str(d3.get("ingestSpans")))
    check(any("one ingest date" in e for e in d3.get("errors") or []),
          "and says so out loud", str(d3.get("errors")))

    print()
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), "; ".join(FAILED)))
        return 1
    print("wcmd: %d sites, read from a committed file with the network broken" % len(recs))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
survey_registries.py — what does each state actually publish, and in what shape.

WHY

Sig: "what about the rest of the states". Iowa took a scraper of its own, and
the honest answer to that question is that nobody knows yet, because every
state publishes differently. Three shapes are already confirmed and they are
all different:

  IOWA      two HTML lists, and a one-page directory report.
            Name, City, County, Phone. No street address.
  ILLINOIS  a SEARCH FORM, not a list. Nothing to page through.
  NEBRASKA  a PDF mailing list carrying COMPANY, ADDRESS, ADDRESS 2, CITY,
            STATE, ZIP -- street addresses, which no other confirmed source has.

So "nineteen more scrapers like Iowa's" is wrong before it starts. This asks
every candidate once and reports what came back, so the next nineteen are
designed against evidence instead of an assumption.

IT WRITES NO SCRAPER AND PARSES NO REGISTRY. It classifies: is this a table and
how many rows, is it a form, is it a PDF, does the page link to a CSV or an
Excel file, and what do the header cells say. One run, the whole landscape.

EVERY CANDIDATE URL BELOW IS EXACTLY THAT -- a candidate, found by search and
in most cases never opened, because the hosts are unreachable from the sandbox
this was written in. The survey's job is to tell us which ones are real.

Stdlib only.
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "registry-survey.json"
UA = "agsist-bidreader (+https://agsist.com; sig@farmers1st.com)"

# THE DENOMINATOR OF REGISTRIES, 2026-09-04.
#
# The National Agricultural Law Center's state compilation says which states
# regulate grain warehouses at all, and that is the list this survey is trying
# to finish. THIRTY states do; twenty do not, and the twenty include Michigan,
# California, New York and Pennsylvania -- states with real elevators and no
# licence roll to harvest, which have to come from Barchart and the platform
# sweeps instead.
#
#   REGULATED (30): AL AR CO DE GA ID IL IN IA KS KY LA MN MS MO MT NE NM ND
#                   OH OK OR SC SD TN TX WA WV WI WY
#   NOT REGULATED : AK AZ CA CT FL HI ME MD MA MI NV NH NJ NY NC PA RI UT VT VA
#
# EIGHT OF THE THIRTY ARE HARVESTED: IA MO OH ND AR IN SD NE. They account for
# 2,966 of the directory's 4,253 rows -- an average of 371 elevators per state.
# The twenty-two that are not show what Barchart alone carries, and the numbers
# say plainly that this is a gap and not a fact about those states:
#
#     KS 361   IL 340   MN 286   WI 111   MI 37   OK 33   CO 27
#     WA 20    MT 11    TX 8     WY 5     ID 2    OR 2
#
# Texas has eight. Idaho has two. Those are not counts of elevators, they are
# counts of what one Corn Belt directory happened to carry.
#
# EVERY URL BELOW WAS FOUND BY SEARCH AND MOST HAVE NEVER BEEN OPENED -- the
# hosts are unreachable from the sandbox this was written in, which is the
# whole reason this script runs on the runner. Nothing here is parsed and
# nothing is believed. A state with no line is a state whose URL nobody has
# found yet; it is named in NEEDS_A_URL rather than guessed at, because a
# plausible-looking path that 404s is worse than an admitted blank.

# state, what we expect, url, confidence
CANDIDATES = [
    # ---- harvested already; kept so a change of shape is noticed ----------
    ("IA", "one-page directory report", "http://idalsdata.org/IowaData/grainWarehouseDirectoryReportHtml.cfm?version=HTML", "confirmed by reading it"),
    ("IA", "licensing list, dealers", "https://data.iowaagriculture.gov/licensing_lists/graindealers/", "confirmed, 251 rows, paginated"),
    ("IA", "licensing list, warehouses", "https://data.iowaagriculture.gov/licensing_lists/grainwarehouse/", "confirmed, 102 rows, paginated"),
    ("MO", "dealer/warehouse database", "https://agriculture.mo.gov/grains/grainsearch.php", "confirmed, 304 rows"),
    ("NE", "PSC mailing list PDF", "https://psc.nebraska.gov/sites/default/files/doc/administration/RR-212/Mailing%20List%20GDGW,%20Interested%20Parties,%20&%20Insurance%20Carriers.pdf", "confirmed: has ADDRESS columns"),

    # ---- the twenty-two, in order of how many elevators are behind them ----
    ("KS", "grain warehouse programme", "https://www.agriculture.ks.gov/divisions-programs/grain-warehouse", "search 2026-09-04; the licensing and resources pages both timed out on the last survey"),
    ("KS", "grain warehouse licensing", "https://www.agriculture.ks.gov/divisions-programs/grain-warehouse/licensing", "surveyed 2026-09-03, no answer"),
    ("KS", "applications and licences", "https://www.agriculture.ks.gov/licenses/grain-warehouse-applications-and-licenses", "search 2026-09-04, unopened"),
    ("KS", "documents page", "https://www.agriculture.ks.gov/divisions-programs/grain-warehouse/documents", "search 2026-09-04, unopened — may link a list"),

    ("IL", "lookup form", "https://apps.agr.illinois.gov/AEM/warehouselookup.php", "confirmed a FORM, not a list"),
    ("IL", "dealer/warehouse look-up page", "https://agr.illinois.gov/consumers/grainwarehouses/licensed-grain-dealer-warehouse-look-up.html", "search 2026-09-04, unopened — the page around the form"),
    ("IL", "grain warehouses index", "https://agr.illinois.gov/consumers/grainwarehouses.html", "search 2026-09-04, unopened"),

    ("MN", "grain licensing", "https://www.mda.state.mn.us/grain-licensing-0", "search 2026-09-04, unopened"),
    ("MN", "warehouse licensing", "https://www.mda.state.mn.us/warehouse-licensing", "search 2026-09-04, unopened"),

    ("TX", "grain warehouse programme", "https://texasagriculture.gov/Home/Production-Agriculture/Grain-Warehouse", "search 2026-09-04, unopened"),

    ("WA", "licence book PDF", "https://cms.agr.wa.gov/WSDAKentico/Documents/GWA-License-Book-21-22.pdf", "search 2026-09-04: titled PUBLIC GRAIN WAREHOUSES/DEALERS LICENSED WITH THE STATE OF WASHINGTON"),
    ("WA", "warehouses and dealers PDF", "https://cms.agr.wa.gov/WSDAKentico/Documents/Grain-Warehouse-Audit-Grain-Dealers.pdf", "search 2026-09-04, unopened"),

    ("OR", "SOS licence directory, bonded grain warehouse", "https://apps.oregon.gov/SOS/LicenseDirectory/LicenseDetail/170", "search 2026-09-04: says 'Last updated 01/05/2026'"),

    ("ID", "warehouse programme", "https://agri.idaho.gov/ag-inspections/warehouse-program/", "search 2026-09-04, unopened"),

    ("MT", "commodity warehouse licence", "https://prod-agr.mt.gov/Topics/A-D/Commodity-Pages/Commodity-Warehouse-License", "search 2026-09-04, unopened"),

    ("OK", "licensing and permits", "https://ag.ok.gov/licensing-permits/", "search 2026-09-04, unopened"),

    # ---- the national list, which is a SUPPLEMENT and not the denominator --
    #
    # USWA licences are FEDERAL. The 2010 snapshot read on 2026-09-04 lists
    # roughly 687 grain facilities for the whole country -- against 4,253 rows
    # already in this repository. Most elevators are licensed by their state,
    # not by USDA, so this is a few hundred names the state rolls will not
    # have, not the national roster. Worth taking; not worth waiting for.
    ("US", "USDA WCMD dashboard", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/WCMDDashboard?:isGuestRedirectFromVizportal=y&:embed=y", "national, Tableau, export unknown; returned 200 and 0 rows on 2026-09-03"),
    ("US", "USWA active warehouses, data.gov", "https://catalog.data.gov/dataset/uswa-active-warehouses", "read 2026-09-04: its only distribution is a PDF at fsa.usda.gov"),
    ("US", "USWA licensed and bonded, 2010 snapshot", "http://www.fsa.usda.gov/Internet/FSA_File/whselst2010.pdf", "READ 2026-09-04: 'Licensed and Bonded Warehouses Licensed Under the U.S. Warehouse Act As of December 31, 2010'. Town / warehouse / operator, no street address. SIXTEEN YEARS OLD — the survey should look for a newer year"),
    ("US", "USWA snapshot, another year", "http://www.fsa.usda.gov/Internet/FSA_File/whselst2012.pdf", "search 2026-09-04: the file name carries the year, so the newest one is worth finding"),
]

# States that regulate grain warehouses and whose published list nobody has
# located yet. NOT a list of guesses -- a list of searches somebody still owes.
# Naming them is the point: a state missing from CANDIDATES because no URL was
# found looks exactly like a state that does not exist.
NEEDS_A_URL = ["AL", "CO", "DE", "GA", "KY", "LA", "MS", "NM", "SC", "TN", "WV", "WI", "WY"]

# Regulated states already harvested by scripts/fetch_registries.py.
HARVESTED = ["IA", "MO", "OH", "ND", "AR", "IN", "SD", "NE"]


DATA_LINK = re.compile(r'href=["\']([^"\']+\.(?:csv|xlsx?|json|txt))["\']', re.I)
FORMISH = re.compile(r"<form\b", re.I)
TR = re.compile(r"<tr\b", re.I)
TH = re.compile(r"<th[^>]*>(.*?)</th>", re.I | re.S)


def look(url, timeout):
    d = {"url": url}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
            raw = r.read(1_500_000)
            d.update(status=r.status, contentType=ctype, bytes=len(raw))
    except Exception as ex:
        d.update(status=0, error="%s: %s" % (type(ex).__name__, str(ex)[:130]))
        return d

    if "pdf" in d.get("contentType", "") or url.lower().endswith(".pdf"):
        # A PDF is not a dead end — Nebraska's carries street addresses, which
        # is better than every HTML source confirmed so far. It just needs a
        # different reader, and that is worth knowing before writing one.
        d["shape"] = "pdf"
        return d

    body = raw.decode("utf-8", "replace")
    rows = len(TR.findall(body))
    heads = [re.sub(r"<[^>]+>|\s+", " ", h).strip() for h in TH.findall(body)][:12]
    links = sorted(set(DATA_LINK.findall(body)))[:8]
    d.update(rows=rows, headerCells=[h for h in heads if h], dataLinks=links)
    if links:
        d["shape"] = "page offering a data file"
    elif rows >= 15:
        d["shape"] = "html table"
    elif FORMISH.search(body):
        d["shape"] = "search form"
    elif "tableau" in body.lower() or "vizql" in body.lower():
        d["shape"] = "tableau dashboard"
    else:
        d["shape"] = "unclear"
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--pause", type=float, default=0.8)
    a = ap.parse_args()

    out = []
    for st, what, url, conf in CANDIDATES:
        d = look(url, a.timeout)
        d.update(state=st, expected=what, confidence=conf)
        out.append(d)
        print("%-3s %-28s %-18s %s"
              % (st, what[:28], d.get("shape") or ("HTTP %s" % d.get("status")),
                 d.get("error", "")[:60] or
                 ("%s rows" % d["rows"] if d.get("rows") else "")))
        time.sleep(a.pause)

    OUT.write_text(json.dumps({
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": ("What each state publishes and in what shape. Candidates were found by "
                 "search; most had never been opened when this list was written. Nothing "
                 "here is parsed or trusted — this is reconnaissance."),
        "results": out,
    }, indent=1) + "\n")

    ok = [d for d in out if d.get("status") == 200]
    print("\n%d of %d candidates answered" % (len(ok), len(out)))
    for shape in sorted({d.get("shape") for d in ok if d.get("shape")}):
        n = [d for d in ok if d.get("shape") == shape]
        print("   %-26s %d  (%s)" % (shape, len(n), ", ".join(sorted({d["state"] for d in n}))))
    dead = [d for d in out if d.get("status") != 200]
    if dead:
        print("   %-26s %d  (%s)" % ("no answer", len(dead), ", ".join(d["state"] for d in dead)))
    """WHERE THE REST OF THE COUNTRY IS, IN THREE NUMBERS.

    That sentence used to be a hand-typed list of states that had drifted out
    of date the moment candidates were added to it -- it still named MN, SD,
    ND, OH, IN, AR and TX as having no candidate, and five of those are either
    harvested or listed above. A summary that has to be edited by hand is a
    summary that lies. Derive it."""
    have = {st for st, _, _, _ in CANDIDATES}
    regulated = set(HARVESTED) | set(NEEDS_A_URL) | (have - {"US"})
    print("\n%d states regulate grain warehouses (National Agricultural Law "
          "Center, read 2026-09-04)." % len(regulated))
    print("   harvested by fetch_registries.py   %2d  %s"
          % (len(HARVESTED), " ".join(sorted(HARVESTED))))
    tried = sorted((have - {"US"}) - set(HARVESTED))
    print("   a candidate URL to try            %2d  %s" % (len(tried), " ".join(tried)))
    print("   nobody has found the list yet     %2d  %s"
          % (len(NEEDS_A_URL), " ".join(sorted(NEEDS_A_URL))))
    print("\nThe twenty states that do NOT regulate grain warehouses at all -- "
          "Michigan, California,\nNew York, Pennsylvania among them -- have no "
          "licence roll to harvest. They have to come\nfrom Barchart and the "
          "platform sweeps, and that is a different job.")
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

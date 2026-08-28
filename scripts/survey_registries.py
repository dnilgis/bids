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

# state, what we expect, url, confidence
CANDIDATES = [
    ("IA", "one-page directory report", "http://idalsdata.org/IowaData/grainWarehouseDirectoryReportHtml.cfm?version=HTML", "confirmed by reading it"),
    ("IA", "licensing list, dealers", "https://data.iowaagriculture.gov/licensing_lists/graindealers/", "confirmed, 251 rows, paginated"),
    ("IA", "licensing list, warehouses", "https://data.iowaagriculture.gov/licensing_lists/grainwarehouse/", "confirmed, 102 rows, paginated"),
    ("IL", "lookup form", "https://apps.agr.illinois.gov/AEM/warehouselookup.php", "confirmed a form, not a list"),
    ("IL", "older lookup", "https://agr.state.il.us/sharepoint/warehouselookup.php", "search result, robots refused a read"),
    ("MO", "dealer/warehouse database", "https://agriculture.mo.gov/grains/grainsearch.php", "search result, unopened"),
    ("KS", "grain warehouse licensing", "https://www.agriculture.ks.gov/divisions-programs/grain-warehouse/licensing", "search result, unopened"),
    ("KS", "grain warehouse resources", "https://www.agriculture.ks.gov/divisions-programs/grain-warehouse/resources", "search result, unopened"),
    ("NE", "PSC mailing list PDF", "https://psc.nebraska.gov/sites/default/files/doc/administration/RR-212/Mailing%20List%20GDGW,%20Interested%20Parties,%20&%20Insurance%20Carriers.pdf", "search result: has ADDRESS columns"),
    ("US", "USDA WCMD dashboard", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/WCMDDashboard?:isGuestRedirectFromVizportal=y&:embed=y", "national, Tableau, export unknown"),
]

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
    print("\nStates with no candidate URL at all, which is most of them: "
          "MN WI SD ND OH IN MI TX OK CO MT WA AR KY TN MS NC SC PA NY.")
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

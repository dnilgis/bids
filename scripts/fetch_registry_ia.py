#!/usr/bin/env python3
"""
fetch_registry_ia.py — Iowa's licensed grain dealers and warehouses.

WHY IOWA FIRST

Sig, 2026-08-27: "have you been getting the licensed grain buyers and
populating our elevator map" -- and the honest answer was no. Grey reads 0.

Iowa is the right first state and the numbers say so. Barchart carries 86 Iowa
facilities; we scrape 6; the state licenses 251 grain dealers and 102 grain
warehouses. The registry is roughly three times the size of the commercial feed
for that state, which is the first hard measurement of how much of the country
is missing.

WHAT THESE LISTS ARE, AND WHAT THEY ARE NOT

A grain DEALER licence lets a business buy grain from farmers. A grain
WAREHOUSE licence lets it store grain for them. Most country elevators hold
both; plenty of dealers are feed mills, processors, ethanol plants or farm
operations that a farmer cannot walk into and sell a load to. So the count of
licences is an upper bound on elevators, not a count of them, and this script
reports the two lists separately and their overlap rather than adding them up.

Fields are Name, City, County, Phone. NO STREET ADDRESS -- so anything derived
from here is a town centroid, which is exactly the right precision for a grey
pin and is drawn as a ring rather than a dot. The phone matters more than the
address anyway: ten digits is the strongest key in this project's dedup rule,
and it is what will match these against the 727 Barchart facilities and our own
255 without falling back to company names, which are worthless when "CHS" is
two hundred businesses.

WHY IT DIAGNOSES ITSELF

data.iowaagriculture.gov and idalsdata.org are both unreachable from the
sandbox this was written in, exactly like the Census geocoder and the Barchart
API before it. So the parser below was built against the described shape and a
fixture, and has never met the real page. A scraper written blind that reports
"0 rows" teaches nothing and costs a whole round trip; this one always prints
what it actually received -- status, bytes, table and row counts, the header
cells it found, and the raw HTML of the first unparsed row -- so a failed run
comes back with the evidence to fix it in one pass instead of three.

Stdlib only. No key, no secret.
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "registry-ia.json"
UA = "agsist-bidreader (+https://agsist.com; sig@farmers1st.com)"

# The one-page report is preferred: the licensing_lists site paginates 25 at a
# time with no export, and 300 rows is a dozen round trips to somebody's server
# for something they already publish whole.
SOURCES = [
    {"kind": "warehouse", "url": "http://idalsdata.org/IowaData/grainWarehouseDirectoryReportHtml.cfm?version=HTML",
     "note": "one-page directory report"},
    {"kind": "warehouse", "url": "https://data.iowaagriculture.gov/licensing_lists/grainwarehouse/",
     "note": "paginated licensing list", "paginate": True},
    {"kind": "dealer", "url": "https://data.iowaagriculture.gov/licensing_lists/graindealers/",
     "note": "paginated licensing list", "paginate": True},
]

PHONE = re.compile(r"\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}")


class Tables(HTMLParser):
    """Every <tr> in the document as a list of cell strings, plus enough of the
    raw shape to diagnose a page this parser has never seen."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.headers = [], []
        self._row, self._cell, self._in = None, None, None
        self.tables = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables += 1
        elif tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell, self._in = [], tag

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            txt = re.sub(r"\s+", " ", "".join(self._cell)).strip()
            if self._row is not None:
                self._row.append(txt)
            if self._in == "th" and txt:
                self.headers.append(txt)
            self._cell, self._in = None, None
        elif tag == "tr" and self._row is not None:
            if any(c for c in self._row):
                self.rows.append(self._row)
            self._row = None


def label_split(text):
    """The one-page report was described as 'Name: X City Y Phone: Z County: W'
    rather than a clean table. If the table parse finds nothing, fall back to
    reading those labels out of the flat text -- same fields, different
    packaging, and no reason to lose a whole state to a layout choice."""
    out = []
    for m in re.finditer(
            # County is bounded by the NEXT record's "Name:" rather than left
            # greedy. Unbounded, it swallowed the following "Name" and with it
            # the marker the next match needed, so a two-record fixture parsed
            # as one and a three-hundred-record page would have parsed as one
            # too — a failure that looks like a thin registry, not a bug.
            r"Name:\s*(?P<name>.+?)\s*City:?\s*(?P<city>.+?)\s*Phone:?\s*(?P<phone>[\d()\-.\s]{7,}?)"
            r"\s*County:?\s*(?P<county>[A-Za-z .'\-]{2,30}?)(?=\s*Name:|\s*$)",
            text):
        out.append({"name": m.group("name").strip(), "city": m.group("city").strip(),
                    "phone": m.group("phone").strip(), "county": m.group("county").strip()})
    return out


def columns_of(headers, rows):
    """Map fields to column indexes by header text, and if there are no usable
    headers, infer from the data: the phone column is the one that looks like a
    phone in most rows, and Name / City / County sit around it."""
    idx = {}
    low = [h.lower() for h in headers]
    for want, keys in (("name", ("name", "business", "company", "firm")),
                       ("city", ("city", "town")),
                       ("county", ("county",)),
                       ("phone", ("phone", "telephone"))):
        for i, h in enumerate(low):
            if any(k in h for k in keys):
                idx[want] = i
                break
    if "phone" not in idx and rows:
        width = max(len(r) for r in rows)
        for i in range(width):
            hits = sum(1 for r in rows if len(r) > i and PHONE.search(r[i] or ""))
            if hits >= max(3, len(rows) // 3):
                idx["phone"] = i
                break
    if "name" not in idx and rows:
        idx["name"] = 0
    # NO HEADERS AT ALL. Both Iowa lists print Name, City, County, Phone in that
    # order, so once the phone column is found the other two sit immediately
    # before it. Without this a header-less page kept the name and the phone and
    # silently dropped the CITY — and city is the only thing these records carry
    # that can be turned into a pin at all.
    if "phone" in idx and ("city" not in idx or "county" not in idx):
        ph = idx["phone"]
        if ph - 2 >= 1 and "city" not in idx:
            idx["city"] = ph - 2
        if ph - 1 >= 1 and "county" not in idx:
            idx["county"] = ph - 1
    return idx


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def scrape(src, pages, timeout, verbose):
    """Returns (records, diagnostic). Never raises: one dead list must not cost
    the other two."""
    diag = {"url": src["url"], "kind": src["kind"], "note": src["note"]}
    urls = [src["url"]]
    if src.get("paginate"):
        # Guessing a pagination shape is guessing; ask for the obvious ones and
        # let the diagnostic say which, if any, moved the row count.
        urls += ["%s?page=%d" % (src["url"], p) for p in range(2, pages + 1)]

    seen, recs = set(), []
    for u in urls:
        try:
            status, body = fetch(u, timeout)
        except Exception as ex:
            diag.setdefault("errors", []).append("%s: %s" % (type(ex).__name__, str(ex)[:120]))
            break
        diag.setdefault("pages", []).append({"url": u, "status": status, "bytes": len(body)})
        p = Tables()
        try:
            p.feed(body)
        except Exception as ex:
            diag.setdefault("errors", []).append("parse: %s" % type(ex).__name__)
        diag["tables"] = p.tables
        diag["headerCells"] = p.headers[:12]
        diag["rowsSeen"] = diag.get("rowsSeen", 0) + len(p.rows)

        got = []
        if p.rows:
            idx = columns_of(p.headers, p.rows)
            diag["columnMap"] = idx
            for r in p.rows:
                if "phone" in idx and len(r) > idx["phone"] and not PHONE.search(r[idx["phone"]] or ""):
                    continue                       # header or spacer row
                rec = {k: (r[i].strip() if len(r) > i else "") for k, i in idx.items()}
                if rec.get("name"):
                    got.append(rec)
        if not got:
            # The table route found nothing. Try the labelled-text route before
            # giving up, and keep a sample of what we actually received.
            flat = re.sub(r"<[^>]+>", " ", body)
            got = label_split(re.sub(r"\s+", " ", flat))
            if got:
                diag["parsedVia"] = "labelled text, not a table"
        else:
            diag["parsedVia"] = "table"
        if not got:
            diag["firstRowRaw"] = (p.rows[0] if p.rows else body[:400])
        new = 0
        for g in got:
            key = (g.get("name", "").lower(), g.get("city", "").lower())
            if key in seen:
                continue
            seen.add(key)
            g["kind"] = src["kind"]
            recs.append(g)
            new += 1
        diag.setdefault("newPerPage", []).append(new)
        if src.get("paginate") and new == 0 and len(diag["newPerPage"]) > 1:
            break                                   # pagination is not working; stop asking
        time.sleep(0.4)
    diag["kept"] = len(recs)
    if verbose and recs:
        diag["sample"] = recs[:3]
    return recs, diag


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=20, help="pagination attempts per paginated list")
    ap.add_argument("--timeout", type=int, default=45)
    ap.add_argument("--fixture", help="parse this local HTML file instead of the network")
    a = ap.parse_args()

    if a.fixture:
        body = Path(a.fixture).read_text()
        p = Tables()
        p.feed(body)
        idx = columns_of(p.headers, p.rows)
        print("fixture: %d tables, %d rows, headers %s" % (p.tables, len(p.rows), p.headers[:8]))
        print("column map: %s" % idx)
        for r in p.rows[:4]:
            print("   %s" % r)
        flat = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", body))
        print("labelled-text route would find: %d" % len(label_split(flat)))
        return 0

    allrecs, diags = [], []
    for src in SOURCES:
        recs, diag = scrape(src, a.pages, a.timeout, verbose=True)
        diags.append(diag)
        print("%-9s %-58s -> %d records%s"
              % (diag["kind"], src["url"][:58], len(recs),
                 "" if recs else "   ** nothing parsed, see the diagnostic **"))
        allrecs += recs
        if src["kind"] == "warehouse" and recs and src is SOURCES[0]:
            # The one-page report worked; no need to bother the paginated twin.
            SOURCES[1]["skip"] = True

    # One record per business+town, remembering which licences it holds.
    merged = {}
    for r in allrecs:
        k = (re.sub(r"[^a-z0-9]", "", r.get("name", "").lower()),
             re.sub(r"[^a-z]", "", r.get("city", "").lower()))
        e = merged.setdefault(k, {"name": r.get("name"), "city": r.get("city"),
                                  "county": r.get("county"), "phone": r.get("phone"),
                                  "state": "IA", "licences": [], "source": "registry-ia"})
        if r["kind"] not in e["licences"]:
            e["licences"].append(r["kind"])
        for f in ("phone", "county"):
            if not e.get(f) and r.get(f):
                e[f] = r[f]

    out = sorted(merged.values(), key=lambda e: (e.get("city") or "", e.get("name") or ""))
    both = sum(1 for e in out if len(e["licences"]) == 2)
    OUT.write_text(json.dumps({
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "state": "IA",
        "note": ("Licensed grain dealers and warehouses as Iowa publishes them. Name, city, "
                 "county and phone only -- no street address, so anything mapped from here is "
                 "a town centroid. A dealer licence is not proof a farmer can sell there."),
        "counts": {"businesses": len(out),
                   "dealer_only": sum(1 for e in out if e["licences"] == ["dealer"]),
                   "warehouse_only": sum(1 for e in out if e["licences"] == ["warehouse"]),
                   "both": both,
                   "with_phone": sum(1 for e in out if e.get("phone"))},
        "diagnostics": diags,
        "businesses": out,
    }, indent=1) + "\n")

    print("\n%d businesses (%d hold both licences, %d with a phone)"
          % (len(out), both, sum(1 for e in out if e.get("phone"))))
    if not out:
        print("\nNOTHING PARSED. The diagnostic in %s says what came back:" % OUT.name)
        for d in diags:
            print("   %s" % json.dumps({k: v for k, v in d.items() if k != "sample"})[:600])
        return 1
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

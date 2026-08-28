#!/usr/bin/env python3
"""
fetch_registries.py — state licensed grain dealer and warehouse registries.

WHY

Sig: "have you been getting the licensed grain buyers and populating our
elevator map" — no, and grey read zero. This is the source that fills it.
Barchart's 727 is a hard ceiling; the states are where the rest of the country
lives.

WHAT THE SURVEY FOUND, 2026-08-28

Ten candidates asked once. Seven answered, and no two states are alike:

    MO   html table, 304 rows      a real published list, the best of them
    IA   html table, 853 rows      one-page report, plus two paginated lists
    NE   pdf                       the only source with STREET ADDRESSES
    IL   search form               nothing to page through
    US   tableau dashboard         USDA, national, export unknown
    KS   HTTP 403                  blocks bots outright
    IL   (older url)               timed out

So this is a table of states, not a script per state. Adding one is a row.

WHAT THE FIRST LIVE RUN TAUGHT, AND WHY THE PARSER LOOKS LIKE THIS

  * The Iowa directory report is NINE NESTED TABLES, 566 rows, with the data in
    one of them. A phone-column detector that wanted a phone in a third of ALL
    rows found none, so nothing parsed: 8 records out of 300. Tables are judged
    one at a time.
  * `?page=2` returned a BYTE-IDENTICAL page. The parameter was ignored, and
    the run took 25 of Iowa's 251 dealers while reporting success. Pagination
    is now probed under seven spellings and the diagnostic says which won. A
    parameter that changes nothing is worse than none: it produces a confident
    run holding a tenth of the data.
  * The two Iowa sources DISAGREE ON COLUMN ORDER — the lists are
    Name/City/County/Phone, the report is Name/City/Phone/County. Counting back
    from the phone column got city wrong on both, so inference is now
    order-independent.

WHAT THESE LISTS ARE NOT

A grain DEALER licence lets a business buy grain from farmers; a WAREHOUSE
licence lets it store it. Country elevators usually hold both, but so do feed
mills, ethanol plants, processors and farm operations that a farmer cannot walk
into and sell a load to. The count of licences is an upper bound on elevators,
never a count of them, and registry_report.py measures the difference.

Fields are Name, City, County, Phone. No street address outside Nebraska, so
anything mapped from here is a town centroid — which is exactly the right
precision for a grey pin, and the map draws it as a ring rather than a dot. The
phone is the valuable field anyway: ten digits is the strongest key in this
project's dedup rule, and it is what matches these against the 727 Barchart
facilities and our own 255 without falling back to company names, which are
worthless when "CHS" is two hundred businesses.

Stdlib only. No key, no secret.
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "registries.json"
UA = "agsist-bidreader (+https://agsist.com; sig@farmers1st.com)"

# The one-page report is preferred: the licensing_lists site paginates 25 at a
# time with no export, and 300 rows is a dozen round trips to somebody's server
# for something they already publish whole.
# state, licence kind, url, notes. Adding a state is adding rows.
SOURCES = [
    {"state": "IA", "kind": "warehouse", "note": "one-page directory report",
     "url": "http://idalsdata.org/IowaData/grainWarehouseDirectoryReportHtml.cfm?version=HTML"},
    {"state": "IA", "kind": "warehouse", "note": "licensing list", "paginate": True,
     "url": "https://data.iowaagriculture.gov/licensing_lists/grainwarehouse/"},
    {"state": "IA", "kind": "dealer", "note": "licensing list", "paginate": True,
     "url": "https://data.iowaagriculture.gov/licensing_lists/graindealers/"},
    # Confirmed by the survey: a 304-row HTML table, the largest single list any
    # state was found to publish.
    {"state": "MO", "kind": "dealer+warehouse", "note": "database listing",
     "url": "https://agriculture.mo.gov/grains/grainsearch.php", "paginate": True},
]

PHONE = re.compile(r"\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}")


class Tables(HTMLParser):
    """Every <tr> in the document as a list of cell strings, plus enough of the
    raw shape to diagnose a page this parser has never seen."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.headers = [], []
        self.per_table = []          # rows grouped by the table they came from
        self._row, self._cell, self._in = None, None, None
        self._depth = 0
        self.tables = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables += 1
            self._depth += 1
            self.per_table.append([])
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
                if self.per_table:
                    self.per_table[-1].append(self._row)
            self._row = None
        elif tag == "table":
            self._depth = max(0, self._depth - 1)


def label_split(text):
    # NOTE: callers must unescape first. This route strips tags with a regex
    # instead of going through HTMLParser, so nothing decodes the entities on
    # the way — "A &amp; K Feed & Grain" reached the output verbatim.
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
    # EVERY FIELD A STATE OFFERS, NOT THE FOUR IOWA HAPPENS TO HAVE.
    # Missouri's header row reads Company Name, Manager Name, Address, City,
    # State, Zip, Phone, County, Warehouse License, Dealer Class, Capacity --
    # street addresses, ZIPs and STORAGE CAPACITY. Mapping only Iowa's four
    # threw all of that away on 288 records: addresses that would have been
    # street-precision pins instead of town centroids, and a capacity figure
    # that separates a country elevator from a feed mill far better than any
    # guess at its name.
    for want, keys in (("name", ("company name", "business name", "name", "business", "company", "firm")),
                       ("city", ("city", "town")),
                       ("county", ("county",)),
                       ("phone", ("phone", "telephone")),
                       ("address", ("address", "street")),
                       ("zip", ("zip", "postal")),
                       ("st", ("state",)),
                       ("capacity", ("capacity", "bushels")),
                       ("licence", ("license", "licence", "class"))):
        # Longest key first, so "company name" wins over "name" and a column
        # called "Manager Name" cannot be taken for the business.
        best = None
        for k in sorted(keys, key=len, reverse=True):
            for i, h in enumerate(low):
                if k in h and i not in idx.values():
                    best = i
                    break
            if best is not None:
                break
        if best is not None:
            idx[want] = best
    if "phone" not in idx and rows:
        # A THIRD OF ALL ROWS WAS THE WRONG BAR, and the Iowa directory report
        # proved it: nine nested layout tables, 566 rows between them, and the
        # real data confined to one of them. No single column had phones in a
        # third of everything, so no phone column was found, so nothing was
        # parsed — 8 records out of 300. Judge each table on its own and take
        # the column that is mostly phones WITHIN it.
        width = max(len(r) for r in rows)
        best, best_hits = None, 0
        for i in range(width):
            hits = sum(1 for r in rows if len(r) > i and PHONE.search(r[i] or ""))
            if hits > best_hits:
                best, best_hits = i, hits
        if best is not None and best_hits >= max(3, len(rows) // 4):
            idx["phone"] = best
    if "name" not in idx and rows:
        idx["name"] = 0
    # NO HEADERS AT ALL. Both Iowa lists print Name, City, County, Phone in that
    # order, so once the phone column is found the other two sit immediately
    # before it. Without this a header-less page kept the name and the phone and
    # silently dropped the CITY — and city is the only thing these records carry
    # that can be turned into a pin at all.
    if "phone" in idx and ("city" not in idx or "county" not in idx) and rows:
        # ORDER-INDEPENDENT, because the two Iowa sources do not agree on it.
        # The licensing lists print Name, City, County, Phone; the directory
        # report prints Name, City, Phone, County. Counting backwards from the
        # phone column got county right on one and city wrong on both. What is
        # stable is that whatever is left over, in order, is city then county.
        width = max(len(r) for r in rows)
        spare = [i for i in range(width) if i not in (idx.get("name"), idx.get("phone"))]
        if spare and "city" not in idx:
            idx["city"] = spare[0]
        if len(spare) > 1 and "county" not in idx:
            idx["county"] = spare[1]
    return idx


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


PAGE_PARAMS = [
    ("%s?page=%%d" % "{u}", 1, 1),      # 1-indexed page number
    ("%s?page=%%d" % "{u}", 1, 0),      # 0-indexed page number
    ("%s?p=%%d" % "{u}", 1, 1),
    ("%s?pg=%%d" % "{u}", 1, 1),
    ("%s?start=%%d" % "{u}", 25, 25),   # row offset
    ("%s?offset=%%d" % "{u}", 25, 25),
    ("%s?limit=1000&offset=%%d" % "{u}", 25, 0),
]


def probe_pagination(url, timeout, diag):
    """Return (url_format, step) for whatever actually turns the page, or None.

    A parameter that changes nothing is worse than no parameter: it produces a
    confident run that quietly holds a tenth of the data.
    """
    try:
        _, first = fetch(url, timeout)
    except Exception as ex:
        diag.setdefault("errors", []).append("probe: %s" % type(ex).__name__)
        return None
    tried = []
    for tmpl, step, base in PAGE_PARAMS:
        fmt = tmpl.replace("{u}", url)
        try:
            _, second = fetch(fmt % (base + step), timeout)
        except Exception as ex:
            tried.append({"param": fmt, "error": type(ex).__name__})
            continue
        moved = second != first
        tried.append({"param": fmt % (base + step), "bytes": len(second), "changed": moved})
        if moved:
            diag["pagination"] = {"works": fmt, "step": step, "tried": tried}
            return fmt, step
        time.sleep(0.3)
    diag["pagination"] = {"works": None, "tried": tried,
                          "note": "nothing turned the page; only the first page was read"}
    return None


def scrape(src, pages, timeout, verbose):
    """Returns (records, diagnostic). Never raises: one dead list must not cost
    the other two."""
    diag = {"url": src["url"], "kind": src["kind"], "note": src["note"]}
    _ = pages
    urls = [src["url"]]
    if src.get("paginate"):
        # PROBE THE PARAMETER, DO NOT ASSUME IT. `?page=2` returned a
        # byte-identical page — 10,918 bytes both times — so it was being
        # ignored outright, and the run took 25 of Iowa's 251 dealers while
        # reporting success. Ask for page two under several spellings, keep the
        # first that changes the body, and say in the diagnostic which one won
        # so the next state starts from evidence.
        param = probe_pagination(src["url"], timeout, diag)
        if param:
            fmt, step = param
            urls += [fmt % (step * i) for i in range(1, pages)]

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
        # EACH TABLE ON ITS OWN. A page can be one data table wrapped in eight
        # layout tables, and treating them as a single pile of rows is what
        # turned three hundred Iowa warehouses into eight.
        groups = [g for g in (p.per_table or []) if g] or ([p.rows] if p.rows else [])
        maps = []
        for g in groups:
            idx = columns_of(p.headers, g)
            if "phone" not in idx:
                continue                            # not the data table
            # ONE CELL PER ROW IS NOT A TABLE. When the phone column and the
            # name column are the same index, every "record" is the entire line
            # — "Name: ADM Grain Company City Clinton Phone: ..." — and the
            # business name comes out as the whole sentence. That parsed as
            # seven confident records on the Iowa report fixture, which is
            # exactly the kind of success that hides a failure.
            if idx.get("phone") == idx.get("name"):
                continue
            maps.append({"rows": len(g), "map": idx})
            for r in g:
                if len(r) > idx["phone"] and not PHONE.search(r[idx["phone"]] or ""):
                    continue                        # header or spacer row
                rec = {k: (r[i].strip() if len(r) > i else "") for k, i in idx.items()}
                # "Phone:" arrived as a business name from a header row that
                # happened to carry a phone-shaped cell. A name that is a bare
                # label, or two characters long, is not a business.
                nm = (rec.get("name") or "").strip()
                if nm and len(nm) > 2 and not nm.rstrip(":").lower() in (
                        "name", "phone", "city", "county", "company", "address", "state", "zip"):
                    got.append(rec)
        diag["columnMap"] = maps or columns_of(p.headers, p.rows)
        diag["tablesWithData"] = len(maps)
        p_rows_seen = len(p.rows)
        # A TABLE ROUTE THAT "SUCCEEDS" WITH ALMOST NOTHING IS STILL A FAILURE.
        # The Iowa directory report has 561 rows in its data table and the
        # table route kept TWO of them, because the rows are not cells of a
        # record — they are lines of "Name: X City Y Phone: Z County: W". Two
        # is non-zero, so the fallback never ran and the run reported success
        # while holding 0.4% of the state. Whichever route reads more of the
        # page wins.
        flat = None
        if len(got) < max(5, p_rows_seen // 5):
            flat = label_split(re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", body))))
        if flat is not None and len(flat) >= len(got):
            diag["parsedVia"] = "labelled text (%d) beat the table route (%d)" % (len(flat), len(got))
            got = flat
        elif got:
            diag["parsedVia"] = "table"
        elif flat:
            got = flat
            diag["parsedVia"] = "labelled text, not a table"
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
    ap.add_argument("--states", default="", help="comma-separated, e.g. IA,MO (blank = all)")
    ap.add_argument("--fixture", help="parse this local HTML file instead of the network")
    a = ap.parse_args()

    if a.fixture:
        body = Path(a.fixture).read_text()
        p = Tables()
        p.feed(body)
        print("fixture: %d tables, %d rows, headers %s" % (p.tables, len(p.rows), p.headers[:8]))
        groups = [g for g in (p.per_table or []) if g] or ([p.rows] if p.rows else [])
        kept = 0
        for n, g in enumerate(groups):
            idx = columns_of(p.headers, g)
            if "phone" not in idx:
                print("   table %d: %d rows, no phone column — skipped" % (n, len(g)))
                continue
            if idx.get("phone") == idx.get("name"):
                print("   table %d: %d rows, one cell per row — not a table, skipped" % (n, len(g)))
                continue
            print("   table %d: %d rows, map %s" % (n, len(g), idx))
            for r in g:
                if len(r) > idx["phone"] and not PHONE.search(r[idx["phone"]] or ""):
                    continue
                rec = {k: (r[i].strip() if len(r) > i else "") for k, i in idx.items()}
                if rec.get("name"):
                    kept += 1
                    if kept <= 3:
                        print("      %s" % rec)
        flat = label_split(re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", body))))
        print("   table route kept %d, labelled-text route found %d" % (kept, len(flat)))
        route = ("labelled text" if (kept < max(5, len(p.rows) // 5) and len(flat) >= kept) or kept == 0
                 else "table")
        print("   -> this run would use the %s route" % route)
        if route == "labelled text" and flat:
            for r in flat[:3]:
                print("      %s" % r)
        return 0

    want = {x.strip().upper() for x in a.states.split(",") if x.strip()}
    allrecs, diags = [], []
    for src in SOURCES:
        if want and src["state"] not in want:
            continue
        recs, diag = scrape(src, a.pages, a.timeout, verbose=True)
        diag["state"] = src["state"]
        diags.append(diag)
        print("%-3s %-16s %-52s -> %d records%s"
              % (src["state"], src["kind"], src["url"][:52], len(recs),
                 "" if recs else "   ** nothing parsed, see the diagnostic **"))
        for r in recs:
            r["state"] = src["state"]
        allrecs += recs

    # One record per business per town per state. A business appears once even
    # when it holds both licences, and the licences it holds are remembered —
    # that pairing is the closest thing these lists carry to "is this an
    # elevator", short of going and looking.
    merged = {}
    for r in allrecs:
        k = (r.get("state"),
             re.sub(r"[^a-z0-9]", "", (r.get("name") or "").lower()),
             re.sub(r"[^a-z]", "", (r.get("city") or "").lower()))
        e = merged.setdefault(k, {"name": r.get("name"), "city": r.get("city"),
                                  "county": r.get("county"), "phone": r.get("phone"),
                                  # A state that names its own state column beats
                                  # the one we inferred from which list we asked.
                                  "state": (r.get("st") or r.get("state") or "").upper(),
                                  "address": r.get("address") or None,
                                  "zip": (str(r.get("zip") or "")[:5] or None),
                                  "capacity": r.get("capacity") or None,
                                  "licenceClass": r.get("licence") or None,
                                  "licences": [],
                                  "source": "registry-%s" % (r.get("state") or "").lower()})
        for lic in str(r.get("kind") or "").split("+"):
            if lic and lic not in e["licences"]:
                e["licences"].append(lic)
        for f in ("phone", "county", "address", "capacity"):
            if not e.get(f) and r.get(f):
                e[f] = r[f]

    out = sorted(merged.values(), key=lambda e: (e.get("state") or "", e.get("city") or "", e.get("name") or ""))
    per_state = {}
    for e in out:
        per_state[e["state"]] = per_state.get(e["state"], 0) + 1
    counts = {"businesses": len(out),
              "byState": per_state,
              "both_licences": sum(1 for e in out if len(e["licences"]) > 1),
              "with_phone": sum(1 for e in out if e.get("phone"))}

    OUT.write_text(json.dumps({
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": ("Licensed grain dealers and warehouses as each state publishes them. Name, "
                 "city, county and phone — no street address, so anything mapped from here is "
                 "a town centroid. A dealer licence is not proof a farmer can sell there."),
        "counts": counts,
        "diagnostics": diags,
        "businesses": out,
    }, indent=1) + "\n")

    print("\n%d businesses  %s" % (len(out), json.dumps(per_state)))
    print("   %d hold both licences, %d carry a phone" % (counts["both_licences"], counts["with_phone"]))
    if not out:
        print("\nNOTHING PARSED ANYWHERE. The diagnostics say what came back:")
        for d in diags:
            print("   %s" % json.dumps({k: v for k, v in d.items() if k != "sample"})[:500])
        return 1
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

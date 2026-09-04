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

    MO   html table, 304 rows      one page, no pager, complete at 288
    IA   html report, 140 records  plus two lists that page by POST, 251 + 102
    NE   pdf                       the only source with STREET ADDRESSES
    IL   search form               nothing to page through
    US   tableau dashboard         USDA, national, export unknown
    KS   HTTP 403                  blocks bots outright
    IL   (older url)               timed out

So this is a table of states, not a script per state. Adding one is a row.

WHAT THE LIVE RUNS TAUGHT, AND WHY THE PARSER LOOKS LIKE THIS

Four runs, each of which reported success. Every one of these was found by
reading the page the run committed, not the log it printed.

  * The Iowa directory report is NINE NESTED TABLES, 566 rows, with the data in
    one of them. A phone-column detector that wanted a phone in a third of ALL
    rows found none: 8 records out of 300. Tables are judged one at a time.
  * The report is not a table of records at all. It is a TWO-COLUMN LABEL/VALUE
    table, one <tr> per field, so the column detector was always going to fail
    on it. pairs_route reads it exactly: 140 of 140.
  * `?page=2` returned a BYTE-IDENTICAL page and the run took 25 of Iowa's 251
    dealers while reporting success. Pagination is probed, not assumed.
  * Then Missouri answered the FIRST spelling offered, because Incapsula stamps
    a fresh `cb=` nonce into one script tag on every response — so every body
    differs from every other body and any parameter "works". The probe compares
    the BUSINESSES on the page, never the bytes.
  * The probe found Missouri's `?page=2` and the fetch loop then asked for
    `?page=1`, which is the page it had already read. Zero new rows, and the
    zero-new guard broke out before page two was ever requested: 25 of 75 on a
    controlled server. The loop starts where the probe proved it moved.
  * Iowa's two lists page by POSTING A RELATIVE OFFSET INSIDE A SESSION —
    Next posts +25, Prev posts -25, and the server holds the position. Twelve
    GET spellings were refused because no URL can produce page two. That was
    never a parameter this project failed to guess; it was a shape it did not
    have.
  * Iowa prints "25 out of 251" under its own table. Three runs took the 25 and
    reported success. A source that publishes its total is checked against it,
    and a short walk is now the loudest line in the output.
  * The two Iowa sources DISAGREE ON COLUMN ORDER — the lists are
    Name/City/County/Phone, the report is Name/City/Phone/County. Inference is
    order-independent.
  * Missouri cuts every company name at FORTY CHARACTERS, mid-word, and what it
    cuts is the town suffix that separates six sibling facilities of the same
    company. Sixteen of twenty-six were completed from the city column; the rest
    carry a flag, because "Cottonw" against a city of Caruthersville is
    Cottonwood Point and nothing here knows that.

THE PAGES ARE COMMITTED. debug/registries/ holds the first two pages of every
source. All three hosts are unreachable from the machine this parser is written
on, and every fix above was posted blind into CI and read back out of a log
until that changed. Fixtures are cheaper than runs.

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

# THE ROUTES, NAMED. Adding a state is adding a row; adding a SHAPE is adding
# a branch, and a row that names a shape with no branch has to fail loudly
# rather than fall through to the PDF reader and report an unreadable PDF.
#
# "pdf" is the fallback branch in both fetchers and therefore never appears as
# an equality test, which is why this list exists rather than being scraped out
# of the code: test/registries.test.mjs tried that on 2026-09-04 and concluded
# the repository had stopped implementing PDFs.
ROUTES = ("html", "csv", "xls", "pdf")

# state, licence kind, url, notes. Adding a state is adding a row.
# A source with a "post" key pages by POSTing an offset inside a session; one
# with "paginate" pages by a URL parameter that gets probed. Neither is assumed.
SOURCES = [
    {"state": "IA", "kind": "warehouse", "note": "one-page directory report",
     "url": "http://idalsdata.org/IowaData/grainWarehouseDirectoryReportHtml.cfm?version=HTML"},
    # POST, NOT GET. Both of these page by posting a relative offset inside a
    # session — see walk_post. Twelve GET spellings were refused before the page
    # was read; it says "25 out of 251" right under the table.
    {"state": "IA", "kind": "warehouse", "note": "licensing list",
     "url": "https://data.iowaagriculture.gov/licensing_lists/grainwarehouse/",
     "post": {"fields": {"name": "", "location": "", "county": "All", "submit": "filter"},
              "offsetField": "offset", "delta": 25}},
    {"state": "IA", "kind": "dealer", "note": "licensing list",
     "url": "https://data.iowaagriculture.gov/licensing_lists/graindealers/",
     "post": {"fields": {"name": "", "location": "", "county": "All", "submit": "filter"},
              "offsetField": "offset", "delta": 25}},
    # Confirmed by the survey: a 304-row HTML table, the largest single list any
    # state was found to publish.
    {"state": "MO", "kind": "dealer+warehouse", "note": "database listing",
     "url": "https://agriculture.mo.gov/grains/grainsearch.php", "paginate": True},

    # ── VERIFIED 2026-08-28, one state at a time, by fetching each page ──────
    # Twenty-two states were checked. The Iowa shape — an HTML list that pages
    # by POST — turned out to be the EXCEPTION, not the rule. What states
    # actually publish, counted: ten PDFs, five one-page HTML tables, five
    # search forms with nothing to page through, two client-side dashboards
    # that leak no data, one CSV. Oklahoma publishes no list at all, which was
    # confirmed by looking rather than assumed from a 403.
    #
    # KANSAS WAS RECORDED HERE AS PUBLISHING NOTHING, AND THAT IS WRONG.
    #
    # Four agriculture.ks.gov URLs have returned 403 to the runner on three
    # separate days, with our own user-agent and with a browser string, and I
    # took the 2026-08-28 note at its word and stopped looking.
    #
    # Then K-State's Arthur Capper Cooperative Center, in "Mapping Grain
    # Locations in Kansas" (agmanager.info, read 2026-09-04), names its sources:
    #
    #     Kansas Department of Agriculture — "Grain Elevator Licenses" report
    #     USDA — "United States Warehouse Act Licensed Warehouses" report
    #
    # Somebody is reading a KDA licence report. The same paper counts OVER 550
    # co-operative grain locations in Kansas plus more than 250 non-co-op ones
    # — against the 361 rows this repository holds for Kansas, all of them
    # Barchart's. Kansas is the largest single hole on the map and it is not a
    # dead end; it is a door we cannot open from this network.
    #
    # It needs a person with a browser, which is why it is not a row here yet.
    #
    # So the work was never "nineteen more scrapers like Iowa's". It is three
    # routes — table, csv, pdf — and a row per state.

    # OHIO IS THE BEST-SHAPED SOURCE ANY STATE PUBLISHES: a plain CSV at a
    # stable URL, no form, no pager, no licence key. Ohio is also one of the
    # worst holes on the map — 42 Barchart facilities and not one read.
    {"state": "OH", "kind": "dealer+warehouse", "note": "csv export", "route": "csv",
     "url": "https://dam.assets.ohio.gov/raw/upload/v1745847679/Grain.csv"},

    # The whole table on one page. (The sibling /licensesearch/4 is a form —
    # not that one.)
    {"state": "ND", "kind": "dealer+warehouse", "note": "licence register",
     "url": "https://lars.ndda.nd.gov/public/allLicenses/4/"},

    {"state": "AR", "kind": "warehouse", "note": "warehouse list",
     "url": "https://agriculture.arkansas.gov/crops-industry/quality-control-and-compliance/grain-warehouses/"},

    # ── TEXAS. Eight rows in the directory; a hundred and thirty-nine here. ──
    #
    # Found 2026-09-04 by keeping the programme page and reading it. That page
    # is FORMS -- its 36 <tr> fooled the survey's row counter -- and the list
    # is one click down, behind "Click here for a list of grain warehouses
    # licensed by TDA". An .xls, which is the best shape any state publishes.
    #
    # The ?ver= token is part of the URL DotNetNuke serves; the survey could
    # not even see this link until it learned that a query string may follow an
    # extension. Whether the token is stable is unknown -- if this ever 404s,
    # re-read the programme page for a fresh one rather than trimming it off.
    #
    # COUNTY, NO CITY. Texas gives a county and no town and no street, so every
    # Texas record lands at county precision and must not claim better.
    {"state": "TX", "kind": "warehouse", "note": "licensee list, xls", "route": "xls",
     "url": "https://texasagriculture.gov/Portals/0/Reports/PIR/grain_warehouse.xls"
            "?ver=8h5xCiF7GXXNfllq9gtibA%3d%3d",
     # Stated, not inferred. "name" would land on CLI_LEGAL_NAME anyway, and
     # only because it is the earlier column -- an answer that is right until
     # somebody reorders the export.
     "columns": {"name": "cli_legal_name", "county": "county_name"}},

    # ── IDAHO IS NOT TAKEN, AND HERE IS EXACTLY WHY ─────────────────────────
    #
    # Two PDFs were found on 2026-09-04 and both were fetched and read:
    #   Commodity-Dealer-Licensees-1.pdf     40 licensees
    #   ID-WA-Cooperative-Licensees.pdf      15 licensees, Idaho AND Washington
    #
    # A pattern gets the count and the state right and CANNOT SPLIT THE TOWN
    # FROM THE COMPANY. Measured, not guessed -- this is what came back:
    #
    #     name "Ag Solution, Inc. dba"        city "Mountain Malt Idaho Falls"
    #     name "Amy's Kitchen,"               city "Inc. Pocatello"
    #     name "Almota Elevato r"             city "Company Colfax"
    #
    # The extractor leaves double spaces INSIDE words ("Mountain  Malt",
    # "Idaho  Falls", "Elevato r"), so whitespace marks nothing, and the line
    # carries no other separator. A human reads "Idaho Falls" as a town because
    # they know it is one. A regex cannot, and a town filed wrongly is worse
    # than a state left unread.
    #
    # It could be split against geocodes/zip-candidates.json -- take the
    # longest trailing phrase that is a real town in that state -- and that is
    # a new route rather than a pattern.
    #
    # AND IT IS NOT WORTH ONE YET. Their own page says "A Licensee is only
    # listed once but may have multiple business locations", and several are
    # headquartered out of state: Ardent Mills at Ogden UT, Cereal Byproducts
    # at Mount Prospect IL, Columbia Grain at Clarkston WA. These are COMPANIES
    # with a mailing address, not elevators with a location. Fifty-five company
    # names put nothing on a map.
    #
    # The captures are in debug/registries/survey/ for whoever writes that
    # route.

    # ── PDFs. Eight states publish this way; these three are the largest. ────
    # "1 Berne Hi-Way Hatchery, Inc. Berne Adams Active"
    {"state": "IN", "kind": "dealer+warehouse", "note": "licensees by county", "route": "pdf",
     "url": "https://www.in.gov/dA/163601981f/Licensees-by-County-06.18.2026.pdf?language_id=1",
     "pattern": r"^\s*(?P<no>\d{1,4})\s+(?P<name>.+)\s+(?P<city>[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*)?)"
                r"\s+(?P<county>[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*)?)\s+"
                r"(?P<status>Active|Inactive|Pending|Expired)\s*$"},
    # "ADVANCED SUNFLOWER LLC BHURON A+VCS" — the permit letter is glued to the
    # town, so the name has to be greedy or the S of SUNFLOWER becomes the permit.
    {"state": "SD", "kind": "dealer+warehouse", "note": "PUC licence list", "route": "pdf",
     "url": "http://puc.sd.gov/commission/warehouse/Grain%20License%20Info.pdf",
     # The Class column is only ever A+VCS, A or B. Accepting any capitalised
     # word as a class is what let "FREDERICK FARMERS ELEVATOR" parse as a
     # company in a town called ARMERS with a class of ELEVATOR.
     "pattern": r"^(?P<name>.+)\s(?P<licence>[BFSW])(?P<city>[A-Z][A-Za-z0-9.'&/-]*"
                r"(?: [A-Z0-9][A-Za-z0-9.'&/-]*)*?)(?:,\s*(?P<st>[A-Z]{2}))?"
                r"\s+(?P<cls>A\+VCS|A|B)\s*$",
     # THIS PATTERN SWALLOWED SIXTY-THREE COMPLETE RECORDS.
     #
     # A continuation is meant to catch the SECOND half of a wrapped licensee —
     # "BHARROLD A+VCS", a location with no name. But the shape of that fragment
     # is also the shape of an ordinary record whose company name simply STARTS
     # with B, F, S or W, and this document has sixty-three of those:
     #
     #     BUNGE USA GRAIN LLC FKIMBALL A+VCS
     #     FREMAR, LLC FCANOVA A+VCS
     #     SUNBIRD, INC BHURON A+VCS
     #
     # Each matched, each was glued onto the line above it, and because the join
     # is sequential a RUN of them collapsed into one line. That is where the
     # 296-character record naming eight businesses across four states came
     # from, and it is why it was pinned on a single town in Indiana.
     #
     # THE TEST IS NOT THE FRAGMENT'S SHAPE, IT IS WHETHER THE LINE IS ALREADY A
     # RECORD. Tightening the character class was the wrong fix and I tried it
     # first: it kept 29 lines and lost every genuine wrap, because no character
     # class can separate "BHARROLD A+VCS" from "BS GRAIN, LLC BGETTYSBURG B" —
     # only the record pattern can, and it already exists two lines up.
     # pdf_records() now refuses to treat any line as a continuation if that
     # line parses as a record on its own. Measured on the committed page: 81
     # lines matched this shape, 18 are genuine wraps, 63 are records.
     "continuation": r"^[BFSW][A-Z][A-Za-z0-9 .,'&/-]*\s+(?:A\+VCS|A|B)$",
     "cityStrip": r"-\d+$"},

    # NEBRASKA REFRESHES ITS LIST CONSTANTLY AND PUTS THE DATE IN THE FILENAME,
    # so a hard-coded URL is a scraper with an expiry date on it. The link is
    # discovered from the programme page each run instead. Nebraska is also the
    # only state that prints its own totals on the document — "TOTAL LICENSED
    # GRAIN DEALERS 116" — which is the completeness check for free.
    {"state": "NE", "kind": "dealer", "note": "PSC dealer list", "route": "pdf",
     "url": "https://psc.nebraska.gov/grain", "discover": r"Grain[%20\s]*Dealer[%20\s]*List[^\"']*\.pdf",
     "pattern": r"^(?P<name>.+?)\s+(?P<licence>\d{2,5})\s+(?P<capacity>[\d,]{3,})\s+"
                r"(?P<city>[A-Z][A-Za-z .'&/-]+)[,.]\s*(?P<st>[A-Z]{2})(?:\s+[A-Z]+)?\s*$"},
    {"state": "NE", "kind": "warehouse", "note": "PSC warehouse list", "route": "pdf",
     "url": "https://psc.nebraska.gov/grain", "discover": r"Grain[%20\s]*Warehouse[%20\s]*List[^\"']*\.pdf",
     # A DIFFERENT DOCUMENT ENTIRELY from the dealer list next to it, by the same
     # agency: "19 J. E. MEURET GRAIN CO., INC. BRUNSWICK ANTELOPE". Licence
     # first, no capacity, no state, county instead. Running the dealer's pattern
     # over it returned zero — which is the right failure, and the reason each
     # document gets its own line rather than one clever regex for all of them.
     "pattern": r"^(?P<licence>\d{1,5})\s+(?P<name>.+)\s+(?P<city>[A-Z][A-Z.'&-]*)"
                r"\s+(?P<county>[A-Z][A-Z.'&-]*)\s*$"},]

DUMP_CAP = 600_000     # bytes of each page kept as a fixture
DUMP_PAGES = 2         # first page and the one after it: enough to see the pager

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


LABELS = {"name": "name", "city": "city", "town": "city", "phone": "phone",
          "telephone": "phone", "county": "county", "address": "address",
          "zip": "zip", "state": "st", "capacity": "capacity"}


def pairs_route(groups):
    """The Iowa report is a TWO-COLUMN LABEL/VALUE TABLE — one <tr> per field.

        <tr><td>Name:</td>  <td>A & K Feed & Grain Co., Inc.</td></tr>
        <tr><td>City</td>   <td>Lime Springs</td></tr>
        <tr><td>Phone:</td> <td>563-566-2291</td></tr>
        <tr><td>County:</td><td>Howard</td></tr>

    Not one record per row, which is why the column detector found no phone
    column and kept nothing — and not flat prose either, which is what the
    labelled-text fallback pretends it is. That fallback works, and loses the
    LAST record on every page: it closes a record on the next "Name:", and the
    final one is followed by "Return to Grain Warehouse Bureau" instead. One
    record in 140 — small, permanent, and invisible.

    Reading the pairs is exact, and it goes through HTMLParser, so entities are
    already decoded and "A &amp; K Feed & Grain" cannot leak through the way it
    did on the regex route.
    """
    out = []
    for g in groups:
        two = [r for r in g if len(r) == 2]
        if len(two) < 8 or len(two) < len(g) * 0.5:
            continue
        cur = None
        for label, value in two:
            key = LABELS.get(re.sub(r"[^a-z]", "", (label or "").lower()))
            if not key:
                continue
            value = (value or "").strip()
            if key == "name":
                if cur and cur.get("phone"):
                    out.append(cur)
                cur = {"name": value} if value else None
            elif cur is not None and value:
                cur[key] = value
        if cur and cur.get("phone"):
            out.append(cur)
    return [r for r in out if r.get("name") and len(r["name"]) > 2]


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
    ("%s?PageNum=%%d" % "{u}", 1, 1),
    ("%s?pageNumber=%%d" % "{u}", 1, 1),
    ("%s?page_num=%%d" % "{u}", 1, 1),
    ("%s?paged=%%d" % "{u}", 1, 1),
    ("%s?from=%%d" % "{u}", 25, 0),
    ("%s?per_page=1000&page=%%d" % "{u}", 1, 1),
    ("%spage/%%d/" % "{u}", 1, 1),      # path segment, not a query
]


CSV_KEYS = {
    "name": ("company name", "business name", "licensee", "company", "name", "firm",
             "facility name", "dba", "legal name"),
    "city": ("city", "town", "city/town", "mailing city", "physical city"),
    "county": ("county",),
    "phone": ("phone", "telephone", "phone number", "business phone"),
    "address": ("address", "street", "street address", "mailing address",
                "physical address", "address 1", "address line 1"),
    "zip": ("zip", "zip code", "postal code", "zipcode"),
    "st": ("state", "st"),
    "capacity": ("capacity", "bushel capacity", "licensed capacity", "storage capacity"),
    "licence": ("license", "licence", "license number", "license type", "license no",
                "licence class", "type"),
}


def rows_to_records(header, rows, diag, columns=None):
    """Map an arbitrary column order onto our fields by header name.

    Longest match first, so "Manager Name" cannot win the name column from
    "Company Name" — that mistake threw away every Missouri street address on a
    288-record run.
    """
    idx, used = {}, set()
    lower = [re.sub(r"\s+", " ", (h or "").strip().lower()) for h in header]
    for field, names in CSV_KEYS.items():
        best, bestlen = None, -1
        for i, h in enumerate(lower):
            if i in used or not h:
                continue
            for n in names:
                # A TWO-LETTER SUBSTRING IS NOT EVIDENCE.
                #
                # "st" matched CONTACT_NAME_FIRST on Texas's export and filed
                # DONNA, KEVIN and VICKI as states — because "first" ends in
                # st. It would do the same to last, cost, district, status and
                # street. Measured 2026-09-04 on the sheet itself.
                #
                # A short key has to be the whole header or a whole word in it;
                # a long one may still match loosely, which is what lets
                # "Physical Address 1" answer for "address".
                if len(n) <= 3:
                    hit = (h == n or re.search(r"\b%s\b" % re.escape(n), h) is not None)
                else:
                    hit = (h == n or h.startswith(n) or n in h)
                if hit and len(n) > bestlen:
                    best, bestlen = i, len(n)
        if best is not None:
            idx[field] = best
            used.add(best)
    # A SOURCE MAY STATE ITS OWN MAPPING, and Texas has to.
    #
    # Its headers are UPPER_SNAKE, so "facility name" does not match
    # FACILITY_NAME and only the bare word "name" does -- which lands on
    # CLI_LEGAL_NAME purely because it is the earlier column. That is the right
    # answer (FACILITY_NAME reads "1 APEX GRAIN COMPANY LLC", numbered and
    # truncated, while CLI_LEGAL_NAME is the clean company name) and it is the
    # right answer BY ACCIDENT. A mapping that is correct by column order is a
    # mapping that changes when somebody reorders the export.
    if columns:
        lookup = {h: i for i, h in enumerate(lower)}
        for field, col in columns.items():
            key = re.sub(r"\s+", " ", str(col).strip().lower())
            if key in lookup:
                idx[field] = lookup[key]
            else:
                diag.setdefault("errors", []).append(
                    "this source names a %s column %r and the file has no such header"
                    % (field, col))
        diag["columnsStated"] = dict(columns)
    diag["columnMap"] = [{"rows": len(rows), "map": idx}]
    if "name" not in idx:
        diag.setdefault("errors", []).append("no name column in %s" % lower[:12])
        return []
    out = []
    for r in rows:
        rec = {k: (r[i].strip() if len(r) > i and r[i] else "") for k, i in idx.items()}
        # NOT THE SECOND "Mailing Address". Ohio's export repeats that header —
        # street on one, "TOWN ST 12345" on the other — and reading the second as
        # the facility's town looked like the fix for sixty-two Ohio elevators
        # with no pin. It is the CORPORATE address. Bartlett's Columbus Grove
        # elevator would have been placed in Overland Park, Kansas, and Mennel's
        # Fostoria mill in Decatur, Illinois. Measured before shipping, on the
        # committed file; it never left this machine.
        nm = rec.get("name") or ""
        if len(nm) > 2 and nm.lower() not in CSV_KEYS["name"]:
            out.append(rec)
    return out


def read_csv(body, diag, columns=None):
    """A state that publishes a CSV has done the hard part. Ohio does."""
    import csv as _csv
    import io
    try:
        dialect = _csv.Sniffer().sniff(body[:4096], delimiters=",;\t|")
    except Exception:
        dialect = _csv.excel
    rows = [r for r in _csv.reader(io.StringIO(body), dialect) if any(c.strip() for c in r)]
    if not rows:
        return []
    # THE HEADER IS NOT ALWAYS THE FIRST ROW. Ohio's export opens with a row of
    # `s,s,s,s,s,s` before the real one — so the column mapper was handed six
    # columns all called "s", recognised none of them, and dropped 336 rows.
    # Take the first row in the first ten that actually reads like field names.
    known = {n for names in CSV_KEYS.values() for n in names}
    def score(r):
        return sum(1 for c in r
                   if any(k == c.strip().lower() or k in c.strip().lower() for k in known))
    head = max(range(min(10, len(rows))), key=lambda i: (score(rows[i]), -i))
    if score(rows[head]) < 2:
        head = 0
    diag["headerRow"] = head
    diag["csvColumns"] = rows[head][:14]
    diag["rowsSeen"] = len(rows) - head - 1
    return rows_to_records(rows[head], rows[head + 1:], diag, columns)


def read_xls(raw, diag, columns=None):
    """A legacy .xls, which is what Texas publishes, into the same rows the CSV
    route hands to rows_to_records().

    TEXAS HIDES ITS LIST ONE CLICK DOWN AND THEN SERVES IT AS A SPREADSHEET.
    The programme page at texasagriculture.gov is a page of FORMS -- the
    survey's own row count called its 36 <tr> a table and was wrong. The list
    is behind "Click here for a list of grain warehouses licensed by TDA":

        /Portals/0/Reports/PIR/grain_warehouse.xls?ver=8h5xCiF7GXX...

    READ 2026-09-04 from the copy the survey kept: ONE sheet, 139 data rows,
    fourteen columns. Texas carries 8 rows in this repository's directory
    today.

        ACCT_NUM  EXPIRE_DT  CLI_NUM  CLI_LEGAL_NAME  CLI_DBA
        CONTACT_NAME_*  ATTN_NAME  FACILITY_NAME  COUNTY_NAME

    NO CITY AND NO STREET ADDRESS. County only, which the directory already
    models -- 71 rows sit at county precision. A Texas record is an operator,
    a facility and a county, and it must not pretend to be more than that.

    Nothing is parsed here that the CSV route does not already parse: this
    turns a sheet into a header and rows and hands them straight over, so the
    column mapping, the header-row detection and every guard downstream are
    the same code Ohio goes through."""
    try:
        import xlrd
    except ImportError:
        diag.setdefault("errors", []).append(
            "this source needs xlrd (pip install xlrd) to read a legacy .xls")
        return [], ""
    try:
        book = xlrd.open_workbook(file_contents=raw)
    except Exception as ex:
        diag.setdefault("errors", []).append("xlrd: %s: %s" % (type(ex).__name__, str(ex)[:110]))
        return [], ""
    sheet = book.sheet_by_index(0)
    diag["sheet"] = {"name": sheet.name, "rows": sheet.nrows, "cols": sheet.ncols,
                     "of": book.nsheets}
    if sheet.nrows < 2:
        diag.setdefault("errors", []).append("the sheet has %d row(s)" % sheet.nrows)
        return [], ""
    grid = [[("" if sheet.cell_value(r, c) is None else str(sheet.cell_value(r, c))).strip()
             for c in range(sheet.ncols)] for r in range(sheet.nrows)]
    diag["xlsColumns"] = grid[0][:14]
    diag["rowsSeen"] = len(grid) - 1
    recs = rows_to_records(grid[0], grid[1:], diag, columns)
    # The text kept beside the run, so the next person reads the sheet and not
    # a description of it.
    text = "\n".join(",".join(('"%s"' % c.replace('"', '""')) for c in row) for row in grid)
    return recs, text


def pdf_text(raw, diag):
    """Text out of a PDF, or None with the reason recorded.

    pypdf is a pure-python wheel and installs anywhere; if it is missing the
    run degrades to "this source needs pypdf" rather than failing the state.
    """
    try:
        import io
        from pypdf import PdfReader
    except Exception as ex:
        diag.setdefault("errors", []).append("pdf: pypdf unavailable (%s)" % type(ex).__name__)
        return None
    try:
        r = PdfReader(io.BytesIO(raw))
        diag["pdfPages"] = len(r.pages)
        return "\n".join((p.extract_text() or "") for p in r.pages)
    except Exception as ex:
        diag.setdefault("errors", []).append("pdf: %s" % type(ex).__name__)
        return None


def pdf_records(text, diag, pattern=None, cont=None, citystrip=None):
    """With a pattern, read the document's own shape; without one, fall back to
    lines carrying a phone.

    THE PATTERN BELONGS TO THE DOCUMENT, NOT TO THIS FUNCTION. Three states,
    three completely different line shapes:

        NE  ADVANCED SUNFLOWER, LLC 3070 35,000 HURON, SD
        SD  ADVANCED SUNFLOWER LLC BHURON A+VCS        <- permit letter GLUED on
        IN  1 Berne Hi-Way Hatchery, Inc. Berne Adams Active

    Each is written against the text the run committed and measured against it
    before it ships. The name is GREEDY in all three: non-greedy found the "S"
    of SUNFLOWER as South Dakota's permit letter and read the company as
    "ADVANCED", and it split "Berne Hi-Way Hatchery, Inc." into a name and a
    city called "Inc. Berne".
    """
    lines = [re.sub(r"\s+", " ", l.strip()) for l in (text or "").splitlines() if l.strip()]
    # A RECORD THAT WRAPS ONTO A SECOND LINE IS STILL ONE RECORD.
    # South Dakota's PDF wraps long licensee names, so the document holds
    #     FREDERICK FARMERS ELEVATOR
    #     BHARROLD A+VCS
    # — a name with no location, and a location with no name. Matched one line at
    # a time that produced garbage that LOOKED like data: a company called
    # "FREDERICK" in a town called "ARMERS". Thirty-one of South Dakota's
    # records were shapes like that, and a wrong town is worse than a missing
    # one because it puts a pin somewhere real.
    #
    # AND A LINE THAT IS ALREADY A RECORD IS NEVER A CONTINUATION.
    # The fragment "BHARROLD A+VCS" and the record "BS GRAIN, LLC BGETTYSBURG B"
    # have the same shape, because plenty of companies begin with B, F, S or W.
    # Joining on shape alone glued 63 of South Dakota's own records onto the
    # line above them, and since the join is sequential a run of them collapsed
    # into one: the worst was 296 characters, named eight businesses across four
    # states, and carried a single town in Indiana into the geocoder. The record
    # pattern is the only thing in this file that can tell them apart, so it
    # decides. A genuine wrap has no company name and cannot match it.
    if cont:
        rxc, joined = re.compile(cont), []
        rxr = re.compile(pattern) if pattern else None
        for l in lines:
            if rxc.match(l) and joined and not (rxr and rxr.match(l)):
                joined[-1] += " " + l
            else:
                joined.append(l)
        diag["pdfLinesJoined"] = len(lines) - len(joined)
        lines = joined
    diag["pdfLines"] = len(lines)
    if pattern:
        rx = re.compile(pattern)
        out = []
        for l in lines:
            # THE TOTALS LINE IS NOT A BUSINESS. Nebraska's own
            # "TOTAL LICENSED GRAIN WAREHOUSES 44" — the line the completeness
            # check reads — matched the record pattern and came out as a company
            # called "TOTAL" in a town called "GRAIN".
            if stated_total(l):
                continue
            m = rx.match(l)
            if not m:
                continue
            rec = {k: (v or "").strip() for k, v in m.groupdict().items() if v}
            rec.pop("no", None); rec.pop("cls", None); rec.pop("status", None)
            # Agtegra's locations carry a facility number — "ALPENA-098",
            # "ANDOVER-064". The town is the part a gazetteer has heard of.
            if citystrip and rec.get("city"):
                rec["city"] = re.sub(citystrip, "", rec["city"]).strip()
            _two_word_city(rec)
            if len(rec.get("name", "")) > 2:
                out.append(rec)
        diag["pdfLinesMatched"] = len(out)
        return out
    return _pdf_phone_lines(text, diag)


# Every US state a grain registry names, for the run-together test below.
_STATE_RX = re.compile(r"\b(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]"
                       r"|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b,?")
_NAME_MAX = 90


def _run_together(name):
    """True when a record is several licensees the PDF ran onto one line.

    Two independent signs, either is enough: a name longer than any real one,
    or a name that mentions two states — which happens when the next row's
    "CITY, ST" got glued to this row's name.
    """
    n = (name or "").strip()
    return len(n) > _NAME_MAX or len(_STATE_RX.findall(n)) >= 2


# Words a company name genuinely ends in. Anything else at the end of a name,
# sitting immediately before a one-word city, is more likely the first half of a
# two-word town.
NAME_TAILS = {"INC", "INC.", "LLC", "L.L.C.", "LC", "CO", "CO.", "COMPANY", "CORP",
              "CORP.", "COOP", "CO-OP", "COOPERATIVE", "NON-STOCK", "NONSTOCK",
              "LP", "L.P.", "LTD", "LTD.", "PARTNERSHIP", "ASSOCIATION", "FARMS",
              "GRAIN", "MILLING", "ELEVATOR", "SEED", "FEED", "ENERGY", "AG"}


def _two_word_city(rec):
    """Nebraska's warehouse list is NAME CITY COUNTY with nothing between them,
    so a two-word town is split by whitespace alone and its first word is read
    as the end of the company name:

        ELYS INCORPORATED GUIDE   ROCK    WEBSTER     -> Guide Rock
        ...COOPERATIVE, NON-STOCK BATTLE  CREEK       -> Battle Creek
        RICHARDSON MILLING INC. SO SIOUX  CITY        -> South Sioux City

    Three of forty-four. Nothing here KNOWS which is right — a fixed list of
    Nebraska towns would be inventing data — so both readings are carried and
    the geocoder decides on evidence: "ROCK, NE" does not resolve and "GUIDE
    ROCK, NE" does. Guessing here would put a pin in the wrong county; carrying
    the alternative costs one field.
    """
    name, city = rec.get("name", ""), rec.get("city", "")
    if not name or not city or " " in city:
        return
    tail = name.rsplit(" ", 1)[-1]
    if len(tail) < 2 or tail.upper() in NAME_TAILS or not tail[0].isalpha():
        return
    rec["cityAlt"] = tail + " " + city
    rec["nameAlt"] = name[: -len(tail)].strip()


def _pdf_phone_lines(text, diag):
    """One record per line that carries a phone, which is the only field these
    documents reliably share. THE FIELD MAPPING IS NOT GUESSED HERE — the text
    is dumped alongside the run (debug/registries/*.txt) so the next pass writes
    it against the real document. Ten states publish this way; getting it right
    once is worth more than getting it approximately right eight times."""
    out = []
    for line in (text or "").splitlines():
        line = re.sub(r"\s{2,}", "  ", line.strip())
        if not line or not PHONE.search(line):
            continue
        m = PHONE.search(line)
        before, after = line[:m.start()].strip(" ,-"), line[m.end():].strip(" ,-")
        # "Name  City ST  Zip" is the usual left-hand shape.
        st = re.search(r"\b([A-Z]{2})\b[\s,]*(\d{5})?\s*$", before)
        rec = {"name": before, "phone": m.group(0)}
        if st:
            rec["st"] = st.group(1)
            if st.group(2):
                rec["zip"] = st.group(2)
            rec["name"] = before[:st.start()].strip(" ,-")
        parts = re.split(r"\s{2,}", rec["name"])
        if len(parts) >= 2:
            rec["name"], rec["city"] = parts[0].strip(), parts[-1].strip()
        if after and len(after) < 40:
            rec["county"] = after
        if len(rec["name"]) > 2:
            out.append(rec)
    diag["pdfLinesWithPhone"] = len(out)
    return out


def discover_pdf(page_url, pattern, timeout, diag):
    """Nebraska puts the refresh date in the filename, so the URL changes every
    time the list is republished. Hard-coding it is a scraper with an expiry
    date. Find the link on the programme page instead."""
    try:
        _, body = fetch(page_url, timeout)
    except Exception as ex:
        diag.setdefault("errors", []).append("discover: %s" % type(ex).__name__)
        return None
    hits = re.findall(r'href="([^"]+)"', body)
    rx = re.compile(pattern, re.I)
    for h in hits:
        if rx.search(h):
            u = urllib.parse.urljoin(page_url, unescape(h))
            diag["discovered"] = u
            return u
    diag.setdefault("errors", []).append("discover: nothing on %s matched %s" % (page_url, pattern))
    return None


def fetch_file(src, timeout, diag, dump):
    """A CSV or a PDF: one request, no pagination, and the RAW TEXT IS KEPT.

    Ten of the twenty-two states checked publish a PDF and one publishes a CSV.
    Neither can be parsed well from a guess about its layout, and none of these
    hosts is reachable from the machine this parser is written on — the same
    trap that cost four blind runs on Iowa. So the extracted text is committed
    next to the run and the field mapping is written against the document."""
    url = src["url"]
    if src.get("discover"):
        url = discover_pdf(url, src["discover"], timeout, diag) or ""
        if not url:
            return []
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, status = r.read(), r.status
    except Exception as ex:
        diag.setdefault("errors", []).append("%s: %s" % (type(ex).__name__, str(ex)[:120]))
        return []
    diag["pages"] = [{"url": url, "status": status, "bytes": len(raw)}]

    if src["route"] == "csv":
        text = raw.decode("utf-8-sig", "replace")
        recs = read_csv(text, diag, src.get("columns"))
    elif src["route"] == "xls":
        recs, text = read_xls(raw, diag, src.get("columns"))
        if not text:
            return []
    else:
        text = pdf_text(raw, diag)
        if text is None:
            return []
        recs = pdf_records(text, diag, src.get("pattern"),
                           src.get("continuation"), src.get("cityStrip"))
        told = stated_total(text)
        if told and told[1]:
            diag["statedTotal"] = {"total": told[1]}
            if len(recs) < told[1]:
                diag["INCOMPLETE"] = ("the document says %d and this parse found %d"
                                      % (told[1], len(recs)))

    if dump is not None:
        try:
            dump.mkdir(parents=True, exist_ok=True)
            (dump / (slug(url) + (".csv" if src["route"] in ("csv", "xls") else ".txt"))
             ).write_text(text[:DUMP_CAP], "utf-8")
        except Exception as ex:
            diag.setdefault("errors", []).append("dump: %s" % type(ex).__name__)
    return recs


def fetch_file(src, timeout, diag, dump):
    """A CSV or a PDF: one request, no pagination, and the RAW TEXT IS KEPT.

    Ten of the twenty-two states checked publish a PDF and one publishes a CSV.
    Neither can be parsed well from a guess about its layout, and none of these
    hosts is reachable from the machine this parser is written on — the same
    trap that cost four blind runs on Iowa. So the extracted text is committed
    next to the run and the field mapping is written against the document."""
    url = src["url"]
    if src.get("discover"):
        url = discover_pdf(url, src["discover"], timeout, diag) or ""
        if not url:
            return []
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, status = r.read(), r.status
    except Exception as ex:
        diag.setdefault("errors", []).append("%s: %s" % (type(ex).__name__, str(ex)[:120]))
        return []
    diag["pages"] = [{"url": url, "status": status, "bytes": len(raw)}]

    if src["route"] == "csv":
        text = raw.decode("utf-8-sig", "replace")
        recs = read_csv(text, diag, src.get("columns"))
    elif src["route"] == "xls":
        recs, text = read_xls(raw, diag, src.get("columns"))
        if not text:
            return []
    else:
        text = pdf_text(raw, diag)
        if text is None:
            return []
        recs = pdf_records(text, diag, src.get("pattern"),
                           src.get("continuation"), src.get("cityStrip"))
        told = stated_total(text)
        if told and told[1]:
            diag["statedTotal"] = {"total": told[1]}
            if len(recs) < told[1]:
                diag["INCOMPLETE"] = ("the document says %d and this parse found %d"
                                      % (told[1], len(recs)))

    if dump is not None:
        try:
            dump.mkdir(parents=True, exist_ok=True)
            (dump / (slug(url) + (".csv" if src["route"] in ("csv", "xls") else ".txt"))
             ).write_text(text[:DUMP_CAP], "utf-8")
        except Exception as ex:
            diag.setdefault("errors", []).append("dump: %s" % type(ex).__name__)
    return recs


def slug(url):
    return re.sub(r"[^a-z0-9]+", "-", url.lower()).strip("-")[:80]


def dump_page(dump, url, body, diag, n):
    if dump is None or n >= DUMP_PAGES:
        return
    try:
        dump.mkdir(parents=True, exist_ok=True)
        (dump / (slug(url) + ".html")).write_text(body[:DUMP_CAP], "utf-8")
    except Exception as ex:
        diag.setdefault("errors", []).append("dump: %s" % type(ex).__name__)


STATED_TOTAL = re.compile(r"\b(\d+)\s+out of\s+(\d+)\b", re.I)

# Nebraska prints it on the document instead: "TOTAL LICENSED GRAIN DEALERS 116".
_KINDS = r"(?:DEALERS?|WAREHOUSES?|LICENSEES?|FACILITIES)"
STATED_TOTAL_2 = re.compile(
    r"\bTOTAL\s+(?:NUMBER\s+OF\s+)?(?:LICENSED\s+)?[A-Z ]{0,30}?"
    + _KINDS + r"\s*[:\-]?\s*(\d{1,5})\b", re.I)
# AND WITH THE NUMBER IN FRONT. Nebraska's dealer list says
# "TOTAL LICENSED GRAIN DEALERS 116"; its warehouse list, from the same agency,
# says "43 TOTAL LICENSED GRAIN WAREHOUSES". The second spelling was invisible
# to the check — so that document had no completeness guard at all, AND the
# line parsed as a business called "TOTAL LICENSED" in a town called "GRAIN".
STATED_TOTAL_3 = re.compile(
    r"^\s*(\d{1,5})\s+TOTAL\s+(?:NUMBER\s+OF\s+)?(?:LICENSED\s+)?[A-Z ]{0,30}?"
    + _KINDS + r"\b", re.I | re.M)


def stated_total(body):
    """A source that says how many rows it has is a completeness check for free,
    and the only reason 25-of-251 ever looked like a success is that nobody read
    it. Iowa prints "25 out of 251" under its table; Nebraska prints "TOTAL
    LICENSED GRAIN DEALERS 116" on the PDF. Same guard, two spellings."""
    m = STATED_TOTAL.search(body)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    m = STATED_TOTAL_2.search(body)
    if m:
        return (0, int(m.group(1)))
    m = STATED_TOTAL_3.search(body)
    return (0, int(m.group(1))) if m else None


def post(url, fields, jar, timeout=45):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=data, headers={
        "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
    with op.open(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def get_with(url, jar, timeout=45):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with op.open(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def walk_post(src, pages, timeout, diag, dump):
    """Iowa's licensing lists page by POSTING A RELATIVE OFFSET IN A SESSION.

    Twelve GET spellings were tried against these two lists and every one was
    refused, and the run took 25 of 251 dealers and 25 of 102 warehouses while
    reporting success three times. The page itself says why:

        <form method="post" action="/licensing_lists/graindealers/">
          <input type="hidden" name="offset" id="offset">
        $('#next').click(function() { $('#offset').val(25);  $('#filterBtn').click(); });
        $('#prev').click(function() { $('#offset').val(-25); $('#filterBtn').click(); });

    Next posts +25 and previous posts -25 — a DELTA, not a position. The server
    holds where you are in the session, so the walk needs a cookie jar and a
    POST per page, and no URL will ever produce page two. That is not a
    parameter this project failed to guess; it is a shape it did not have.

    Some servers written this way read the offset as absolute instead. Both are
    tried: if the second POST returns businesses already seen, the walk switches
    to absolute positions and says so in the diagnostic.
    """
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    spec = src["post"]
    delta = int(spec.get("delta", 25))
    field = spec.get("offsetField", "offset")

    try:
        status, body = get_with(src["url"], jar, timeout)
    except Exception as ex:
        diag.setdefault("errors", []).append("post-walk open: %s" % type(ex).__name__)
        return []
    diag.setdefault("pages", []).append({"url": src["url"], "status": status, "bytes": len(body)})
    dump_page(dump, src["url"], body, diag, 0)

    told = stated_total(body)
    if told:
        diag["statedTotal"] = {"shown": told[0], "total": told[1]}

    recs, seen, covered = [], set(), 0
    first_page = keyset(extract(body))       # what "the server ignored the offset" looks like
    for r in extract(body, diag):
        k = (r.get("name", "").lower(), r.get("city", "").lower())
        if k not in seen:
            seen.add(k); recs.append(r)
    diag.setdefault("newPerPage", []).append(len(recs))

    # DELTA FIRST, ABSOLUTE ON THE FIRST STALL — whenever it comes.
    # An earlier version only tried absolute if the FIRST post returned nothing,
    # which a server reading the offset as a position passes: it serves rows
    # 25-49 quite happily and then repeats them forever, because the walk keeps
    # posting the same +25. The switch has to arm on the first stall at any
    # page, and in absolute mode the offset is simply how many rows are already
    # held, which is self-correcting.
    # THE CURSOR IS WHERE THE WALK HAS READ TO, NOT HOW MANY IT KEPT.
    # It was len(recs) — the DEDUPED count — so every repeated row made the
    # offset lag one behind the walk's real position, the next page re-read a
    # row it already had, and the lag compounded. Iowa's dealers came back 24 at
    # a time instead of 25 for eight pages running and the walk finished one row
    # short of the tail: 250 of a stated 251. Advancing by the rows the server
    # actually RETURNED cannot skip a row whether its offset is 0- or 1-based.
    mode, tried_absolute, cursor = "delta", False, 0
    for i in range(1, max(1, pages)):
        fields = dict(spec.get("fields") or {})
        fields[field] = str(delta if mode == "delta" else cursor)
        fields.setdefault("submit", "filter")
        try:
            status, body = post(src["url"], fields, jar, timeout)
        except Exception as ex:
            diag.setdefault("errors", []).append("post %d: %s" % (i, type(ex).__name__))
            break
        diag["pages"].append({"url": "POST %s=%s" % (field, fields[field]),
                              "status": status, "bytes": len(body)})
        dump_page(dump, src["url"] + "-post%d" % i, body, diag, i)
        rows = extract(body, diag)
        # THE ECHO IS RECORDED BEFORE THE LOOP CAN BREAK ON IT.
        # A page identical to the first one is how a server says it is ignoring
        # the offset, and it also yields nothing new — so checking it after the
        # zero-new break meant the flag was never once set on the case it was
        # written for.
        if i > 1 and keyset(rows) == first_page:
            diag.setdefault("offsetIgnoredFrom", fields[field])
        new = 0
        for r in rows:
            k = (r.get("name", "").lower(), r.get("city", "").lower())
            if k in seen:
                continue
            seen.add(k); recs.append(r); new += 1
        diag["newPerPage"].append(new)
        if new == 0:
            if mode == "delta" and not tried_absolute:
                mode, tried_absolute = "absolute", True
                diag["offsetMode"] = "absolute"
                cursor = len(recs)          # first absolute ask: where we are
                continue
            break
        if mode == "absolute":
            cursor += len(rows)
        else:
            cursor = len(recs)
        # COVERAGE IS EVIDENCE, NOT ARITHMETIC. A server that ignores the offset
        # hands back page one forever, and counting those rows as ground covered
        # produced a FALSE ALL-CLEAR on a fixture that truncated at row 150: 173
        # of 251, reported as "the walk read every row". A page identical to the
        # first one is proof of nothing.
        if "offsetIgnoredFrom" not in diag:
            covered = max(covered, cursor)
        if told and covered >= told[1]:
            break
        time.sleep(0.4)
    diag.setdefault("offsetMode", mode)

    # SHORT OF THE STATED TOTAL? ASK FOR THE TAIL DIRECTLY.
    # Walking forward can stall one page from the end for reasons this code
    # cannot see from here. The last page has a known offset, so ask for it
    # rather than giving up: two requests, bounded, and it either finds the
    # missing rows or proves they are not missing.
    if told and len(recs) < told[1] and mode == "absolute":
        for off in (max(0, told[1] - delta), max(0, told[1] - 1)):
            try:
                f = dict(spec.get("fields") or {})
                f[field] = str(off); f.setdefault("submit", "filter")
                _, body = post(src["url"], f, jar, timeout)
            except Exception:
                break
            got = 0
            for r in extract(body, diag):
                k = (r.get("name", "").lower(), r.get("city", "").lower())
                if k in seen:
                    continue
                seen.add(k); recs.append(r); got += 1
            tail = keyset(extract(body))
            echoed = tail == first_page
            diag.setdefault("tailSweep", []).append(
                {"offset": off, "new": got, "gotPageOneBack": echoed})
            if not echoed and tail:
                # The server honoured an offset at the end of the list, so the
                # tail exists and was read.
                covered = max(covered, told[1])
            if len(recs) >= told[1]:
                break
            time.sleep(0.4)
    diag["covered"] = covered
    if told and len(recs) < told[1]:
        # TWO DIFFERENT FAILURES, AND ONLY ONE OF THEM IS A FAILURE.
        # If the walk read past the stated total and still holds fewer unique
        # businesses, no row was missed — two licensees share a name and a town
        # and collapsed on the dedup key. If it never got that far, rows were
        # genuinely lost. Reporting both as "INCOMPLETE" would cry wolf until
        # nobody reads it.
        if covered >= told[1]:
            diag["shortButCovered"] = (
                "the page says %d and %d unique businesses came back; the walk read "
                "every row, so the difference is names repeating in the same town"
                % (told[1], len(recs)))
        else:
            diag["INCOMPLETE"] = ("the page says %d, this walk took %d and only read as "
                                  "far as row %d" % (told[1], len(recs), covered))
    return recs


def keyset(records):
    return {(r.get("name", "").strip().lower(), r.get("city", "").strip().lower())
            for r in records if r.get("name")}


def probe_pagination(url, timeout, diag):
    """Return (url_format, step, base) for whatever actually turns the page.

    A parameter that changes nothing is worse than no parameter: it produces a
    confident run that quietly holds a tenth of the data.

    IT COMPARES THE BUSINESSES, NOT THE BYTES. Missouri answered yes to the
    FIRST spelling offered and the diagnostic recorded `?page=` as working —
    because Incapsula stamps a fresh `cb=` nonce into one script tag on every
    response, so every page differs from every other page and any parameter
    "works". The page has 304 rows, one table and no pager anywhere in it. A
    nonce, a timestamp, a CSRF token or an analytics id defeats a byte
    comparison outright; the set of names and towns does not.
    """
    try:
        _, first = fetch(url, timeout)
    except Exception as ex:
        diag.setdefault("errors", []).append("probe: %s" % type(ex).__name__)
        return None
    firstkeys = keyset(extract(first))
    tried = []
    for tmpl, step, base in PAGE_PARAMS:
        fmt = tmpl.replace("{u}", url)
        try:
            _, second = fetch(fmt % (base + step), timeout)
        except Exception as ex:
            tried.append({"param": fmt, "error": type(ex).__name__})
            continue
        fresh = keyset(extract(second)) - firstkeys
        moved = bool(fresh)
        tried.append({"param": fmt % (base + step), "bytes": len(second),
                      "bytesDiffer": second != first, "newBusinesses": len(fresh),
                      "changed": moved})
        if moved:
            diag["pagination"] = {"works": fmt, "step": step, "base": base, "tried": tried}
            return fmt, step, base
        time.sleep(0.3)
    diag["pagination"] = {"works": None, "tried": tried,
                          "note": "nothing turned the page; only the first page was read"}
    return None


COUNTY_TAIL = re.compile(r",\s*[A-Za-z]{2}\.?\s*$")


OUT_OF_STATE = re.compile(r"^\s*out[\s-]*of[\s-]*state\s*$", re.I)


def mark_out_of_state(rec):
    """A state's list is who it LICENSES, not who is inside its borders.

    Iowa writes "out-of-state" in the county column for a business licensed to
    buy Iowa grain from somewhere else, and thirty-one of them were being
    counted as Iowa elevators and looked for in the Iowa gazetteer: Lighthouse
    Commodities of Bismarck (701 = North Dakota), Viserion of Boulder, Bunge of
    Chesterfield (314 = Missouri). They never resolved, which is the right
    outcome for the wrong reason — the town is fine, it is simply not in Iowa.

    So the licensing state is kept as `licensedBy` and `state` is emptied rather
    than guessed. Nothing here knows where Boulder is; the phone's area code is
    a hint, not an address. An unplaced pin is honest. A pin in the wrong state
    is not, and neither is a state count inflated by thirty-one businesses that
    are somewhere else.
    """
    if OUT_OF_STATE.match(str(rec.get("county") or "")):
        rec["outOfState"] = True
        rec["licensedBy"] = rec.get("state") or rec.get("licensedBy")
        rec["county"] = None
        rec["st"] = ""                       # do not claim the licensing state
    return rec


def clean_county(v):
    """Missouri writes the county as "Clinton, MO". The state is already its
    own column; repeating it inside the county turns every county key into a
    string no other state's list will ever match."""
    return COUNTY_TAIL.sub("", (v or "").strip()).strip(" ,")


def mark_truncation(recs, diag):
    """Missouri cuts every company name at forty characters.

    Twenty-six names sit at EXACTLY forty and not one exceeds it, and the cuts
    land mid-word — "Consolidated Grain & Barge Co. - Cottonw". What gets lost
    is the town suffix, which is the only thing separating six sibling
    facilities of the same company, so a name key built from this field silently
    collapses them.

    Where the cut tail is a prefix of the city we already hold, the name is
    completed from that city and stamped `nameRepaired`. Where it is not —
    "Cottonw" against a city of Caruthersville, because the facility is
    Cottonwood Point — nothing is guessed. It stays truncated and flagged, and
    the flag is what stops the dedup from trusting it.
    """
    if not recs:
        return
    widest = max(len(r.get("name") or "") for r in recs)
    atmax = [r for r in recs if len(r.get("name") or "") == widest]
    if widest < 20 or len(atmax) < 5:
        return                                  # a long name, not a cut column
    diag["nameTruncatedAt"] = widest
    diag["namesAtWidth"] = len(atmax)
    repaired = 0
    for r in atmax:
        r["nameTruncated"] = True
        name, city = r.get("name") or "", (r.get("city") or "").strip()
        if not city:
            continue
        # The separator is not always a dash: "Farmers Elevator & Supply Co. of
        # Hawk Po" is cut after a plain "of". So take the LONGEST suffix of the
        # name that is a proper prefix of the city and begins at a word break.
        cut = None
        for k in range(len(name), 2, -1):
            tail = name[-k:]
            if not city.lower().startswith(tail.lower()) or len(city) <= len(tail):
                continue
            before = name[-k - 1] if len(name) > k else ""
            if before and not (before.isspace() or before in "-,.&/"):
                continue
            cut = k
            break
        if cut:
            r["name"] = name[: len(name) - cut] + city
            r["nameRepaired"] = "city"
            r.pop("nameTruncated", None)
            repaired += 1
    diag["namesRepairedFromCity"] = repaired


def extract(body, diag=None):
    """Every record this page yields, by whichever route reads more of it.

    Factored out of the fetch loop so the PAGINATION PROBE can call it. The
    probe used to ask whether the body changed, and agriculture.mo.gov answered
    yes to every spelling it was offered — because Incapsula stamps a fresh
    `cb=` nonce into one script tag on every response. A page with a nonce, a
    timestamp, a CSRF token or an analytics id defeats a byte comparison
    outright, and the first parameter tried wins by accident. Records are the
    only honest signal: if page two holds the same businesses, it is page one.
    """
    diag = {} if diag is None else diag
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
        # A PHONE IS THE BEST KEY, NOT AN ENTRY REQUIREMENT.
        # This said `if "phone" not in idx: continue`, written when the only two
        # states in the table were Iowa and Missouri, which both publish one.
        # Most states do not. North Dakota's register parsed perfectly — 286
        # rows, name/county/city/zip all mapped — and every record was thrown
        # away for want of a column North Dakota does not have. Arkansas too,
        # and Ohio, and all three PDFs: five of six new states returned zero for
        # this one reason.
        if "name" not in idx or not ({"city", "county", "address"} & set(idx)):
            continue                            # not the data table
        # ONE CELL PER ROW IS NOT A TABLE. When the phone column and the
        # name column are the same index, every "record" is the entire line
        # — "Name: ADM Grain Company City Clinton Phone: ..." — and the
        # business name comes out as the whole sentence. That parsed as
        # seven confident records on the Iowa report fixture, which is
        # exactly the kind of success that hides a failure.
        if "phone" in idx and idx.get("phone") == idx.get("name"):
            continue
        maps.append({"rows": len(g), "map": idx})
        for r in g:
            if "phone" in idx and len(r) > idx["phone"] and not PHONE.search(
                    r[idx["phone"]] or ""):
                continue                        # header or spacer row
            rec = {k: (r[i].strip() if len(r) > i else "") for k, i in idx.items()}
            # "Phone:" arrived as a business name from a header row that
            # happened to carry a phone-shaped cell. A name that is a bare
            # label, or two characters long, is not a business.
            nm = (rec.get("name") or "").strip()
            # With no phone to prove a row is data, the header row walks straight
            # through as a business called "Company Name".
            if nm.lower() in {(h or "").strip().lower() for h in p.headers}:
                continue
            if nm and len(nm) > 2 and not nm.rstrip(":").lower() in (
                    "name", "phone", "city", "county", "company", "address", "state",
                    "zip", "licensee", "license no", "license number", "company name",
                    "office city", "grain licensee name", "status", "no."):
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
    pairs = pairs_route(groups)
    if len(pairs) > len(got):
        diag["parsedVia"] = "label/value pairs (%d) beat the table route (%d)" % (len(pairs), len(got))
        got = pairs

    flat = None
    if len(got) < max(5, p_rows_seen // 5):
        flat = label_split(re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", body))))
    if flat is not None and len(flat) > len(got):
        diag["parsedVia"] = "labelled text (%d) beat the table route (%d)" % (len(flat), len(got))
        got = flat
    elif got:
        diag.setdefault("parsedVia", "table")
    elif flat:
        got = flat
        diag["parsedVia"] = "labelled text, not a table"
    if not got:
        diag["firstRowRaw"] = (p.rows[0] if p.rows else body[:400])
    return got


def scrape(src, pages, timeout, verbose, dump=None):
    """Returns (records, diagnostic). Never raises: one dead list must not cost
    the other two."""
    diag = {"url": src["url"], "kind": src["kind"], "note": src["note"],
            "route": src.get("route", "html")}

    if src.get("route") in ("csv", "pdf"):
        recs = fetch_file(src, timeout, diag, dump)
        for r in recs:
            r["kind"] = src["kind"]
            if r.get("county"):
                r["county"] = clean_county(r["county"])
        mark_truncation(recs, diag)
        diag["kept"] = len(recs)
        if verbose and recs:
            diag["sample"] = recs[:3]
        return recs, diag

    if src.get("post"):
        recs = walk_post(src, pages, timeout, diag, dump)
        for r in recs:
            r["kind"] = src["kind"]
            if r.get("county"):
                r["county"] = clean_county(r["county"])
        mark_truncation(recs, diag)
        diag["kept"] = len(recs)
        if verbose and recs:
            diag["sample"] = recs[:3]
        return recs, diag
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
            # START WHERE THE PROBE PROVED IT MOVED, NOT AT ONE.
            # Missouri's `?page=2` was measured as a different page and then
            # never fetched: the loop began at `?page=1`, which IS the base
            # page, contributed nothing new, and the zero-new guard broke out
            # before page two was ever asked for. The probe reads
            # `base + step`; so does the first URL after it.
            fmt, step, base = param
            urls += [fmt % (base + step * i) for i in range(1, pages)]

    seen, recs, dumped = set(), [], 0
    for u in urls:
        try:
            status, body = fetch(u, timeout)
        except Exception as ex:
            diag.setdefault("errors", []).append("%s: %s" % (type(ex).__name__, str(ex)[:120]))
            break
        diag.setdefault("pages", []).append({"url": u, "status": status, "bytes": len(body)})
        if True:
            # THE HOSTS ARE UNREACHABLE FROM WHERE THIS PARSER IS WRITTEN.
            # idalsdata.org, data.iowaagriculture.gov and agriculture.mo.gov
            # are all blocked from the machine that writes this file, so every
            # parser fix has been a guess posted into CI and read back from a
            # log. Committing the page itself turns that into a fixture: one
            # run, then the markup can be read directly and the next fix is
            # measured before it ships. Public pages, no key, no header.
            dump_page(dump, u, body, diag, dumped)
            dumped += 1
        got = extract(body, diag)
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
    for r in recs:
        if r.get("county"):
            r["county"] = clean_county(r["county"])
    mark_truncation(recs, diag)
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
    ap.add_argument("--dump-dir", default="", help="write each fetched page here as a fixture")
    ap.add_argument("--post-walk", action="store_true",
                    help="with --probe-url, page by POSTing an offset in a session")
    ap.add_argument("--probe-url", default="",
                    help="scrape this one URL and print {records, diagnostic} as JSON; "
                         "how the pagination behaviour is tested against a real server")
    a = ap.parse_args()

    if a.fixture:
        # IT CALLS extract(), NOT A COPY OF IT. This branch used to re-implement
        # the route selection, so it could — and did — report a different winner
        # than the run it was meant to predict. One code path, one answer.
        body = Path(a.fixture).read_text(errors="replace")
        p = Tables()
        p.feed(body)
        diag = {}
        recs = extract(body, diag)
        print("fixture: %d tables, %d rows, headers %s"
              % (p.tables, len(p.rows), p.headers[:8]))
        print("   route: %s" % diag.get("parsedVia", "nothing parsed"))
        print("   column map: %s" % json.dumps(diag.get("columnMap"))[:200])
        told = stated_total(body)
        if told:
            print("   the page says: %d out of %d" % told)
        print("   %d records" % len(recs))
        for r in recs[:3]:
            print("      %s" % r)
        return 0

    dump = Path(a.dump_dir) if a.dump_dir else None
    if dump and not dump.is_absolute():
        dump = ROOT / a.dump_dir

    if a.probe_url:
        probe_src = {"state": "XX", "kind": "dealer", "note": "probe", "url": a.probe_url}
        if a.post_walk:
            probe_src["post"] = {"fields": {"name": "", "location": "", "county": "All",
                                            "submit": "filter"},
                                 "offsetField": "offset", "delta": 25}
        else:
            probe_src["paginate"] = True
        recs, diag = scrape(probe_src,
                            a.pages, a.timeout, verbose=False, dump=dump)
        print(json.dumps({"records": len(recs), "diagnostic": diag}))
        return 0
    want = {x.strip().upper() for x in a.states.split(",") if x.strip()}
    allrecs, diags = [], []
    for src in SOURCES:
        if want and src["state"] not in want:
            continue
        recs, diag = scrape(src, a.pages, a.timeout, verbose=True, dump=dump)
        diag["state"] = src["state"]
        diags.append(diag)
        note = ""
        if not recs:
            note = "   ** nothing parsed, see the diagnostic **"
        elif diag.get("INCOMPLETE"):
            # THE FAILURE THAT LOOKED LIKE A SUCCESS FOR THREE RUNS.
            # 25 of 251 printed as "-> 25 records" and nothing else. A source
            # that publishes its own total is checked against it, out loud.
            note = "   ** INCOMPLETE: %s **" % diag["INCOMPLETE"]
        print("%-3s %-16s %-52s -> %d records%s"
              % (src["state"], src["kind"], src["url"][:52], len(recs), note))
        for r in recs:
            r["state"] = src["state"]
            # AFTER the state is stamped, not before. Called from scrape() this
            # read r["state"] before main() had put it there, so licensedBy came
            # out null on all 31 records and the state stayed "IA" — the flag was
            # set and neither thing it was for actually happened. Shipped and
            # ineffective, which is worse than not shipped: the count looked
            # corrected and was not.
            mark_out_of_state(r)
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
                                  # `or` fell through an empty st straight back to
                                  # the licensing state, which is the thing being
                                  # corrected. None means "we do not know", and it
                                  # has to survive the chain.
                                  "state": (None if r.get("outOfState")
                                            else (r.get("st") or r.get("state") or "").upper()),
                                  "address": r.get("address") or None,
                                  "zip": (str(r.get("zip") or "")[:5] or None),
                                  "capacity": r.get("capacity") or None,
                                  "licenceClass": r.get("licence") or None,
                                  "nameTruncated": bool(r.get("nameTruncated")) or None,
                                  "nameRepaired": r.get("nameRepaired"),
                                  # COMPUTED AND THEN DROPPED. cityAlt was being
                                  # worked out correctly and left behind here, so
                                  # every record reached the geocoder with alt=None
                                  # and 42 elevators in two-word towns got no pin.
                                  # The same shape of bug as nameTruncated: a field
                                  # list that has to be edited in two places.
                                  "outOfState": r.get("outOfState") or None,
                                  "licensedBy": r.get("licensedBy"),
                                  "cityAlt": r.get("cityAlt"),
                                  "nameAlt": r.get("nameAlt"),
                                  "licences": [],
                                  "source": "registry-%s" % (r.get("state") or "").lower()})
        for lic in str(r.get("kind") or "").split("+"):
            if lic and lic not in e["licences"]:
                e["licences"].append(lic)
        for f in ("phone", "county", "address", "capacity"):
            if not e.get(f) and r.get(f):
                e[f] = r[f]

    out = sorted(merged.values(), key=lambda e: (e.get("state") or "", e.get("city") or "", e.get("name") or ""))
    # ── A RUN-TOGETHER RECORD IS NOT A BUSINESS, AND IT IS NOT DROPPED EITHER
    #
    # The joiner fix above closes the way these were made — the eleven known
    # mashed names all disappear at the source. This stays as a BACKSTOP,
    # because a PDF that changes shape can make new ones and nothing downstream
    # can tell a mashed name from a merely long one.
    #
    # THE THRESHOLD IS MEASURED, NOT PICKED. Operator-name length across the
    # 1,832 geocoded registry records runs 24 at the median, 36 at the ninetieth
    # and 61 at the ninety-ninth — and 395 at the top. Past ninety characters, or
    # naming two states at once, is nowhere near an honest licensee name. On the
    # committed South Dakota page it now catches nothing, which is what a
    # backstop behind a working fix is supposed to do.
    #
    # They are REPORTED, not silently discarded: a quiet drop tells the next
    # reader the registry is smaller than it is.
    mashed = [e for e in out if _run_together(e.get("name"))]
    if mashed:
        out = [e for e in out if not _run_together(e.get("name"))]
        print("\n%d REGISTRY ROWS ARRIVED WITH SEVERAL LICENSEES RUN TOGETHER "
              "and were not written:" % len(mashed))
        for e in mashed:
            print("   %-4s %s…" % (e.get("licensedBy") or e.get("state") or "?",
                                   (e.get("name") or "")[:88]))

    # A COUNT WITH A KEY CALLED "null" IS A COUNT NOBODY CAN READ.
    # Emptying the state on an out-of-state licensee was right; letting the
    # tally print {"null": 31} alongside real state codes was not. They are
    # counted apart, under a name that says what they are.
    per_state, no_state = {}, 0
    for e in out:
        if not e.get("state"):
            no_state += 1
            continue
        per_state[e["state"]] = per_state.get(e["state"], 0) + 1
    counts = {"businesses": len(out),
              # Licensed by a state, located somewhere else, and the state's own
              # list says so. Not in byState, because they are not in that state.
              "licensedButLocatedElsewhere": no_state,
              "incompleteSources": [{"url": d["url"], "state": d.get("state"),
                                     "why": d["INCOMPLETE"]} for d in diags
                                    if d.get("INCOMPLETE")],
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

    short = [d for d in diags if d.get("INCOMPLETE")]
    if short:
        print("\nINCOMPLETE SOURCES — each of these publishes a total this run did not reach:")
        for d in short:
            print("   %-3s %-58s %s" % (d.get("state"), d["url"][:58], d["INCOMPLETE"]))

    print("\n%d businesses  %s" % (len(out), json.dumps(per_state)))
    if no_state:
        print("   plus %d licensed by a state but located elsewhere — their own "
              "list says so, so they are not counted in any state" % no_state)
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

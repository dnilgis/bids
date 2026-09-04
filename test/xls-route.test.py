#!/usr/bin/env python3
"""TEXAS PUBLISHES A SPREADSHEET, AND A PERSON'S FIRST NAME IS NOT A STATE.

Texas hides its licensed grain warehouses one click below a page of forms and
serves them as a legacy .xls. 139 rows, against the EIGHT this repository
carried for Texas before it was read.

Two things are pinned here.

1. THE ROUTE. read_xls() turns a sheet into a header and rows and hands them to
   the same rows_to_records() Ohio's CSV goes through, so the column mapping,
   the header detection and every guard downstream are one implementation.

2. THE MATCH THAT WAS TOO LOOSE. CSV_KEYS maps "st" onto a state column by
   substring, and "st" is inside "CONTACT_NAME_FIRST". On the real sheet that
   filed DONNA, KEVIN and VICKI as states. It would do the same to last, cost,
   district, status and street on any other export.

    python test/xls-route.test.py
"""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fr", ROOT / "scripts" / "fetch_registries.py")
fr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fr)

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


# ── a short key must be a whole word ──────────────────────────────────────
def mapped(header, row=None):
    d = {}
    fr.rows_to_records(header, [row or ["x"] * len(header)], d)
    return d["columnMap"][0]["map"]


m = mapped(["ACCT_NUM", "CLI_LEGAL_NAME", "CONTACT_NAME_FIRST", "COUNTY_NAME"])
check("st" not in m,
      "a person's first name is still being mapped to the state column: %s" % m)
check(m.get("name") == 1, "the legal name column was not found: %s" % m)
check(m.get("county") == 3, "the county column was not found: %s" % m)

# The same trap in every other shape it takes.
for header in (["Name", "Last Name", "County"], ["Name", "Street", "County"],
               ["Name", "District", "County"], ["Name", "Status", "County"],
               ["Name", "Cost Centre", "County"]):
    check("st" not in mapped(header),
          "%r maps a state column that is not one" % header[1])

# AND A REAL STATE COLUMN MUST STILL BE FOUND, in both spellings states use.
check(mapped(["Company Name", "City", "State", "Zip"]).get("st") == 2,
      "a column called State is no longer the state")
check(mapped(["Name", "St", "County"]).get("st") == 1,
      "a column called St is no longer the state")
# A long key still matches loosely — this is what lets "Physical Address 1"
# answer for "address", and Missouri's 288 records depend on it.
check(mapped(["Business Name", "Physical Address 1", "City"]).get("address") == 1,
      "a long key stopped matching loosely and Missouri's addresses are gone")

# ── a source may state its own mapping ────────────────────────────────────
d = {}
fr.rows_to_records(["CLI_LEGAL_NAME", "FACILITY_NAME", "COUNTY_NAME"],
                   [["ACME GRAIN INC", "1 ACME GRAIN INC (R", "HILL"]], d,
                   {"name": "cli_legal_name", "county": "county_name"})
got = d["columnMap"][0]["map"]
check(got.get("name") == 0,
      "the stated name column was ignored — FACILITY_NAME reads '1 ACME GRAIN INC (R', "
      "numbered and truncated, and would be filed as the company")
check(d.get("columnsStated"), "the source's stated mapping is not recorded in the diagnostics")
# A stated column that does not exist must SAY so rather than silently fall
# back to whatever the guesser found.
d2 = {}
fr.rows_to_records(["NAME", "COUNTY_NAME"], [["A", "B"]], d2, {"city": "town_name"})
check(any("town_name" in e for e in d2.get("errors", [])),
      "a source named a column the file does not have and nothing said so")

# ── the route, against the sheet Texas actually served ────────────────────
XLS = ROOT / "debug" / "registries" / "survey" / "tx-the-licensee-list-xls.html"
if XLS.exists():
    try:
        import xlrd  # noqa: F401
    except ImportError:
        print("xlrd is not installed; the sheet checks are skipped")
    else:
        src = [s for s in fr.SOURCES if s["state"] == "TX"][0]
        check(src.get("route") == "xls", "the Texas source is no longer on the xls route")
        diag = {}
        recs, text = fr.read_xls(XLS.read_bytes(), diag, src.get("columns"))
        check(len(recs) == 139,
              "the Texas sheet gave %d records, not the 139 it held on 2026-09-04" % len(recs))
        check(diag["sheet"]["cols"] == 14, "the sheet's shape changed: %s" % diag["sheet"])
        check(not diag.get("errors"), "errors reading the sheet: %s" % diag.get("errors"))
        first = recs[0]
        check(first.get("name") == "WEST GRAIN INC", "first record: %s" % first)
        check(first.get("county") == "MCLENNAN", "first record: %s" % first)
        # NO CITY AND NO STREET. Texas gives a county and nothing finer, and a
        # record must not claim better than the document it came from.
        check(not first.get("city"), "a city appeared from a sheet that has no city column")
        check(not first.get("address"), "an address appeared from a sheet that has none")
        check(not first.get("st"), "a state appeared from a sheet that has no state column")
        # THE TEXT IS KEPT, because the next person reads the sheet and not a
        # description of it — the same rule the CSV and PDF routes follow.
        check(text and "CLI_LEGAL_NAME" in text.splitlines()[0],
              "read_xls kept no text for the run to commit")
        check(len(text.splitlines()) == 140, "the kept text is not the whole sheet")
else:
    print("no captured Texas sheet at %s; the route checks are skipped" % XLS)

# ── a missing reader loses the state loudly, not silently ─────────────────
check("needs xlrd" in (ROOT / "scripts" / "fetch_registries.py").read_text(),
      "a missing xlrd would fail without saying what is missing")
# COMMENTS ARE NOT COVERAGE — the fourth time today. Checking that the string
# "xlrd" appears in the workflow passed with the install line reverted, because
# the comment I wrote above it names the package. Match the run: line.
import re as _re
WF = (ROOT / ".github" / "workflows" / "registries.yml").read_text()
check(_re.search(r"run:\s*pip install[^\n]*\bxlrd\b", WF),
      "the workflow's pip line does not install xlrd, so the Texas route cannot run there")

# AND EVERY WORKFLOW THAT RUNS THIS FILE, NOT JUST THE ONE I WAS THINKING OF.
#
# This guard checked registries.yml and stopped. test.yml runs the whole
# python glob — including this file — and installed only zipcodes and pypdf,
# so on the backstop that exists to make sure no guard goes unrun, the Texas
# and Wisconsin checks skipped themselves and the tick went green anyway.
# A skip that reports success is the same defect as a guard that never runs.
_WFDIR = ROOT / ".github" / "workflows"
for _wf in sorted(_WFDIR.glob("*.yml")):
    _t = _wf.read_text()
    # does it run test/*.test.py as a glob, or name this file?
    _runs_me = ("test/*.test.py" in _t) or ("xls-route.test.py" in _t)
    if not _runs_me:
        continue
    check(_re.search(r"run:\s*pip install[^\n]*\bxlrd\b", _t),
          "%s runs this guard and does not install xlrd — the Texas and "
          "Wisconsin checks will skip themselves and the run will be green"
          % _wf.name)

# ── the wiring, not the rule ──────────────────────────────────────────────
#
# read_xls() being correct says nothing about whether anything calls it. FOUR
# times this repository has shipped a correct, tested function that nothing
# invoked, and Texas was the fourth: 63,998 bytes fetched at status 200 and
# handed to the HTML reader. tables: 0. rowsSeen: 0. firstRowRaw a wall of
# U+FFFD. read_xls() was perfect and unreachable.
#
# There were THREE places the word "xls" had to appear and I had written two.
SRC = (ROOT / "scripts" / "fetch_registries.py").read_text()

# ONE FETCHER. fetch_file() was in this file twice, byte for byte, the second
# copy shadowing the first — and the guard that stood here asked for TWO of
# each string, which meant it REQUIRED the duplication rather than catching
# it. Every edit to the first copy was dead on arrival.
check(SRC.count("def fetch_file(") == 1,
      "fetch_file() is defined %d times; the later definition wins and the "
      "earlier one is dead code that still reads correctly to a grep"
      % SRC.count("def fetch_file("))

check(SRC.count('src["route"] == "xls"') == 1,
      "the xls branch is in %d place(s) in the one fetcher"
      % SRC.count('src["route"] == "xls"'))
check(SRC.count('(".csv" if src["route"] in ("csv", "xls")') == 1,
      "the fetcher does not write an xls run's kept text as .csv")
check(SRC.count('read_xls(raw, diag, src.get("columns"))') == 1,
      "the fetcher does not pass the source's stated columns through")

# AND THE ROUTER. The branch inside the fetcher is worth nothing if the line
# that chooses the fetcher does not name the route. Read the tuple off the
# code and require every non-html route ROUTES declares.
_router = _re.search(r'src\.get\("route"\)\s+in\s+\(([^)]*)\)', SRC)
check(_router is not None,
      'the router line `src.get("route") in (...)` is gone from fetch_registries')
_dispatched = set(_re.findall(r'"([a-z]+)"', _router.group(1)) if _router else [])
for _r in fr.ROUTES:
    if _r == "html":
        continue
    check(_r in _dispatched,
          'ROUTES declares "%s" and the router sends only %s to the file '
          "fetcher — a %s source would be fetched and then read as HTML"
          % (_r, ", ".join(sorted(_dispatched)) or "nothing", _r))
check("sheet_by_index(0)" in SRC,
      "read_xls no longer takes the FIRST sheet — a workbook's later sheets are "
      "whatever the author left there")

# ── the stated mapping must be stated ─────────────────────────────────────
#
# On the sheet Texas serves today, dropping the "columns" key changes nothing:
# the bare word "name" lands on CLI_LEGAL_NAME because it is the earlier
# column. That is the right answer BY ACCIDENT, and the accident lasts exactly
# until somebody reorders the export. The declaration is the point.
tx = [s for s in fr.SOURCES if s["state"] == "TX"][0]
check(tx.get("columns", {}).get("name") == "cli_legal_name",
      "the Texas source no longer states which column is the company name")
check(tx.get("columns", {}).get("county") == "county_name",
      "the Texas source no longer states which column is the county")
# And a stated mapping must actually beat what the guesser would have picked.
d3 = {}
fr.rows_to_records(["FACILITY_NAME", "CLI_LEGAL_NAME"],
                   [["1 ACME (R", "ACME GRAIN INC"]], d3,
                   {"name": "cli_legal_name"})
check(d3["columnMap"][0]["map"].get("name") == 1,
      "the guesser won over the stated mapping")

# ── one cell, three fields ────────────────────────────────────────────────
#
# Wisconsin's DATCP export heads a column "City, State & Zip Code" and fills it
# "Independence, WI 54747" — the town, the state and the ZIP that every other
# source gives separately and that geocoding needs separately.
sp = fr.split_city_state_zip
check(sp({"city": "Independence, WI 54747"})
      == {"city": "Independence", "st": "WI", "zip": "54747"},
      "the plain case does not split")
check(sp({"city": "Sioux Falls, SD 57104-1234"})["zip"] == "57104-1234", "ZIP+4 is lost")
# A REAL ROW WITH THE SPACE MISSING. "La Farge, WI54639" is in the file.
check(sp({"city": "La Farge, WI54639"}) == {"city": "La Farge", "st": "WI", "zip": "54639"},
      "a missing space between state and ZIP loses a real Wisconsin town")
# AND THE TWO LETTERS MUST BE A STATE. With the space optional, "…AB12345"
# would split as happily as "…WI54639".
check(sp({"city": "Somewhere, AB12345"}) == {"city": "Somewhere, AB12345"},
      "two letters that are not a state were forced into one")
check(sp({"city": "Montreal, Quebec H2Y 2G3"})["city"] == "Montreal, Quebec H2Y 2G3",
      "a Canadian address was mangled into a US one")
check(sp({"city": "Saskatoon, SK"})["city"] == "Saskatoon, SK", "SK is not a US state")
check(sp({"city": "Davenport"})["city"] == "Davenport",
      "a bare town gained a state it never had")
# IT FILLS GAPS AND NEVER OVERWRITES. A source with its own state column keeps it.
check(sp({"city": "Ames, IA 50010", "st": "NE", "zip": "68025"})
      == {"city": "Ames", "st": "NE", "zip": "68025"},
      "the combined cell overwrote a state the file stated in its own column")
check(sp({}) == {} and sp({"city": ""}) == {"city": ""}, "an empty record is not left alone")

# ── Wisconsin, against the file DATCP actually publishes ──────────────────
WI = ROOT / "fixtures" / "registry-wi-datcp.xls"
if WI.exists():
    try:
        import xlrd  # noqa: F811
    except ImportError:
        print("xlrd is not installed; the Wisconsin checks are skipped")
    else:
        wsrc = [s for s in fr.SOURCES if s["state"] == "WI"][0]
        check(wsrc.get("route") == "xls", "Wisconsin is not on the xls route")
        # STATED, NOT GUESSED — the same accident as Texas. On this file the
        # guesser happens to land on the right columns, and it does so because
        # of where they sit. "Legal Name of Entity" is not "name" by any rule;
        # it wins because nothing else matches better today.
        for field, col in (("name", "legal name of entity"),
                           ("address", "mailing address"),
                           ("city", "city, state & zip code")):
            check(wsrc.get("columns", {}).get(field) == col,
                  "Wisconsin no longer states which column is the %s" % field)
        wd = {}
        wrecs, _ = fr.read_xls(WI.read_bytes(), wd, wsrc.get("columns"))
        check(len(wrecs) == 210,
              "Wisconsin gave %d records, not the 210 in the file dated 4 May 2026" % len(wrecs))
        # THE BEST-SHAPED SOURCE OF THE LOT: a street address on every row.
        check(sum(1 for r in wrecs if r.get("address")) == 210,
              "a street address went missing — every row in this file has one")
        check(sum(1 for r in wrecs if r.get("st")) == 207,
              "%d rows carry a state; 207 do, and the three that do not are two "
              "Canadian addresses and a bare 'Davenport'"
              % sum(1 for r in wrecs if r.get("st")))
        # TWO ROWS ARE ELEVATORS THIS REPOSITORY ALREADY READS, which is the
        # cheapest confirmation available that this is the right population.
        by = {r["name"]: r for r in wrecs}
        ace = by.get("Ace Ethanol, LLC")
        check(ace and ace.get("city") == "Stanley" and ace.get("zip") == "54768",
              "Ace Ethanol does not match sources/aceethanol-stanley.json: %s" % ace)
        adell = by.get("Adell Cooperative Union")
        check(adell and adell.get("city") == "Adell" and adell.get("st") == "WI",
              "Adell Cooperative — the board the sweep calls 'location 2451' — "
              "did not come back with its town: %s" % adell)
else:
    print("no Wisconsin fixture at %s; those checks are skipped" % WI)

# ── A SLOW HOST IS ASKED TWICE, AND THAT IS TESTED BY BEING SLOW ──────────
#
# Wisconsin's 210 licensees were lost to "URLError: <urlopen error timed out>"
# — a 3 MB workbook that took longer than 45 seconds. The document was fine,
# read_xls() was fine, and we kept nothing because the machine gave up.
#
# The first version of this check was TEXTUAL: it asserted the retry loop's
# source line was present. A mutation that cut the loop back to a single
# attempt passed it, because I had quoted the loop in a comment two lines
# above. So this one starts a server that is genuinely slow on its first
# answer and counts the requests it receives.
def slow_host_is_retried():
    import http.server, socketserver, threading, time, csv, io

    state = {"n": 0}
    body = b"name,city,st,zip\nSLOW GRAIN CO,Chetek,WI,54728\n"

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            state["n"] += 1
            if state["n"] == 1:
                time.sleep(4)          # longer than the 1s first attempt
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = Server(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        diag = {}
        recs = fr.fetch_file(
            {"state": "ZZ", "route": "csv",
             "url": "http://127.0.0.1:%d/slow.csv" % port},
            1, diag, None)
    finally:
        srv.shutdown()

    check(state["n"] == 2,
          "the slow host was asked %d time(s); a first attempt that times out "
          "must be followed by exactly one slower ask" % state["n"])
    check(len(recs) == 1,
          "the second attempt answered and %d record(s) came back" % len(recs))
    check("slowRetry" in diag,
          "nothing in the diagnostics says the answer came late: %s"
          % sorted(diag))
    check(not diag.get("errors"),
          "a run that succeeded on the retry still filed errors: %s"
          % diag.get("errors"))


# AND A REAL FAILURE IS STILL ONE REQUEST. Retrying a 404 would double every
# dead source's cost for nothing.
def a_refusal_is_not_retried():
    import http.server, socketserver, threading

    state = {"n": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            state["n"] += 1
            self.send_error(404)

        def log_message(self, *a):
            pass

    class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = Server(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        diag = {}
        recs = fr.fetch_file(
            {"state": "ZZ", "route": "csv",
             "url": "http://127.0.0.1:%d/gone.csv" % port},
            2, diag, None)
    finally:
        srv.shutdown()

    check(state["n"] == 1,
          "a 404 was asked %d times; only silence earns a second ask"
          % state["n"])
    check(recs == [] and diag.get("errors"),
          "the 404 was not recorded as an error: %s" % diag)


slow_host_is_retried()
a_refusal_is_not_retried()

if fails:
    for f in fails:
        print("FAIL: %s" % f)
    sys.exit(1)
print("xls route: Texas 139 at county precision; Wisconsin 210 with a street address each")

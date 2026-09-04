#!/usr/bin/env python3
"""THE DENOMINATOR OF REGISTRIES, AND THE ARITHMETIC THAT HAS TO CLOSE.

Sig, repeatedly: "what about the rest of the elevators in the country". The
answer is a number, and the number is only honest if nothing in it is
hand-maintained prose that has drifted.

The National Agricultural Law Center's state compilation (read 2026-09-04)
says THIRTY states regulate grain warehouses. survey_registries.py splits
those thirty three ways -- harvested, has a candidate URL, nobody has found
the list yet -- and the three must add up to thirty with no state counted
twice and none missing.

That summary used to be a hand-typed sentence, and it had already gone wrong:
it named MN, SD, ND, OH, IN, AR and TX as "no candidate URL" when five of them
were either harvested or in the candidate list. A summary edited by hand is a
summary that lies. This is why it is derived, and this is what keeps it
derived.

    python test/registry-denominator.test.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "scripts" / "survey_registries.py").read_text()

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


def listed(name):
    m = re.search(name + r"\s*=\s*\[(.*?)\]", SRC, re.S)
    assert m, "%s is not defined in survey_registries.py" % name
    return [x for x in re.findall(r"\"([A-Z]{2})\"", m.group(1))]


HARVESTED = listed("HARVESTED")
NEEDS = listed("NEEDS_A_URL")
cand = re.search(r"^CANDIDATES = \[(.*?)^\]", SRC, re.S | re.M)
assert cand, "CANDIDATES is not defined"
CAND_STATES = sorted({s for s in re.findall(r"\(\"([A-Z]{2})\",", cand.group(1))} - {"US"})

# ── the three buckets are disjoint ────────────────────────────────────────
ALREADY_SCRAPED_BUT_STILL_PROBED = {"IA", "MO", "NE", "IL", "IN", "WA", "ID"}
check(not (set(HARVESTED) & set(NEEDS)),
      "a state is both harvested and needing a URL: %s" % (set(HARVESTED) & set(NEEDS)))
check(not (set(NEEDS) & set(CAND_STATES)),
      "a state has a candidate URL and is also listed as needing one: %s"
      % (set(NEEDS) & set(CAND_STATES)))
check(not ((set(HARVESTED) & set(CAND_STATES)) - ALREADY_SCRAPED_BUT_STILL_PROBED),
      "a harvested state reappears as an unharvested candidate: %s"
      % ((set(HARVESTED) & set(CAND_STATES)) - ALREADY_SCRAPED_BUT_STILL_PROBED))

# ── REGULATING AND PUBLISHING ARE DIFFERENT QUESTIONS ─────────────────────
#
# This asserted that the three buckets were EXACTLY the thirty states the
# National Agricultural Law Center says regulate grain warehouses, and that no
# state outside those thirty could appear. Then Grain Journal's index turned up
# licence lists for MICHIGAN ("Licensed Grain Dealers by Facility", a PDF),
# MARYLAND and NORTH CAROLINA — all three on the Law Center's "does not
# regulate" side.
#
# Both things are true. That compilation answers whether a state has a grain
# warehouse STATUTE; it says nothing about whether an agency publishes a list
# of licensees, and several publish one anyway. I had been using one list as
# the answer to both questions.
#
# So: the thirty regulated states must all still be accounted for, and any
# state beyond them has to be there because somebody found a URL — never
# because a name drifted into a list.
REGULATED = set(
    "AL AR CO DE GA ID IL IN IA KS KY LA MN MS MO MT NE NM ND OH OK OR SC SD "
    "TN TX WA WV WI WY".split())
check(len(REGULATED) == 30, "the regulated list is %d, not 30" % len(REGULATED))
covered = set(HARVESTED) | set(NEEDS) | set(CAND_STATES)
missing = REGULATED - covered
check(not missing,
      "%d regulated state(s) are in no bucket at all: %s" % (len(missing), " ".join(sorted(missing))))

# ── every candidate carries a URL and how far it has been believed ────────
rows = re.findall(r'\(\"([A-Z]{2})\",\s*\"([^\"]+)\",\s*\"([^\"]+)\",\s*\"([^\"]+)\"\)',
                  cand.group(1))
extra = (covered - REGULATED) - {"US", "CN"}
for st in sorted(extra):
    urls = [u for s2, _, u, _ in rows if s2 == st]
    check(urls, "%s is on the worklist, does not regulate grain warehouses, and has no URL — "
                "a name has drifted into a list" % st)

check(len(rows) >= 20, "only %d candidates parsed" % len(rows))
for st, what, url, conf in rows:
    check(url.startswith("http"), "%s: %r is not a URL" % (st, url))
    check(len(conf) > 12, "%s %s: no note on how far this URL has been believed" % (st, url))

# A URL nobody has opened must SAY so. Every one of these was found by search
# from a sandbox that cannot reach the hosts, and a candidate that reads as
# confirmed when it is not is how a 404 becomes a missing state.
unopened = [c for _, _, _, c in rows if re.search(r"unopened|search result|search 20", c)]
check(unopened, "no candidate admits to being unopened, which cannot be true")

# ── the summary is derived, not typed ─────────────────────────────────────
check("MN WI SD ND OH IN MI TX OK CO MT WA AR KY TN MS NC SC PA NY" not in SRC,
      "the hand-typed state list is back; it was wrong about five states")
check("len(regulated)" in SRC, "the summary no longer derives its own count")

# ── the survey must bring the page back, and see the commonest format ─────

SURVEY = SRC   # scripts/survey_registries.py, already read above
WF = (ROOT / ".github" / "workflows" / "registries.yml").read_text()

# A LINK HUNT THAT CANNOT SEE PDFs. Ten of the twenty-two states checked
# publish their list as a PDF, and three of the eight already harvested are
# read with a PDF route -- yet DATA_LINK matched only csv|xlsx?|json|txt. The
# 2026-09-04 survey duly reported Idaho, Montana and Oklahoma as forms with no
# data file, from pages of 129 KB, 195 KB and 121 KB.
m = re.search(r"DATA_LINK = re\.compile\((.*?)\)\n", SURVEY, re.S)
check(m, "DATA_LINK is gone")
if m:
    for fmt in ("pdf", "csv", "xls", "json"):
        check(fmt in m.group(1),
              "the data-file hunt cannot see .%s, which is a format these states use" % fmt)
    # And it must actually match one, not merely mention it in a comment.
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("_srv", ROOT / "scripts" / "survey_registries.py")
    _m = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_m)
    for href in ['href="/lists/warehouses.pdf"', "href='a/b.CSV'", 'href="x.xlsx"']:
        check(_m.DATA_LINK.search(href), "DATA_LINK does not match %s" % href)
    check(not _m.DATA_LINK.search('href="/page.html"'), "DATA_LINK matches an ordinary page")

# A 403 IS NOT ALWAYS AN ANSWER ABOUT THE DOCUMENT. Kansas refused all four of
# its candidates identically; four pages refusing the same way is one filter,
# not four answers. The retry is one extra request and it records which
# identity got through, because "Kansas publishes nothing" and "Kansas has a
# bot filter" send the next person to entirely different work.
check('if "403" not in str(ex):' in SURVEY,
      "the retry is not limited to a refusal — every failure would be asked twice")
check('d.update(status=status, contentType=ctype, bytes=len(raw), ua=label)' in SURVEY,
      "the survey no longer records WHICH user-agent answered")

# COMMENTS ARE NOT COVERAGE — a lesson this repository has already paid for.
# Checking that the string "--keep" appears in the workflow passed while I had
# written the word into a COMMENT above the step, and checking for "BROWSER_UA"
# passed with the constant renamed to BROWSER_UA_UNUSED and never called. Three
# mutations survived that way. So the workflow is matched on its `run:` line,
# and the behaviour is measured by running it.
check(re.search(r"run:\s*python scripts/survey_registries\.py[^\n]*--keep", WF),
      "the workflow's run: line does not pass --keep")
check("git add -f debug/registries/survey" in WF,
      "captured pages are added without -f and may be silently ignored")

# ── a page we could not keep must never cost us the harvest ───────────────
#
# Run 91883116181 kept nineteen pages and GitHub refused the push: the Illinois
# Department of Agriculture ships a Mapbox secret token in the markup of two of
# its PUBLIC pages. Push protection cannot tell whose key it is, and it does not
# have to. What was not acceptable is what went with those two files -- ONE
# blocked path took down the whole commit, so that run's registry fetch, its
# rebuilt directory and its survey JSON were lost too, under a log line reading
# only "repository rule violations".
steps = re.findall(r"^      - name: (.+)$", WF, re.M)
try:
    i_commit = next(i for i, n in enumerate(steps) if n.strip() == "Commit")
    i_keep = next(i for i, n in enumerate(steps) if "survey's pages" in n)
    check(i_keep > i_commit, "the captures are committed BEFORE the harvest is safe")
except StopIteration:
    fails.append("the two commit steps are no longer both present")

keep_step = WF[WF.rfind("- name: Keep the survey's pages"):] if "Keep the survey's pages" in WF else ""
check("continue-on-error: true" in keep_step,
      "the capture commit can fail the job, which is how a blocked page loses a harvest")
data_commit = WF[WF.find("- name: Commit"):WF.rfind("- name: Keep the survey's pages")]
check("git reset -q -- debug/registries/survey" in data_commit,
      "the data commit still stages the captures, so one blocked page takes it down")

# ── script is not the document ────────────────────────────────────────────
import importlib.util as _iu
_s = _iu.spec_from_file_location("_srv2", ROOT / "scripts" / "survey_registries.py")
_srv = _iu.module_from_spec(_s); _s.loader.exec_module(_srv)

PAGE = (b'<html><head><script>var t="sk.eyJ1IjoiaWxsaW5vaXMiLCJhIjoiY2xhYmNkZWZnaGlqayJ9.AbCdEf";'
        b'</script><style>.x{color:red}</style></head><body>'
        b'<table><tr><th>Company</th><th>City</th></tr><tr><td>Acme</td><td>Peoria</td></tr></table>'
        b'<a href="/list.pdf">Licensed warehouses</a>'
        b'<div data-key="AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345">map</div></body></html>')
kept, redactions = _srv.scrub(PAGE, "text/html")
text = kept.decode()
check("sk.eyJ1" not in text, "a Mapbox token survived the scrub — this is the exact blocked case")
check("AIzaSy" not in text, "a key written into a data- attribute survived the scrub")
check(redactions >= 1, "the scrub did not record that it redacted anything")
# THE DOCUMENT ITSELF IS UNTOUCHED. Everything this survey and the next parser
# need is markup; everything that carries a credential is script.
check("<th>Company</th>" in text and "Peoria" in text, "the scrub ate the table")
check("/list.pdf" in text, "the scrub ate the data-file link the survey exists to find")
check("script removed by survey_registries" in text,
      "script was dropped with no note saying so — an empty capture would look like an empty page")
# A PDF is not a script host and must come back byte-identical, or a licence
# book stops being the document it was.
pdf = b"%PDF-1.4 stream sk.eyJ1IjoiZXhhbXBsZSJ9.xxxxxxxxxxxxxxxxxxxxxxxxxx endstream"
back, n = _srv.scrub(pdf, "application/pdf")
check(back == pdf and n == 0, "a PDF was rewritten; a licence book must come back as itself")

# ── the query string hid the one link that mattered ───────────────────────
#
# Texas publishes its licensed grain warehouses as an EXCEL FILE, and the link
# hunt could not see it, because the href is
#
#     /Portals/0/Reports/PIR/grain_warehouse.xls?ver=8h5xCiF7GXXNfllq9gtibA%3d%3d
#
# and the extension has to be last before the quote. DotNetNuke stamps ?ver= on
# every asset it serves and so does most of the web. Measured against the pages
# kept on 2026-09-04: allowing a query string finds TWENTY-EIGHT more links on
# the Texas page alone, one of them the list this whole exercise is for.
for href in ['href="/Portals/0/Reports/PIR/grain_warehouse.xls?ver=8h5xCiF7GXX%3d%3d"',
             "href='/a/list.pdf?v=2'", 'href="/b/data.csv?download=1&x=2"']:
    check(_srv.DATA_LINK.search(href), "a versioned asset is invisible: %s" % href)
check(_srv.DATA_LINK.search('href="/Portals/x.xls?ver=1"').group(1).endswith("?ver=1"),
      "the query string is dropped from the pattern's capture")

# A WEAK POSITIVE ON A PAGE WITH NOTHING is worse than saying nothing: it is a
# wrong answer with a filename attached. Oklahoma's page is 102 links of
# pesticide forms and an egg statute, and at a threshold of one it confidently
# offered "SensitiveCropRegistry_guide" as the grain roster.
for weak in ["/SensitiveCropRegistry_guide_10_29_20.pdf", "/Oklahoma-RUP-Dealer-Lic-ver-2.pdf"]:
    check(_srv.rank_link(weak) < 2,
          "%s would be offered as a roster; it is not one" % weak)

# ── which of eight links is the roster ────────────────────────────────────
#
# Idaho offers eight PDFs: five fillable bond and application forms, and two
# licensee lists. Oklahoma offers a hundred and two, and not one of them is a
# grain roster. "8 data link(s)" tells nobody which is which.
check(_srv.rank_link("/Portals/0/Reports/PIR/grain_warehouse.xls?ver=x") >= 2,
      "Texas's own licensee spreadsheet does not read as a roster")
check(_srv.rank_link(".../WarehouseProgram/Commodity-Dealer-Licensees-1.pdf") >= 2,
      "Idaho's licensee list does not read as a roster")
# EVERY ONE OF THESE BEAT A REAL ROSTER TO THE TOP OF A REAL PAGE.
for form in ["/ACP grain warehouse supporting docs info.pdf",
             "/AG00884%20Rates%20for%20Storing%20and%20Handling%20Grain.pdf",
             "/AG04019%20Grain%20Licensing%20Financial%20Statement.pdf",
             "/10_25_Warehouse-Charter-App.pdf",
             "/Final-Website-10162025-Dealer-Renewal.pdf",
             "/Commodity-Dealer-Bond-FILLABLE.pdf",
             "/rgw_300_application_to_operate_a_public_grain_warehouse.pdf"]:
    check(_srv.rank_link(form) < 2,
          "%s outranks a real roster — it is a form" % form.rsplit("/", 1)[-1][:40])
# A SPREADSHEET IS MORE OFTEN A ROSTER THAN A FORM IS. Texas ships .xls, Ohio
# .csv; the forms are always PDFs.
check(_srv.rank_link("/x/warehouse-list.csv") > _srv.rank_link("/x/warehouse-list.pdf"),
      "a tabular format is not preferred over a PDF of the same name")

# ── and the two rosters those pages named are now candidates ──────────────
# COMMENTS ARE NOT COVERAGE — for the third time today. Checking `"x" in
# SURVEY` passed with the candidate deleted, because the comment above it
# quotes the same filename. Look in the CANDIDATE URLs and nowhere else.
cand_urls = " ".join(re.findall(r'\(\"[A-Z]{2}\",\s*\"[^\"]+\",\s*\"([^\"]+)\"',
                                cand.group(1)))
check("grain_warehouse.xls" in cand_urls,
      "the Texas licensee spreadsheet was found and then not written down as a candidate")
check("Commodity-Dealer-Licensees" in cand_urls,
      "Idaho's licensee list was found and then not written down as a candidate")
check("ID-WA-Cooperative-Licensees" in cand_urls,
      "the Idaho/Washington co-operative list was found and then not written down")

# ── the fourteen states Grain Journal's index handed over ──────────────────
#
# grainjournal.com/web-directory/facility-listings keeps a curated list of
# "<State> State Licensed Warehouses" links, and it answered in one page most
# of what a week of one-state-at-a-time searching had not. These are the ones
# worth losing sleep over if they go missing.
#
# KANSAS ABOVE ALL. Four agriculture.ks.gov URLs 403 on three separate days
# with both user-agents, and this repository wrote Kansas off as publishing
# nothing. The list is a plain PDF on wapp.kda.ks.gov — a host nobody had
# tried. K-State's own factsheet counts 550+ co-operative grain locations in
# Kansas plus 250+ others, against the 361 Barchart rows we hold.
check("wapp.kda.ks.gov" in cand_urls,
      "the Kansas PDF is gone — it is the largest single hole on the map and it "
      "took a month to find the host")
check("Licensed_Grain_Dealers_by_Facility" in cand_urls,
      "Michigan's by-facility list is gone")
for host in ("agr.georgia.gov", "mda.maryland.gov", "mdac.ms.gov", "ldaf.state.la.us",
             "mtplants.mt.gov", "apps.ncagr.gov", "mda.state.mn.us"):
    check(host in cand_urls, "the candidate for %s is gone" % host)

# ── a csv is the answer, not an "unclear" ─────────────────────────────────
#
# Sig sent the WCMD dashboard URL on 2026-09-04 and appending .csv to the view
# path returns real data. The survey would have called it "unclear": content
# that is not HTML falls through to the tag counters, which find no <tr> and no
# <form>, and report a mystery about a file that is already the table.
check("WCMDDashboard.csv" in cand_urls,
      "the WCMD csv export that actually returned data is not a candidate")
# THE SUMMARY IS ONE SHEET. The per-warehouse rows are on another, and Tableau
# names its sheets whatever the author typed, so the probes are how we find
# out. They must be marked as probes and not as findings.
probes = [c for _, what, _, c in rows if "probe" in what.lower()]
check(len(probes) >= 5,
      "the workbook's other sheets are no longer probed — only %d left" % len(probes))
for c in probes:
    check("never opened" in c or "probe" in c,
          "a probe is recorded as though somebody had opened it")


def measured():
    """Run the survey against a local server: does it keep the page, find a
    PDF link, and get past a filter that refuses our own user-agent?

    Everything above reads the source. This runs it, because the three things
    that matter here are all things the source can look correct about and
    still not do."""
    import http.server, socketserver, threading, subprocess, tempfile, shutil, json, pathlib
    # THE PAGE THE SERVER SERVES CARRIES A KEY, because scrub() being correct
    # says nothing about whether the capture path calls it. Bypassing it broke
    # no test until this page did — the third time this repository has been
    # bitten by testing a rule instead of the wiring.
    PAGE = (b'<html><head><script>var t="sk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGFiY2RlZmdoIn0.QqWwEe";'
            b'</script></head><body>'
            b'<table><tr><th>Company</th></tr><tr><td>A</td></tr></table>'
            b'<a href="/lists/warehouse-licensees.xls?ver=AbC%3d%3d">Licensed warehouses</a>'
            b'<a href="/forms/bond-FILLABLE.pdf">Bond form</a></body></html>')

    # A page whose ONLY data file is a weak match — Oklahoma's case, where 102
    # links of pesticide forms produced a confident wrong answer at threshold 1.
    WEAK = (b'<html><body><a href="/SensitiveCropRegistry_guide_10_29_20.pdf">guide</a>'
            b'</body></html>')
    # A CSV, because a file that is already the table must not come back as a
    # mystery. Content that is not HTML falls through to the tag counters,
    # which find no <tr> and no <form>, and report "unclear".
    CSV = b"Commodity,All Warehouses,CCC Approved\nGrain,4802,4538\nCotton,329,325\n"

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/walled") and "Mozilla" not in self.headers.get("User-Agent", ""):
                self.send_response(403); self.end_headers(); self.wfile.write(b"no"); return
            csvish = self.path.startswith("/data")
            body = CSV if csvish else (WEAK if self.path.startswith("/weak") else PAGE)
            self.send_response(200)
            self.send_header("Content-Type", "text/csv" if csvish else "text/html")
            self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = socketserver.TCPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    """RUN A COPY, IN A DIRECTORY OF ITS OWN.

    The first version patched scripts/survey_registries.py in place and put it
    back in a finally. Then a run was interrupted, the finally never fired, and
    the repository was left holding a survey script with four localhost
    candidates in it — a guard that corrupts the thing it guards.

    The script takes its ROOT from its own __file__, so a copy in a temp tree
    writes its output there too. Nothing in the repository is touched, no
    restore is needed, and an interrupted run leaves a temp directory behind
    and nothing else.

    The candidate list is REPLACED rather than prepended, because prepending
    left the real thirty in place: every run of this guard fired thirty
    requests at state agriculture departments to test a regex."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="survey-guard-"))
    (tmp / "scripts").mkdir()
    (tmp / "data").mkdir()
    local = ('CANDIDATES = [\n'
             '    ("ZZ", "open page", "http://127.0.0.1:%d/open", "probe, never opened"),\n'
             '    ("ZY", "walled page", "http://127.0.0.1:%d/walled", "probe, never opened"),\n'
             '    ("ZX", "weak page", "http://127.0.0.1:%d/weak", "probe, never opened"),\n'
             '    ("ZW", "a csv", "http://127.0.0.1:%d/data.csv", "probe, never opened"),\n]\n'
             'UNUSED_CANDIDATES = [' % (port, port, port, port))
    script = tmp / "scripts" / "survey_registries.py"
    script.write_text((ROOT / "scripts" / "survey_registries.py").read_text()
                      .replace("CANDIDATES = [", local, 1))
    try:
        subprocess.run([sys.executable, str(script), "--timeout", "3", "--pause", "0", "--keep"],
                       capture_output=True, text=True, cwd=str(tmp))
        out_json = tmp / "data" / "registry-survey.json"
        check(out_json.exists(), "the survey wrote no output at all")
        if not out_json.exists():
            return
        got = {r["state"]: r for r in json.loads(out_json.read_text())["results"]}
        check(set(got) == {"ZZ", "ZY", "ZX", "ZW"},
              "the guard asked something other than its own local server: %s" % sorted(got))
        if "ZZ" in got:
            check(got["ZZ"].get("kept"), "the page that answered was not kept")
            kept_path = tmp / str(got["ZZ"].get("kept") or "x")
            check(kept_path.exists(), "the survey recorded a kept path that does not exist")
            if kept_path.exists():
                body = kept_path.read_text(errors="replace")
                check("sk.eyJ1" not in body,
                      "THE CAPTURE PATH DID NOT SCRUB. A key on the page reached the file "
                      "that gets committed — this is exactly what blocked run 91883116181.")
                check("<th>Company</th>" in body, "the kept page lost the table it was kept for")
            links = got["ZZ"].get("dataLinks") or []
            check(any(".pdf" in l for l in links), "the PDF link on the page was not found")
            # THE URL MUST COME BACK FETCHABLE. Texas's spreadsheet is served
            # only at its ?ver= URL; a link recorded without its query string
            # is a link nobody can follow.
            check(any(l.endswith("?ver=AbC%3d%3d") for l in links),
                  "the query string was stripped from a stored link — it cannot be fetched back")
            roster = got["ZZ"].get("looksLikeARoster") or []
            check(roster and "warehouse-licensees.xls" in roster[0],
                  "the roster was not picked out from the form beside it")
            check(not any("bond-FILLABLE" in r for r in roster),
                  "a bond form was offered as a roster")
        if "ZY" in got:
            # THE WHOLE POINT OF THE RETRY. Kansas refused four candidates
            # identically; this proves a filter on the user-agent is passed and
            # recorded, rather than reported as a state that publishes nothing.
            check(got["ZY"].get("status") == 200,
                  "a page that refuses our user-agent was reported as unreachable")
            check(got["ZY"].get("ua") == "browser",
                  "the survey did not record that it took a second identity to get in")
        if "ZX" in got:
            check(got["ZX"].get("dataLinks"), "the weak page's link was not seen at all")
            check(not got["ZX"].get("looksLikeARoster"),
                  "a page whose only data file is a pesticide guide was offered a roster — "
                  "this is Oklahoma's 102 links producing a confident wrong answer")
        if "ZW" in got:
            # The WCMD dashboard's .csv export is exactly this case, and it is
            # the only national grain count anyone publishes: 4,802 warehouses.
            check(got["ZW"].get("shape") == "csv",
                  "a csv was classified as %r — a file that IS the table came back a mystery"
                  % got["ZW"].get("shape"))
            check((got["ZW"].get("headerCells") or [None])[0] == "Commodity",
                  "the csv's own header row was not read")
            check(got["ZW"].get("rows") == 2, "the csv's rows were not counted")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        srv.shutdown()

measured()

if fails:
    for f in fails:
        print("FAIL: %s" % f)
    sys.exit(1)
print("survey: keeps its pages, sees PDFs, and asks twice only on a refusal")

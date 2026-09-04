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
check(not (set(HARVESTED) & set(NEEDS)),
      "a state is both harvested and needing a URL: %s" % (set(HARVESTED) & set(NEEDS)))
check(not (set(NEEDS) & set(CAND_STATES)),
      "a state has a candidate URL and is also listed as needing one: %s"
      % (set(NEEDS) & set(CAND_STATES)))
check(not (set(HARVESTED) & set(CAND_STATES) - {"IA", "MO", "NE", "IL"}),
      "a harvested state reappears as an unharvested candidate: %s"
      % (set(HARVESTED) & set(CAND_STATES)))

# ── and together they are the thirty ──────────────────────────────────────
REGULATED = set(HARVESTED) | set(NEEDS) | set(CAND_STATES)
check(len(REGULATED) == 30,
      "the three buckets cover %d states, not the 30 that regulate grain "
      "warehouses: %s" % (len(REGULATED), " ".join(sorted(REGULATED))))

# ── the twenty that do not regulate must not appear as work ───────────────
# Michigan, California, New York and Pennsylvania have real elevators and no
# licence roll. Putting one of them on a registry worklist sends somebody to
# look for a document that does not exist.
UNREGULATED = set("AK AZ CA CT FL HI ME MD MA MI NV NH NJ NY NC PA RI UT VT VA".split())
check(not (REGULATED & UNREGULATED),
      "a state that does not regulate grain warehouses is on the worklist: %s"
      % (REGULATED & UNREGULATED))
check(len(UNREGULATED) == 20, "the unregulated list is %d, not 20" % len(UNREGULATED))

# ── every candidate carries a URL and how far it has been believed ────────
rows = re.findall(r'\(\"([A-Z]{2})\",\s*\"([^\"]+)\",\s*\"([^\"]+)\",\s*\"([^\"]+)\"\)',
                  cand.group(1))
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


def measured():
    """Run the survey against a local server: does it keep the page, find a
    PDF link, and get past a filter that refuses our own user-agent?

    Everything above reads the source. This runs it, because the three things
    that matter here are all things the source can look correct about and
    still not do."""
    import http.server, socketserver, threading, subprocess, tempfile, shutil, os, json
    # THE PAGE THE SERVER SERVES CARRIES A KEY, because scrub() being correct
    # says nothing about whether the capture path calls it. Bypassing it broke
    # no test until this page did — the third time this repository has been
    # bitten by testing a rule instead of the wiring.
    PAGE = (b'<html><head><script>var t="sk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGFiY2RlZmdoIn0.QqWwEe";'
            b'</script></head><body>'
            b'<table><tr><th>Company</th></tr><tr><td>A</td></tr></table>'
            b'<a href="/lists/warehouses.pdf">Licensed warehouses</a></body></html>')

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/walled") and "Mozilla" not in self.headers.get("User-Agent", ""):
                self.send_response(403); self.end_headers(); self.wfile.write(b"no"); return
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(PAGE))); self.end_headers()
            self.wfile.write(PAGE)

        def log_message(self, *a):
            pass

    srv = socketserver.TCPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    script = ROOT / "scripts" / "survey_registries.py"
    out_json = ROOT / "data" / "registry-survey.json"
    kept_dir = ROOT / "debug" / "registries" / "survey"
    backup = script.read_text()
    saved = out_json.read_text() if out_json.exists() else None
    had = sorted(p.name for p in kept_dir.glob("*")) if kept_dir.exists() else []
    try:
        script.write_text(backup.replace(
            "CANDIDATES = [",
            'CANDIDATES = [\n    ("ZZ","open","http://127.0.0.1:%d/open","probe"),\n'
            '    ("ZY","walled","http://127.0.0.1:%d/walled","probe"),' % (port, port), 1))
        subprocess.run([sys.executable, str(script), "--timeout", "3", "--pause", "0", "--keep"],
                       capture_output=True, text=True, cwd=str(ROOT))
        got = {r["state"]: r for r in json.loads(out_json.read_text())["results"]
               if r.get("state") in ("ZZ", "ZY")}
        check("ZZ" in got and "ZY" in got, "the survey did not reach the local server")
        if "ZZ" in got:
            check(got["ZZ"].get("kept"), "the page that answered was not kept")
            kept_path = ROOT / str(got["ZZ"].get("kept") or "x")
            check(kept_path.exists(), "the survey recorded a kept path that does not exist")
            if kept_path.exists():
                body = kept_path.read_text(errors="replace")
                check("sk.eyJ1" not in body,
                      "THE CAPTURE PATH DID NOT SCRUB. A key on the page reached the file "
                      "that gets committed — this is exactly what blocked run 91883116181.")
                check("<th>Company</th>" in body, "the kept page lost the table it was kept for")
            check(any(l.endswith(".pdf") for l in got["ZZ"].get("dataLinks") or []),
                  "the PDF link on the page was not found")
        if "ZY" in got:
            # THE WHOLE POINT OF THE RETRY. Kansas refused four candidates
            # identically; this proves a filter on the user-agent is passed and
            # recorded, rather than reported as a state that publishes nothing.
            check(got["ZY"].get("status") == 200,
                  "a page that refuses our user-agent was reported as unreachable")
            check(got["ZY"].get("ua") == "browser",
                  "the survey did not record that it took a second identity to get in")
    finally:
        script.write_text(backup)
        if saved is not None:
            out_json.write_text(saved)
        if kept_dir.exists():
            for f in kept_dir.glob("*"):
                if f.name not in had:
                    f.unlink()
        srv.shutdown()


measured()

if fails:
    for f in fails:
        print("FAIL: %s" % f)
    sys.exit(1)
print("survey: keeps its pages, sees PDFs, and asks twice only on a refusal")

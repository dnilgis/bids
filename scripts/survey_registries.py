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
PAGES = ROOT / "debug" / "registries" / "survey"
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

    ("TX", "grain warehouse programme", "https://texasagriculture.gov/Home/Production-Agriculture/Grain-Warehouse", "READ 2026-09-04: a programme page. Its 36 <tr> are FORMS, not warehouses — the survey's own row count called it a table and was wrong. The list is one link down"),
    # THE LIST ITSELF, read off that page's bytes on 2026-09-04:
    #   "Find a TDA-Licensed Grain Warehouse — Click here for a list of grain
    #    warehouses licensed by TDA."   ->  /Portals/0/Reports/PIR/grain_warehouse.xls
    # An EXCEL FILE, which is the best shape any state has offered so far, and
    # the link the survey could not see until it learned about query strings.
    ("TX", "THE LICENSEE LIST, xls", "https://texasagriculture.gov/Portals/0/Reports/PIR/grain_warehouse.xls?ver=8h5xCiF7GXXNfllq9gtibA%3d%3d", "found in the page kept on 2026-09-04; never fetched"),

    ("WA", "licence book PDF", "https://cms.agr.wa.gov/WSDAKentico/Documents/GWA-License-Book-21-22.pdf", "search 2026-09-04: titled PUBLIC GRAIN WAREHOUSES/DEALERS LICENSED WITH THE STATE OF WASHINGTON"),
    ("WA", "warehouses and dealers PDF", "https://cms.agr.wa.gov/WSDAKentico/Documents/Grain-Warehouse-Audit-Grain-Dealers.pdf", "search 2026-09-04, unopened"),

    ("OR", "SOS licence directory, bonded grain warehouse", "https://apps.oregon.gov/SOS/LicenseDirectory/LicenseDetail/170", "search 2026-09-04: says 'Last updated 01/05/2026'"),

    ("ID", "warehouse programme", "https://agri.idaho.gov/ag-inspections/warehouse-program/", "READ 2026-09-04: twelve data links, five of them fillable bond and application forms"),
    # Two of those twelve are licensee ROSTERS, and the second covers two states.
    ("ID", "commodity dealer licensees", "https://agri.idaho.gov/wp-content/uploads/WarehouseProgram/Commodity-Dealer-Licensees-1.pdf", "found in the page kept on 2026-09-04; never fetched"),
    ("ID", "Idaho AND Washington co-op licensees", "https://agri.idaho.gov/wp-content/uploads/WarehouseProgram/ID-WA-Cooperative-Licensees.pdf", "found in the page kept on 2026-09-04; never fetched"),

    ("MT", "commodity warehouse licence", "https://prod-agr.mt.gov/Topics/A-D/Commodity-Pages/Commodity-Warehouse-License", "search 2026-09-04, unopened"),

    ("OK", "licensing and permits", "https://ag.ok.gov/licensing-permits/", "search 2026-09-04, unopened"),

    # ══════════════════════════════════════════════════════════════════════
    #  FOURTEEN STATES FROM ONE PAGE — grainjournal.com/web-directory/
    #  facility-listings, sent by Sig on 2026-09-04.
    # ══════════════════════════════════════════════════════════════════════
    #
    # Grain Journal keeps a curated index of "<State> State Licensed
    # Warehouses" links. Every URL below is copied verbatim off that page. It
    # answers, in one go, most of what a week of searching one state at a time
    # did not — and it corrects two things this repository had written down as
    # settled.
    #
    # KANSAS IS NOT A DEAD END, AND WE HAD THE WRONG HOST.
    # Four agriculture.ks.gov URLs returned 403 on three separate days, with
    # both user-agents, and the source table has said since 2026-08-28 that
    # Kansas publishes nothing. Grain Journal points at a PLAIN PDF on a host
    # nobody here had tried: wapp.kda.ks.gov. K-State's own "Mapping Grain
    # Locations in Kansas" (agmanager.info, read 2026-09-04) cites the same
    # thing — a KDA "Grain Elevator Licenses" report — and counts OVER 550
    # co-operative grain locations plus more than 250 non-co-op ones, against
    # the 361 Barchart rows this repository holds. Kansas is the largest single
    # hole on the map.
    #
    # MICHIGAN PUBLISHES A LIST AND IS ON OUR "DOES NOT REGULATE" SIDE.
    # The National Agricultural Law Center's compilation put Michigan among the
    # twenty states that do not regulate grain warehouses. Michigan publishes
    # "Licensed Grain Dealers BY FACILITY" as a PDF. Regulating and publishing
    # are not the same question, and I had been treating one list as the answer
    # to both.
    ("KS", "KDA licensed warehouses, PDF", "http://wapp.kda.ks.gov/grain-warehouse/gw_public.pdf", "from grainjournal.com 2026-09-04; a DIFFERENT HOST from the four that 403"),
    ("MI", "licensed grain dealers by facility, PDF", "https://www.michigan.gov/documents/mdard/Licensed_Grain_Dealers_by_Facility_640332_7.pdf", "from grainjournal.com 2026-09-04; unopened"),
    ("MN", "MDA licence search", "http://www2.mda.state.mn.us/webapp/lis/default.jsp", "from grainjournal.com 2026-09-04; unopened"),
    ("GA", "state licensed warehouses", "http://agr.georgia.gov/warehouse.aspx", "from grainjournal.com 2026-09-04; unopened"),
    ("MD", "grain licensing", "http://mda.maryland.gov/foodfeedquality/Pages/grain.aspx", "from grainjournal.com 2026-09-04; unopened"),
    ("MS", "grain dealers and warehouses", "https://www.mdac.ms.gov/bureaus-departments/regulatory-services/grain-dealers-warehouses/", "from grainjournal.com 2026-09-04; unopened"),
    ("LA", "commodities commission", "http://www.ldaf.state.la.us/consumers/commodities-commission/", "from grainjournal.com 2026-09-04; unopened"),
    ("CO", "commodity handler programme", "https://ag.colorado.gov/inspection-consumer-services/commodity-handler", "from grainjournal.com 2026-09-04 (colorado.gov/pacific redirects); unopened"),
    ("MT", "licence search", "https://mtplants.mt.gov/Licenses/External/ExternalLicenseSearch.aspx", "from grainjournal.com 2026-09-04; unopened"),
    ("OR", "ODA licence search", "http://oda.state.or.us/dbs/licenses/search.lasso?&division=cid", "from grainjournal.com 2026-09-04; unopened"),
    ("NC", "licence search, grain dealers", "http://apps.ncagr.gov/LicenseSearch/Home/Search/015", "from grainjournal.com 2026-09-04; unopened"),
    ("ID", "warehouse control programme", "https://agri.idaho.gov/main/about/about-isda/ag-inspections/warehouse-control-program/warehouses/", "from grainjournal.com 2026-09-04; a different page from the one already surveyed"),
    ("WA", "GWA licence book, canonical URL", "https://agr.wa.gov/FP/Pubs/docs/gwaLicenseBook.pdf", "from grainjournal.com 2026-09-04; the cms.agr.wa.gov copy already fetched at 713 KB"),
    ("IL", "licensed dealer and warehouse look-up", "https://www2.illinois.gov/sites/agr/Consumers/GrainWarehouses/Pages/Licensed-Grain-Dealer-Warehouse-Look-up.aspx", "from grainjournal.com 2026-09-04; the older sharepoint spelling"),
    ("IN", "ISDA licensed warehouses", "https://secure.in.gov/isda/2399.htm", "from grainjournal.com 2026-09-04; Indiana is already scraped from a PDF"),
    # Not a state, and worth knowing it exists: Canada licenses centrally.
    ("CN", "Canadian Grain Commission licensees", "http://www.grainscanada.gc.ca/licensee-licence/licensed-agreees-eng.htm", "from grainjournal.com 2026-09-04; out of scope for now, recorded so nobody re-finds it"),

    # ---- the national list, which is a SUPPLEMENT and not the denominator --
    #
    # USWA licences are FEDERAL. The 2010 snapshot read on 2026-09-04 lists
    # roughly 687 grain facilities for the whole country -- against 4,253 rows
    # already in this repository. Most elevators are licensed by their state,
    # not by USDA, so this is a few hundred names the state rolls will not
    # have, not the national roster. Worth taking; not worth waiting for.
    ("US", "USDA WCMD dashboard", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/WCMDDashboard?:isGuestRedirectFromVizportal=y&:embed=y", "a Tableau shell; 200 and no rows on 2026-09-03 and again on 2026-09-04"),
    # THE DASHBOARD EXPORTS. Sig sent the dashboard URL on 2026-09-04 and
    # appending .csv to the VIEW path returns real data -- the summary sheet,
    # 79 rows of counts by commodity, READ that day:
    #
    #     Grain   4,802 warehouses   4,538 CCC approved   2,387 USWA licensed
    #     Cotton    329              Peanut 304           Sugar 85 …
    #
    # 4,802 GRAIN WAREHOUSES is the first national denominator anybody has
    # published in one place, and it is larger than this whole repository's
    # directory. It counts warehouses under a CCC storage agreement and/or a
    # USWA licence, which is NOT the same set as elevators posting a cash bid
    # -- but it is a real count of real facilities, and nothing else comes
    # close.
    ("US", "WCMD summary, csv export", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/WCMDDashboard.csv?:isGuestRedirectFromVizportal=y&:embed=y", "READ 2026-09-04: 79 rows, counts by commodity. Grain = 4802"),
    # The summary is one SHEET of the workbook. The per-warehouse rows are on
    # another, and Tableau names its sheets whatever the author typed. These
    # are probes: the sandbox cannot reach this host, so one runner pass says
    # which of them exist and the rest get deleted. A 404 here costs nothing.
    ("US", "WCMD sheet probe: Warehouse Detail", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/WarehouseDetail.csv?:embed=y", "probe, never opened"),
    ("US", "WCMD sheet probe: Warehouse List", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/WarehouseList.csv?:embed=y", "probe, never opened"),
    ("US", "WCMD sheet probe: Warehouse Locations", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/WarehouseLocations.csv?:embed=y", "probe, never opened"),
    ("US", "WCMD sheet probe: Map", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/Map.csv?:embed=y", "probe, never opened"),
    ("US", "WCMD sheet probe: Sheet1", "https://publicdashboards.dl.usda.gov/t/MRP_PUB/views/WCMDDashboard/Sheet1.csv?:embed=y", "probe, never opened"),
    # The clickable USWA map data.gov points at. DNS does not resolve from the
    # sandbox; the runner is on a different network and may see it.
    ("US", "USWA licensed warehouses map", "https://saltlake.sc.egov.usda.gov/approved_whses/uswa/approved_whses_USWA.asp", "data.gov's only distribution for the USWA map; DNS fails from the sandbox"),
    ("US", "USWA active warehouses, data.gov", "https://catalog.data.gov/dataset/uswa-active-warehouses", "read 2026-09-04: its only distribution is a PDF at fsa.usda.gov"),
    ("US", "USWA licensed and bonded, 2010 snapshot", "http://www.fsa.usda.gov/Internet/FSA_File/whselst2010.pdf", "READ 2026-09-04: 'Licensed and Bonded Warehouses Licensed Under the U.S. Warehouse Act As of December 31, 2010'. Town / warehouse / operator, no street address. SIXTEEN YEARS OLD — the survey should look for a newer year"),
    ("US", "USWA snapshot, another year", "http://www.fsa.usda.gov/Internet/FSA_File/whselst2012.pdf", "search 2026-09-04: the file name carries the year, so the newest one is worth finding"),
]

# States that regulate grain warehouses and whose published list nobody has
# located yet. NOT a list of guesses -- a list of searches somebody still owes.
# Naming them is the point: a state missing from CANDIDATES because no URL was
# found looks exactly like a state that does not exist.
NEEDS_A_URL = ["AL", "DE", "KY", "NM", "SC", "TN", "WV", "WI", "WY"]

# Regulated states already harvested by scripts/fetch_registries.py.
HARVESTED = ["IA", "MO", "OH", "ND", "AR", "IN", "SD", "NE"]


# THE FORMAT MOST OF THEM ACTUALLY USE WAS MISSING FROM THIS.
#
# This hunted for csv, xlsx, json and txt -- and not PDF, while TEN of the
# twenty-two states checked publish their list as a PDF and three of the eight
# already harvested are read with a PDF route. So the survey of 2026-09-04
# reported Idaho, Montana and Oklahoma as "search form" with no data file,
# from pages of 129 KB, 195 KB and 121 KB that almost certainly link one.
# A link hunt that cannot see the commonest format is a link hunt that reports
# absence it never tested for.
# ...AND THE QUERY STRING HID THE ONE THAT MATTERED.
#
# Texas publishes its licensed grain warehouses as an EXCEL FILE and this
# pattern could not see it, because the href is
#
#     /Portals/0/Reports/PIR/grain_warehouse.xls?ver=8h5xCiF7GXXNfllq9gtibA%3d%3d
#
# and the extension has to be the last thing before the quote. DotNetNuke
# stamps ?ver= on every asset it serves; so do most CMSes. Measured against the
# pages kept on 2026-09-04: allowing a query string finds TWENTY-EIGHT more
# links on the Texas page alone, one of which is the list this whole exercise
# is looking for.
DATA_LINK = re.compile(
    r'href=["\']([^"\']+\.(?:csv|xlsx?|xls|json|txt|pdf)(?:\?[^"\']*)?)["\']', re.I)

# WHICH OF EIGHT LINKS IS THE ROSTER.
#
# Idaho's page offers eight PDFs: five are fillable bond and application forms,
# and two are "Commodity-Dealer-Licensees-1.pdf" and
# "ID-WA-Cooperative-Licensees.pdf". Oklahoma's eight are pesticide forms and
# an egg statute, and none of them is a grain list at all. Reporting "8 data
# link(s)" tells nobody which is which, and a person checking by hand opens
# eight PDFs to find that seven were never candidates.
#
# So the links are RANKED, on the words in their own file names, and the
# ranking is reported rather than acted on. Nothing is fetched because it
# scored well; the score decides what to say and what order to say it in.
ROSTER_WORDS = ("licensee", "licensed", "license-list", "warehouse", "dealer", "buyer",
                "grain", "list", "directory", "registry", "roster", "active", "current")
# Tuned against the pages kept on 2026-09-04, not guessed at. Each of these
# beat a real roster to the top of a real page: "ACP grain warehouse supporting
# docs info.pdf" outscored Texas's own grain_warehouse.xls, Minnesota's "Rates
# for Storing and Handling Grain" and "Grain Licensing Financial Statement"
# both read as grain lists, and Oklahoma's "Warehouse-Charter-App" and
# "Dealer-Renewal" led its 102 links.
FORM_WORDS = ("application", "app", "renewal", "fillable", "bond", "form", "instruction",
              "certificate", "claim", "fee-schedule", "fee_schedule", "rates", "financial",
              "statement", "supporting", "info", "charter", "proof", "contact", "brochure",
              "template", "notice", "org-chart", "plan", "invite", "statute", "manual",
              "order", "tutorial", "faq")
# A ROSTER IS FAR MORE OFTEN A SPREADSHEET THAN A FORM IS. Texas publishes an
# .xls, Ohio a .csv; the forms are always PDFs. That is a signal about the
# format, not about any one state.
TABULAR = (".csv", ".xls", ".xlsx", ".json")


def rank_link(href):
    """+1 per roster word, -2 per form word, +2 for a tabular format.

    A file NAME is all there is to go on before fetching, so this decides what
    to SAY and in what order — nothing is fetched because it scored well."""
    name = href.rsplit("/", 1)[-1].split("?")[0].lower()
    score = sum(1 for w in ROSTER_WORDS if w in name)
    score -= 2 * sum(1 for w in FORM_WORDS if w in name)
    if any(name.endswith(e) for e in TABULAR):
        score += 2
    return score
FORMISH = re.compile(r"<form\b", re.I)
TR = re.compile(r"<tr\b", re.I)
TH = re.compile(r"<th[^>]*>(.*?)</th>", re.I | re.S)


# A 403 IS NOT ALWAYS AN ANSWER ABOUT THE DOCUMENT.
#
# Kansas returned 403 on 2026-09-04 to all FOUR of its candidates -- the
# programme page, licensing, applications, documents. Four different pages
# refusing identically is not four pages saying no; it is one filter in front
# of them, and the thing it filtered was the only variable those four requests
# shared: the User-Agent. Whether that is true is a measurement and not a
# guess, so on a 403 this asks exactly once more with a browser string and
# RECORDS WHICH ONE GOT THROUGH, because "Kansas publishes nothing" and
# "Kansas has a bot filter" send the next person to completely different work.
#
# Rule 11: these are public licence rolls that any farmer can open in a
# browser. Nothing here is behind a login and nothing is fetched faster than a
# person would.
BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0 Safari/537.36 agsist-bidreader (+https://agsist.com)")


# OTHER PEOPLE'S SECRETS ARRIVE IN OTHER PEOPLE'S PAGES.
#
# Run 91883116181 kept 19 pages and GitHub refused the push: the Illinois
# Department of Agriculture ships a MAPBOX SECRET ACCESS TOKEN in the markup of
# two of its public pages. Push protection cannot tell whose key it is, and it
# does not have to -- the key does not belong in this repository either way.
#
# The damage was not the two files. One blocked path took down the WHOLE
# commit, so the registry fetch, the rebuilt directory and the survey JSON of
# that run were all lost with them.
#
# Rule 3 has always said secrets never live in files. It turns out to apply to
# secrets we did not create and did not want.
#
# SCRIPT IS NOT THE DOCUMENT. Everything this survey looks for -- tables, rows,
# header cells, links to a data file -- is markup. Everything that carries a
# credential is script, style or an inline event handler. So the capture keeps
# the page and drops the code, which removes the whole class of problem rather
# than pattern-matching for the keys we happen to have seen. A licence list has
# never been rendered by the JavaScript we are throwing away; if one ever is,
# it will show up as an empty capture and say so.
SCRIPTY = re.compile(
    r"<script\b[^>]*>[\s\S]*?</script\s*>|<style\b[^>]*>[\s\S]*?</style\s*>"
    r"|<link\b[^>]*rel=[\"']preload[\"'][^>]*>",
    re.I)
# A last look for anything credential-shaped that survived, so a page that
# writes a key into a data- attribute is caught too. Redacted, not dropped:
# the next person needs to see that something was there.
KEYISH = re.compile(
    r"(sk\.[A-Za-z0-9._-]{20,}"                    # mapbox secret
    r"|pk\.[A-Za-z0-9._-]{40,}"                    # mapbox public, long form
    r"|AIza[0-9A-Za-z_-]{30,}"                     # google
    r"|gh[pousr]_[A-Za-z0-9]{30,}"                 # github
    r"|xox[baprs]-[A-Za-z0-9-]{20,}"               # slack
    r"|AKIA[0-9A-Z]{16})")                         # aws key id


def scrub(raw, ctype):
    """Return the bytes to keep, and how many redactions were made."""
    if "html" not in (ctype or "") and not raw[:200].lstrip().lower().startswith(b"<"):
        return raw, 0                      # a PDF or a CSV is not a script host
    text = raw.decode("utf-8", "replace")
    text = SCRIPTY.sub("<!-- script removed by survey_registries.py: a licence "
                       "list is markup, and script is where other people's API "
                       "keys live -->", text)
    text, n = KEYISH.subn("REDACTED-BY-SURVEY", text)
    return text.encode("utf-8"), n


def fetch(url, timeout, ua):
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
        return r.status, ctype, r.read(1_500_000)


def look(url, timeout):
    d = {"url": url}
    raw = None
    for ua, label in ((UA, "ours"), (BROWSER_UA, "browser")):
        try:
            status, ctype, raw = fetch(url, timeout, ua)
            d.update(status=status, contentType=ctype, bytes=len(raw), ua=label)
            d["_raw"] = raw
            d.pop("error", None)
            break
        except Exception as ex:
            d.update(status=0, ua=label,
                     error="%s: %s" % (type(ex).__name__, str(ex)[:130]))
            if "403" not in str(ex):
                break            # only a refusal is worth a second identity
    if raw is None:
        return d

    # A CSV IS THE ANSWER, NOT AN "UNCLEAR". Content that is not HTML falls
    # through to the tag counters below, which find no <tr> and no <form> and
    # report "unclear" -- about a file that is already the table we wanted.
    ctype = d.get("contentType", "")
    if ("csv" in ctype or "excel" in ctype or "spreadsheet" in ctype
            or re.search(r"\.(csv|xlsx?)(\?|$)", url, re.I)):
        head = raw[:4000].decode("utf-8", "replace")
        first = head.splitlines()[0] if head.splitlines() else ""
        d["shape"] = "csv" if ("," in first and "<" not in first[:200]) else "spreadsheet"
        d["headerCells"] = [c.strip().strip('"') for c in first.split(",")][:14]
        d["rows"] = max(0, raw.count(b"\n") - 1)
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
    links = sorted(set(DATA_LINK.findall(body)))
    ranked = sorted(links, key=lambda l: (-rank_link(l), l))
    d.update(rows=rows, headerCells=[h for h in heads if h], dataLinks=ranked[:12])
    best = [l for l in ranked if rank_link(l) >= 2]
    if best:
        d["looksLikeARoster"] = best[:4]
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
    ap.add_argument("--keep", action="store_true",
                    help="write every page that answered to debug/registries/survey/, "
                         "so the next reader is written from bytes rather than from a "
                         "one-word shape")
    a = ap.parse_args()

    if a.keep:
        PAGES.mkdir(parents=True, exist_ok=True)

    out = []
    for st, what, url, conf in CANDIDATES:
        d = look(url, a.timeout)
        d.update(state=st, expected=what, confidence=conf)
        """KEEP THE PAGE. A CLASSIFICATION IS NOT A DOCUMENT.

        This run told us Texas serves an html table of 36 rows and no <th> at
        all, and Washington two PDFs of 713 KB and 383 KB. None of that is
        enough to write a reader: what a reader needs is the column order, the
        row shape and the three rows that will break it.

        Four fixes today were written from bytes the runner kept -- the
        AgriCharts cell widening, the AgHost DataGrid selector, the
        cashbidssingle heading and the Hillsdale tab strip -- and every one of
        them had first been guessed at wrong from a summary. The survey is the
        one step that reaches these hosts, so it is the one chance to bring
        the page back."""
        if a.keep and d.get("bytes"):
            ext = ".pdf" if d.get("shape") == "pdf" else ".html"
            name = "%s-%s%s" % (st.lower(),
                                re.sub(r"[^a-z0-9]+", "-", what.lower()).strip("-")[:40], ext)
            try:
                body, redacted = scrub(d.pop("_raw"), d.get("contentType"))
                (PAGES / name).write_bytes(body)
                d["kept"] = "debug/registries/survey/%s" % name
                d["keptBytes"] = len(body)
                if redacted:
                    d["redacted"] = redacted
            except Exception as ex:
                d["keptError"] = str(ex)[:80]
        d.pop("_raw", None)
        out.append(d)
        print("%-3s %-28s %-18s %s"
              % (st, what[:28], d.get("shape") or ("HTTP %s" % d.get("status")),
                 d.get("error", "")[:60] or
                 ((("%s rows" % d["rows"]) if d.get("rows") else "")
                  + (("  %d data link(s)" % len(d["dataLinks"])) if d.get("dataLinks") else "")
                  + (("  ROSTER? %s" % d["looksLikeARoster"][0].rsplit("/", 1)[-1][:44])
                     if d.get("looksLikeARoster") else "")
                  + ("  [browser UA]" if d.get("ua") == "browser" else ""))))
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

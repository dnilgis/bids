#!/usr/bin/env python3
"""
A REGISTRY ROW IS ONE LICENSEE.

South Dakota's PUC publishes its licence list as a PDF, and the text extractor
sometimes puts several table rows on one line. The continuation joiner then glued
that line onto the previous licensee's name. Eleven records came out as one
company each; the worst ran 296 characters and named eight businesses across four
states, and it was pinned on a single town in Indiana:

    "S&G COMMODITIES, LLC BOMAHA, NE B SCHMITZ GRAIN INC BCURRIE, MN A+VCS
     SCOULAR CANADA, ULC BSASKATOON, SK B SEED EXCHANGE, LLC BPLATTE B ..."

Found on 2026-09-01 by building the coverage map and clicking a grey pin.

Two guards, tested here against the REAL eleven, captured out of the published
geocode rather than typed from memory:

  1. the continuation pattern must join a genuine wrapped town and refuse a line
     that is itself a whole record;
  2. anything still mashed is refused at write time and printed, never stored.

    python3 test/registry-run-together.test.py

No network. Instant.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


def fixture_names(R):
    """Every real licensee name the committed fixtures hold, read by the
    shipped readers — never by a copy of them written for this test.

    Wisconsin's workbook goes through read_xls() and the three licence books
    through pdf_text()/pdf_records(), each with the SOURCE ENTRY that names
    them, so a change to a source's pattern or column map shows up here."""
    out = set()

    xls = os.path.join(ROOT, "fixtures", "registry-wi-datcp.xls")
    wi = next((s for s in R.SOURCES if s.get("state") == "WI"), None)
    if wi and os.path.exists(xls):
        recs, _ = R.read_xls(open(xls, "rb").read(), {}, wi.get("columns"))
        out |= {r["name"] for r in recs if r.get("name")}

    for fx, state in (("registry-wa-licence-book.pdf", "WA"),
                      ("registry-id-dealers.pdf", "ID"),
                      ("registry-id-wa-coops.pdf", "ID")):
        path = os.path.join(HERE, "fixtures", fx)
        if not os.path.exists(path):
            continue
        text = R.pdf_text(open(path, "rb").read(), {})
        for src in [s for s in R.SOURCES if s.get("state") == state]:
            try:
                recs = R.pdf_records(text, {}, src.get("pattern"), src.get("continuation"),
                                     src.get("cityStrip"), src.get("carry"))
            except Exception:
                continue
            out |= {r["name"] for r in recs if r.get("name")}
    return out


def main():
    import fetch_registries as R

    print("the eleven real mangled names are all caught")
    fx = os.path.join(HERE, "fixtures", "mashed-registry-names.json")
    names = json.load(open(fx))
    check(len(names) == 11, "the fixture holds all eleven", "%d" % len(names))
    missed = [n for n in names if not R._run_together(n)]
    check(not missed, "every one is refused by _run_together",
          "%d slipped through, e.g. %s" % (len(missed), (missed[:1] or [""])[0][:70]))

    # ── WHERE THE REAL NAMES COME FROM, AND WHY IT IS NOT data/registries.json ──
    #
    # THIS TEST LATCHED THE PIPELINE SHUT — 2026-09-07, run 91957... .
    #
    # It used to read `data/registries.json` and require `len(good) > 1500`.
    # That file is the FETCH'S OWN OUTPUT, and this suite runs in the workflow
    # step named "Test the readers this run is about to use" — which sits
    # BEFORE the fetch, on purpose, so a regression is caught before an hour of
    # geocoding is spent on data it would mangle. Right principle. But it means
    # a guard reading the fetch's output is a LATCH: the 2026-09-07 20:46 run
    # narrowed that file to 210 records, this check went red at 210, the step
    # is `bash -e`, and the fetch step was therefore SKIPPED. The one action
    # that would have restored the file could no longer run, and the 22:42 run
    # proved it: exit 1 here, `steps.fetch.outcome == skipped`, eleven states
    # still gone. A test that can prevent its own cure is not a guard.
    #
    # And the threshold was never a property of `_run_together` anyway. It was
    # a property of how much had been harvested that week — the same mistake
    # test/registry-readers.test.py already has a paragraph about, where exact
    # PDF row counts turned out to be asserting a property of pypdf's version.
    #
    # So the corpus is built from COMMITTED BYTES, through the SHIPPED readers:
    # Wisconsin's workbook and the three licence-book PDFs. Three states, two
    # file formats, and not one byte of it moves when the pipeline runs.
    print("\nand no real licensee name is")
    good = sorted(fixture_names(R) - set(names))
    caught = [n for n in good if R._run_together(n)]
    # A BAND, NOT A NUMBER. The PDF share of this corpus is extracted by pypdf,
    # which is installed unpinned, and a newer release reads a few more rows
    # than an older one — measured 2026-09-07 at 280 (210 Wisconsin + 70 from
    # the books). The floor is what makes the check mean something; the ceiling
    # catches a reader that started inventing records.
    check(200 <= len(good) <= 400,
          "200-400 real licensee names to test against, from committed fixtures",
          "%d" % len(good))
    check(not caught, "no ordinary licensee trips the test",
          "%d would be thrown away, e.g. %s" % (len(caught), (caught[:1] or [""])[0][:70]))

    # THE JOIN DECISION, NOT THE REGEX. Tightening the character class was my
    # first fix and it was wrong: it refused the mashed lines and lost every
    # genuine wrap too, because "BHARROLD A+VCS" and "BS GRAIN, LLC BGETTYSBURG B"
    # have the same shape. What separates them is the record pattern, so what is
    # tested here is the joiner's verdict on a two-line document — the same
    # decision the run makes, not a regex the run never consults alone.
    print("\nthe joiner takes a wrapped town and refuses a whole record")
    sd = next(s for s in R.SOURCES if s.get("state") == "SD")

    def joined_onto_previous(line):
        """True when pdf_records glues `line` onto the licensee above it."""
        head = "FREDERICK FARMERS ELEVATOR"
        d = {}
        R.pdf_records(head + "\n" + line, d, sd["pattern"],
                      sd.get("continuation"), sd.get("cityStrip"))
        return d.get("pdfLinesJoined") == 1

    for real in ["BHARROLD A+VCS", "BSINAI A+VCS", "BPLATTE B", "BWATERTOWN B"]:
        check(joined_onto_previous(real), "joins a genuine wrap: " + real)
    # Each of these is a real South Dakota licensee whose NAME begins with B, F,
    # S or W. Sixty-three lines in that document look like this and every one of
    # them was being eaten.
    for whole in ["BUNGE USA GRAIN LLC FKIMBALL A+VCS",
                  "FREMAR, LLC FCANOVA A+VCS",
                  "SUNBIRD, INC BHURON A+VCS",
                  "BS GRAIN, LLC BGETTYSBURG B",
                  "BFLAGLER, CO B WAGNER'S LLC SHAFER SEED COMPANY BMILFORD, IL B",
                  "BOMAHA, NE B SCHMITZ GRAIN INC BCURRIE, MN A+VCS"]:
        check(not joined_onto_previous(whole),
              "refuses a line that parses as a record: " + whole[:34] + "\u2026")

    print("\nthe threshold is where the measurement put it")
    src = open(os.path.join(ROOT, "scripts", "fetch_registries.py")).read()
    check("_NAME_MAX = 90" in src,
          "the length limit is 90, the figure the name-length sweep supports",
          "someone moved it without re-running the sweep")

    print()
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), "; ".join(FAILED)))
        return 1
    print("registry run-together: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

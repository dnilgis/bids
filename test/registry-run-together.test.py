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


def main():
    import fetch_registries as R

    print("the eleven real mangled names are all caught")
    fx = os.path.join(HERE, "fixtures", "mashed-registry-names.json")
    names = json.load(open(fx))
    check(len(names) == 11, "the fixture holds all eleven", "%d" % len(names))
    missed = [n for n in names if not R._run_together(n)]
    check(not missed, "every one is refused by _run_together",
          "%d slipped through, e.g. %s" % (len(missed), (missed[:1] or [""])[0][:70]))

    print("\nand no real licensee name is")
    reg = json.load(open(os.path.join(ROOT, "data", "registries.json")))["businesses"]
    good = [b["name"] for b in reg if b.get("name") and b["name"] not in names]
    caught = [n for n in good if R._run_together(n)]
    check(len(good) > 1500, "there are real names to test against", "%d" % len(good))
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

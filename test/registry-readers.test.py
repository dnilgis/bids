#!/usr/bin/env python3
"""
TWO REGISTRY READERS: WASHINGTON'S BLOCKS, AND IDAHO'S UNSEPARATED LINE.

Washington's WSDA licence book is the first registry source that is not one
record per line. It is a block per company, and the locations are the whole
point of it:

    *Almota Elevator Company, Inc. 509/397-3456 185A Port Almota/Whitman 2,703,000
    Dan Hart, Mgr. 509/397-3459 (Fax)           185B Union Center/Whitman  426,000
    P.O. Box 617                                185C Mockonema/Whitman     457,000
    Colfax, WA 99111

Three elevators. The company's name is on the first line only, so reading each
line alone gives a grain elevator in Union Center run by "Dan Hart, Mgr." and
one in Mockonema run by a post-office box. Both towns are real, which is what
makes it dangerous: a pin lands, in the right place, under a person's name.

`carry` names the line that starts a block. The marker is the DOCUMENT'S OWN —
its key page says "* = Warehouse/Dealer License" — not "the line has a phone
number on it", which was tried first and picked up the Fax line underneath.

Everything here runs against test/fixtures/registry-wa-licence-book.pdf, the
2023-24 book exactly as it was served. No network.

    python3 test/registry-carry.test.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

FAILED = []


def _pypdf_version():
    """Printed beside the counts, because the counts move with it and nothing
    else in this file explains why a number changed."""
    try:
        import pypdf
        return pypdf.__version__
    except Exception:
        return "unknown"


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


def main():
    import fetch_registries as R

    src = next((s for s in R.SOURCES if s.get("state") == "WA"), None)
    check(src is not None, "Washington is a source")
    if not src:
        return 1
    check(src.get("carry"), "and it declares a carry pattern")

    raw = open(os.path.join(HERE, "fixtures", "registry-wa-licence-book.pdf"), "rb").read()
    diag = {}
    text = R.pdf_text(raw, diag)
    check(text and len(text) > 20000, "the committed book still extracts", "%s" % len(text or ""))

    recs = R.pdf_records(text, diag, src.get("pattern"), src.get("continuation"),
                         src.get("cityStrip"), src.get("carry"))

    # ── the counts, and WHY THEY ARE A BAND AND NOT A NUMBER ────────────────
    #
    # These were first written as exact figures — 205 rows, 114 pairs, 20
    # companies, 109 towns — measured on the committed PDF. They went red on
    # the first CI run, 2026-09-06, at 212 / 116 / 21 / 110.
    #
    # The document did not change; it is the same committed bytes. THE TEXT
    # EXTRACTOR DID. pypdf is installed unpinned in the workflow, so the runner
    # had a newer release than the machine the numbers were measured on
    # (pypdf 3.17.4), and a newer release lays this page out slightly better —
    # it reads SEVEN MORE warehouses and one more company, not fewer.
    #
    # So the exact count was asserting a property of a library, dressed up as a
    # property of a licence book, and it would have gone red on any Tuesday
    # somebody bumped pypdf. What IS a property of the document is asserted
    # exactly below: no elevator filed under a manager or a post-office box, no
    # town that does not exist, Almota's three yards, both Idaho splits. Those
    # passed on BOTH versions and they are the checks that matter.
    #
    # The band is wide enough for a better extractor and narrow enough that a
    # collapse fails. The numbers are printed every run, so a drift is visible
    # rather than merely tolerated.
    print("\nwhat the book actually holds   (pypdf %s)" % _pypdf_version())
    pairs = sorted({(r["name"], r.get("city", "")) for r in recs})
    firms = {n for n, _ in pairs}
    towns = {c for _, c in pairs}
    print("    %d location rows · %d company-and-town pairs · %d companies · %d towns"
          % (len(recs), len(pairs), len(firms), len(towns)))
    check(200 <= len(recs) <= 230, "200-230 location rows (205 on pypdf 3.17.4, 212 on the runner)",
          "%d" % len(recs))
    check(110 <= len(pairs) <= 130, "110-130 company-and-town pairs (114 / 116)", "%d" % len(pairs))
    check(19 <= len(firms) <= 25, "19-25 companies (20 / 21)", "%d" % len(firms))
    check(105 <= len(towns) <= 125, "105-125 towns (109 / 110)", "%d" % len(towns))
    check(all(r.get("city") for r in recs), "every row has a town")

    # ── the bug the carry exists to prevent ─────────────────────────────────
    print("\nno elevator is filed under a manager or a post-office box")
    for bad in ("Mgr.", "Pres.", "CEO", "P.O.", "PO Box", "(Fax)"):
        hits = [r["name"] for r in recs if bad.lower() in r["name"].lower()]
        check(not hits, 'no company name contains "%s"' % bad,
              "%d, e.g. %s" % (len(hits), (hits[:1] or [""])[0]))

    almota = sorted(r.get("city") for r in recs if r["name"].startswith("Almota"))
    check(almota == ["Mockonema", "Port Almota", "Union Center"],
          "Almota Elevator keeps all three of its towns", "%s" % almota)

    # ── the licence code, and the towns that do not exist ───────────────────
    print("\nthe licence code takes its own trailing letters")
    # Ritzville numbers past Z — 295U, 295UU, 295UUU — and the extractor renders
    # those "295U U" and "295U UU". A code of \d+[A-Z] left the spare letters on
    # the front of the town and filed grain at "U Edwall" and "V Washtucna".
    for ghost in ("U Edwall", "V Washtucna", "UU Edwall", "VV Washtucna"):
        check(ghost not in towns, 'no town called "%s"' % ghost)
    for real in ("Edwall", "Washtucna", "Ritzville", "Lacrosse", "Colfax", "Pomeroy"):
        check(real in towns, '"%s" is read' % real)

    # ── and the guess that belongs to a different document ──────────────────
    print("\n_two_word_city does not run when the name came from another line")
    # It offers the last word of the company name as the first word of the town,
    # which is only meaningful where the two ran together with nothing between
    # them. Here the document separates them with "/", and it produced a town
    # called "Oregon Vancouver" out of "United Grain Corporation of Oregon".
    alts = [r for r in recs if "cityAlt" in r]
    check(not alts, "no alternative towns are invented",
          "%d, e.g. %s" % (len(alts), (alts[:1] or [{}])[0].get("cityAlt", "")))

    # ── a location above its own header is dropped, not guessed ─────────────
    print("\na location with no company above it is refused")
    orphan = "  185Z Nowhere/Whitman 1,000\n"
    d2 = {}
    got = R.pdf_records(orphan, d2, src.get("pattern"), src.get("continuation"),
                        src.get("cityStrip"), src.get("carry"))
    check(got == [], "nothing is emitted without a carried name", "%s" % got)

    # ── IDAHO: the split that needed no new route ───────────────────────────
    print("\nIdaho's town is separated by _two_word_city, not by a gazetteer")
    # The 2026-09-04 note wrote Idaho off: the line carries no separator between
    # the company and the town, and splitting them "is a new route rather than a
    # pattern". The route was already in the file — Nebraska's _two_word_city —
    # and it carries BOTH readings so the Census geocoder decides on evidence.
    ids = [s for s in R.SOURCES if s.get("state") == "ID"]
    check(len(ids) == 2, "both Idaho documents are sources", "%d" % len(ids))
    for fx, want, src2 in (("registry-id-dealers.pdf", 40, ids[0] if ids else None),
                           ("registry-id-wa-coops.pdf", 15, ids[1] if len(ids) > 1 else None)):
        if not src2:
            continue
        txt = R.pdf_text(open(os.path.join(HERE, "fixtures", fx), "rb").read(), {})
        rs = R.pdf_records(txt, {}, src2.get("pattern"))
        check(len(rs) == want, "%s reads %d licensees" % (fx, want), "%d" % len(rs))
        check(all(r.get("st") for r in rs), "every one carries the state the document printed")
        by = {r["name"]: r for r in rs}
        if fx == "registry-id-dealers.pdf":
            # THE FOUR SHAPES, and what makes each of them resolvable.
            hits = [r for r in rs if r.get("city") == "Falls" and r.get("cityAlt") == "Idaho Falls"]
            check(hits, '"Idaho Falls" is offered as the alternative to "Falls"')
            hits = [r for r in rs if r.get("cityAlt") == "Brigham City"]
            check(hits, '"Brigham City" is offered as the alternative to "City"')
            hits = [r for r in rs if r.get("cityAlt") == "Mount Prospect"]
            check(hits, '"Mount Prospect" is offered as the alternative to "Prospect"')
            # And the case where the PLAIN reading is the right one: the
            # alternative "Primeland Lewiston" is the one that will not resolve.
            hits = [r for r in rs if r.get("city") == "Lewiston"]
            check(hits, '"Lewiston" is read plainly, with the alternative carried beside it')
            # Nothing here decides which is right — that is the geocoder's job —
            # so BOTH must survive the reader.
            amb = [r for r in rs if "cityAlt" in r]
            check(len(amb) >= 8, "several rows carry an alternative to be arbitrated",
                  "%d" % len(amb))
            # Out-of-state licensees are counted, never attributed to Idaho.
            out_of = {r["st"] for r in rs} - {"ID"}
            check(out_of, "licensees the document places in other states keep those states",
                  "%s" % sorted(out_of))

    print("\n%d check(s) failed" % len(FAILED) if FAILED else "\nall checks passed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())

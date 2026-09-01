#!/usr/bin/env python3
"""
A REASON WITH A HOLE IN IT IS WORSE THAN NO REASON.

The first coverage map listed six sources as

    "coordinate rejected: 40.8528,-98.0201 is outside "

with the state's name simply absent. Those six have no state on file, so
in_state() had no box to test against and returned False — the right verdict,
an unverifiable coordinate should not go on a map — but the message interpolated
an empty string and came out reading like a bad coordinate. It sent me looking
for a geocoding fault when the real one was a missing field, and the coordinates
turned out to be fine.

THIS TESTS THE PRODUCER, NOT THE PUBLISHED FILE. geocodes/places.json still
contains those six strings and will until the geocode job next runs on the
runner, which is not something a test should wait for. So the sentences are
built here, from the same code, and read.

    python3 test/unplaced-reason.test.py

No network. Instant.
"""
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location("bg", os.path.join(ROOT, "scripts", "build_geocodes.py"))
BG = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BG)

FAILED = []


def check(ok, name, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else "  -- " + detail))
    if not ok:
        FAILED.append(name)


# The shapes a half-built sentence takes. Each one is a real failure mode:
# a trailing space is an empty tail substitution, a doubled space is an empty
# middle one, and a preposition at the end is a value that never arrived.
HOLES = [
    (r"\s$",                              "ends in whitespace"),
    (r"\b(is outside|is in|from|than|near|of)\s*$", "stops where a value should be"),
    (r"  ",                               "has a doubled space"),
    (r"\b(undefined|null|NaN|None)\b",    "carries a placeholder word"),
    (r"\(\)|\[\]|''|\"\"",                "carries an empty pair"),
]


def whole(sentence, name):
    for rx, what in HOLES:
        if re.search(rx, sentence):
            check(False, name, '%s: "%s"' % (what, sentence))
            return
    check(len(sentence.strip()) > 8, name, 'too short to be a reason: "%s"' % sentence)


def main():
    print("a source with no state gets a sentence, not a gap")
    # in_state() is the function that returns False with nothing to say. Confirm
    # that is still true, so this test is testing the situation it claims to.
    check(BG.in_state(41.0, -98.0, "", {"NE": (40.0, 43.0, -104.0, -95.3)}) is False,
          "in_state still refuses a source with no state")
    check(BG.in_state(41.0, -98.0, "NE", {"NE": (40.0, 43.0, -104.0, -95.3)}) is True,
          "and still accepts one that is genuinely inside")

    print("\nthe sentences the run writes")
    # Built the way build_geocodes.py builds them, with the values that broke it.
    made = [
        ("coordinate rejected: %.4f,%.4f may well be right, but this source "
         "has no state on file, so there is nothing to check it against" % (40.8528, -98.0201),
         "no state on file"),
        ("coordinate rejected: %.4f,%.4f is outside %s" % (40.8528, -98.0201, "NE"),
         "outside a state that is named"),
        ("coordinate rejected: %s" % "70 km from Ramsey",
         "too far from its town"),
    ]
    for sentence, name in made:
        whole(sentence, name)

    print("\nand the shape that used to ship is caught")
    bad = "coordinate rejected: %.4f,%.4f is outside %s" % (40.8528, -98.0201, "")
    caught = any(re.search(rx, bad) for rx, _ in HOLES)
    check(caught, "the old empty-state sentence would fail this test",
          "the guard does not catch what it was written for")

    print("\nthe source file no longer builds that sentence")
    src = open(os.path.join(ROOT, "scripts", "build_geocodes.py"), encoding="utf-8").read()
    check("has no state on file, so there is nothing to check it against" in src,
          "build_geocodes.py has the no-state branch")
    # .index() would raise here when the branch is missing, and a guard that
    # crashes instead of reporting is a guard nobody can read the output of.
    a = src.find('if not (st or "").strip():')
    b = src.find("if not in_state(lat, lon, st, boxes):")
    check(a != -1 and b != -1 and a < b,
          "the no-state branch runs BEFORE the out-of-state one",
          "missing" if a == -1 else "it is placed after, so the empty message is reached first")

    print()
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), "; ".join(FAILED)))
        return 1
    print("unplaced reasons: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

/* AN ELEVATOR IN THE WRONG STATE IS A PIN IN A REAL PLACE.
 *
 * On 2026-09-06 AgMark LLC. of Beloit, Kansas had two sources filed at
 * Gaylord, MINNESOTA — 55334, Sibley County, 384 miles from every other
 * elevator it runs. Nothing was broken. Nothing refused. The bid published,
 * the map drew a pin, and the pin was in Minnesota.
 *
 * IT MATCHED ON A NAME, NOT A PLACE. data/known-elevators.json holds exactly
 * one Gaylord and it is the Minnesota one, so the sweep matched the board's
 * label to the only town of that name it had heard of. The same shape as
 * "LIBERAL KS" filed in Missouri and AgMark's six Kansas towns scattered across
 * WI/OH/ND/SD/IA/MN — each found by hand, each after it shipped.
 *
 * scripts/state-outliers.mjs was written to find them and then RAN IN NO
 * WORKFLOW AND HAD NO TEST, which is the same defect as the tool itself: a
 * check nobody runs is a draft. This is that check.
 *
 * WHAT IT ASSERTS. Not "there are no outliers" — co-ops cross state lines and
 * most of these are correct. It asserts that every source more than FAR_MILES
 * from its operator's own centre is one a PERSON WROTE DOWN, with the reason.
 * A new one appears as a failure naming the id, and the fix is either to
 * correct the source or to add a line here saying why it is right.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, FAR_MILES } from "../scripts/state-outliers.mjs";

const { findings } = analyse();

/* ── DECLARED, WITH THE EVIDENCE ────────────────────────────────────────────
   Each of these was checked against the operator's OWN board — the list of
   towns it publishes — not against a guess about how far a co-op might reach. */
const ACCOUNTED_FOR = {
  "ceagrain-apache":
    "CoMark Equity Alliance is Kansas, and its own cashgrid publishes Apache, " +
    "Braman, Chickasha, Fort Cobb, Newkirk, Tuttle and Union City — Oklahoma " +
    "towns, on the board, under its own name. A co-op reaching south.",
  "ceagrain-fortcobb": "as ceagrain-apache: on CoMark's own Oklahoma list.",
  "ceagrain-chickasha": "as ceagrain-apache: on CoMark's own Oklahoma list.",
  "ceagrain-tuttle": "as ceagrain-apache: on CoMark's own Oklahoma list.",
  "ceagrain-unioncity": "as ceagrain-apache: on CoMark's own Oklahoma list.",
  "farmerscooperative-bungeemporia":
    "A DELIVERY POINT, NOT A YARD. Farmers Cooperative of Dorchester is " +
    "Nebraska; Bunge's Emporia, Kansas plant is where it ships, and the co-op " +
    "posts a bid for hauling there. The braces in the board's own label — " +
    "{BUNGE - EMPORIA} — are how that board marks a destination.",
};

test("no source sits far from its operator without somebody having said why", () => {
  const far = findings.filter((f) => f.milesFromOperatorCentre !== "" &&
                                     Number(f.milesFromOperatorCentre) >= FAR_MILES);
  const undeclared = far.filter((f) => !ACCOUNTED_FOR[f.id])
    .map((f) => `${f.id} — ${f.location}, ${f.state} is ${f.milesFromOperatorCentre} miles ` +
                `from ${f.operator}'s ${f.homeState} centre`);
  assert.deepEqual(undeclared, [],
    "Check the operator's OWN board for the town before writing it down here. " +
    "If the board does not list it, the source is wrong and the source is what changes.");
});

test("and nothing is declared that is not actually far", () => {
  /* A DECLARATION THAT NO LONGER APPLIES IS A COMMENT PRETENDING TO BE A RULE.
     If a source is fixed or retired, its line here has to go, or the next
     person reads a warning about an elevator that no longer has a problem. */
  const farIds = new Set(findings
    .filter((f) => f.milesFromOperatorCentre !== "" &&
                   Number(f.milesFromOperatorCentre) >= FAR_MILES)
    .map((f) => f.id));
  const stale = Object.keys(ACCOUNTED_FOR).filter((id) => !farIds.has(id));
  assert.deepEqual(stale, [], "these are no longer outliers — remove them from ACCOUNTED_FOR");
});

test("AgMark's Gaylord is in Kansas, and this is the row that proves it", () => {
  /* THE ONE THIS FILE EXISTS FOR. Kept as a named check rather than left to the
     general rule above, because the general rule would go quiet the moment
     somebody added "agmarkllc-gaylord" to ACCOUNTED_FOR to make it green. */
  const gaylord = findings.filter((f) => /gaylord/i.test(f.id));
  assert.deepEqual(gaylord, [],
    "a Gaylord source is an outlier again. AgMark LLC. is Beloit, Kansas, and " +
    "every one of the twenty-five towns on its own board is in Kansas — Gaylord " +
    "sits between Athol and Kensington (Smith County) and Glade and Kirwin " +
    "(Phillips County). Gaylord KS is ZIP 67638. Gaylord MN is 384 miles away.");
});

test("the threshold is where the measurement put it, not where it is convenient", () => {
  /* Measured 2026-09-06 over 973 sources: the out-of-state distances fall into
     two groups with nothing between them — 150 to 195 miles for co-ops reaching
     over a line, and 384 for the two that were simply wrong. FAR_MILES is the
     FLOOR of the ordinary group, so every ordinary case has to be written down
     too. Raising it to hide a failure is the thing this asserts against. */
  assert.equal(FAR_MILES, 150, "moving this needs a fresh measurement, not a red run");
  const far = findings.filter((f) => f.milesFromOperatorCentre !== "" &&
                                     Number(f.milesFromOperatorCentre) >= FAR_MILES);
  assert.ok(far.length >= 5,
    `only ${far.length} rows are above the threshold — if that is because the ` +
    "threshold moved rather than because sources were fixed, put it back");
});

test("a distance that could not be computed is reported, not treated as zero", () => {
  /* The bug this tool was written for hid in a blank: all thirteen of AgMark's
     Kansas sources carried lat = null, so there was no centre to measure from
     and the Minnesota outlier sorted to the bottom of its own report. An
     uncheckable row is a louder signal than a nearby one. */
  const unchecked = findings.filter((f) => f.milesFromOperatorCentre === "");
  assert.deepEqual(unchecked.map((f) => f.id), [],
    "an out-of-state source whose operator has no placeable home locations — " +
    "it may be the only pin that operator draws, and nothing can check it");
});

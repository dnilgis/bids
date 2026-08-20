/* TOWN, OR SOMEWHERE THE GRAIN GOES?
 *
 * Every name in this file was READ OFF A REAL DTN ROSTER captured on
 * 2026-08-20 across eight co-operatives. None of it is invented, which is the
 * point: a classifier tested only on names somebody made up is a classifier
 * tested on somebody's idea of the problem.
 *
 * The cost of getting this wrong is specific. A manifest carries a town and a
 * geocode, and AGSIST drops a pin with them. Ask a geocoder for "Bunge PDC"
 * and it answers -- no error, just a coordinate somewhere -- and a bid appears
 * on the map at a place nobody chose. That is rule one broken quietly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { destinationReason, looksLikeDestination } from "../lib/place.mjs";

/* Real locations from the rosters that ARE towns. */
const TOWNS = [
  "Dunlap", "Elmwood", "Green  Valley", "Monica", "Williamsfield", "Alto ",
  "Anselmo", "Arnold", "Cedar Rapids", "Farnam", "Gothenburg", "Merna",
  "Midway", "North Loup", "Ord", "Spalding", "ADAMS", "AUBURNDALE", "HIXTON",
  "MAUSTON", "SEYMOUR", "STRATFORD", "TOMAH", "WEST SALEM", "WISC RAPIDS",
  "BLAIR ", "Valders", "WHITELAW", "Chilton", "KIEL", "MISHICOT", "READFIELD",
  "CENTER VALLEY", "Jefferson", "Ixonia", "Manchester", "New Albin", "Ossian",
  "Postville", "Fairbanks", "Mineral Point", "Mazomanie", "Richland Center",
  "Westby",
];

/* Real locations from the same rosters that are NOT towns. */
const NOT_TOWNS = [
  "ADM  Havana", "ADM Lacon", "ADM C.C.", "CHS Havana", "AGP-Hastings",
  "AGP-David City", "Green America-Ord", "BioUrja ", "ICP", "Bunge PDC",
  "Valero CC", "Shell Rock Soy", "Viserion Mcgregor", "Tharaldson Ethanol",
  "Big River Dyersville", "Big River Resources", "Red Wing Grain LLC",
  "Alton Grain", "UNITED QUALITY COOP", "CP Feeds-Valders", "CP Feeds-Wrightstown",
  "Local",
];

test("every real town is left alone", () => {
  const wrong = TOWNS.filter((t) => looksLikeDestination(t))
    .map((t) => `${t} -> ${destinationReason(t)}`);
  assert.deepEqual(wrong, [], `flagged a real town:\n${wrong.join("\n")}`);
});

test("every real destination is flagged", () => {
  const missed = NOT_TOWNS.filter((t) => !looksLikeDestination(t));
  assert.deepEqual(missed, [], `let a destination through: ${missed.join(", ")}`);
});

test("THE FLAG CARRIES ITS REASON", () => {
  // A flag whose grounds cannot be seen is a flag people learn to click past.
  for (const t of NOT_TOWNS) {
    const r = destinationReason(t);
    assert.ok(typeof r === "string" && r.length > 20, `${t}: unhelpful reason ${r}`);
    assert.ok(r.includes(t.trim()), `${t}: the reason does not quote the name it is about`);
  }
});

test("'Local' is a placeholder, and is called one", () => {
  // Both Clifford Farmers and United Quality use it. A geocoder will answer
  // for the word "Local" without complaint.
  assert.match(destinationReason("Local"), /placeholder/);
  assert.match(destinationReason("local"), /placeholder/);
  assert.equal(destinationReason("Localville"), null, "a town that merely starts with it");
});

test("a joined pair is a question, not an answer", () => {
  // "Ft Atkinson/Waucoma" is Premier's, and it is genuinely two towns. The
  // machine must not pick one.
  for (const n of ["Ft Atkinson/Waucoma", "Waupun/Brandon", "Cedar Grv/Random Lk"])
    assert.match(destinationReason(n), /joins two names|facility|buyer/);
});

test("nothing, blank and rubbish do not throw", () => {
  assert.equal(destinationReason(""), null);
  assert.equal(destinationReason(null), null);
  assert.equal(destinationReason(undefined), null);
  assert.equal(destinationReason("   "), null);
});

test("a buyer is matched as a WORD, not as a substring", () => {
  // "adm" inside "Adamsville" is not Archer Daniels Midland, and "Adams" is a
  // real Allied Cooperative location.
  assert.equal(destinationReason("Adams"), null);
  assert.equal(destinationReason("Adamsville"), null);
  assert.equal(destinationReason("Chsville"), null);
  assert.ok(looksLikeDestination("ADM Havana"));
});

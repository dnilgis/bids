/*
 * THE KEY THAT MERGES A REGISTRY ROW WHEN THERE IS NO PHONE TO ASK.
 *
 * Every merge in this repository was decided by a ten-digit phone until
 * 2026-09-09. USDA's national warehouse list has no phone column at all, so
 * 4,613 sites would have walked past that rule — and 1,346 of them are
 * elevators data/directory.json already held. A blind append put the directory
 * at 9,784 rows where the truth is about 7,900, and the coverage percentage on
 * /elevators divides by that number.
 *
 * WHAT IS TESTED HERE IS THE RULE AND THE SEAM, AND NOTHING ELSE.
 *
 * Not data/directory.json. That file is written by the pipeline this key runs
 * inside, and a guard that reads the pipeline's own output can bolt the door on
 * the pipeline — 2026-09-07, eleven states unrecoverable, see the long note in
 * test/registry-run-together.test.py. The cases below are hand-worked from
 * names that are in the sources, and the seam is read off the script.
 */
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orgKey, operatorKey, placeKey } from "../lib/orgkey.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("a trailing legal form is not part of the business", () => {
  /* The case that made the rule necessary: CHS is on 200-odd rows of USDA's
     list as "CHS Inc." and on a dozen boards as "CHS". */
  assert.equal(operatorKey("CHS Inc."), "CHS");
  assert.equal(operatorKey("CHS, Inc"), "CHS");
  assert.equal(operatorKey("CHS"), "CHS");
  assert.equal(operatorKey("Bartlett Grain Company, LLC"), "BARTLETTGRAIN");
  assert.equal(operatorKey("The DeLong Co., Inc."), "DELONG");
  assert.equal(operatorKey("DeLong Company"), "DELONG");
  /* Two spellings of one co-op. The hyphen, the space and the long form all
     arrive as the same key or the same yard gets two pins. */
  for (const n of ["River Country Co-op", "River Country Cooperative",
                   "RIVER COUNTRY CO OP", "River Country Co-Operative"])
    assert.equal(operatorKey(n), "RIVERCOUNTRYCOOP", n);
  /* Never to nothing: a name that is all legal form keeps its last word rather
     than becoming the empty string, which would match every other such name. */
  assert.equal(operatorKey("Grain Co LLC"), "GRAIN");
  assert.equal(operatorKey("LLC"), "LLC");
  assert.equal(operatorKey(""), "");
});

test("and a word inside the name is left alone", () => {
  /* THE LINE THIS KEY WILL NOT CROSS. Stripping COOP, ASSN or ELEVATOR finds a
     few dozen more merges and collapses these two, which are two businesses.
     A duplicate pin is visible and fixable; a silent merge hides a real
     elevator behind somebody else's pin and nothing on the map says so. */
  assert.notEqual(operatorKey("Farmers Coop Elevator Assn."),
                  operatorKey("Farmers Cooperative"));
  assert.notEqual(operatorKey("Premier Cooperative"), operatorKey("Premier Grain"));
});

test("the town is what makes a name identity", () => {
  /* An operator name on its own is forbidden as a key and build_directory.mjs
     has carried the paragraph saying so since 2026-08-20: "CHS" is two hundred
     businesses. In one town it is one yard. */
  assert.notEqual(orgKey("OK", "Hennessey", "CHS Inc."),
                  orgKey("OK", "Okarche", "CHS Inc."));
  assert.notEqual(orgKey("IL", "Morris", "CHS Inc."),
                  orgKey("MN", "Morris", "CHS Inc."));
  /* Two towns called Afton, in two states, one on USDA's list and one already
     in this directory. */
  assert.notEqual(orgKey("OK", "AFTON", "Beachner Grain, Inc."),
                  orgKey("IA", "AFTON", "New Cooperative, Inc."));
  /* Same town, two operators — Hennessey holds more than one elevator. */
  assert.notEqual(orgKey("OK", "Hennessey", "CHS Inc."),
                  orgKey("OK", "Hennessey", "Wheeler Brothers Grain"));
  /* And the same yard written two ways is one key. */
  assert.equal(orgKey("OK", "AFTON", "Beachner Grain, Inc."),
               orgKey("ok", "Afton", "Beachner Grain"));
  assert.equal(placeKey("wi", "Eau Claire"), "WI|EAUCLAIRE");
});

test("a row with no state or no town is not identified by this key", () => {
  /* A HALF-EMPTY KEY MATCHES EVERY OTHER HALF-EMPTY KEY. Thirty-one businesses
     in data/registries.json are licensed by one state and located somewhere
     else, and carry no state at all on purpose. Merging those on "|CHS" would
     drop real elevators, so the key refuses to exist. */
  assert.equal(orgKey("", "Bismarck", "Lighthouse Commodities, LLC"), "");
  assert.equal(orgKey("ND", "", "Lighthouse Commodities, LLC"), "");
  assert.equal(orgKey("ND", "Bismarck", ""), "");
  assert.equal(orgKey(null, null, null), "");
});

test("the seam: build_directory.mjs asks the key, and says how often it answered", () => {
  /* THE RULE BEING RIGHT IS HALF OF IT. Three times in this repository a
     correct, tested function has sat unwired — scaleByContract was one. This
     reads the wiring rather than trusting it. */
  const src = readFileSync(join(ROOT, "scripts/build_directory.mjs"), "utf8");
  assert.match(src, /import \{ orgKey \} from "\.\.\/lib\/orgkey\.mjs"/,
    "build_directory.mjs no longer imports the key");
  /* The registry branch, not merely somewhere in the file. */
  const reg = src.slice(src.indexOf("const regRaw"));
  assert.match(reg, /const key = orgKey\(r\.state, r\.location, r\.operator\)/,
    "the registry rows are no longer keyed");
  assert.match(reg, /if \(key && ourOrgs\.has\(key\)\) \{/,
    "a registry row is no longer checked against what we already hold");
  assert.match(reg, /else \{ regMergedByName\+\+; return null; \}/,
    "a registry row that names an elevator we already hold is no longer dropped");
  assert.match(reg, /if \(key && regOrgs\.has\(key\)\) \{/,
    "two registries naming one yard are no longer merged");
  assert.match(reg, /regMergedWithin\+\+;\n    return null;/,
    "the second row is no longer dropped");
  /* AND THE DROP IS COUNTED. A quiet drop tells the next reader the registry is
     smaller than it is — the same rule the run-together backstop follows. */
  assert.match(src, /registryMergedByName: regMergedByName/,
    "the count is no longer written into the directory's own counts");
  assert.match(src, /registryMergedWithinRegistries: regMergedWithin/);
  /* The set has to hold the Barchart rows too, or 643 of the merges measured on
     2026-09-09 would not happen: those are yards Barchart knows and we do not
     read. */
  assert.match(src, /for \(const k of Object\.values\(knownRaw\)\) addOrg\(/,
    "the known-elevator rows are no longer added to the merge set");
  /* THE PHONE RULE IS UNTOUCHED. This key is what happens when there is no
     phone; it is not a replacement for one. */
  assert.match(src, /if \(ph\.length === 10 && \(ourPhones\.has\(ph\) \|\| knownPhones\.has\(ph\)\)\)/,
    "the phone rule has been changed or removed");
});

test("a disabled manifest is not a row on the map, and must not drop one", () => {
  /* FOUND BY READING THIS CHANGE ADVERSARIALLY, 2026-09-10, and it was already
     true of the phone rule. `elevators` is built from the sources with
     `enabled !== false`; the three merge sets were built from ALL of them. So
     a registry row was dropped as "we already read that yard" against a
     manifest this build does not emit, and the elevator left the map from both
     sides at once. Eleven rows on the 2026-09-09 data; Horizon Resources at
     Williston, North Dakota lost the only row in the town. */
  const src = readFileSync(join(ROOT, "scripts/build_directory.mjs"), "utf8");
  assert.match(src, /const active = sources\.filter\(\(s\) => s\.enabled !== false\)/,
    "the enabled set is gone");
  for (const set of ["ourPhones", "ourTowns"])
    assert.match(src, new RegExp(`const ${set} = new Set\\(active\\.`),
      `${set} is built from every manifest again, disabled ones included`);
  /* ourOrgs is a Map of key to phones and is filled by a loop, not a map(). */
  assert.match(src, /for \(const s of active\) addOrg\(s\.state, s\.location, s\.operator, s\.phone\);/,
    "ourOrgs is filled from every manifest again, disabled ones included");
});

test("the row that is dropped hands over what it knew", () => {
  /* Two rolls naming one yard: the second row goes, and the first row keeps
     its capacity and its facility name. Measured 2026-09-09: dropping them
     outright lost the only capacity figure for 45 yards and the only facility
     name for 53. Empty fields only — a published value is never overwritten. */
  const src = readFileSync(join(ROOT, "scripts/build_directory.mjs"), "utf8");
  assert.match(src, /const regOrgs = new Map\(\);/,
    "regOrgs is a Set again, so there is no surviving row to hand anything to");
  assert.match(src, /const keep = regOrgs\.get\(key\);/);
  assert.match(src, /if \(keep && !keep\[f\] && r\[f\]\) keep\[f\] = r\[f\];/,
    "the fill is gone, or it has started overwriting published values");
  assert.match(src, /if \(key\) regOrgs\.set\(key, row\);/,
    "the surviving row is not remembered, so nothing merges within the registries");
});

test("a name-and-town match never overrules a phone", () => {
  /* The Andersons hold a head office and an elevator in Maumee, Ohio, under
     one name — 419-482-5009 and 419-893-5050. The key cannot tell them apart
     and the phone can, so where both rows publish ten digits and the digits
     differ, the registry row stays and the build says how often that happened.
     Sixteen rows on the 2026-09-09 data. */
  const src = readFileSync(join(ROOT, "scripts/build_directory.mjs"), "utf8");
  assert.match(src, /const ourOrgs = new Map\(\);/,
    "ourOrgs is a Set again, so it cannot remember a phone to disagree with");
  assert.match(src, /if \(ph\.length === 10 && theirs\.size && !theirs\.has\(ph\)\) regPhoneDisagreed\+\+;/,
    "a registry row with its own phone number is merged away on a name match again");
  assert.match(src, /registryKeptOnADifferentPhone: regPhoneDisagreed/,
    "and the count is no longer published");
});

test("a row says what its own document says about it", () => {
  /* This sentence read `(r.licences || ["grain"])[0]` and called every licence
     a STATE licence. USDA's list broke both halves at once: 2,387 of its
     warehouses are licensed federally, and 50 are printed Unlicensed and now
     carry no licence at all — where the old sentence would have produced
     "holds a state undefined licence". */
  const src = readFileSync(join(ROOT, "scripts/build_directory.mjs"), "utf8");
  /* The old expression, in the CODE — the comment above it quotes the same
     string on purpose, so this looks at the `why:` block alone. Comments are
     not coverage, and checking the whole file passed with the fallback still
     in it. */
  const why = src.slice(src.indexOf("    why: ("), src.indexOf("; no bid feed found yet"));
  assert.doesNotMatch(why, /\["grain"\]/, 'the invented "grain" licence is back');
  assert.match(src, /r\.licenceClass === "Federal" \? "federal" : "state"/,
    "a federal licence is called a state one again");
  assert.match(src, /is listed as a grain warehouse and holds no licence on that list/,
    "an unlicensed warehouse has gone back to claiming a licence");
  assert.match(src, /r\.licenceStatus && !\/issued\/i\.test\(r\.licenceStatus\)/,
    "a suspended licence no longer says so");
});

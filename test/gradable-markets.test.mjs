/* THE SKELETON BUILDER HAD A SENTENCE IN IT THAT WAS ABOUT TO BECOME A LIE.
 *
 * scripts/gradable-markets.mjs turns a partner's bootstrap into manifest
 * skeletons. Until 2026-09-15 two of the fields it wrote were constants:
 *
 *     cashRounding: "floor-cent",
 *     note: "... captured 2026-09-07 (discover run 92448826700) ...
 *            Their board declares cash_bid_rounding_mode "always_down";
 *            cashRounding is that and not a count."
 *
 * Both are true of POET. Both would have been printed on all 152 ADM files,
 * where `commodity_settings` is `{}` on every market and their board declares
 * nothing at all. That is a number nobody measured, wearing a provenance note
 * that says somebody did — which is the one thing this repository is for.
 *
 * Nothing had ever tested this file. These are the tests.
 *
 *     node --test test/gradable-markets.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { skeletonFor, slugOf } from "../scripts/gradable-markets.mjs";
import { marketsFrom } from "../lib/adapters/gradable.mjs";

const POET = readFileSync(new URL("../fixtures/gradable-poet-bootstrap.json", import.meta.url), "utf8");
const ADM  = readFileSync(new URL("../fixtures/gradable-adm-bootstrap.json", import.meta.url), "utf8");

const skels = (body, partner, slug) =>
  marketsFrom(body).filter((m) => !m.demo && m.publicSite)
    .map((m) => skeletonFor(m, partner, slug, "test capture"));

test("A MARKET THAT DECLARES NO ROUNDING GETS NULL, not floor-cent", () => {
  const s = skels(ADM, "adm", "adm");
  assert.equal(s.length, 152);
  assert.equal(s.filter((x) => x.cashRounding === null).length, 152,
    "a rounding nobody measured reached a manifest");
  assert.equal(s.filter((x) => x.cashRoundingCents === null).length, 152,
    "cashRoundingCents says 0, which is a measurement, next to a null mode");
});

test("and a market that DOES declare one keeps theirs", () => {
  /* POET states three different modes across its plants. If this ever comes
     back all-null, the reader has stopped reading rather than ADM having
     stopped declaring. */
  const s = skels(POET, "poet", "poetgrain");
  const modes = {};
  for (const x of s) modes[String(x.cashRounding)] = (modes[String(x.cashRounding)] ?? 0) + 1;
  assert.ok(Object.keys(modes).length >= 3, JSON.stringify(modes));
  /* THREE MODES AND TWO SILENCES. Measured across POET's 35 live markets:
       floor-cent 17 · round-cent-either 10 · round-cent 6 · null 2
     The two nulls are the markets whose commodity_settings names no mode, and
     they are not an error here — the 35 committed POET manifests carry
     `cashRounding: undefined` on exactly two files, so whoever wrote them hit
     the same two and declined to invent a value. The old hardcoded
     "floor-cent" was wrong for those two as well; nobody had noticed because
     the skeletons were read by a person before they became files. */
  assert.equal(modes["null"], 2, JSON.stringify(modes));
  assert.equal(s.length - 2, s.filter((x) => x.cashRounding !== null).length);
});

test("THE NOTE NEVER CLAIMS A DECLARATION THAT IS NOT THERE", () => {
  for (const x of skels(ADM, "adm", "adm")) {
    assert.doesNotMatch(x.note, /declares cash_bid_rounding_mode/,
      `${x.id} claims ADM declared a rounding mode`);
    assert.match(x.note, /DECLARES NO ROUNDING/);
    assert.match(x._pending, /counts the\s+residuals/);
  }
  /* And POET's note still says what POET's payload says. */
  const p = skels(POET, "poet", "poetgrain")[0];
  assert.match(p.note, /declares cash_bid_rounding_mode/);
});

test("the capture line is the capture that happened, not POET's", () => {
  /* It was hardcoded to POET's run number and would have been stamped on 152
     ADM files as their provenance. */
  const x = skels(ADM, "adm", "adm")[0];
  assert.match(x.note, /test capture/);
  assert.doesNotMatch(x.note, /92448826700/, "POET's run number is on an ADM file");
});

test("EVERY SKELETON IS HELD DISABLED AND HAS NO BANDS", () => {
  for (const body of [POET, ADM])
    for (const x of skels(body, "adm", "adm")) {
      assert.equal(x.enabled, false);
      assert.deepEqual(x.bands, {});
    }
  /* bands {} is not an oversight — lib/sources.mjs REFUSES a manifest with no
     bands, so these cannot be dropped into sources/ until a board read says
     which crops each market posts. That refusal is the safety net. */
});

test("identity comes from the payload: no SET THIS survives on ADM", () => {
  const s = skels(ADM, "adm", "adm");
  assert.equal(s.filter((x) => x.state === "SET THIS").length, 0);
  assert.equal(s.filter((x) => x.operator === "SET THIS").length, 0);
  for (const x of s) {
    assert.ok(x.zip, `${x.id} has no zip`);
    assert.ok(x.address, `${x.id} has no street line`);
    assert.equal(typeof x.lat, "number");
    assert.equal(typeof x.lon, "number");
    assert.match(x.url, /^https:\/\/adm\.gradable\.com\//);
    assert.equal(x.locationId, String(x.locationId));
  }
});

test("the id is slugged from THEIR display name, and no two collide", () => {
  const s = skels(ADM, "adm", "adm");
  const ids = s.map((x) => x.id);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.deepEqual([...new Set(dupes)], [],
    `two markets would be written to one file: ${[...new Set(dupes)].join(", ")}`);
  assert.equal(slugOf("Arkansas City, KS (East)"), "arkansascitykseast");
  assert.equal(slugOf("Abilene, KS"), "abileneks");
});

test("THE CLI PASSES THE CAPTURE, and the default is not somebody's real run", () => {
  /* Testing skeletonFor(..., "test capture") directly proves the parameter
     works and proves nothing about the call site. Reverting BOTH — the default
     back to POET's run number and the call site back to three arguments — left
     every other test in this file green. */
  const src = readFileSync(new URL("../scripts/gradable-markets.mjs", import.meta.url), "utf8");
  assert.match(src, /skeletonFor\(m, partner, operatorSlug, capture\)/,
    "the CLI drops the capture argument, so every file would carry the default");
  assert.match(src, /const capture = flag\("capture"/,
    "there is no --capture flag for the run to state its own provenance");
  assert.doesNotMatch(src, /capture = "[^"]*\d{8,}/,
    "the default capture line carries a real run number, which is a provenance claim");
});

test("THE SHIPPED POET MANIFESTS AGREE WITH THE READER, ALL 35 OF THEM", () => {
  /* The strongest check available, and the one that says the fix is right
     rather than merely different. Thirty-five POET manifests were written by a
     person reading those boards. Matched to skeletons by locationId — not by
     id, because poetgrain-bigstonecity was hand-named without the state suffix
     slugOf produces — the rounding the reader derives equals the rounding that
     shipped on every single one, the two nulls included.

     The old hardcoded "floor-cent" DISAGREED WITH 18 OF THE 35. It had drifted
     from the hand-written files and nothing noticed, because nothing compared
     them. This test is that comparison. */
  const dir = new URL("../sources/", import.meta.url);
  const skels = marketsFrom(POET).filter((m) => !m.demo && m.publicSite)
    .map((m) => skeletonFor(m, "poet", "poetgrain", "test capture"));
  let compared = 0;
  for (const s of skels) {
    const hit = readdirSync(dir)
      .filter((f) => f.startsWith("poetgrain-") && f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")))
      .find((f) => String(f.locationId) === String(s.locationId));
    if (!hit) continue;
    compared++;
    const shipped = hit.cashRounding === undefined ? null : hit.cashRounding;
    assert.equal(shipped, s.cashRounding,
      `${hit.id} shipped ${JSON.stringify(shipped)}; the reader says ${JSON.stringify(s.cashRounding)}`);
  }
  assert.equal(compared, 35, "a committed POET manifest went missing from the comparison");
});

/* ---------------------------------------------------------------------------
 * FILLING A MANIFEST FROM A BOARD READ.
 *
 * Everything below was found by BUILDING 152 MANIFESTS AND LOADING THEM, not
 * by reading the validator. The first build produced 152 files and
 * lib/sources.mjs refused every single one.
 * --------------------------------------------------------------------------- */
import { fillFromReading, bandsFromReading, reportRefusal, readingsByMarket,
         MIN_TESTABLE_TO_ENABLE } from "../scripts/gradable-markets.mjs";
import { validateSource, loadSources } from "../lib/sources.mjs";

const reading = (over = {}) => ({
  marketId: 371713182, rows: 12,
  crops: [
    { code: "02", commodity: "Corn", unresolved: false, rows: 6, deliveries: 2, band: "corn", range: [2, 12] },
    { code: "01", commodity: "Soybeans", unresolved: false, rows: 6, deliveries: 2, band: "soybean", range: [6, 32] },
  ],
  declaredInBootstrap: null, declaredOnBoard: null,
  rounding: { testable: 12, mode: "exact", confident: "exact", margin: 0, residuals: [0] },
  roundingSaid: "exact [12 testable]",
  ...over,
});
const skelFor = (state = "KS") => ({
  ...skeletonFor(marketsFrom(ADM).find((m) => m.marketId === 371713182), "adm", "adm", "test capture"),
  state,
});

test("EXACT MEANS THE KEY IS ABSENT, NOT NULL — 152 manifests were refused over this", () => {
  /* lib/sources.mjs tests `s.cashRounding !== undefined`, so a null falls into
     the membership check and comes back `cashRounding "null" is not one of
     exact, floor-cent, ...`. Every one of 152 files failed on it. */
  const f = fillFromReading(skelFor(), reading());
  assert.equal("cashRounding" in f, false, "a null cashRounding is back and the loader will refuse it");
  assert.equal(f.cashRoundingCents, 0, "an exact board must pin the guard at zero tolerance");
  assert.deepEqual(validateSource({ ...f, id: "adm-x" }), []);
});

test("a market that DOES have a counted mode carries it", () => {
  const f = fillFromReading(skelFor(), reading({
    rounding: { testable: 9, mode: "floor-cent", confident: "floor-cent", margin: 9, residuals: [0.25, 0.75] } }));
  assert.equal(f.cashRounding, "floor-cent");
  assert.equal(f.cashRoundingCents, 0);
  assert.deepEqual(validateSource({ ...f, id: "adm-y" }), []);
});

test("and one with no established mode is held, with both keys absent", () => {
  const f = fillFromReading(skelFor(), reading({
    rounding: { testable: 5, mode: null, confident: null, margin: 0, residuals: [0.25, -0.5] },
    roundingSaid: "rounding UNRESOLVED" }));
  assert.equal("cashRounding" in f, false);
  assert.equal("cashRoundingCents" in f, false);
  assert.equal(f.enabled, false);
  assert.match(f._pending, /established no rounding mode/);
});

test("ONE TESTABLE ROW IS NOT A MEASUREMENT", () => {
  /* roundingEvidence exempts `exact` from its margin — it is the absence of a
     rule rather than a rule — so a single row that happens to reconcile comes
     back confident. That is not enough to turn a board on. */
  assert.equal(MIN_TESTABLE_TO_ENABLE, 2);
  const one = fillFromReading(skelFor(), reading({
    rounding: { testable: 1, mode: "exact", confident: "exact", margin: 0, residuals: [0] } }), { enable: true });
  assert.equal(one.enabled, false);
  assert.match(one._pending, /only 1 testable row/);
  const two = fillFromReading(skelFor(), reading({
    rounding: { testable: 2, mode: "exact", confident: "exact", margin: 0, residuals: [0] } }), { enable: true });
  assert.equal(two.enabled, true);
});

test("THE BANDS ARE THE BOARD'S OWN CROPS, and an unbanded one gets no band", () => {
  const { bands, unbanded } = bandsFromReading(reading({
    crops: [
      { code: "02", commodity: "Corn", band: "corn", range: [2, 12], rows: 4 },
      { code: "MW", commodity: "Soybean Meal", band: null, range: null, rows: 2 },
    ] }));
  assert.deepEqual(bands, { corn: [2, 12] });
  assert.deepEqual(unbanded, ["MW Soybean Meal"]);
  const f = fillFromReading(skelFor(), reading({
    crops: [
      { code: "02", commodity: "Corn", band: "corn", range: [2, 12], rows: 4 },
      { code: "MW", commodity: "Soybean Meal", band: null, range: null, rows: 2 },
    ] }));
  assert.match(f.note, /Soybean Meal/, "the note does not say which crop is being withheld");
  assert.match(f.note, /withheld/);
});

test("several of their codes under one band name is fine; two different ranges is not", () => {
  /* 11, 16 and U9 are all red winter wheat. Writing [3,20] twice is not a
     conflict. Two DIFFERENT pairs under one name would be, and the last one
     would silently win. */
  const crops = [
    { code: "11", commodity: "Wheat (Soft Red Winter)", band: "red winter", range: [3, 20], rows: 2 },
    { code: "16", commodity: "Wheat (Hard Red Winter)", band: "red winter", range: [3, 20], rows: 2 },
  ];
  assert.deepEqual(bandsFromReading({ marketId: 1, crops }).bands, { "red winter": [3, 20] });
  assert.throws(() => bandsFromReading({ marketId: 1, crops: [
    crops[0], { ...crops[1], range: [5, 9] } ] }), /two different bands/);
});

test("A CANADIAN MARKET IS WRITTEN AND HELD, because nobody has read its currency", () => {
  const f = fillFromReading(skelFor("SK"), reading(), { enable: true });
  assert.equal(f.enabled, false);
  assert.match(f._pending, /SK/);
  assert.match(f._pending, /currency/);
  /* But it still has to LOAD — loadSources validates before it skips a
     disabled source, so a refused Canadian file is an error every pass. */
  assert.deepEqual(validateSource({ ...f, id: "adm-ca", lat: 52.12, lon: -104.38 }), []);
});

test("a market with no board read is never turned into a file", () => {
  /* 30 of 152 on the first build. Each would have been "no bands. Every
     commodity needs a floor and ceiling" in every pass, forever. */
  const f = fillFromReading(skelFor(), undefined, { enable: true });
  assert.deepEqual(f.bands, {});
  assert.equal(f.enabled, false);
  assert.ok(validateSource({ ...f, id: "adm-z" }).some((e) => /no bands/.test(e)),
    "an empty-bands manifest now loads, so nothing stops it being written");
  const src = readFileSync(new URL("../scripts/gradable-markets.mjs", import.meta.url), "utf8");
  assert.match(src, /const publishable = \(x\) => Object\.keys\(x\.bands \?\? \{\}\)\.length > 0;/,
    "the writer no longer filters out bandless manifests");
  assert.match(src, /boardsPath \? built\.filter\(publishable\) : built/,
    "--json emits bandless manifests again");
});

test("a failed board is recorded as why, not as silence", () => {
  const f = fillFromReading(skelFor(), undefined, { failure: "the instruments array is empty" });
  assert.match(f._pending, /asked and did not read/);
  assert.match(f._pending, /instruments array is empty/);
});

test("A REHEARSAL REPORT CAN NEVER BECOME A MANIFEST", () => {
  assert.match(reportRefusal({ transport: "rehearsal", partner: "adm", markets: [1] }, "adm") ?? "", /REHEARSAL/);
  assert.match(reportRefusal({ transport: "fetch", partner: "poet", markets: [1] }, "adm") ?? "", /partner/);
  assert.ok(reportRefusal({ transport: "fetch", partner: "adm", markets: [] }, "adm"));
  assert.equal(reportRefusal({ transport: "fetch", partner: "adm", markets: [{ marketId: 1 }] }, "adm"), null);
});

test("--enable without --boards is refused at the CLI", () => {
  const src = readFileSync(new URL("../scripts/gradable-markets.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(enable && !boardsPath\)/,
    "--enable no longer needs a board read, so a payload nobody read could publish");
});

test("THE WHOLE SET LOADS: 152 markets, a report, and zero loader errors", () => {
  /* The end of the chain, run rather than described. Build every ADM manifest
     from a report, hand them to loadSources, and demand it finds nothing. */
  const ms = marketsFrom(ADM).filter((m) => !m.demo && m.publicSite);
  const readings = new Map(ms.slice(0, 120).map((m) => [String(m.marketId), reading({ marketId: m.marketId })]));
  const built = ms
    .map((m) => fillFromReading(skeletonFor(m, "adm", "adm", "t"), readings.get(String(m.marketId)), { enable: true }))
    .filter((x) => Object.keys(x.bands).length);
  assert.equal(built.length, 120);
  const r = loadSources(built);
  assert.deepEqual(r.errors, [], r.errors.slice(0, 3).join("\n"));
  assert.ok(r.sources.length > 100, `${r.sources.length} loaded`);
  /* Not one of them may carry a placeholder. */
  assert.equal(built.filter((x) => JSON.stringify(x).includes("SET THIS")).length, 0);
});

test("THE WORKFLOW LOADS EVERY MANIFEST BEFORE IT WRITES ANY", () => {
  /* The first build of these produced 152 files and lib/sources.mjs refused all
     152. A build that does not load must never reach sources/. */
  const y = readFileSync(new URL("../.github/workflows/gradable-manifests.yml", import.meta.url), "utf8");
  assert.match(y, /name: They must load/, "the load gate is gone");
  assert.match(y, /loadSources/, "nothing checks the manifests against the loader");
  assert.match(y, /SET THIS/, "the placeholder check is gone");
  /* The load step has no `if:`, so it runs on a dry run too. */
  const load = y.slice(y.indexOf("name: They must load"), y.indexOf("name: Write and commit"));
  assert.doesNotMatch(load, /^\s+if:/m, "the load gate only runs when committing");
  /* And the write step does. */
  assert.match(y, /name: Write and commit\n\s+if: \$\{\{ inputs\.commit \}\}/);
});

test("nothing publishes without the second box", () => {
  const y = readFileSync(new URL("../.github/workflows/gradable-manifests.yml", import.meta.url), "utf8");
  const enable = y.slice(y.indexOf("      enable:"), y.indexOf("permissions:"));
  assert.match(enable, /default: false/, "enable is defaulted on");
  assert.match(y, /if \[ "\$ENABLE" = "true" \]; then ARGS="\$ARGS --enable"; fi/);
  assert.match(y, /transport === "rehearsal"/, "a rehearsal report could reach the manifest builder");
});

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

/* WHAT scripts/dtn-build.mjs MUST REFUSE.
 *
 * This script turns a pasted probe log into source files, and every source
 * file it writes will be polled and published. So the tests worth having are
 * mostly about what it declines to do: the failure mode is not a crash, it is
 * ninety-eight plausible manifests with one silently wrong field in them.
 *
 * The log format asserted here is not invented for the test. It was taken from
 * a real run of scripts/dtn-probe.mjs against
 * fixtures/dtn-cs-agpartners-e0172401.json on 2026-08-22, which is the same
 * path the runner takes with a live page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseProbeLog, verdicts, idFor, decide, noteFor, barchartList, slug, SET, HUMAN_FIELDS,
  looksLikeTheSameRun, unwrapActionsLog, geocodeList, splitPostal,
} from "../scripts/dtn-build.mjs";

/* ---- a log, in exactly the shape the probe prints ----------------------- */

const manifest = (over = {}) => ({
  id: "town", operator: "Premier Cooperative", location: "Mount Horeb", state: SET,
  platform: "dtn-cs", url: "https://api.dtn.com/markets/sites/E0266901/cash-bids?units=us",
  browserPage: "https://www.premiercooperative.com/agricultural/detailed-cash-bids",
  locationId: "101", siteId: "E0266901",
  bands: { corn: [2, 12] }, cadence: "grain-day", provenance: "scraped",
  enabled: false, note: SET, cashRoundingCents: 0, publicNote: "…",
  zip: null, lat: null, lon: null, phone: null, email: null, website: SET, inMerge: true,
  ...over,
});

/** One `--- …` block, exactly as probeOne() prints it. */
function block(m, { rows = 12, commodities = "Corn", mode = "floor-cent", notATown = null } = {}) {
  return [
    `\n--- ${m.location} (${m.locationId}) — ${rows} row(s): ${commodities} — ${mode} ` +
      `[${rows} testable: exact 3, round 6, floor ${rows}]`,
    ...(notATown ? [`    NOT A TOWN? ${notATown}`] : []),
    JSON.stringify(m, null, 2),
  ].join("\n");
}

/** A whole log: the VERDICTS section, then the blocks. */
function log(entries) {
  const v = ["", `VERDICTS ${entries[0].m.siteId}`,
    ...entries.map((e) => `  V ${e.m.siteId} ${e.m.locationId} ${e.mode ?? "floor-cent"} ` +
                          `${e.testable ?? 12} ${e.margin ?? 9}`)];
  return [
    "========================================================================",
    "[1/1] Premier Cooperative  (E0266901)",
    "25 row(s), 2 location(s)",
    ...v,
    ...entries.map((e) => block(e.m, e.opts ?? {})),
  ].join("\n");
}

/* ---- reading ------------------------------------------------------------ */

test("a log is read back into locations, manifests and verdicts", () => {
  const a = manifest({ location: "Mount Horeb", locationId: "101" });
  const b = manifest({ location: "Barneveld", locationId: "102" });
  const { entries, bad } = parseProbeLog(log([{ m: a }, { m: b, mode: "-", testable: 2, margin: 0 }]));

  assert.deepEqual(bad, []);
  assert.deepEqual(entries.map((e) => e.location), ["Mount Horeb", "Barneveld"]);
  assert.equal(entries[0].manifest.siteId, "E0266901");
  assert.equal(entries[0].verdict.mode, "floor-cent");
  assert.equal(entries[0].verdict.testable, 12);
  assert.equal(entries[1].verdict.mode, "-", "a location with no established mode still has a verdict line");
});

test("A MANIFEST CARRYING A BRACE IN ITS TEXT IS NOT TRUNCATED", () => {
  /* The manifests this script reads have a free-text `note`, and the probe's
     own skeleton note is prose. The moment one contains a brace or a quote, a
     regex-shaped parser stops at the wrong character — and it does not throw,
     it silently drops every location after it in the log. */
  const m = manifest({ note: 'a } brace, a { brace and a "quote" walk into a bar' });
  const { entries, bad } = parseProbeLog(log([{ m }, { m: manifest({ location: "Blue Mounds", locationId: "103" }) }]));
  assert.deepEqual(bad, []);
  assert.equal(entries.length, 2, "the location after the awkward note must survive");
  assert.equal(entries[0].manifest.note, 'a } brace, a { brace and a "quote" walk into a bar');
});

test("a heading whose manifest will not parse is REPORTED, not skipped quietly", () => {
  const good = log([{ m: manifest() }]);
  const broken = good.replace('"platform": "dtn-cs"', '"platform": dtn-cs');
  const { entries, bad } = parseProbeLog(broken);
  assert.equal(entries.length, 0);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /Mount Horeb \(101\)/);
});

/* ---- naming ------------------------------------------------------------- */

test("the id carries the operator, because two co-ops can both have an Elgin", () => {
  assert.equal(idFor("Premier Cooperative", "Mount Horeb"), "premiercooperative-mounthoreb");
  assert.equal(idFor("Allied Cooperative", "Elgin"), "alliedcooperative-elgin");
  assert.equal(idFor("Country Visions Cooperative", "Elgin"), "countryvisionscooperative-elgin");
});

test("an unfilled operator is refused rather than slugged into a filename", () => {
  /* `setthis-goodhue` is a file nobody would look at twice. */
  assert.equal(idFor(SET, "Goodhue"), null);
  assert.equal(idFor("", "Goodhue"), null);
  assert.equal(idFor("Premier Cooperative", ""), null);
});

/* ---- what it refuses ---------------------------------------------------- */

test("a destination is never written, and the reason travels with the refusal", () => {
  const m = manifest({ location: "Bunge PDC", locationId: "900" });
  const { entries } = parseProbeLog(log([{ m, opts: { notATown: '"Bunge PDC" carries a grain buyer\'s name (bunge) — a destination, not a town' } }]));
  const { write, skip } = decide(entries);
  assert.deepEqual(write, []);
  assert.equal(skip.length, 1);
  assert.match(skip[0].why, /destination, not a town/);
  assert.match(skip[0].why, /bunge/);
});

test("A DESTINATION THE LOG DID NOT FLAG IS STILL CAUGHT", () => {
  /* The log is a record of what an older probe knew. If the buyer list has
     grown since, the log's silence is not evidence that the name is a town. */
  const m = manifest({ location: "ADM Havana", locationId: "901" });
  const { entries } = parseProbeLog(log([{ m }]));      // no NOT A TOWN? line printed
  assert.ok(entries[0].notATown, "the build must re-ask, not trust the log's silence");
  assert.ok(entries[0].flaggedByBuildOnly);
  const { write, skip } = decide(entries);
  assert.deepEqual(write, []);
  assert.equal(skip.length, 1);
});

test("ONE ELEVATOR IS NOT WRITTEN TWICE BECAUSE THE TWO IDS DIFFER", () => {
  /* The real bug, caught the first time this ran against a real log. The probe
     was given --operator "Ag Partners Cooperative", so the id came out
     `agpartnerscooperative-goodhue` while `agpartners-goodhue` had been live
     for days. Two files, two ids, one elevator, both polling the same
     locationId. The key is siteId + location.id, which is what the feed keys
     on and what the manifests already say is the location key. */
  const m = manifest({ operator: "Ag Partners Cooperative", location: "Goodhue",
                       locationId: "7240", siteId: "e0172401" });
  const { entries } = parseProbeLog(log([{ m }]));
  const existingByKey = new Map([["e0172401 7240", "agpartners-goodhue"]]);
  const { write, skip } = decide(entries, { existingByKey });

  assert.deepEqual(write, [], "an id check alone would have let this through");
  assert.match(skip[0].why, /agpartners-goodhue/);
  assert.match(skip[0].why, /e0172401 7240/);
});

test("an existing id is not overwritten either", () => {
  const { entries } = parseProbeLog(log([{ m: manifest() }]));
  const { write, skip } = decide(entries, { existing: new Set(["premiercooperative-mounthoreb"]) });
  assert.deepEqual(write, []);
  assert.match(skip[0].why, /one writer per artefact/);
});

/* ---- the rounding mode, which is the field most likely to be wrong ------ */

test("ONE LOG NEVER STATES A ROUNDING MODE", () => {
  /* Country Partners' Cedar Rapids read round-cent at 20:59 and floor-cent at
     21:21 on 2026-08-20, from the same seventeen rows. A confident-looking
     mode from a single snapshot is the thing this refuses. */
  const { entries } = parseProbeLog(log([{ m: manifest(), mode: "floor-cent", testable: 25, margin: 14 }]));
  const { write } = decide(entries);
  assert.equal(write.length, 1);
  assert.equal(write[0].manifest.cashRounding, undefined,
    "a mode seen once must not reach a manifest, however clear its margin looked");
  assert.match(write[0].manifest.note, /DELIBERATELY ABSENT/);
  assert.match(write[0].manifest.note, /different day/);
});

test("two logs that AGREE state the mode, and the note says on what evidence", () => {
  const m = manifest();
  const now = log([{ m, mode: "floor-cent", testable: 25, margin: 14 }]);
  const then = log([{ m, mode: "floor-cent", testable: 22, margin: 11 }]);
  const { entries } = parseProbeLog(now);
  const { write } = decide(entries, { prior: verdicts(then) });
  assert.equal(write[0].manifest.cashRounding, "floor-cent");
  assert.match(write[0].manifest.note, /TWO probe runs on different prices agreed/);
});

test("two logs that DISAGREE state nothing, and say so", () => {
  const m = manifest();
  const now = log([{ m, mode: "floor-cent", testable: 25, margin: 14 }]);
  const then = log([{ m, mode: "round-cent", testable: 25, margin: 12 }]);
  const { entries } = parseProbeLog(now);
  const { write } = decide(entries, { prior: verdicts(then) });
  assert.equal(write[0].manifest.cashRounding, undefined);
  assert.match(write[0].manifest.note, /an earlier run said round-cent/);
});

/* ---- what reaches disk -------------------------------------------------- */

test("everything written is disabled, and what a person still owes is counted", () => {
  const { entries } = parseProbeLog(log([{ m: manifest() }]));
  const { write } = decide(entries);
  assert.equal(write[0].manifest.enabled, false, "a generated source is never live on arrival");
  /* state and website ship as SET THIS from the probe; address and phone are
     absent entirely. All four are owed, and the count is what stops a
     half-filled manifest drifting in unnoticed. */
  assert.deepEqual(write[0].blanks.sort(), [...HUMAN_FIELDS].sort());
});

test("the generated note records the measurement rather than a conclusion", () => {
  const { entries } = parseProbeLog(log([{ m: manifest() }]));
  const { write } = decide(entries);
  const note = write[0].manifest.note;
  assert.match(note, /browser and not by a fetch/i, "why there is a Chromium in a scraper");
  assert.match(note, /we hold no key at all/, "the key is theirs and public in their page");
  assert.match(note, /location\.id \(101\)/, "the location key is the number, not the name");
  assert.match(note, /COORDINATES ARE NULL/, "a town centroid is not a yard");
  assert.notEqual(note, SET);
});

/* ---- Barchart ----------------------------------------------------------- */

test("a town Barchart already carries is kept, but out of the merged map", () => {
  /* Not dropped. A first-party read is fresher and carries basis and delivery
     detail Barchart does not always keep -- the same reasoning
     sources/boyceville.json already carries. It is excluded from the merge so
     one elevator is not two rows. */
  const bc = barchartList("# towns\nMount Horeb, WI\nBarneveld, WI\n");
  assert.equal(bc.size, 2);
  const { entries } = parseProbeLog(log([{ m: manifest() }]));
  const { write } = decide(entries, { barchart: bc });
  assert.equal(write.length, 1, "still written");
  assert.equal(write[0].manifest.inMerge, false);
  assert.match(write[0].manifest.inMergeWhy, /Barchart already carries/);
  assert.equal(write[0].barchartCovered, true);
});

test("with no Barchart list nothing is marked as covered", () => {
  /* Silence is not a coverage claim. Without a list, inMerge stays as the
     probe set it, and the script says so in its report rather than implying
     these are all gaps. */
  const { entries } = parseProbeLog(log([{ m: manifest() }]));
  const { write } = decide(entries);
  assert.equal(write[0].manifest.inMerge, true);
  assert.equal(write[0].manifest.inMergeWhy, undefined);
  assert.equal(write[0].barchartCovered, false);
});

test("the barchart list reads both shapes and ignores comments", () => {
  const bc = barchartList([
    "# a comment",
    "",
    "Mount Horeb, WI",
    "PREMIER COOPERATIVE|Barneveld, WI   # facility and town",
  ].join("\n"));
  assert.equal(bc.size, 2);
  assert.ok(bc.covers("Mount Horeb"));
  assert.ok(bc.covers("barneveld"), "matching is on the slug, so casing cannot hide a hit");
  assert.equal(bc.covers("Blue Mounds"), null);
});

test("slugging is stable across the punctuation these names actually carry", () => {
  assert.equal(slug("Ft. Atkinson"), "ftatkinson");
  assert.equal(slug("St. Nazianz"), "stnazianz");
  assert.equal(slug("O'Neill"), "oneill");
});

/* ---- a log cannot corroborate itself ------------------------------------ */

test("THE SAME LOG PASSED TWICE DOES NOT ESTABLISH A ROUNDING MODE", () => {
  /* Caught by running this end to end and handing it the same file for --log
     and --against. It stated floor-cent on both locations without a murmur.
     A snapshot agreeing with itself is not a second day's prices. */
  const m = manifest();
  const one = log([{ m, mode: "floor-cent", testable: 20, margin: 12 }]);
  const { entries } = parseProbeLog(one);
  const V = verdicts(one);

  assert.equal(looksLikeTheSameRun(V, V), true);
  const { write } = decide(entries, { prior: V, sameRun: looksLikeTheSameRun(V, V) });
  assert.equal(write[0].manifest.cashRounding, undefined,
    "a log compared with itself agrees with itself, and that is not evidence");
});

test("two real runs are not mistaken for one", () => {
  /* Different prices move the testable count and the margin. */
  const m = manifest();
  const now = verdicts(log([{ m, mode: "floor-cent", testable: 20, margin: 12 }]));
  const then = verdicts(log([{ m, mode: "floor-cent", testable: 18, margin: 9 }]));
  assert.equal(looksLikeTheSameRun(now, then), false);
  const { entries } = parseProbeLog(log([{ m, mode: "floor-cent", testable: 20, margin: 12 }]));
  const { write } = decide(entries, { prior: then, sameRun: false });
  assert.equal(write[0].manifest.cashRounding, "floor-cent");
});

test("no shared locations at all is not agreement either", () => {
  const now = verdicts(log([{ m: manifest({ locationId: "101" }) }]));
  const then = verdicts(log([{ m: manifest({ locationId: "999" }) }]));
  assert.equal(looksLikeTheSameRun(now, then), false, "nothing in common cannot look like the same run");
});


/* ---- the log that actually arrives -------------------------------------- */

test("AN ACTIONS LOG IS READ AS IT ARRIVES, TIMESTAMPS AND ALL", () => {
  /* The first real log — run 88349821780, 2026-08-22 — came as a zip of
     probe/5_Ask.txt with an ISO timestamp on every line, a BOM on the first
     and ANSI colour around the echoed shell. Every heading and every verdict
     line failed to match and the script read ZERO locations out of a good
     69-location run. Nothing threw; it just said "read 0 location(s)", which
     is indistinguishable from a probe that found nothing. */
  const plain = log([{ m: manifest() }]);
  const asActions = "\uFEFF" + plain.split("\n")
    .map((l, i) => `2026-08-22T21:21:${String(10 + (i % 40)).padStart(2, "0")}.1234567Z ${l}`)
    .join("\n");

  const { entries, bad } = parseProbeLog(asActions);
  assert.deepEqual(bad, []);
  assert.equal(entries.length, 1, "a timestamped log must read exactly like a plain one");
  assert.equal(entries[0].location, "Mount Horeb");
  assert.equal(entries[0].manifest.siteId, "E0266901");
  assert.equal(entries[0].verdict.mode, "floor-cent",
    "the verdict lines are timestamped too, and they are what carries the rounding evidence");
});

test("the --against log is unwrapped as well", () => {
  /* It is the same kind of file. A prior log whose verdict lines silently fail
     to match reads as "there was no prior run", which is the quiet way to lose
     a corroborated rounding mode. */
  const plain = log([{ m: manifest(), mode: "floor-cent", testable: 18, margin: 9 }]);
  const stamped = plain.split("\n").map((l) => `2026-08-22T21:21:35.6394938Z ${l}`).join("\n");
  const V = verdicts(stamped);
  assert.equal(V.size, 1);
  assert.equal(V.get("E0266901 101").mode, "floor-cent");
  assert.equal(V.get("E0266901 101").testable, 18);
});

test("ANSI colour and group markers do not break a heading", () => {
  const ESC = String.fromCharCode(27);
  const plain = log([{ m: manifest() }]);
  const noisy = plain.replace("VERDICTS", ESC + "[36;1mVERDICTS" + ESC + "[0m");
  const { entries } = parseProbeLog("##[group]Run node\n" + noisy);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verdict.mode, "floor-cent");
});

test("unwrapping is a no-op on a log that was already plain", () => {
  const plain = log([{ m: manifest() }]);
  assert.equal(unwrapActionsLog(plain), plain);
});


/* ---- coordinates ---------------------------------------------------------
   The rules come from geocodes/README.md, which is where the argument about
   this file already happened. These assert that dtn-build obeys them. */

const TSV = [
  "# a comment line",
  "Allied Cooperative\thttps://www.allied.coop/grain/cash-bids\t\t\tHIXTON\t-91.00691356\t44.38205361",
  "Alcivia\thttps://www.alcivia.com/x\t\t\tELMWOOD\t-92.15147432\t44.77935",
  "Synergy Coop\thttps://x\t\t\tRice Lake, WI\t-91.73868744\t45.51678958",
  "Sloppy Coop\thttps://x\t\t\tCASSELTON\t-81.8645\t40.21473",
].join("\n");

test("a coordinate is taken only on an OPERATOR AND TOWN match", () => {
  const g = geocodeList(TSV);
  assert.equal(g.find("Allied Cooperative", "HIXTON").row.lat, 44.38205361);
});

test("A TOWN NAME IS NOT A KEY — the Elmwood trap", () => {
  /* Ag-Land FS's Elmwood is in Illinois; the only Elmwood in the file is
     Alcivia's, in Wisconsin. Matching on town alone would have pinned an
     Illinois elevator in Wisconsin with nothing on the page to say so. Found
     in the real 2026-08-22 build. */
  const g = geocodeList(TSV);
  const r = g.find("Ag-Land FS", "Elmwood");
  assert.equal(r.row, undefined, "this must not resolve");
  assert.match(r.refused, /belongs to Alcivia/);
  assert.match(r.refused, /two different places/);
});

test("the known-bad row is refused by name", () => {
  /* README rule 2: Synergy / Rice Lake resolves to a park, 611 m out. */
  const g = geocodeList(TSV);
  const r = g.find("Synergy Coop", "Rice Lake");
  assert.equal(r.row, undefined);
  assert.match(r.refused, /known bad/);
});

test("THE LOW-PRECISION POPULATION IS REFUSED EVEN IF SOMEBODY PASTES IT BACK IN", () => {
  /* The dropped rows are a bad join — latitude 32.39 for a Minnesota town,
     longitude -81.86 for North Dakota. They are told apart by decimal places,
     and this file is edited by hand, so the check is made here rather than
     trusted to have been made once. */
  const g = geocodeList(TSV);
  const r = g.find("Sloppy Coop", "Casselton");
  assert.equal(r.row, undefined);
  assert.match(r.refused, /low-precision population/);
});

test("a town with no row at all says so, and is not confused with a refusal", () => {
  const g = geocodeList(TSV);
  const r = g.find("Premier Cooperative", "Westby");
  assert.equal(r.missing, true);
  assert.equal(r.refused, undefined);
});

test("a filled coordinate carries its provenance into the note", () => {
  const g = geocodeList(TSV);
  const m = manifest({ operator: "Allied Cooperative", location: "HIXTON", locationId: "501" });
  const { entries } = parseProbeLog(log([{ m }]));
  const { write } = decide(entries, { geocodes: g });
  assert.equal(write[0].manifest.lat, 44.38205361);
  assert.match(write[0].manifest.note, /EVIDENCE AND NOT A FACT/);
  assert.match(write[0].manifest.note, /matched on operator AND town/);
  assert.match(write[0].manifest.note, /check this pin against the operator/);
});

test("with no geocode file every pin stays null", () => {
  const { entries } = parseProbeLog(log([{ m: manifest() }]));
  const { write } = decide(entries);
  assert.equal(write[0].manifest.lat, null);
  assert.equal(write[0].manifest.lon, null);
});


test("THE POSTAL COLUMN IS TWO FORMATS AND BOTH MUST MATCH", () => {
  /* 42 of the real file's 82 rows are `Town, ST` or `Town, ST 54768`; the rest
     are a bare TOWN. Slugging the whole cell turned `Goodhue, MN 55027` into
     `goodhuemn55027`, which matched nothing — and produced no error, just a
     town with no coordinate, indistinguishable from one the file lacks. */
  assert.deepEqual(splitPostal("Goodhue, MN 55027"), { town: "Goodhue", state: "MN", zip: "55027" });
  assert.deepEqual(splitPostal("Cylon, WI"),          { town: "Cylon",   state: "WI", zip: null });
  assert.deepEqual(splitPostal("ADAMS"),              { town: "ADAMS",   state: null, zip: null });
  assert.deepEqual(splitPostal("MENOMONIE FEED MILL"),{ town: "MENOMONIE FEED MILL", state: null, zip: null });
});

test("a Town, ST row resolves and hands over its state and zip", () => {
  const tsv = "Ag Partners\thttps://x\t\t101 S Broadway\tGoodhue, MN 55027\t-92.62402113\t44.40021447";
  const g = geocodeList(tsv);
  const hit = g.find("Ag Partners", "Goodhue");
  assert.equal(hit.row.state, "MN");
  assert.equal(hit.row.zip, "55027");

  const m = manifest({ operator: "Ag Partners", location: "Goodhue", locationId: "7240", siteId: "zz" });
  const { entries } = parseProbeLog(log([{ m }]));
  const { write } = decide(entries, { geocodes: g });
  assert.equal(write[0].manifest.state, "MN", "the state came from the file, not from the operator");
  assert.equal(write[0].manifest.zip, "55027");
  assert.equal(write[0].manifest.address, "101 S Broadway");
});

test("A BARE TOWN ROW NEVER INVENTS A STATE", () => {
  /* Half the file says nothing about the state. Inheriting one from the
     operator is exactly the assumption that put six Iowa towns under a
     Wisconsin co-operative in the 2026-08-22 run. */
  const tsv = "Allied Cooperative\thttps://x\t\t\tHIXTON\t-91.00691356\t44.38205361";
  const g = geocodeList(tsv);
  const m = manifest({ operator: "Allied Cooperative", location: "HIXTON", locationId: "501" });
  const { entries } = parseProbeLog(log([{ m }]));
  const { write } = decide(entries, { geocodes: g });
  assert.equal(write[0].manifest.lat, 44.38205361, "the coordinate still arrives");
  assert.equal(write[0].manifest.state, SET, "the state does not");
});

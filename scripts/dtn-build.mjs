#!/usr/bin/env node
/* THE PROBE'S LOG IN, SOURCE FILES OUT.
 *
 * scripts/dtn-probe.mjs runs on the Actions runner, because api.dtn.com and
 * the co-operatives' own pages are not reachable from a sandbox -- measured
 * again on 2026-08-22, when every one of premiercooperative.com, allied.coop,
 * countryvisionscoop.com, fscooperatives.com and api.dtn.com answered
 * `x-deny-reason: host_not_allowed` through the egress proxy. So the probe
 * prints, a person copies the log, and until now somebody then hand-typed
 * ninety-eight manifests out of it.
 *
 * That is the step this removes. It reads the LOG -- not an artefact, not a
 * JSON dump, the pasted log -- because a log is the thing that actually
 * arrives. Eight site ids, ninety-eight locations, one paste.
 *
 *   node scripts/dtn-build.mjs --log run.txt                     # say what it would do
 *   node scripts/dtn-build.mjs --log run.txt --write             # write them
 *   node scripts/dtn-build.mjs --log now.txt --against then.txt --write
 *
 * WHAT IT REFUSES TO DO, WHICH IS MOST OF THE POINT
 *
 *   - It never writes a location the probe flagged as a destination. "Bunge
 *     PDC" is a place a co-operative delivers to, not a town it has a yard in,
 *     and a geocoder will answer for it without complaint.
 *   - It never states `cashRounding` from ONE log. Country Partners' Cedar
 *     Rapids read round-cent at 20:59 and floor-cent at 21:21 on 2026-08-20,
 *     seventeen rows both times. A rounding mode is a property of how they
 *     compute their board, so the only honest evidence is the same answer on a
 *     different day's prices. Without --against, the field is left off, which
 *     keeps the identity guard exact and makes a wrong board refuse loudly.
 *   - It never overwrites an existing source file. One writer per artefact.
 *   - It never invents a state, an address, a website or a coordinate. Those
 *     stay `SET THIS` and are COUNTED, so a half-filled manifest cannot drift
 *     quietly into the repository.
 *   - Everything it writes is `enabled: false`. A person turns a source on.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { destinationReason } from "../lib/place.mjs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] ?? d; };
const has = (n) => args.includes(`--${n}`);

export const SET = "SET THIS";

/* ---- reading the log ----------------------------------------------------- */

/* `V <siteId> <locationId> <mode> <testable> <margin>`, one per location.
   Same shape parseVerdicts() in the probe reads, and deliberately so: the two
   scripts must not disagree about what a verdict line means. */
export function verdicts(text) {
  const out = new Map();
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const m = l.trim().match(/^V\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(-?\d+)/);
    if (m) out.set(`${m[1]} ${m[2]}`, { mode: m[3], testable: +m[4], margin: +m[5] });
  }
  return out;
}

/* The probe prints, per location:
 *
 *   --- Goodhue (7240) — 16 row(s): Corn, Soybeans — floor-cent [25 testable: …]
 *       NOT A TOWN? "Bunge PDC" carries a grain buyer's name …      (sometimes)
 *   {                                                               ← the manifest
 *     "id": "goodhue",
 *     …
 *   }
 *
 * BRACE COUNTING RATHER THAN A REGEX, and rather than JSON.parse on a guess at
 * where the object ends. The manifest contains free text -- a `note` that may
 * one day carry a brace -- so the scan tracks whether it is inside a string and
 * whether the previous character was a backslash. A parser that gets this wrong
 * does not fail loudly; it silently truncates the last manifest of a run.
 */
export function parseProbeLog(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const V = verdicts(text);
  const out = [];
  const bad = [];

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^---\s+(.*?)\s+\((\S+?)\)\s+—\s+(\d+)\s+row/);
    if (!head) continue;
    const [, location, locationId, rows] = head;

    /* The NOT A TOWN? line, when the probe printed one. Read from the log
       rather than recomputed, because the log is the record of what the probe
       actually saw -- and then CHECKED against a fresh call below, so a probe
       too old to know about a new buyer name cannot smuggle one through. */
    let logged = null;
    let j = i + 1;
    for (; j < lines.length && !lines[j].trimStart().startsWith("{"); j++) {
      const nt = lines[j].match(/NOT A TOWN\?\s+(.*)$/);
      if (nt) logged = nt[1].trim();
    }
    if (j >= lines.length) { bad.push(`${location} (${locationId}): no manifest followed its heading`); continue; }

    let depth = 0, inStr = false, esc = false, end = -1;
    const buf = [];
    scan: for (let k = j; k < lines.length; k++) {
      buf.push(lines[k]);
      for (const ch of lines[k]) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { end = k; break scan; } }
      }
    }
    if (end === -1) { bad.push(`${location} (${locationId}): its manifest never closed`); continue; }

    let manifest;
    try { manifest = JSON.parse(buf.join("\n")); }
    catch (e) { bad.push(`${location} (${locationId}): ${e.message}`); continue; }

    const v = V.get(`${manifest.siteId} ${locationId}`) ?? null;
    out.push({
      location, locationId, rows: +rows,
      manifest,
      verdict: v,
      /* BOTH, AND THEY MUST AGREE. `logged` is what the probe said at the time;
         `fresh` is what this build says now. A name that only one of them
         flags is still a name a person has to look at. */
      notATown: logged ?? destinationReason(location),
      flaggedByLogOnly: !!logged && !destinationReason(location),
      flaggedByBuildOnly: !logged && !!destinationReason(location),
      i,
    });
  }
  return { entries: out, bad };
}

/* ---- naming -------------------------------------------------------------- */

export const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/* THE PROBE EMITS THE BARE TOWN AND THAT IS NOT ENOUGH.
 *
 * Its skeleton says `id: "goodhue"`. The repository's own convention is
 * `agpartners-goodhue`, and the reason is not tidiness: two co-operatives can
 * both have an Elgin, and the second one to be added would either overwrite
 * the first or need renaming after the fact. The operator goes in the id.
 *
 * `SET THIS` as an operator is refused rather than slugged -- `setthis-goodhue`
 * is a filename nobody would notice was wrong. */
export function idFor(operator, location) {
  const op = slug(operator);
  const town = slug(location).slice(0, 22);
  if (!op || op === slug(SET)) return null;
  if (!town) return null;
  return `${op}-${town}`;
}

/* ---- the note, written from what was measured ---------------------------- */

/* THE NOTE IS THE PART THAT MAKES THIS RE-CHECKABLE A WEEK LATER, and it is
   the part a person writing ninety-eight files by hand stops writing properly
   somewhere around the fifteenth. So it is generated, from the evidence, and
   it states what was measured rather than what was assumed. */
export function noteFor(e, { agreed, priorMode } = {}) {
  const m = e.manifest;
  const v = e.verdict;
  const bits = [];

  bits.push(
    `DTN Content Services cash-bids-table-widget. Read from ONE call to ${m.url} — ` +
    `the site id ${m.siteId} carries this location and its neighbours together, so every one ` +
    `of them is a source file and none of them is new code.`);

  bits.push(
    `IT IS READ THROUGH A BROWSER AND NOT BY A FETCH: DTN answered a server-side probe with ` +
    `"The api key is valid, but it is valid to be used within a browser only", so their gateway ` +
    `scopes these widget keys to browser use. poll.mjs loads ${m.browserPage} in a real Chromium ` +
    `and reads the response their own widget asks for, which means we hold no key at all — ` +
    `theirs is public in their page, as it must be for the widget to work.`);

  bits.push(
    `THE LOCATION KEY IS THE NUMERIC location.id (${m.locationId}) AND NOT THE NAME: a display ` +
    `name is exactly the thing a vendor re-cases, and some of these names are companies rather ` +
    `than towns.`);

  if (v && agreed && m.cashRounding) {
    bits.push(
      `cashRounding is ${m.cashRounding}, and it is stated because TWO probe runs on different ` +
      `prices agreed on it (${v.testable} testable rows this run, margin ${v.margin} over the ` +
      `runner-up). One run is not evidence of a rounding mode: Country Partners' Cedar Rapids ` +
      `read round-cent and then floor-cent twenty minutes apart on 2026-08-20 from the same ` +
      `seventeen rows.`);
  } else if (v && v.mode && v.mode !== "-") {
    bits.push(
      `cashRounding is DELIBERATELY ABSENT. One run said ${v.mode} (${v.testable} testable rows, ` +
      `margin ${v.margin})` +
      (priorMode ? `, an earlier run said ${priorMode}` : ` and there is no second run to agree with it`) +
      `. A mode is a property of how they compute their board, so it needs the same answer on a ` +
      `different day's prices. Left off, the identity guard stays exact and a board that does ` +
      `not reconcile refuses loudly instead of publishing under a mode nobody established.`);
  } else {
    bits.push(
      `cashRounding is absent because no single rule explained every testable row on this board. ` +
      `The identity guard stays exact.`);
  }

  bits.push(
    `COORDINATES ARE NULL AND THAT IS DELIBERATE: the feed carries no coordinate, and a town ` +
    `centroid is a different place from a yard — measured at 1.4 miles on babgrain-auburn. ` +
    `Geocode the street address before relying on a map pin.`);

  bits.push(`Built by scripts/dtn-build.mjs from a dtn-probe log; ${e.rows} row(s) for this location.`);

  return bits.join(" ");
}

/* ---- the decision -------------------------------------------------------- */

/* Which fields a generated manifest is allowed to leave for a person, and the
   order the report lists them in. Named here so "how many are still blank" is
   one list rather than a scattering of truthy checks. */
export const HUMAN_FIELDS = ["state", "website", "address", "phone"];

/* IS THIS ACTUALLY A SECOND READING, OR THE SAME ONE TWICE?
 *
 * The whole value of --against is that a rounding mode held across a DIFFERENT
 * DAY'S PRICES. Nothing stops somebody passing the same log twice -- I did it
 * myself the first time this was run end to end, and it stated floor-cent on
 * two co-operatives without a murmur. A snapshot cannot corroborate itself.
 *
 * Identical verdict lines for every shared location -- same mode, same testable
 * count, same margin -- is what two copies of one run look like. Two genuine
 * runs on a moving board essentially never produce identical row counts across
 * every location; when they do, it is because the boards did not move, and then
 * they still do not constitute a second day's evidence. */
export function looksLikeTheSameRun(now, prior) {
  const shared = [...now.keys()].filter((k) => prior.has(k));
  if (!shared.length) return false;
  return shared.every((k) => {
    const a = now.get(k), b = prior.get(k);
    return a.mode === b.mode && a.testable === b.testable && a.margin === b.margin;
  });
}

export function decide(entries, {
  prior = new Map(), existing = new Set(), existingByKey = new Map(), barchart = null,
  sameRun = false,
} = {}) {
  const write = [], skip = [];

  for (const e of entries) {
    if (e.notATown) {
      skip.push({ e, why: `destination, not a town — ${e.notATown}` });
      continue;
    }
    const id = idFor(e.manifest.operator, e.location);
    if (!id) {
      skip.push({ e, why: `no operator on the probe line, so the id would be "${slug(e.location)}" ` +
                          `and two co-operatives with an Elgin would collide — pass --operator to the probe` });
      continue;
    }
    /* THE ID IS NOT THE KEY, AND CHECKING IT ALONE LETS A DUPLICATE THROUGH.
     *
     * Caught on the first real log this was run against. The probe was given
     * `--operator "Ag Partners Cooperative"`, so idFor produced
     * `agpartnerscooperative-goodhue` — while sources/agpartners-goodhue.json
     * has been live for days. Two files, two ids, ONE elevator, both polling
     * the same locationId, and an id check would have said the coast was
     * clear because the two strings differ.
     *
     * The key is what the feed keys on: siteId plus the numeric location.id.
     * That is the same reasoning the manifests already carry about why the
     * location key is location.id and not the display name. */
    const key = `${e.manifest.siteId} ${e.locationId}`;
    if (existingByKey.has(key)) {
      skip.push({ e, id, why: `already read by sources/${existingByKey.get(key)}.json — same siteId ` +
                              `and locationId (${key}). A second file would poll one elevator twice ` +
                              `under two ids` });
      continue;
    }
    if (existing.has(id)) {
      skip.push({ e, id, why: `sources/${id}.json already exists — one writer per artefact` });
      continue;
    }

    const v = e.verdict;
    const was = prior.get(`${e.manifest.siteId} ${e.locationId}`);
    const priorMode = was ? was.mode : null;
    /* `sameRun` collapses the agreement to nothing on purpose: a log compared
       with itself agrees with itself, and that is not evidence. */
    const agreed = !sameRun && !!(v && v.mode && v.mode !== "-" && priorMode && priorMode === v.mode);

    const m = { ...e.manifest, id };
    /* Stated ONLY on agreement across two runs. The probe already withheld it
       on a thin margin; this withholds it again on a single snapshot. */
    if (!agreed) delete m.cashRounding;
    else m.cashRounding = v.mode;

    m.enabled = false;
    m.note = noteFor({ ...e, manifest: m }, { agreed, priorMode });

    /* BARCHART IS A REASON TO SET inMerge, NOT A REASON TO DROP A SOURCE.
       A first-party read is fresher and carries basis and delivery detail
       Barchart's payload does not always keep, so the file is still written —
       it is kept out of the merged map so one elevator is not two rows. Same
       shape sources/boyceville.json already uses. */
    if (barchart) {
      const hit = barchart.covers(e.location, m.state);
      if (hit) {
        m.inMerge = false;
        m.inMergeWhy = `Barchart already carries ${hit}. Read first-party because that read is ` +
          `fresher and carries basis and delivery detail Barchart's payload does not always keep; ` +
          `excluded from the merged map so one elevator is not two rows.`;
      }
    }

    const blanks = HUMAN_FIELDS.filter((k) => m[k] === SET || m[k] === undefined || m[k] === null);
    write.push({ e, id, manifest: m, agreed, priorMode, blanks,
                 barchartCovered: m.inMerge === false });
  }
  return { write, skip };
}

/* ---- the script ---------------------------------------------------------- */

/* A Barchart coverage list, if one is on disk. One `Town, ST` or `Facility|Town, ST`
   per line; blank lines and # comments ignored. Deliberately a FILE and not a
   fetch: this runs where barchart.com is not reachable, and a coverage claim
   that cannot be re-read is not a coverage claim. */
export function barchartList(text) {
  const towns = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const town = line.includes("|") ? line.split("|").pop().trim() : line;
    towns.add(slug(town.split(",")[0]));
  }
  return {
    size: towns.size,
    covers(location) { const k = slug(location); return towns.has(k) ? location : null; },
  };
}

function main() {
  const logPath = flag("log");
  if (!logPath) {
    console.error("usage: node scripts/dtn-build.mjs --log <probe log> [--against <earlier log>] " +
                  "[--barchart <list>] [--out sources] [--write]");
    process.exit(2);
  }
  const outDir = flag("out", "sources");
  const doWrite = has("write");

  const { entries, bad } = parseProbeLog(readFileSync(logPath, "utf8"));
  const prior = flag("against") ? verdicts(readFileSync(flag("against"), "utf8")) : new Map();
  const barchart = flag("barchart") ? barchartList(readFileSync(flag("barchart"), "utf8")) : null;
  /* Every source already on disk, by BOTH names it can be known under: its id,
     and the siteId+locationId the feed keys it on. See decide(). */
  const existing = new Set();
  const existingByKey = new Map();
  if (existsSync(outDir))
    for (const f of readdirSync(outDir).filter((f) => f.endsWith(".json"))) {
      const id = f.slice(0, -5);
      existing.add(id);
      try {
        const src = JSON.parse(readFileSync(join(outDir, f), "utf8"));
        if (src.siteId != null && src.locationId != null)
          existingByKey.set(`${src.siteId} ${src.locationId}`, id);
      } catch { /* a source that will not parse is another script's problem */ }
    }

  const now = verdicts(readFileSync(logPath, "utf8"));
  const sameRun = prior.size > 0 && looksLikeTheSameRun(now, prior);
  if (sameRun)
    console.log(`\n::warning::THE --against LOG LOOKS LIKE THE SAME RUN. Every shared location has ` +
                `the same mode, the same testable count and the same margin, which is what one log ` +
                `compared with itself looks like. No cashRounding will be stated. Run the probe ` +
                `again on another day's prices and pass THAT log.`);

  const { write, skip } = decide(entries, { prior, existing, existingByKey, barchart, sameRun });

  console.log(`read ${entries.length} location(s) from ${logPath}`);
  if (bad.length) {
    console.log(`\n${bad.length} HEADING(S) WITHOUT A USABLE MANIFEST — reported, not skipped quietly:`);
    for (const b of bad) console.log(`  ${b}`);
  }
  if (!prior.size)
    console.log(`no --against log, so NO source will state cashRounding. One snapshot does not ` +
                `establish a rounding mode; run the probe again on another day and pass that log.`);
  if (!barchart)
    console.log(`no --barchart list, so nothing is marked as already covered. inMerge is left as ` +
                `the probe set it — that is not the same as "Barchart does not have these".`);
  else
    console.log(`barchart list: ${barchart.size} town(s)`);

  if (skip.length) {
    console.log(`\nSKIPPED ${skip.length}:`);
    for (const s of skip) console.log(`  ${s.e.location} (${s.e.locationId}) — ${s.why}`);
  }

  console.log(`\nWOULD WRITE ${write.length}:`);
  for (const w of write)
    console.log(`  ${w.id.padEnd(34)} ${w.manifest.cashRounding ?? "(no rounding stated)"}` +
                `${w.barchartCovered ? "  [Barchart covers it — inMerge:false]" : ""}` +
                `${w.blanks.length ? `  STILL BLANK: ${w.blanks.join(", ")}` : ""}`);

  const blocked = write.filter((w) => w.blanks.length);
  console.log(`\n${write.length} to write, ${skip.length} skipped, ` +
              `${blocked.length} still needing a person (${HUMAN_FIELDS.join("/")}), ` +
              `${write.filter((w) => w.manifest.cashRounding).length} with a rounding mode two runs agreed on`);

  if (!doWrite) { console.log(`\nNothing written. Add --write.`); return; }

  for (const w of write)
    writeFileSync(join(outDir, `${w.id}.json`), JSON.stringify(w.manifest, null, 2) + "\n");
  console.log(`\nwrote ${write.length} file(s) to ${outDir}/. Every one is enabled:false — ` +
              `fill in ${HUMAN_FIELDS.join(", ")}, geocode the address, then enable.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

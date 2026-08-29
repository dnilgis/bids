#!/usr/bin/env node
/* FILL THE COORDINATE A MANIFEST IS MISSING, FROM THE FILE THAT ALREADY HAS IT.
 *
 * WHY THIS EXISTS. On 2026-08-29 the project had 401 source manifests and 82
 * coordinates. `geocodes/places.json` held 251 places, keyed BY SOURCE ID, and
 * 216 of them were for manifests whose `lat` was null. The two files had never
 * been joined. Every one of those elevators publishes a price and none of them
 * can be put on a distance-sorted map, which is the difference between a feed
 * and a product.
 *
 * It also blocks the only question that matters for switching Barchart off:
 * "is there a live bid within N miles of this farmer?" That was answerable for
 * 72 of 342 enabled sources, so the answer was not worth having.
 *
 * IT NEVER OVERWRITES A COORDINATE. A pin already in a manifest was put there
 * by somebody who looked -- several were corrected by hand against the
 * operator's own published address, and flashgrain-thorp's note records a
 * previous pin that sat 6.5 km from the yard because it was the TOWN and not
 * the elevator. A centroid must never win against that.
 *
 * PRECISION IS CARRIED, NOT DROPPED. places.json says it plainly: "'street' is
 * where the elevator is; 'town' is the centroid of its town's ZIPs and can be
 * miles off. The map must say which." So the manifest gets `latPrecision`, and
 * anything downstream that draws a pin can tell the two apart. Of the 216:
 * 126 street, 90 town.
 *
 * DRY RUN BY DEFAULT. Pass --write to change files.
 *
 *   node scripts/geocode-fill.mjs
 *   node scripts/geocode-fill.mjs --write
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { validateSource } from "../lib/sources.mjs";

const SRC = new URL("../sources/", import.meta.url);
const PLACES = new URL("../geocodes/places.json", import.meta.url);

/* THE SENTENCE THAT GOES IN THE NOTE. Same shape dtn-build.mjs uses when it
   fills a coordinate while writing a manifest, so a reader cannot tell which
   tool put the pin there and does not need to. */
export function noteFor(id, p) {
  const how = p.precision === "street"
    ? `a STREET-level fix on the elevator itself`
    : `the CENTROID OF THE TOWN's ZIPs, which can be miles from the yard`;
  return ` COORDINATE filled ${p.lat},${p.lon} from geocodes/places.json on ` +
    `2026-08-29, keyed on this source's own id and resolved from ` +
    `"${p.resolvedFrom}" via ${p.via}. It is ${how}. EVIDENCE, NOT A FACT: ` +
    `check it against the operator's own published address before anything ` +
    `depends on the distance.`;
}

export function plan(sources, places) {
  const fill = [], skip = [], refuse = [];
  for (const s of sources) {
    const p = places[s.id];
    if (!p) { skip.push({ id: s.id, why: "no entry in places.json" }); continue; }
    if (s.lat !== null && s.lat !== undefined) {
      /* NOT AN ERROR AND NOT A NO-OP WORTH HIDING: say when the two disagree,
         because a manifest pin and a centroid a hundred miles apart means one
         of them is about the wrong elevator. */
      const far = Math.abs(s.lat - p.lat) > 0.5 || Math.abs(s.lon - p.lon) > 0.5;
      skip.push({ id: s.id, why: far ? `HAS A PIN, and places.json disagrees by more than half a degree` : "already has a pin" });
      continue;
    }
    /* ASK ONLY WHAT THIS CHANGE BREAKS. Running validateSource on the result
       and refusing on any complaint sounds safer and is not: a manifest that
       is already invalid for some unrelated reason -- a dtn-cs source with no
       browserPage, say -- would then be denied a coordinate it could perfectly
       well have, and the log would blame the coordinate for it. So validate
       BEFORE and AFTER and refuse only on what is new. That isolates the one
       question this tool is allowed to answer: does adding this pin make the
       manifest worse? */
    const before = new Set(validateSource(s, new Set()));
    const after = validateSource({ ...s, lat: p.lat, lon: p.lon }, new Set());
    const introduced = after.filter((x) => !before.has(x));
    if (introduced.length) { refuse.push({ id: s.id, why: introduced.join("; ") }); continue; }
    fill.push({ id: s.id, lat: p.lat, lon: p.lon, precision: p.precision, p });
  }
  return { fill, skip, refuse };
}

export function applyTo(s, f) {
  s.lat = f.lat;
  s.lon = f.lon;
  s.latPrecision = f.precision;
  s.note = String(s.note ?? "").trimEnd() + noteFor(s.id, f.p);
  return s;
}

function main() {
  const write = process.argv.includes("--write");
  const places = JSON.parse(readFileSync(PLACES, "utf8")).places;
  const files = readdirSync(SRC).filter((f) => f.endsWith(".json"));
  const sources = files.map((f) => JSON.parse(readFileSync(new URL(f, SRC), "utf8")));

  const { fill, skip, refuse } = plan(sources, places);
  const byPrec = fill.reduce((a, f) => (a[f.precision] = (a[f.precision] || 0) + 1, a), {});
  const had = sources.filter((s) => s.lat !== null && s.lat !== undefined).length;

  console.log(`sources ${sources.length}, places ${Object.keys(places).length}`);
  console.log(`placed before ${had}  ->  after ${had + fill.length}\n`);
  console.log(`FILL ${fill.length}   street ${byPrec.street ?? 0}  town ${byPrec.town ?? 0}`);
  for (const f of fill.slice(0, 6)) console.log(`   ${f.id.padEnd(42)} ${f.lat},${f.lon}  ${f.precision}`);
  if (fill.length > 6) console.log(`   ... and ${fill.length - 6} more`);

  const loud = skip.filter((s) => s.why.startsWith("HAS A PIN, and"));
  if (loud.length) {
    console.log(`\nDISAGREEMENTS -- a manifest pin and a centroid more than half a degree apart:`);
    for (const s of loud) console.log(`   ${s.id}`);
  }
  if (refuse.length) {
    console.log(`\nREFUSED ${refuse.length} -- the filled manifest would not validate:`);
    for (const r of refuse) console.log(`   ${r.id}: ${r.why}`);
  }
  console.log(`\nskipped ${skip.length} (${skip.filter((s) => s.why === "no entry in places.json").length} not in places.json, ` +
              `${skip.filter((s) => s.why.startsWith("already")).length} already pinned, ${loud.length} disagreeing)`);

  if (!write) { console.log(`\nDRY RUN. Nothing written. Pass --write to apply.`); return 0; }

  const byId = new Map(sources.map((s, i) => [s.id, files[i]]));
  for (const f of fill) {
    const file = byId.get(f.id);
    const s = JSON.parse(readFileSync(new URL(file, SRC), "utf8"));
    writeFileSync(new URL(file, SRC), JSON.stringify(applyTo(s, f), null, 2) + "\n");
  }
  console.log(`\nWROTE ${fill.length} manifest(s).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

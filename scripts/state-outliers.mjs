/* SOURCES WHOSE STATE DISAGREES WITH THE REST OF THEIR OPERATOR.
 * ===========================================================================
 *
 *     node scripts/state-outliers.mjs            write the report
 *     node scripts/state-outliers.mjs --print    and print it
 *
 * WHY
 *
 * 2026-09-05. A dry run of agricharts-sweep was checked before writing, and it
 * showed AgMark LLC — a north-central Kansas co-operative — about to place six
 * of its Kansas towns in Wisconsin, Ohio, North Dakota, South Dakota, Iowa and
 * Minnesota. That was a bug in board-siblings.mjs and it was fixed.
 *
 * But the same log also showed this, and it is not new and not mine:
 *
 *     sources/agmarkllc-gaylord.json   Gaylord, MN 55334   44.5463, -94.1955
 *
 * AgMark's board lists Agra, Athol, Glade, Kirwin, Logan, Phillipsburg, Smith
 * Center and Speed. That is Smith and Phillips counties, Kansas — and Gaylord,
 * Kansas is in Smith County, among them. The shipped source puts it about 380
 * miles away in Minnesota, because data/known-elevators.json carries a row
 * reading "AgMark LLC | Gaylord | Gaylord MN 55334".
 *
 * A wrong state is a wrong coordinate, and a wrong coordinate on this site is
 * a farmer driving to the wrong elevator. Nothing was checking for it.
 *
 * WHAT THIS IS NOT
 *
 * It is NOT an automatic fix, and it never will be. Co-operatives cross state
 * lines constantly and most of what this finds is correct: CHS Drayton really
 * does have Kennedy, Minnesota; CoMark really is in Kansas and Oklahoma;
 * Innovative Ag really does reach into Wisconsin. Deciding which is wrong
 * needs somebody who knows the country, so this writes a short list to look
 * at and changes nothing.
 *
 * THE SIGNAL, AND ITS LIMIT
 *
 * An operator with four or more sources, where a minority sit in a different
 * state from the rest. The minority is reported with the distance from the
 * operator's own centre, because that is what separates a border town from a
 * mistake: Kennedy MN is 20 miles from CHS Drayton's other yards; Gaylord MN
 * is 380 from AgMark's.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRINT = process.argv.includes("--print");

/* Great-circle miles. Plain arithmetic on two coordinates we already hold —
   nothing is looked up and nothing is invented. */
function miles(a, b) {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const byOperator = new Map();
for (const f of readdirSync(ROOT + "sources")) {
  if (!f.endsWith(".json")) continue;
  let s; try { s = JSON.parse(readFileSync(ROOT + "sources/" + f, "utf8")); } catch { continue; }
  if (!s.operator || !s.state) continue;
  if (!byOperator.has(s.operator)) byOperator.set(s.operator, []);
  byOperator.get(s.operator).push(s);
}

const findings = [];
for (const [operator, rows] of byOperator) {
  if (rows.length < 4) continue;                 /* too few to have a "rest" */
  const counts = new Map();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) || 0) + 1);
  const [home, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const odd = rows.filter((r) => r.state !== home);
  if (!odd.length) continue;
  /* A genuinely two-state co-op is not an outlier; it is a two-state co-op. */
  if (odd.length / rows.length > 0.35) continue;

  /* The operator's centre, from its home-state locations that carry one. */
  const placed = rows.filter((r) => r.state === home && r.lat != null && r.lon != null);
  const centre = placed.length
    ? { lat: placed.reduce((t, r) => t + r.lat, 0) / placed.length,
        lon: placed.reduce((t, r) => t + r.lon, 0) / placed.length }
    : null;

  for (const r of odd) {
    const d = (centre && r.lat != null && r.lon != null) ? miles(centre, r) : null;
    findings.push({
      operator, id: r.id, location: r.location, state: r.state,
      homeState: home, homeCount: n, total: rows.length,
      milesFromOperatorCentre: d == null ? "" : Math.round(d),
      lat: r.lat ?? "", lon: r.lon ?? "",
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  A DISTANCE THAT COULD NOT BE COMPUTED IS NOT A SMALL DISTANCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *  The first version sorted on the number and treated a blank as zero, so the
 *  case this tool was written for sank to the bottom of its own report:
 *
 *      agmarkllc-gaylord   Gaylord, MN   among 13 Kansas locations   distance ""
 *
 *  Blank because all THIRTEEN of AgMark's Kansas sources carry lat = null.
 *  There was no centre to measure from — so on the coverage map AgMark is a
 *  single pin, in Minnesota, and it is the wrong one. The thirteen right ones
 *  are not drawn at all.
 *
 *  "We could not check" is a louder signal than "it is nearby", not a quieter
 *  one. Same shape as every other mistake in this repository today: absence of
 *  evidence read as evidence of absence. So an uncheckable row sorts FIRST and
 *  is counted on its own line. */
const rank = (f) => f.milesFromOperatorCentre === "" ? Infinity : Number(f.milesFromOperatorCentre);
findings.sort((a, b) => rank(b) - rank(a));

mkdirSync(ROOT + "data/gaps", { recursive: true });
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(ROOT + "data/gaps/state-outliers.csv",
  "operator,id,location,state,operator_home_state,home_count,total,miles_from_operator_centre,lat,lon\n" +
  findings.map((f) => [f.operator, f.id, f.location, f.state, f.homeState, f.homeCount,
    f.total, f.milesFromOperatorCentre, f.lat, f.lon].map(q).join(",")).join("\n") + "\n");

const unchecked = findings.filter((f) => f.milesFromOperatorCentre === "");
const far = findings.filter((f) => f.milesFromOperatorCentre !== "" &&
                                   Number(f.milesFromOperatorCentre) >= 150);
console.log("\nSOURCES IN A DIFFERENT STATE FROM THE REST OF THEIR OPERATOR");
console.log("  operators examined (4+ sources) : " +
  [...byOperator.values()].filter((r) => r.length >= 4).length);
console.log("  out-of-state sources            : " + findings.length);
console.log("  of those, 150+ miles out        : " + far.length);
console.log("  DISTANCE COULD NOT BE CHECKED   : " + unchecked.length +
  "   <- look at these first: the operator's own locations carry no coordinate,");
console.log("                                        so the outlier may be the only pin it draws");
console.log("\n  written: data/gaps/state-outliers.csv");
console.log("\n  NOTHING IS CHANGED. Co-ops cross state lines and most of this is correct.");

if (PRINT || far.length || unchecked.length) {
  console.log("\n  " + "operator".padEnd(32) + "location".padEnd(22) + "st  home  miles");
  for (const f of (PRINT ? findings : unchecked.concat(far)).slice(0, 40))
    console.log("  " + f.operator.slice(0, 31).padEnd(32) + String(f.location).slice(0, 21).padEnd(22) +
      f.state.padEnd(4) + f.homeState.padEnd(6) +
      (f.milesFromOperatorCentre === "" ? "  n/a" : String(f.milesFromOperatorCentre).padStart(5)));
}

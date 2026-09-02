/* THE SWITCH-OFF SCOREBOARD.
 *
 * Sig, 2026-08-29: "i want to build bids like i dont have any barchart api …
 * when bids is rock solid i can switch off the barchart api." The decision that
 * came with it was that the switch goes REGION BY REGION on a measured figure,
 * not all at once on a feeling. This is that figure.
 *
 * WHAT IT ASKS. agsist queries Barchart around 50 reader ZIPs. For each one:
 * do WE have a price near it from our own scraping? Near at three radii,
 * because "covered" is not one number — 25 miles is a farmer's own elevator,
 * 100 miles is the market he can reach.
 *
 * WHAT COUNTS AS A PRICE. read or stale. Not `known`: an elevator we can name
 * but have never read serves nobody, and counting it would turn the roadmap
 * into the scoreboard. Not `down` either — past the withdrawal window there is
 * nothing to publish, which is the whole point of the window.
 *
 * IT PRINTS AND IT WRITES. The number is useless once a run scrolls off, so it
 * goes to data/coverage.json for anything that wants to chart it, and to a
 * GitHub notice so the answer is on the run summary without opening a log.
 *
 * IT REFUSES TO GUESS. No grid file, no coverage figure — it exits non-zero
 * rather than printing a smaller number that looks like progress.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv;
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const ROOT = flag("--root") ? resolve(flag("--root"))
  : join(dirname(fileURLToPath(import.meta.url)), "..");

/* Miles, because every other distance a farmer sees on this project is miles. */
export const RADII = [25, 50, 100];

/* GREAT-CIRCLE, NOT PYTHAGORAS ON DEGREES.
   A degree of longitude is 54 miles at the Texas panhandle and 44 at the
   Canadian border, so flat arithmetic would over-count the north and
   under-count the south — on a grid that runs from Texas to North Dakota. */
export function milesBetween(a, b, c, d) {
  const R = 3958.7613, r = Math.PI / 180;
  const dLat = (c - a) * r, dLon = (d - b) * r;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Does this elevator carry a price a consumer could publish right now? */
export const servesAPrice = (e) => e.status === "read" || e.status === "stale";

export function coverage(points, elevators, radii = RADII) {
  const live = elevators.filter((e) => servesAPrice(e) && e.placed && Number.isFinite(e.lat));
  const rows = points.map((p) => {
    const d = live.map((e) => milesBetween(p.lat, p.lon, e.lat, e.lon)).sort((x, y) => x - y);
    const within = {};
    for (const r of radii) within[r] = d.filter((x) => x <= r).length;
    return { zip: p.zip, label: p.label, within, nearest: d.length ? Math.round(d[0] * 10) / 10 : null };
  });
  const covered = {};
  for (const r of radii) covered[r] = rows.filter((x) => x.within[r] > 0).length;
  return { rows, covered, points: points.length, elevatorsWithAPrice: live.length };
}

function main() {
  const gridPath = join(ROOT, "data", "grid-50.json");
  const dirPath = join(ROOT, "data", "directory.json");
  for (const [p, what] of [[gridPath, "data/grid-50.json"], [dirPath, "data/directory.json"]]) {
    if (!existsSync(p)) {
      console.error(`FAILED: ${what} is missing. This reads them, it does not create them — ` +
        `and a coverage figure computed without the grid would be a smaller number that ` +
        `looks like progress.`);
      return 1;
    }
  }
  const grid = JSON.parse(readFileSync(gridPath, "utf8"));
  const dir = JSON.parse(readFileSync(dirPath, "utf8"));
  if (!Array.isArray(grid.points) || grid.points.length !== grid.count) {
    console.error(`FAILED: data/grid-50.json says ${grid.count} points and carries ` +
      `${grid.points?.length}. It is a copy of agsist's ZIP_GRID; regenerate it.`);
    return 1;
  }

  const c = coverage(grid.points, dir.elevators || []);
  const pct = (n) => `${n}/${c.points} (${Math.round((n / c.points) * 100)}%)`;

  console.log(`coverage: ${c.elevatorsWithAPrice} elevators carrying a price, ` +
              `against ${c.points} reader ZIPs`);
  for (const r of RADII) console.log(`  within ${String(r).padStart(3)} mi: ${pct(c.covered[r])}`);

  const naked = c.rows.filter((x) => x.within[100] === 0)
    .sort((a, b) => (a.nearest ?? 1e9) - (b.nearest ?? 1e9));
  if (naked.length) {
    console.log(`\n  ${naked.length} ZIP(s) with nothing of ours inside 100 mi — ` +
                `these are the regions Barchart is still carrying alone:`);
    for (const x of naked.slice(0, 12))
      console.log(`     ${x.label.padEnd(22)} nearest ${x.nearest == null ? "none at all" : x.nearest + " mi"}`);
  }

  const out = {
    schema: "bids-coverage/1", generated: new Date().toISOString(),
    radiiMiles: RADII, points: c.points, elevatorsWithAPrice: c.elevatorsWithAPrice,
    covered: c.covered, rows: c.rows,
    note: "How many of agsist's 50 reader ZIPs have one of OUR scraped elevators near them. " +
          "read or stale counts; known and down do not. This is the region-by-region figure " +
          "the Barchart switch-off was to be decided on.",
  };
  writeFileSync(join(ROOT, "data", "coverage.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`\nwrote data/coverage.json`);
  console.error(`::notice title=coverage::${pct(c.covered[25])} of reader ZIPs have one of our ` +
    `elevators within 25 mi, ${pct(c.covered[50])} within 50, ${pct(c.covered[100])} within 100 ` +
    `— from ${c.elevatorsWithAPrice} elevators carrying a price.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

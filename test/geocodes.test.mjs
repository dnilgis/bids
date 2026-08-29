/* THE COORDINATE FILE IS DATA A PERSON WILL COPY FROM, SO IT IS GUARDED.
 *
 * geocodes/basis1st-list-2026-08-20.tsv came out of a paste that contained two
 * populations: rows geocoded per facility to seven or nine decimal places, and
 * rows with four decimals and a bare town name that are wrong by hundreds of
 * kilometres — Valero's "Welcome, Minnesota" at latitude 32.39 is in Alabama.
 *
 * Only the good population was kept. These tests exist so it stays that way:
 * the next person to append a row will not have read the README, and a wrong
 * coordinate puts a bid on a map in a county nobody chose. That is rule one,
 * broken quietly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const TSV = new URL("../geocodes/basis1st-list-2026-08-20.tsv", import.meta.url);
const rows = readFileSync(TSV, "utf8").split(/\r?\n/)
  .filter((l) => l && !l.startsWith("#") && !l.startsWith("Name\t"))
  .map((l) => l.split("\t"))
  .map(([name, url, phone, address, postal, lon, lat]) => ({ name, url, phone, address, postal, lon, lat }));

test("the file parses and is not empty", () => {
  assert.ok(rows.length >= 60, `only ${rows.length} rows`);
  for (const r of rows) assert.ok(r.name, `a row with no operator: ${JSON.stringify(r)}`);
});

test("EVERY COORDINATE IS HIGH-PRECISION — the marker that separates the two populations", () => {
  // Four decimal places is the signature of the bad population. Six or more is
  // the signature of the good one. This is the whole guard.
  for (const r of rows) {
    if (!r.lat?.trim() && !r.lon?.trim()) continue;      // a row with no coordinate is honest
    for (const [k, v] of [["lat", r.lat], ["lon", r.lon]]) {
      const dp = (String(v).split(".")[1] ?? "").length;
      assert.ok(dp >= 6, `${r.name} ${r.postal}: ${k}=${v} has only ${dp} decimal places — that is the bad population`);
    }
  }
});

test("and every coordinate is in the Upper Midwest, not Alabama", () => {
  // The bad rows failed exactly here: a latitude in the low 30s, a longitude
  // in the 80s. Deliberately generous — this catches a continent, not a county.
  for (const r of rows) {
    if (!r.lat?.trim()) continue;
    const lat = Number(r.lat), lon = Number(r.lon);
    assert.ok(Number.isFinite(lat) && Number.isFinite(lon), `${r.name}: unreadable coordinate`);
    assert.ok(lat > 38 && lat < 50, `${r.name} ${r.postal}: latitude ${lat} is outside the Midwest`);
    assert.ok(lon > -104 && lon < -82, `${r.name} ${r.postal}: longitude ${lon} is outside the Midwest`);
  }
});

test("a row with no coordinate says so rather than guessing one", () => {
  const blank = rows.filter((r) => !r.lat?.trim());
  for (const r of blank) assert.equal(r.lon?.trim() || "", "", `${r.name}: half a coordinate is worse than none`);
});

test("every url is a url", () => {
  for (const r of rows) if (r.url?.trim()) assert.doesNotThrow(() => new URL(r.url), `${r.name}: ${r.url}`);
});

test("THE TWO CORRECTED PINS STAY CORRECTED", () => {
  /* flashgrain-thorp was pinned 6.5 km from the yard and boyceville 4.1 km --
     both were the town rather than the elevator. Verified 2026-08-20 against
     the operators' published addresses by two independent geocoders. If these
     drift back to a town centroid, a farmer asking which elevator is nearest
     gets the wrong answer. */
  const want = {
    "flashgrain-thorp": [44.91635, -90.74426],
    "boyceville": [45.0494, -91.97755],
  };
  for (const [id, [lat, lon]] of Object.entries(want)) {
    const s = JSON.parse(readFileSync(new URL(`../sources/${id}.json`, import.meta.url), "utf8"));
    assert.equal(s.lat, lat, `${id} latitude`);
    assert.equal(s.lon, lon, `${id} longitude`);
    assert.match(s.note, /COORDINATE CORRECTED/, `${id} must carry why it changed`);
  }
});

test("NO SOURCE FILE PINS AN ELEVATOR OUTSIDE THE CONTINENTAL US", () => {
  /* The precision heuristic above works on the TSV, where the two populations
     differ exactly that way, and it does NOT transfer to the manifests: JSON
     drops trailing zeros, so albertlea's honest 43.65500 arrives as 43.655 and
     a decimal-place count calls it rounded. The bounds check is what actually
     caught the bad rows -- a latitude in the low 30s, a longitude in the 80s --
     and it does not care how the number was written. */
  const dir = new URL("../sources/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    if (s.lat == null && s.lon == null) continue;
    assert.ok(s.lat != null && s.lon != null, `${s.id}: half a coordinate is worse than none`);
    /* WIDENED 2026-08-29, FROM THE MIDWEST TO THE CONTINENTAL US, and the old
       numbers are kept here because the reason they were right matters.

       This was `lat > 38 && lat < 50, lon > -104 && lon < -82`. That box was
       drawn when the project was Wisconsin and Minnesota, and it did its job:
       the rows it caught were "a latitude in the low 30s, a longitude in the
       80s", which is what a transposed or garbage pair looks like.

       By 2026-08-29 it was failing on FOUR correctly geocoded elevators that
       the project had legitimately grown into --

         pinebluffsfeedandgrain-pinebluffs   41.18, -104.07   Wyoming
         piquacoop-piqua                     37.92,  -95.53   Kansas
         abbyvillecoop-abbyville             37.97,  -98.20   Kansas
         agcentral-newcastle                 40.94,  -80.42   Pennsylvania

       -- plus two held Ontario sources. A red check that is red because the
       project succeeded is a check nobody reads any more, which is worse than
       no check. And the direction is now explicitly national, so it was going
       to fail harder every week.

       The new bounds are exactly the ones `validateSource` in lib/sources.mjs
       has ALWAYS enforced at load time. So this is not a loosening: it is this
       test finally agreeing with the guard that actually ships. What it still
       adds over the validator is that it walks every file on disk, including
       the ones that are disabled and therefore never loaded. */
    assert.ok(s.lat > 24 && s.lat < 50, `${s.id}: latitude ${s.lat} is not in the continental US`);
    assert.ok(s.lon > -125 && s.lon < -66, `${s.id}: longitude ${s.lon} is not in the continental US`);
  }
});

test("A FILLED COORDINATE SAYS HOW PRECISE IT IS", () => {
  /* geocodes/places.json is blunt about this and the manifests must not lose
     it: "'street' is where the elevator is; 'town' is the centroid of its
     town's ZIPs and can be miles off. The map must say which."
     scripts/geocode-fill.mjs writes `latPrecision` beside the pin it fills, so
     anything drawing a distance can tell a yard from a town centre. A pin
     placed by hand before that tool existed carries no such field, and that is
     allowed -- what is not allowed is the field without a pin. */
  const dir = new URL("../sources/", import.meta.url);
  let street = 0, town = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    if (s.latPrecision === undefined) continue;
    assert.ok(["street", "town"].includes(s.latPrecision),
      `${s.id}: latPrecision "${s.latPrecision}" is neither street nor town`);
    assert.ok(typeof s.lat === "number",
      `${s.id}: says how precise its coordinate is and does not have one`);
    if (s.latPrecision === "street") street++; else town++;
  }
  /* Not a threshold, a tripwire: if this ever reads 0 and 0 the fill has been
     undone by something and nobody would otherwise notice. */
  if (street + town > 0) assert.ok(street > 0 && town > 0, "both kinds should be present once the fill has run");
});

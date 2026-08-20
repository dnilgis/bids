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

test("NO SOURCE FILE PINS AN ELEVATOR OUTSIDE THE MIDWEST", () => {
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
    assert.ok(s.lat > 38 && s.lat < 50, `${s.id}: latitude ${s.lat} is outside the Midwest`);
    assert.ok(s.lon > -104 && s.lon < -82, `${s.id}: longitude ${s.lon} is outside the Midwest`);
  }
});

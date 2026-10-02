/* The operator's own published location list, and the two places it is used:
 * the sweep (only where the directory has no row) and the coordinate fill
 * (only where a manifest has no coordinate and the published state agrees).
 * Fixture: Alcivia's cashbids-js.php, real bytes from capture.yml run
 * 36956170275, 2026-10-02 UTC. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePublished, bidsArray, platformHost, publishedUrl, plausible } from "../lib/agricharts-published.mjs";
import { planFill } from "../scripts/agricharts-published.mjs";
import { planBoard } from "../scripts/agricharts-sweep.mjs";

const BODY = readFileSync(new URL("../fixtures/cashbidsjs-alciviacoop-2026-10-02.txt", import.meta.url), "utf8");

test("Alcivia's list: 15 locations, same ids as its cashgrid board, each with an address and a coordinate", () => {
  const p = parsePublished(BODY);
  assert.equal(Object.keys(p).length, 15);
  assert.deepEqual(p["79427"], { name: "BALDWIN", street: "930 10th Ave", city: "Baldwin", state: "WI",
    zip: "54002", phone: "800-554-3213", lat: 44.968448, lon: -92.374671 });
  for (const l of Object.values(p)) assert.ok(plausible(l), l.name);
});

test("hosts and the address asked", () => {
  assert.equal(platformHost("https://fsgrain.agricharts.com/markets/cashgrid.php"), "fsgrain.agricharts.com");
  assert.equal(platformHost("https://ceagrain.mobile.agricharts.com/cash/prices.php"), "ceagrain.agricharts.com");
  assert.equal(platformHost("https://sfc_cb-jsi.agricharts.com/"), "sfc_cb-jsi.agricharts.com");
  assert.equal(platformHost("https://www.ceagrain.com/"), null);
  assert.match(publishedUrl("x.agricharts.com"), /^https:\/\/x\.agricharts\.com\/inc\/cashbids\/cashbids-js\.php\?filter=all/);
  assert.equal(bidsArray("no array here"), null);
  assert.equal(parsePublished("<html></html>"), null);
});

test("a hidden or inactive location is left out", () => {
  const body = 'var bids = [{"id":"1","name":"A","city":"X","state":"IA","active":"1","hide_on_sites_and_apis":"1"},'
    + '{"id":"2","name":"B","city":"Y","state":"IA","active":"0"},{"id":"3","name":"C","city":"Z","state":"ia","active":"1","latitude":"0","longitude":"0"}];';
  const p = parsePublished(body);
  assert.deepEqual(Object.keys(p), ["3"]);
  assert.equal(p["3"].state, "IA");
  assert.equal(p["3"].lat, null, "a zero coordinate is no coordinate");
});

test("THE FILL: only a manifest with no coordinate, on its own host and id, in the same state", () => {
  const file = { hosts: { "alciviacoop.agricharts.com": { locations: parsePublished(BODY) } } };
  const base = { platform: "agricharts-cashgrid", url: "https://alciviacoop.agricharts.com/markets/cashgrid.php" };
  const { fill, refused } = planFill([
    { ...base, id: "a", locationId: "79410", state: "WI", lat: null, lon: null },     // fills
    { ...base, id: "b", locationId: "79427", state: "WI", lat: 44.96, lon: -92.36 },  // has one: untouched
    { ...base, id: "c", locationId: "79410", state: "MN", lat: null, lon: null },     // state disagrees
    { ...base, id: "d", locationId: "99999", state: "WI", lat: null, lon: null },     // not on the list
    { platform: "cih", id: "e", url: "x", locationId: "79410", state: "WI", lat: null, lon: null },
  ], file);
  assert.deepEqual(fill.map((f) => [f.id, f.lat, f.lon, f.precision]), [["a", 42.867959, -89.53085, "street"]]);
  assert.deepEqual(refused.map((r) => r.id).sort(), ["c", "d"]);
});

test("THE SWEEP: a location the directory has no row for is placed from the board's own address, and says so", () => {
  const published = parsePublished(BODY);
  const rows = [{ locationId: "79410", location: "BELLEVILLE", commodity: "CORN" }];
  const html = "<title>ALCIVIA - Cash Bids</title>";
  const args = { html, url: "https://alciviacoop.agricharts.com/markets/cashgrid.php", site: "https://alciviacoop.agricharts.com/",
    rows, known: [], byZip: new Map(), existingIds: [], kind: "cashgrid" };
  const without = planBoard(args);
  assert.equal(without.write.length, 0, "no directory, no published list: still refused, as before");
  assert.equal(without.unmatched.length, 1);
  const withPub = planBoard({ ...args, published });
  assert.equal(withPub.write.length, 1);
  const m = withPub.write[0].json;
  assert.equal(m.state, "WI");
  assert.equal(m.zip, "53508");
  assert.equal(m.lat, 42.867959);
  assert.equal(m.latPrecision, "street");
  assert.match(m.note, /the directory has no row for this location/);
  assert.match(m.note, /cashbids-js\.php \(321 5th Ave, Belleville, WI, 53508\)/);
});

test("THE DIRECTORY STILL WINS where it has a row", () => {
  const published = { "79410": { name: "X", street: "1 Elsewhere", city: "Elsewhere", state: "WI", zip: "00000", lat: 45, lon: -90 } };
  const known = [{ facility: "ALCIVIA", branch: "Belleville", city: "Belleville", state: "WI", zip: "53508", phone: null }];
  const r = planBoard({ html: "<title>ALCIVIA - Cash Bids</title>", url: "https://alciviacoop.agricharts.com/markets/cashgrid.php",
    site: "https://alciviacoop.agricharts.com/", rows: [{ locationId: "79410", location: "BELLEVILLE", commodity: "CORN" }],
    known, byZip: new Map(), existingIds: [], kind: "cashgrid", published });
  assert.equal(r.write.length, 1);
  assert.equal(r.write[0].json.zip, "53508", "the directory's ZIP, not the published one");
  assert.doesNotMatch(r.write[0].json.note, /the directory has no row/);
});

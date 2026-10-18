/* fx/wire1, 2026-10-18: sources written from the elevsites captures.
 *
 * Every source scripts/wire-captures.mjs wrote must be provable from the
 * trimmed fixture it was written from: the host is the fixture's, the
 * locationId is on that board, and where the board published a place the
 * manifest's state agrees with it. The hand-written Bushel sources are held to
 * their own fixtures the same way, and run through lib/board.mjs on them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { widgetLocations, splitTown, subsequence, claimRows, placeFor, NOT_A_YARD, OTHER_PLANT,
  planCompany, siblingCaptures } from "../scripts/wire-captures.mjs";
import { shownLocation } from "../lib/agricharts-published.mjs";
import { operatorSlug } from "../scripts/agricharts-sweep.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { buildFile } from "../lib/board.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rd = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const all = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json")).map((f) => rd(`sources/${f}`));
const wired = all.filter((s) => /WRITTEN BY scripts\/wire-captures\.mjs/.test(s.note ?? ""));
const zipTowns = rd("geocodes/zip-towns.json").zips;

test("the wire1 sweep wrote sources, and every one validates", () => {
  assert.ok(wired.length >= 100, `only ${wired.length}`);
  for (const s of wired) assert.deepEqual(validateSource(s), [], s.id);
});

test("every wired source's host and locationId are on the board its fixture saved", () => {
  for (const s of wired) {
    const host = new URL(s.url).hostname;
    const fx = rd(`fixtures/wire1/agricharts-${operatorSlug(s.url)}.json`);
    assert.equal(fx.host, host, s.id);
    assert.ok(new URL(s.url).pathname === "/markets/cashgrid.php", s.id);
    const loc = fx.locations[s.locationId];
    assert.ok(loc, `${s.id}: location ${s.locationId} is not in the fixture`);
    if (loc.state && loc.zip && zipTowns[loc.zip]?.[1] === loc.state)
      assert.equal(s.state, loc.state, `${s.id}: the board publishes ${loc.state}`);
    assert.ok(!NOT_A_YARD.test(loc.label ?? ""), `${s.id}: "${loc.label}" is not a yard`);
  }
});

test("no wired location is a second source for a location already read", () => {
  const seen = new Map();
  for (const s of all.filter((x) => /^agricharts/.test(x.platform ?? "") && x.locationId != null)) {
    const k = String(s.locationId);
    assert.ok(!seen.has(k) || !wired.some((w) => w.id === s.id || w.id === seen.get(k)),
      `location ${k} is read by both ${seen.get(k)} and ${s.id}`);
    seen.set(k, s.id);
  }
});

test("every declared row is claimed once, and a Barchart key's town is the manifest's", () => {
  const claimed = new Map();
  for (const s of all.filter((x) => x.enabled !== false))
    for (const r of [...[].concat(s.registryId ?? []), ...(s.sameAsKnown ?? []).map((k) => `known:${k}`)]) {
      assert.ok(!claimed.has(r), `${r} is claimed by ${claimed.get(r)} and ${s.id}`);
      claimed.set(r, s.id);
    }
  const t = (x) => String(x || "").toLowerCase().replace(/[^a-z]/g, "");
  for (const s of wired) for (const k of s.sameAsKnown ?? [])
    if (k.includes("|")) assert.equal(t(k.split("|").at(-2)), t(s.location), `${s.id}: ${k}`);
});

/* ── the pure parts, on hand-made inputs ─────────────────────────────────── */

test("both widget groupings are read, and the selector fills in the rest", () => {
  const byLoc = `var bids = [{"id":"1","name":"Arcola","city":"Arcola","state":"IL","zip":"61910","active":"1",
    "cashbids":[{"name":"Corn"},{"name":"Beans"}]}];`;
  const byCrop = `var bids = [{"id":"9","name":"Corn","cashbids":[{"locations":[{"id":"2","name":"Ashmore","city":"Ashmore","state":"IL","zip":"61912","active":"1"}]}]}];`
    + `<select name="setLocation"><option value="2">Ashmore</option><option value="3">Kansas</option><option value="0">All Locations</option></select>`;
  const a = widgetLocations(byLoc);
  assert.equal(a.get("1").rows, 2);
  assert.deepEqual([...a.get("1").commodities], ["Corn", "Beans"]);
  const b = widgetLocations(byCrop);
  assert.equal(b.get("2").from, "json");
  assert.equal(b.get("3").from, "select");
  assert.equal(b.get("3").label, "Kansas");
  assert.equal(b.size, 2);
});

test("a sub-site in parentheses is matched by its letters in order, and only then", () => {
  assert.deepEqual(splitTown("Charleston (Fgrange)"), { town: "Charleston", sub: "Fgrange" });
  assert.ok(subsequence("Fgrange", "Fairgrange"));
  assert.ok(subsequence("Mworth", "Middlesworth"));
  assert.ok(!subsequence("South", "Sandoval"));
});

test("claims: a town holding two yards is split by name, and a plain row never takes a named sub-site's yard", () => {
  const loc = (id, label, city) => ({ id, label, place: { city, state: "IL", branch: label } });
  const locs = [loc("a", "Shelbyville", "Shelbyville"), loc("b", "Middlesworth", "Shelbyville"),
                loc("c", "Lis", "Newton"), loc("d", "Sandoval", "Sandoval")];
  const rows = [
    { id: "r1", location: "Shelbyville", state: "IL" },
    { id: "r2", location: "Shelbyville (Mworth)", state: "IL" },
    { id: "r3", location: "Newton (Lis)", state: "IL" },
    { id: "r4", location: "Newton", state: "IL" },          // a different yard in Newton
    { id: "r5", location: "Sandoval (South)", state: "IL" }, // not the Sandoval yard
    { id: "r6", location: "Sandoval", state: "IL" },
    { id: "r7", location: "Sandoval", state: "IN" },          // another state
  ];
  const c = claimRows(rows, locs);
  assert.deepEqual(c.get("a"), ["r1"]);
  assert.deepEqual(c.get("b"), ["r2"]);
  assert.deepEqual(c.get("c"), ["r3"]);
  assert.deepEqual(c.get("d"), ["r6"]);
});

test("a published place whose ZIP is in another state is held, not written", () => {
  const p = placeFor({ label: "Hillsboro, IN", city: "Hillsboro", state: "IL", zip: "47949" },
    { known: [], operator: "Total Grain Marketing", family: [], zipTowns });
  assert.match(p.why, /47949, which is IN/);
  assert.ok(OTHER_PLANT.test("CGB-Albany"));
  assert.ok(NOT_A_YARD.test("All Locations"));
});

/* ── ids1, 2026-10-18: the locations wire1 held as unplaced ── */

test("a location flagged active:true is shown; false, \"0\" and hidden ones are not", () => {
  assert.ok(shownLocation({ active: true, hide_on_sites_and_apis: false }));
  assert.ok(shownLocation({ active: "1", hide_on_sites_and_apis: "0" }));
  assert.ok(shownLocation({}));
  assert.ok(!shownLocation({ active: false }));
  assert.ok(!shownLocation({ active: "0" }));
  assert.ok(!shownLocation({ active: true, hide_on_sites_and_apis: true }));
  assert.ok(!shownLocation({ active: "1", hide_on_sites_and_apis: "1" }));
});

test("var locations fills a location the selector named, and adds none it did not", () => {
  const body = `var bids = [{"id":"9","name":"Corn","cashbids":[{"locations":[{"id":"1","name":"BEATRICE","city":"Beatrice","state":"NE","zip":"68310","active":true}]}]}];`
    + `var locations = [{"id":4605,"name":"DILLER","street1":"603 Commercial St","city":"Diller","state":"NE","zip":"68342","latitude":40.10,"longitude":-96.94,"active":true,"hide_on_sites_and_apis":false},`
    + `{"id":777,"name":"OFFICE","street1":"1 Main","city":"Dorchester","state":"NE","zip":"68343","active":true}];`
    + `<select name="setLocation"><option value="1">BEATRICE</option><option value="4605">DILLER</option></select>`;
  const m = widgetLocations(body);
  assert.equal(m.get("1").from, "json");
  assert.equal(m.get("4605").from, "locations");
  assert.equal(m.get("4605").city, "Diller");
  assert.equal(m.get("4605").zip, "68342");
  assert.equal(m.get("4605").label, "DILLER");
  assert.ok(!m.has("777"), "in the full list but not on the board: not a board location on this evidence");
});

test("the same site's other saved pages are siblings; another site is not", () => {
  const f = ["captures-1/www-farmersco-operative-com", "captures-1/www-farmersco-operative-com-grain-grain-cash-bids",
             "captures-2/farmersco-operative-com-about", "captures-3/farmerscoop-coop", "captures-4/www-farmersco-operative-community"];
  assert.deepEqual(siblingCaptures("https://www.farmersco-operative.com/", f), f.slice(0, 3));
});

function planOne({ label, city, state, zip, rolls, operator = "StateLine Cooperative" }) {
  const body = `var bids = [{"id":"9","name":"Corn","cashbids":[{"locations":[{"id":"1","name":${JSON.stringify(label)},`
    + `"city":${JSON.stringify(city)},"state":"${state}","zip":"${zip}","active":"1"}]}]}];`;
  const responses = [{ url: "https://statelinecoop.agricharts.com/inc/cashbids/cashbids-js.php?x=1", body }];
  return planCompany({ company: "T", operator, website: "https://statelinecoop.com/", page: "p" },
    { responses, known: [], directory: [], zipTowns, sources: [], rolls });
}

test("a board location in a town whose roll licenses only other companies is held as a delivered price", () => {
  const p = planOne({ label: "Mankato", city: "Mankato", state: "MN", zip: "56001",
    rolls: [{ state: "MN", city: "MANKATO", name: "CHS Inc." }, { state: "MN", city: "Mankato", name: "Archer-Daniels-Midland Company" }] });
  assert.equal(p.write.length, 0);
  assert.match(p.held[0].why, /licence roll names only CHS Inc\.; Archer-Daniels-Midland Company at Mankato, MN/);
  /* the company's own licence there: written */
  const q = planOne({ label: "Mankato", city: "Mankato", state: "MN", zip: "56001",
    rolls: [{ state: "MN", city: "Mankato", name: "StateLine Cooperative" }, { state: "MN", city: "MANKATO", name: "CHS Inc." }] });
  assert.equal(q.write.length, 1);
  /* no roll row in the town at all: the board's own record stands */
  const r = planOne({ label: "Buffalo Center", city: "Buffalo Center", state: "IA", zip: "50424", rolls: [] });
  assert.equal(r.write.length, 1);
  /* "Superior Ag" owns "Superior Ag Resources Cooperative, Inc." rows */
  const t = planOne({ label: "Ireland Grain", city: "Ireland", state: "IN", zip: "47545", operator: "Superior Ag",
    rolls: [{ state: "IN", city: "IRELAND", name: "Superior Ag Resources Cooperative, Inc." }] });
  assert.equal(t.write.length, 1);
});

test("a label that names one town while the record names another is held", () => {
  const p = planOne({ label: "Mendota, IL (Terminal)", city: "Morris", state: "IL", zip: "60450", rolls: [] });
  assert.equal(p.write.length, 0);
  assert.match(p.held[0].why, /names Mendota, IL and the board's own record puts it in Morris, IL/);
});

test("the ids1 sources: each is on its fixture with the published town, ZIP and coordinate", () => {
  const ids1 = wired.filter((s) => /full location list \(var locations\)/.test(s.note));
  assert.ok(ids1.length >= 15, `${ids1.length} sources placed from var locations`);
  for (const s of ids1) {
    const fx = rd(`fixtures/wire1/agricharts-${operatorSlug(s.url)}.json`);
    const L = fx.locations[s.locationId];
    assert.ok(L, `${s.id}: ${s.locationId} on the fixture`);
    assert.equal(L.from, "locations", s.id);
    assert.equal(L.state, s.state, s.id);
    assert.equal(L.zip, s.zip, s.id);
    assert.equal(L.city, s.location, s.id);
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), `${s.id} has the published coordinate`);
  }
});

/* ── the hand-written Bushel sources, through the guards on their own capture ── */

for (const [prefix, fx] of [["gatewayfs-", "fixtures/bushel-gatewayfs-gen2-2026-10-18.json"],
                            ["northsideelevator-", "fixtures/bushel-northside-2026-10-18.json"]]) {
  test(`${prefix}* publish every row of their own capture under their declared rounding`, () => {
    const body = readFileSync(join(ROOT, fx), "utf8");
    const mine = all.filter((s) => s.id.startsWith(prefix));
    assert.ok(mine.length >= 2);
    for (const s of mine) {
      assert.deepEqual(validateSource(s), [], s.id);
      const b = buildFile(body, { now: new Date("2026-10-18T02:00:00Z"), sourceUrl: s.url, source: toConfig(s),
                                  extract: adapterFor("bushel") });
      assert.ok(b.file.count > 0, s.id);
      assert.equal((b.file.withheld ?? []).length, 0, `${s.id} withheld rows`);
    }
  });
}

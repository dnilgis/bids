/* A TOWN TO SHOW BESIDE A `city` THAT IS AN ELEVATOR'S NAME.
 * See displayTown() in scripts/merge_bids.mjs. `city` is never touched; `town`
 * comes from a table or stays null with a reason. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { displayTown, NAMEY_CITY, shardOf } from "../scripts/merge_bids.mjs";

const ZT = { "53948": ["Mauston", "WI"], "54642": ["Melrose", "WI"], "56293": ["Wabasso", "MN"],
             "56224": ["Clements", "MN"], "57701": ["Rapid City", "SD"], "57703": ["Rapid City", "SD"],
             "54727": ["Cadott", "WI"], "67516": ["Bazine", "KS"] };
const ZC = { "53948": [43.80, -90.08], "54642": [44.14, -91.04], "56293": [44.38, -95.25],
             "56224": [44.38, -95.05], "57701": [44.10, -103.20], "57703": [44.05, -103.15],
             "54727": [44.95, -91.15] };
const near = (lat, lon) => {
  let best = null, bd = Infinity;
  for (const [z, c] of Object.entries(ZC)) {
    const d = Math.hypot((c[0] - lat) * 111, (c[1] - lon) * 111 * Math.cos(lat * Math.PI / 180));
    if (d < bd) { bd = d; best = z; }
  }
  return { zip: best, km: bd };
};
const T = { zipTown: (z) => ZT[z] || null, zipCoord: (z) => ZC[z] || null, nearestZip: near,
            canon: (t, s) => (t.toUpperCase() === "HERNDON" && s === "KS" ? "Herndon" : null) };
const P = (o) => ({ via: "scrape", source: "x-y", state: "WI", zip: null, lat: null, lon: null, ...o });

test("the name rule: the words Sig listed, and nothing that is a plain town", () => {
  for (const n of ["Walsh Grain", "Melrose Farm Service", "Cadott Grain", "Cushing Coop", "Argyle Co-Op",
                   "Medford Cooperative", "Redfield Elevator", "Turon Mill & Elevator, Inc.",
                   "MENOMONIE FEED MILL", "Country Farm Supply", "Daykin Milling LLC", "Grains Inc"]) {
    assert.ok(NAMEY_CITY.test(n), n);
  }
  for (const n of ["Mauston", "Chetek", "Grand Forks", "Millville", "Feeder", "Pauline", "Edgerton"]) {
    assert.ok(!NAMEY_CITY.test(n), n);
  }
});

test("a plain town gets no display town at all", () => {
  assert.deepEqual(displayTown(P({ city: "Mauston", zip: "53948" }), { places: {} }, T),
                   { town: null, townVia: null, townWhy: null });
});

test("the geocode's own ZIP note wins: Melrose Farm Service -> Melrose", () => {
  const geo = { places: { "x-y": { via: "zip-code", resolvedFrom: "54642 (Melrose)" } } };
  const got = displayTown(P({ city: "Melrose Farm Service" }), geo, T);
  assert.deepEqual(got, { town: "Melrose", townVia: "geocode-zip", townWhy: null });
});

test("the place's own ZIP, when the pin agrees: Walsh Grain -> Mauston", () => {
  const geo = { places: { "x-y": { via: "source-file", precision: "street" } } };
  const got = displayTown(P({ city: "Walsh Grain", zip: "53948", lat: 43.79, lon: -90.10 }), geo, T);
  assert.equal(got.town, "Mauston");
  assert.equal(got.townVia, "zip");
});

test("a head-office ZIP on a branch board is refused (Farmward Clements on Wabasso's ZIP)", () => {
  const geo = { places: { "x-y": { via: "source-file" } } };
  const got = displayTown(P({ city: "Farmward Cooperative - Clements", state: "MN", zip: "56293",
                              lat: 44.38, lon: -95.06 }), geo, T);
  assert.equal(got.town, null);
  assert.match(got.townWhy, /56293 \(Wabasso\).*56224 \(Clements\)/);
});

test("another ZIP of the same town is agreement, not a conflict (Rapid City)", () => {
  const got = displayTown(P({ city: "Rapid City Elevator", state: "SD", zip: "57701",
                              lat: 44.05, lon: -103.151 }), { places: {} }, T);
  assert.equal(got.town, "Rapid City");
});

test("a ZIP in another state is not used", () => {
  const got = displayTown(P({ city: "Bazine Elevator", state: "NE", zip: "67516" }), { places: {} }, T);
  assert.equal(got.town, null);
  assert.match(got.townWhy, /is in KS, the place is in NE/);
});

test("the geocode's town-name match is last, and takes the table's spelling", () => {
  const geo = { places: { "x-y": { via: "zip-centroid", resolvedFrom: "HERNDON" } } };
  const got = displayTown(P({ city: "HERNDON ELEVATOR", state: "KS" }), geo, T);
  assert.deepEqual(got, { town: "Herndon", townVia: "geocode-town", townWhy: null });
  const dash = { places: { "x-y": { via: "zip-centroid", resolvedFrom: "Gibson City -" } } };
  assert.equal(displayTown(P({ city: "Gibson City - Elevator", state: "IL" }), dash, T).town, "Gibson City");
});

test("nothing on file: null, with the reason, never a guess from the name", () => {
  const got = displayTown(P({ city: "Cameron Coop", state: "MO" }), { places: {} }, T);
  assert.equal(got.town, null, "\"Cameron\" is right there in the name and is still not used");
  assert.match(got.townWhy, /not in geocodes\/places\.json; no US ZIP on file/);
});

test("the shard header carries town beside city, and city is untouched", () => {
  const bids = [{ operator: "Walsh Grain", city: "Walsh Grain", state: "WI", lat: 1, lon: 2 }];
  const s = shardOf("Walsh Grain||Walsh Grain|WI", bids, { town: "Mauston", townVia: "zip" });
  assert.equal(s.city, "Walsh Grain");
  assert.equal(s.town, "Mauston");
  assert.equal(s.townVia, "zip");
  assert.equal(shardOf("p", bids).town, null);
});

test("the committed ZIP table names the four Sig asked about", () => {
  const zt = JSON.parse(readFileSync(new URL("../geocodes/zip-towns.json", import.meta.url), "utf8")).zips;
  assert.deepEqual(zt["53948"], ["Mauston", "WI"]);
  assert.deepEqual(zt["54642"], ["Melrose", "WI"]);
  assert.deepEqual(zt["54727"], ["Cadott", "WI"]);
  assert.deepEqual(zt["54006"], ["Cushing", "WI"]);
});

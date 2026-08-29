/* scripts/geocode-fill.mjs -- the join between the manifests and the file that
 * already knows where they are.
 *
 * On 2026-08-29 this repository had 401 manifests, 82 coordinates, and 251
 * geocoded places keyed BY SOURCE ID. Nobody had ever joined them. Every one of
 * those elevators published a price and none could be put on a distance-sorted
 * map -- and the one question that decides when Barchart can be switched off
 * ("is there a live bid within N miles of this farmer?") was answerable for a
 * fifth of the feed.
 *
 * What is worth testing here is not the arithmetic; it is the refusals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { plan, applyTo, noteFor } from "../scripts/geocode-fill.mjs";

const BASE = {
  id: "x-town", operator: "X Co-op", location: "Town", state: "WI",
  platform: "dtn-cs", url: "https://example.com/x", locationId: null,
  bands: { corn: [2, 12] }, cadence: "grain-day", provenance: "scraped",
  enabled: true, note: "a note.", lat: null, lon: null,
};
const P = { lat: 44.5, lon: -90.5, precision: "street", via: "rooftop", resolvedFrom: "Town" };

test("it fills a manifest that has no coordinate", () => {
  const { fill, skip, refuse } = plan([{ ...BASE }], { "x-town": P });
  assert.equal(fill.length, 1);
  assert.equal(skip.length + refuse.length, 0);
  assert.deepEqual([fill[0].lat, fill[0].lon, fill[0].precision], [44.5, -90.5, "street"]);
});

test("IT NEVER OVERWRITES A PIN SOMEBODY PUT THERE", () => {
  /* The whole reason a hand-checked pin exists is that a derived one was
     wrong. flashgrain-thorp's note records the previous value sitting 6.5 km
     from the yard because it was the town rather than the elevator. */
  const { fill, skip } = plan([{ ...BASE, lat: 44.9, lon: -90.7 }], { "x-town": P });
  assert.equal(fill.length, 0);
  assert.match(skip[0].why, /already has a pin/);
});

test("and it SAYS SO LOUDLY when the two disagree by more than half a degree", () => {
  /* Half a degree of latitude is about 35 miles. A manifest pin and a centroid
     that far apart means one of them is about a different elevator, and that is
     worth a line in the log rather than a silent skip. */
  const { skip } = plan([{ ...BASE, lat: 40.0, lon: -90.5 }], { "x-town": P });
  assert.match(skip[0].why, /HAS A PIN, and places.json disagrees/);
});

test("A PIN THAT WOULD NOT VALIDATE IS REFUSED, NOT WRITTEN", () => {
  /* validateSource rejects anything outside the continental US because a
     transposed pair reads as a plausible number and lands in the wrong
     hemisphere. The fill asks it BEFORE writing, so a bad row in places.json
     cannot reach a manifest. */
  const { fill, refuse } = plan([{ ...BASE }], { "x-town": { ...P, lat: -44.5 } });
  assert.equal(fill.length, 0);
  assert.equal(refuse.length, 1);
  assert.match(refuse[0].why, /continental US/);
});

test("a source with no entry is skipped and says why", () => {
  const { fill, skip } = plan([{ ...BASE }], {});
  assert.equal(fill.length, 0);
  assert.match(skip[0].why, /no entry in places.json/);
});

test("THE PRECISION IS CARRIED INTO THE MANIFEST AND INTO THE NOTE", () => {
  /* places.json is blunt: "'street' is where the elevator is; 'town' is the
     centroid of its town's ZIPs and can be miles off. The map must say which."
     Losing that on the way in would make every pin look equally good. */
  const s = applyTo({ ...BASE }, { lat: 44.5, lon: -90.5, precision: "town", p: { ...P, precision: "town" } });
  assert.equal(s.latPrecision, "town");
  assert.match(s.note, /CENTROID OF THE TOWN/);
  assert.match(s.note, /EVIDENCE, NOT A FACT/);
  assert.ok(s.note.startsWith("a note."), "the manifest's own note must survive");
  const street = noteFor("x", P);
  assert.match(street, /STREET-level/);
});

test("every manifest that claims a precision has a coordinate to go with it", () => {
  const dir = new URL("../sources/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    if (s.latPrecision === undefined) continue;
    assert.ok(typeof s.lat === "number" && typeof s.lon === "number",
      `${s.id}: latPrecision without a coordinate`);
  }
});

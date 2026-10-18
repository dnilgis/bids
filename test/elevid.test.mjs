/* Permanent elevator ids and county FIPS codes (2026-10-18).
 * The rule is docs/ELEVATOR-IDS.md; the code is lib/elevid.mjs and lib/county.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assignIds, hashId, mintText, readLedger, writeLedger, ID_RE } from "../lib/elevid.mjs";
import { loadCounties, fipsFor, countyKey } from "../lib/county.mjs";
import { idsFromDirectory, shardOf } from "../scripts/merge_bids.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const C = loadCounties(join(ROOT, "vendor/census-counties/counties.geo.json"));
const row = (id, o = {}) => ({ id, operator: "Farmers Coop", location: "Tonica", state: "IL",
                               lat: 41.23, lon: -89.09, board: false, claims: [], ...o });
const D1 = "2026-10-18", D2 = "2026-10-19";

test("an id is e + nine Crockford base32 characters, and the same first row mints the same id", () => {
  const a = assignIds([row("reg:IL|farmerscoop|tonica")], new Map(), D1);
  const b = assignIds([row("reg:IL|farmerscoop|tonica")], new Map(), D2);
  const id = a.ids.get("reg:IL|farmerscoop|tonica");
  assert.match(id, ID_RE);
  assert.equal(b.ids.get("reg:IL|farmerscoop|tonica"), id);
  assert.equal(id, hashId(mintText(row("reg:IL|farmerscoop|tonica"))));
});

test("a key in the ledger keeps its id even when its name, town and coordinate change", () => {
  const a = assignIds([row("landus-ralston")], new Map(), D1);
  const b = assignIds([row("landus-ralston", { operator: "Landus", location: "Ralston West", lat: 42.1, lon: -94.6 })], a.ledger, D2);
  assert.equal(b.ids.get("landus-ralston"), a.ids.get("landus-ralston"));
  assert.equal(b.counts.kept, 1);
  assert.equal(b.ledger.get("landus-ralston").since, D1, "since never moves");
  assert.equal(b.ledger.get("landus-ralston").loc, "Ralston West", "the line remembers the row as it is now");
});

test("a source that claims a licence row takes that row's id", () => {
  const a = assignIds([row("reg:IL|farmerscoop|tonica")], new Map(), D1);
  const b = assignIds([row("farmerscoop-tonica", { board: true, claims: ["reg:IL|farmerscoop|tonica"] })], a.ledger, D2);
  assert.equal(b.ids.get("farmerscoop-tonica"), a.ids.get("reg:IL|farmerscoop|tonica"));
  assert.equal(b.counts.claimed, 1);
  assert.match(b.ledger.get("farmerscoop-tonica").via, /^claim:reg:/);
});

test("a renamed source file keeps the id when exactly one gone key was the same operator in the same town", () => {
  const a = assignIds([row("fc-tonica"), row("fc-lostant", { location: "Lostant" })], new Map(), D1);
  const b = assignIds([row("farmerscooperative-tonica"), row("fc-lostant", { location: "Lostant" })], a.ledger, D2);
  assert.equal(b.ids.get("farmerscooperative-tonica"), a.ids.get("fc-tonica"));
  assert.equal(b.counts.renamed, 1);
});

test("two candidates for one rename: no carry, a fresh id, counted", () => {
  const a = assignIds([row("fc-tonica-a"), row("fc-tonica-b", { lat: 41.3 })], new Map(), D1);
  const b = assignIds([row("fc-tonica-new")], a.ledger, D2);
  const id = b.ids.get("fc-tonica-new");
  assert.notEqual(id, a.ids.get("fc-tonica-a"));
  assert.notEqual(id, a.ids.get("fc-tonica-b"));
  assert.equal(b.counts.renameAmbiguous, 1);
  /* and two new keys for one gone key: also no carry */
  const c = assignIds([row("x-tonica")], new Map(), D1);
  const d = assignIds([row("y-tonica"), row("z-tonica", { lat: 41.4 })], c.ledger, D2);
  assert.ok(![...d.ids.values()].includes(c.ids.get("x-tonica")));
});

test("an id is never reused: a gone key's id stays in the ledger and is never minted again", () => {
  const a = assignIds([row("old-yard", { operator: "Gone Grain" })], new Map(), D1);
  const gone = a.ids.get("old-yard");
  /* A new key whose mint text hashes to the gone id must step to the next. */
  const r = row("old-yard", { operator: "Gone Grain" });
  const L = new Map(a.ledger);
  L.delete("old-yard");
  L.set("somebody-else", { key: "somebody-else", id: gone, since: D1, via: "minted", st: "KS", op: "Other", loc: "Elsewhere" });
  const b = assignIds([r], L, D2);
  assert.notEqual(b.ids.get("old-yard"), gone);
  assert.equal(b.ids.get("old-yard"), hashId(mintText(r), 1), "collision rule: the same text plus #1");
  assert.equal(b.counts.collisions, 1);
});

test("one id, one live row: the row with a board keeps it, the other is split off with a fresh id", () => {
  const a = assignIds([row("reg:IL|farmerscoop|tonica")], new Map(), D1);
  const b = assignIds([row("farmerscoop-tonica", { board: true, claims: ["reg:IL|farmerscoop|tonica"] })], a.ledger, D2);
  /* The licence row comes back beside the board that inherited its id. */
  const c = assignIds([row("farmerscoop-tonica", { board: true }), row("reg:IL|farmerscoop|tonica")], b.ledger, "2026-10-20");
  assert.equal(c.ids.get("farmerscoop-tonica"), a.ids.get("reg:IL|farmerscoop|tonica"));
  assert.notEqual(c.ids.get("reg:IL|farmerscoop|tonica"), c.ids.get("farmerscoop-tonica"));
  assert.equal(c.counts.split, 1);
});

test("the ledger reads a union-merged file: a key twice keeps the earlier line, junk lines are skipped", () => {
  const t = mkdtempSync(join(tmpdir(), "elevid-"));
  try {
    const p = join(t, "ids.jsonl");
    writeFileSync(p, [
      JSON.stringify({ key: "k", id: "e000000002", since: D2, via: "minted" }),
      "<<<<<<< not json",
      JSON.stringify({ key: "k", id: "e000000001", since: D1, via: "minted" }),
      JSON.stringify({ key: "bad", id: "NOTANID", since: D1 }),
      ""].join("\n"));
    const L = readLedger(p);
    assert.equal(L.size, 1);
    assert.equal(L.get("k").id, "e000000001");
    writeLedger(p, L);
    assert.equal(readFileSync(p, "utf8").trim().split("\n").length, 1);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("the committed directory: every row has a well-formed elevId, no two rows share one, every ledger id is distinct per key", () => {
  const d = JSON.parse(readFileSync(join(ROOT, "data/directory.json"), "utf8"));
  const ids = d.elevators.map((e) => e.elevId);
  assert.ok(ids.every((i) => ID_RE.test(i)), "every row carries an elevId");
  assert.equal(new Set(ids).size, ids.length, "no two rows share an elevId");
  const L = readLedger(join(ROOT, "data/elevator-ids.jsonl"));
  for (const e of d.elevators) assert.equal(L.get(e.id)?.id, e.elevId, `${e.id} matches its ledger line`);
});

test("the committed directory: a US row with a coordinate has a FIPS code, and every code is a county in its state", () => {
  const d = JSON.parse(readFileSync(join(ROOT, "data/directory.json"), "utf8"));
  const stOf = new Map(C.feats.map((f) => [f.fips, f.st]));
  let us = 0, have = 0;
  for (const e of d.elevators) {
    if (e.fips) {
      assert.match(e.fips, /^\d{5}$/);
      assert.equal(stOf.get(e.fips), e.state, `${e.id}: ${e.fips} is a county of ${e.state}`);
      assert.ok(["licence-county", "point", "town-point", "county-point", "nearest-in-state"].includes(e.fipsVia));
      assert.equal(typeof e.fipsSure, "boolean");
    } else assert.ok(e.fipsWhy, `${e.id} says why it has no county`);
    if (e.placed && e.state && !["ON", "MB", "SK", "AB", "QC"].includes(e.state)) { us++; if (e.fips) have++; }
  }
  assert.ok(have / us > 0.99, `${have} of ${us} placed US rows have a county`);
});

test("county lookups, hand-checked: Ames is Story, Abbyville is Reno, the roll's 'La Salle' is LaSalle 17099", () => {
  assert.deepEqual(fipsFor(C, { state: "IA", lat: 42.0308, lon: -93.6319, precision: "street" }),
    { fips: "19169", fipsVia: "point", fipsSure: true });
  assert.equal(fipsFor(C, { state: "KS", lat: 37.97284, lon: -98.2017, precision: "street" }).fips, "20155");
  assert.deepEqual(fipsFor(C, { state: "IL", county: "La Salle" }), { fips: "17099", fipsVia: "licence-county", fipsSure: true });
  assert.equal(fipsFor(C, { state: "MO", county: "Ste. Genevieve" }).fips, "29186");
  assert.equal(countyKey("Saint Francis County"), countyKey("St. Francis"));
});

test("county lookups: Canada, a point in the wrong state, a river-edge town, and an ambiguous roll name", () => {
  assert.equal(fipsFor(C, { state: "ON", lat: 44, lon: -80 }).fips, null);
  const wrong = fipsFor(C, { state: "IA", lat: 40.0, lon: -93.6 });
  assert.equal(wrong.fips, null);
  assert.match(wrong.fipsWhy, /Grundy, MO, not in IA/);
  /* Dubuque on the 20m outline sits just outside Iowa, in the river. */
  assert.deepEqual(fipsFor(C, { state: "IA", lat: 42.5, lon: -90.64, precision: "town" }),
    { fips: "19061", fipsVia: "nearest-in-state", fipsSure: false });
  /* "St. Louis" in Missouri is a county AND a city: the name decides nothing, the point does. */
  const stl = fipsFor(C, { state: "MO", county: "St. Louis", lat: 38.63, lon: -90.2, precision: "street" });
  assert.notEqual(stl.fipsVia, "licence-county");
  assert.deepEqual(fipsFor(null, { state: "IA", lat: 42, lon: -93 }).fips, null, "no outline file: null, not a throw");
});

test("merge copies the directory's keys onto shards by source id, and nulls a source the directory has not seen", () => {
  const ids = idsFromDirectory({ elevators: [{ id: "a-b", elevId: "eabcdefghj", fips: "19169", fipsVia: "point", fipsSure: true }] });
  const s = shardOf("p", [{ operator: "X", city: "Ames", state: "IA" }], null, null, null, ids.get("a-b"));
  assert.equal(s.elevId, "eabcdefghj");
  assert.equal(s.fips, "19169");
  assert.equal(s.fipsVia, "point");
  assert.equal(ids.get("nobody"), undefined);
  assert.ok(!("elevId" in shardOf("p", [{ operator: "X" }])), "without ids the shard shape is unchanged");
});

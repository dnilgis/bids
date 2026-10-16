/* THE ELEVATORS AROUND BLOOMER, WI -- 2026-10-15.
 *
 * Sig named three elevators right around Bloomer: Rooney Grain, River Country
 * Co-op and CDR Farms. Two of them were not read. These tests pin the boards
 * as they were captured through the repository's own workflows on 2026-10-15
 * (bodies kept in fixtures/), so a later change to an adapter, to the delivery
 * reader or to a manifest that would stop them reading goes red here.
 *
 *   River Country Co-op  fixtures/bushel-rivercountry.json  (discover run 38664963571)
 *   Rooney Grain         fixtures/dtn-rooneygrain.json      (discover run 38664965915)
 *   Winchester Ag        fixtures/cashbidssingle-winchesterag-3439/3440.html (probe run 38665068783)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract as bushel } from "../lib/adapters/bushel.mjs";
import { extract as dtn } from "../lib/adapters/dtn-cs.mjs";
import { extractBids } from "../lib/parse.mjs";
import { delivery } from "../lib/delivery.mjs";
import { CASH_ROUNDING } from "../lib/board.mjs";
import { roundingEvidence, residualCents } from "../lib/rounding.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const src = (id) => JSON.parse(read(`sources/${id}.json`));

const RIVER_COUNTRY = ["athens", "bloomer", "boyd", "brokaw", "dorchester", "marathon", "owen", "sheldon"];

test("HAR is harvest: River Country's delivery labels read as a season, not as unreadable", () => {
  for (const [label, key] of [
    ["HAR 26", "newcrop-2026"],
    ["HAR 27", "newcrop-2027"],
    ["HAR 26- contract and feed usage only", "newcrop-2026"],
    ["HAR 26- contract and feed only", "newcrop-2026"],
  ]) {
    const r = delivery(label, "2026-10-15T01:20:08Z");
    assert.equal(r.key, key, label);
    assert.equal(r.via, "season", `"${label}" must say how it was read`);
    assert.equal(r.label, label, "the board's own words survive verbatim");
  }
  /* A whole word only: nothing that merely contains the letters. */
  assert.equal(delivery("Charlotte 26", "2026-10-15").key, null);
});

test("River Country's Bushel board: 30 rows, 8 locations, one manifest per location", () => {
  const rows = bushel(read("fixtures/bushel-rivercountry.json"),
    "https://api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList");
  assert.equal(rows.length, 30);
  assert.equal((rows.unreconciled ?? []).length, 0);
  const byId = new Map(rows.map((r) => [r.locationId, r.location]));
  assert.equal(byId.size, 8);
  for (const town of RIVER_COUNTRY) {
    const s = src(`rivercountrycoop-${town}`);
    assert.equal(byId.get(s.locationId), s.location,
      `${s.id}: locationId ${s.locationId} must be the payload's "${s.location}"`);
    assert.equal(s.state, "WI");
    assert.equal(s.browserPage, "https://portal.bushelpowered.com/rivercountry/cash-bids",
      "their own grain page never calls the board; the portal does");
    assert.equal(s.cashRounding, "floor-cent");
    /* Every row at this location sits inside the declared rule. */
    const rule = CASH_ROUNDING[s.cashRounding];
    for (const r of rows.filter((x) => x.locationId === s.locationId)) {
      assert.ok(rule(residualCents(r)), `${s.id} ${r.commodity} ${r.delivery}: residual ${residualCents(r)}c`);
      assert.ok(delivery(r.delivery, "2026-10-15T01:20:08Z").key, `${s.id}: "${r.delivery}" must resolve to a period`);
    }
  }
  const ev = roundingEvidence(rows);
  assert.equal(ev.confident, "floor-cent", "the whole board settles the mode");
});

test("Rooney Grain: three corn rows, round-cent, placed at its own Chippewa Falls yard", () => {
  const rows = dtn(read("fixtures/dtn-rooneygrain.json"),
    "https://api.dtn.com/markets/sites/e0411701/cash-bids?units=us");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.delivery), ["October", "November", "December"]);
  const s = src("rooneygrain-rooneygrain");
  assert.equal(s.enabled, true);
  assert.equal(s.location, "Chippewa Falls");
  assert.ok(rows.every((r) => r.locationId === s.locationId));
  assert.equal(roundingEvidence(rows).confident, "round-cent");
  const rule = CASH_ROUNDING[s.cashRounding];
  for (const r of rows) assert.ok(rule(residualCents(r)), `${r.delivery}: ${residualCents(r)}c`);
});

test("Winchester Ag Service: two Ohio boards on Wheaton Grain's site, read by the existing parser", () => {
  for (const [id, file, town, n] of [
    ["winchesteragservice-winchester", "fixtures/cashbidssingle-winchesterag-3439.html", "Winchester", 10],
    ["winchesteragservice-georgetown", "fixtures/cashbidssingle-winchesterag-3440.html", "Georgetown", 5],
  ]) {
    const s = src(id);
    assert.equal(s.state, "OH", "Barchart's Chippewa Falls address for this company is Wheaton Grain's, not theirs");
    const rows = extractBids(read(file), s.url).filter((r) => String(r.locationId) === s.locationId);
    assert.equal(rows.length, n, id);
    assert.ok(rows.every((r) => r.location === town), `${id}: board heading is ${town}`);
    const rule = CASH_ROUNDING[s.cashRounding];
    for (const r of rows) {
      const signed = Number((r.futuresPrice * 100 - (r.cash - r.basis) * 100).toFixed(4));
      assert.ok(rule(signed), `${id} ${r.commodity} ${r.delivery}: ${signed}c`);
    }
  }
});

test("Synergy Cooperative: five locations, floor-cent, settled by the second day's board", () => {
  const rows = bushel(read("fixtures/bushel-synergy.json"),
    "https://api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList");
  assert.equal(rows.length, 20);
  /* The 2026-10-15 snapshot alone names no mode: floor-cent and
     round-cent-either both explain it (residuals 0, 0.25 and 0.5c only). */
  assert.equal(roundingEvidence(rows).confident, null, "the first snapshot alone is ambiguous");
  /* 2026-10-16, bushel probe run 38961338857: 20 rows, 4 per location, and at
     every location the probe printed floor 4, round 2, round-either 3, exact 0
     over residuals 0.25, 0.5 and 0.75c -- which on four rows can only be
     0.25, 0.25, 0.5, 0.75. The 0.75c row rules out round-cent-either. The
     body was not dumped, so the residuals are pinned here, not the rows. */
  const day2 = Array.from({ length: 5 }, () => [0.25, 0.25, 0.5, 0.75]).flat()
    .map((s) => ({ cash: 4, basis: -0.5, futuresPrice: 450 + s }));
  assert.equal(roundingEvidence(day2).confident, "floor-cent", "the second day alone settles it");
  const both = roundingEvidence([...rows, ...day2]);
  assert.equal(both.confident, "floor-cent");
  assert.equal(both.margin, 5);
  const byId = new Map(rows.map((r) => [r.locationId, r.location]));
  for (const town of ["almena", "cameron", "elkmound", "ricelake", "ridgeland"]) {
    const s = src(`synergycoop-${town}`);
    assert.equal(byId.get(s.locationId), `${s.location} Grain`, s.id);
    assert.equal(s.enabled, true, s.id);
    assert.equal(s.cashRounding, "floor-cent", s.id);
    assert.equal(s._pending, undefined, `${s.id}: the hold is lifted`);
    const rule = CASH_ROUNDING[s.cashRounding];
    for (const r of rows.filter((x) => x.locationId === s.locationId)) {
      assert.ok(rule(residualCents(r)), `${s.id} ${r.commodity} ${r.delivery}: residual ${residualCents(r)}c`);
      assert.ok(delivery(r.delivery, "2026-10-15T01:39:18Z").key, `"${r.delivery}" resolves`);
    }
  }
});

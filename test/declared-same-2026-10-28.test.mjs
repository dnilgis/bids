// A Barchart row a board names in sameAsKnown is listed in that board's mergedFrom when the row had a ledger id
// of its own that the board did not take, so the id follows the yard downstream instead of going stale.
// Real case (Oct 28, bids#17): centralcommodities-stjoseph took its licence row's id (e3vqrhm1zz) by claim;
// the Barchart row known:2978 it names had been e2xhmjwrwm since Oct 18 and went stale in agsist's ids test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = JSON.parse(readFileSync(join(ROOT, "data", "directory.json"), "utf8"));
const byId = new Map(dir.elevators.map((e) => [e.id, e]));
const ledger = new Map(readFileSync(join(ROOT, "data", "elevator-ids.jsonl"), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l)).map((r) => [r.key, r.id]));
const live = new Set(dir.elevators.map((e) => e.elevId).filter(Boolean));

test("the real case: St. Joseph lists Barchart row 2978 with its own id", () => {
  const b = byId.get("centralcommodities-stjoseph");
  assert.equal(b.elevId, "e3vqrhm1zz");
  const m = (b.mergedFrom || []).find((x) => x.id === "known:2978");
  assert.ok(m, "known:2978 is not in mergedFrom");
  assert.equal(m.rule, "declared");
  assert.equal(m.elevId, "e2xhmjwrwm");
  assert.ok(!byId.has("known:2978"), "the declared row is still a pin");
});

test("every declared entry carries an id the board did not take, and that id is on no live row", () => {
  let n = 0;
  for (const e of dir.elevators) for (const m of e.mergedFrom || []) {
    if (m.rule !== "declared") continue;
    n++;
    assert.ok(m.elevId, `${e.id}: declared ${m.id} has no id`);
    assert.notEqual(m.elevId, e.elevId, `${e.id}: declared ${m.id} repeats the board's own id`);
    assert.equal(m.elevId, ledger.get(m.id), `${e.id}: ${m.id} id is not its ledger id`);
    assert.ok(!live.has(m.elevId), `${m.elevId} is declared folded but still a live row`);
  }
  assert.ok(n >= 1, `declared entries: ${n}`);
});

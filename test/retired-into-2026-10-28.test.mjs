// A retired board names the board that reads its yard (retiredInto), and the directory lists it in that board's
// mergedFrom with its own ledger id, so the id follows the yard downstream instead of going stale.
// Real case (Oct 28): farcoop-mounthope (e780z66t3h) and farcoop-patterson (evhnnwahq9) were minted Oct 27, retired
// in bids#14, and showed up in agsist as two stale ids because nothing said where their yards went.
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
const sources = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")));

test("every retiredInto names a live board and is listed in its mergedFrom with the retired key's own id", () => {
  const retired = sources.filter((s) => s.retiredInto);
  assert.ok(retired.length >= 4, `retired with retiredInto: ${retired.length}`);
  for (const s of retired) {
    assert.equal(s.enabled, false, `${s.id} names retiredInto but is not disabled`);
    const board = byId.get(s.retiredInto);
    assert.ok(board, `${s.id}: ${s.retiredInto} is not in the directory`);
    const m = (board.mergedFrom || []).find((x) => x.id === s.id);
    assert.ok(m, `${s.retiredInto} does not list ${s.id} in mergedFrom`);
    assert.equal(m.rule, "retired");
    assert.equal(m.elevId, ledger.get(s.id) ?? null, `${s.id}: mergedFrom elevId is not its ledger id`);
    assert.ok(!byId.has(s.id), `${s.id} is retired but still a row`);
  }
});

test("the real case: Mount Hope and Patterson's farcoop ids follow the CoMark boards", () => {
  const mh = byId.get("ceagrain-mthope").mergedFrom.find((m) => m.id === "farcoop-mounthope");
  const pa = byId.get("ceagrain-patterson").mergedFrom.find((m) => m.id === "farcoop-patterson");
  assert.equal(mh.elevId, "e780z66t3h");
  assert.equal(pa.elevId, "evhnnwahq9");
});

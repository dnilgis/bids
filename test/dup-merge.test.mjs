/* A DUPLICATE-SUSPECT ROW IS FOLDED INTO ITS BOARD ONLY ON EVIDENCE (2026-10-19).
 * The rule: lib/dup-merge.mjs and docs/ELEVATOR-IDS.md rule 6. The cases below
 * are the ones the rule exists to get right, and the last tests hold every
 * board's permanent id to the build before the fold existed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decideMerges, evidence, loadAliases, fillEmpty, NEAR_METERS } from "../lib/dup-merge.mjs";
import { assignIds, readLedger } from "../lib/elevid.mjs";
import { operatorKey } from "../lib/orgkey.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/* Two points about 100 m apart and about 3 km apart, in Tonica, IL. */
const P = { lat: 41.2150, lon: -89.0700 };
const P100 = { lat: 41.2159, lon: -89.0700 };
const P3K = { lat: 41.2420, lon: -89.0700 };
const board = (o = {}) => ({ id: "fc-tonica", operator: "Farmers Coop", location: "Tonica", state: "IL",
                             phone: "815-442-0000", precision: "street", ...P, ...o });
const sus = (o = {}) => ({ id: "known:9001", operator: "Farmers Cooperative Company", location: "Tonica", state: "IL",
                           phone: null, precision: "street", ...P100, ...o });

test("same phone in the same town: folded, and the reason says so", () => {
  const r = decideMerges([sus({ operator: "Somebody Else Entirely", phone: "(815) 442-0000", ...P3K })], [board()]);
  assert.equal(r.counts.merged, 1);
  const m = r.merges.get("known:9001");
  assert.equal(m.board, "fc-tonica");
  assert.equal(m.rule, "phone");
  assert.match(m.reason, /^dup-merge: phone 8154420000/);
});

test("same phone but a board in another town, far away: not folded", () => {
  /* A co-op's head-office number printed against every branch. */
  const r = decideMerges([sus({ phone: "8154420000", location: "Lostant", lat: 41.14, lon: -89.06 })], [board()]);
  assert.equal(r.counts.merged, 0);
  assert.equal(r.counts.stillFlagged, 1);
});

test("within 400 m and the same operator after folding co-op and legal forms: folded", () => {
  const r = decideMerges([sus()], [board({ operator: "Farmers Co-op, Inc.", phone: null })]);
  assert.equal(operatorKey("Farmers Co-op, Inc."), operatorKey("Farmers Cooperative Company"));
  assert.equal(r.counts.merged, 1);
  assert.equal(r.merges.get("known:9001").rule, "near+operator");
  assert.ok(r.merges.get("known:9001").meters < NEAR_METERS);
});

test("within 400 m and a different operator: not folded", () => {
  const r = decideMerges([sus({ operator: "Tonica Grain LLC" })], [board({ phone: null })]);
  assert.equal(r.counts.merged, 0);
  assert.equal(r.counts.stillFlagged, 1);
});

test("same town, same operator, 3 km apart: not folded (never the town alone)", () => {
  const r = decideMerges([sus({ ...P3K })], [board({ phone: null })]);
  assert.equal(r.counts.merged, 0);
  assert.equal(evidence(sus({ ...P3K }), board({ phone: null })), null);
});

test("two ten-digit phones that differ veto a name match", () => {
  const r = decideMerges([sus({ phone: "815-442-9999" })], [board({ operator: "Farmers Cooperative" })]);
  assert.equal(r.counts.merged, 0);
});

test("evidence for two boards: not folded into either, counted ambiguous", () => {
  const b2 = board({ id: "fc-tonica-south", ...P100 });
  const r = decideMerges([sus({ phone: "8154420000" })], [board(), b2]);
  assert.equal(r.counts.merged, 0);
  assert.equal(r.counts.ambiguous, 1);
  assert.deepEqual(r.ambiguous.get("known:9001").sort(), ["fc-tonica", "fc-tonica-south"]);
});

test("a same-phone board with no coordinate blocks a fold into another, and is not enough alone", () => {
  const unplaced = board({ id: "fc-adm-clinton", location: "ADM - Clinton Grain", lat: undefined, lon: undefined });
  const placed = board({ id: "fs-adm-clinton" });
  const both = decideMerges([sus({ phone: "8154420000" })], [placed, unplaced]);
  assert.equal(both.counts.merged, 0);
  assert.equal(both.counts.ambiguous, 1);
  const alone = decideMerges([sus({ phone: "8154420000" })], [unplaced]);
  assert.equal(alone.counts.merged, 0);
  assert.equal(alone.counts.phoneBoardUnplaced, 1);
});

test("an alias folds only in the states it is cited for", () => {
  const A = loadAliases([{ a: "ScoularView", b: "The Scoular Company", states: ["NE"] }]);
  const s = sus({ state: "NE", location: "Lamar", operator: "The Scoular Company" });
  const b = board({ state: "NE", location: "Lamar", operator: "ScoularView", phone: null });
  assert.equal(decideMerges([s], [b], A).merges.get("known:9001").rule, "near+alias");
  const sKS = { ...s, state: "KS" }, bKS = { ...b, state: "KS" };
  assert.equal(decideMerges([sKS], [bKS], A).counts.merged, 0);
});

test("a fold fills only the board's empty fields", () => {
  const b = { id: "x", address: "1 Main St", phone: null };
  fillEmpty(b, { address: "9 Elm St", phone: "815-442-0000", capacity: 500000, county: "LaSalle" });
  assert.equal(b.address, "1 Main St");
  assert.equal(b.phone, "815-442-0000");
  assert.equal(b.capacity, 500000);
  assert.equal(b.county, undefined, "county would move the board's fips");
});

test("ids: a folded key keeps its own id, the board keeps its, and no rename can carry the folded one", () => {
  const D1 = "2026-10-18", D2 = "2026-10-19";
  const row = (id, o = {}) => ({ id, operator: "Farmers Coop", location: "Tonica", state: "IL", lat: 41.2, lon: -89.1,
                                 board: false, claims: [], ...o });
  const a = assignIds([row("fc-tonica", { board: true }), row("known:9001")], new Map(), D1);
  const boardId = a.ids.get("fc-tonica"), foldedId = a.ids.get("known:9001");
  /* The suspect is folded: not a live row. A NEW key with the same operator
     and town appears; without the hold it would inherit the folded id as a
     rename. */
  const b = assignIds([row("fc-tonica", { board: true }), row("fc-tonica-2", { board: true })], a.ledger, D2,
                      { folded: new Map([["known:9001", { board: "fc-tonica", rule: "phone" }]]) });
  assert.equal(b.ids.get("fc-tonica"), boardId, "the board's id never changes");
  assert.equal(b.ledger.get("known:9001").id, foldedId, "the folded key keeps its own id");
  assert.notEqual(b.ids.get("fc-tonica-2"), foldedId, "a held id is not an orphan");
  assert.equal(b.counts.renamed, 0);
  assert.equal(b.counts.folded, 1);
  /* A folded key the ledger never saw takes the board's id. */
  const c = assignIds([row("fc-tonica", { board: true })], a.ledger, D2,
                      { folded: new Map([["reg:IL|farmerscoop|tonica", { board: "fc-tonica", rule: "near+operator" }]]) });
  assert.equal(c.ledger.get("reg:IL|farmerscoop|tonica").id, boardId);
  assert.equal(c.ledger.get("reg:IL|farmerscoop|tonica").via, "dup-merge:near+operator:fc-tonica");
});

test("every alias pair is cited to at least two manifests that declare a row under the other name", () => {
  const file = JSON.parse(readFileSync(join(ROOT, "data/operator-aliases.json"), "utf8"));
  const geo = JSON.parse(readFileSync(join(ROOT, "geocodes/places.json"), "utf8"));
  assert.ok(file.aliases.length > 0);
  for (const a of file.aliases) {
    assert.notEqual(operatorKey(a.a), operatorKey(a.b), `${a.a} = ${a.b} is not an alias, it is one key`);
    assert.ok(a.states?.length, `${a.a} = ${a.b}: no states`);
    const files = new Set();
    for (const c of a.cite) {
      const { file: path, field, key } = c;
      assert.ok(existsSync(join(ROOT, path)), `${path}: no such manifest`);
      const s = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
      const declared = field === "registryId" ? [].concat(s.registryId ?? []) : (s.sameAsKnown ?? []).map((k) => "known:" + k);
      assert.ok(declared.includes(key), `${path}: the manifest no longer declares ${key}`);
      const row = key.startsWith("reg:") ? geo.registry?.[key.slice(4)] : geo.known?.[key.slice(6)];
      if (!row) continue;   // the declaration stands; the row may have left the roll
      const pair = new Set([operatorKey(s.operator), operatorKey(row.operator)]);
      assert.deepEqual(pair, new Set([operatorKey(a.a), operatorKey(a.b)]), `${path} ${key} does not declare this pair`);
      assert.ok(a.states.includes(s.state), `${path}: ${s.state} is not among the pair's states`);
      files.add(path);
    }
    assert.ok(files.size >= 2, `${a.a} = ${a.b}: fewer than two manifests declare it`);
    for (const st of a.states)
      assert.ok(a.cite.some((c) => JSON.parse(readFileSync(join(ROOT, c.file), "utf8")).state === st),
                `${a.a} = ${a.b}: no declaration cited in ${st}`);
  }
});

/* ── THE BOARD'S PERMANENT ID NEVER MOVES ────────────────────────────────
   The snapshot is every board's and every flagged row's elevId on the build
   before the fold existed (data/directory.json at 0bb1da1). */
const SNAP = JSON.parse(readFileSync(join(ROOT, "test/fixtures/elevids-before-dup-merge-2026-10-19.json"), "utf8"));

test("no board's elevId changed: the ledger still gives every snapshot board its id", () => {
  const L = readLedger(join(ROOT, "data/elevator-ids.jsonl"));
  let n = 0;
  for (const [k, id] of Object.entries(SNAP.boards)) {
    assert.equal(L.get(k)?.id, id, `${k}: ledger id moved from ${id}`);
    n++;
  }
  assert.ok(n > 2000, `only ${n} boards in the snapshot`);
});

test("and a folded row keeps its own id in the ledger (split, rule 5, is the one way a non-board line moves)", () => {
  const L = readLedger(join(ROOT, "data/elevator-ids.jsonl"));
  for (const [k, id] of Object.entries(SNAP.suspects)) {
    const e = L.get(k);
    assert.ok(e, `${k}: ledger line gone (lines are never deleted)`);
    if (!String(e.via).startsWith("split")) assert.equal(e.id, id, `${k}: id moved from ${id}`);
  }
});

test("the directory as built: every board present in the snapshot carries the same elevId, and mergedFrom names the folded id", () => {
  const dir = JSON.parse(readFileSync(join(ROOT, "data/directory.json"), "utf8"));
  const L = readLedger(join(ROOT, "data/elevator-ids.jsonl"));
  const live = new Set(dir.elevators.map((e) => e.id));
  for (const e of dir.elevators) {
    if (e.id in SNAP.boards) assert.equal(e.elevId, SNAP.boards[e.id], `${e.id}: elevId moved`);
    for (const m of e.mergedFrom || []) {
      assert.ok(!live.has(m.id), `${m.id} is folded into ${e.id} and still drawn`);
      assert.equal(m.elevId, L.get(m.id)?.id, `${m.id}: mergedFrom elevId is not its ledger id`);
      assert.match(m.why, /^dup-merge: /);
    }
  }
  const dm = dir.counts.dupMerge;
  assert.ok(dm, "counts.dupMerge missing");
  assert.equal(dm.merged + dm.stillFlagged, dm.suspects);
  assert.equal(dm.merged, dm.byRule.phone + dm.byRule["near+operator"] + dm.byRule["near+alias"]);
  assert.equal(dir.counts.duplicateSuspects, dm.stillFlagged);
  assert.equal(dir.elevators.filter((e) => e.duplicateSuspect).length, dm.stillFlagged);
});

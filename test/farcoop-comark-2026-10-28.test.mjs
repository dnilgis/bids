/* FARMERS COOPERATIVE ELEVATOR COMPANY ON farcoop.com IS COMARK'S FOUR YARDS (2026-10-28).
 *
 * Oct 27 an unverified research list added four farcoop.com boards: Bentley,
 * Halstead, Mount Hope and Patterson, KS. CoMark Equity Alliance (the joint
 * venture Farmers Cooperative is part of) has been read in those four towns on
 * ceagrain.agricharts.com for months, and Barchart's Farmers Cooperative rows
 * there were already folded into the CoMark boards by phone. The new manifests
 * then took two of those folded ids by rename (e049c48vt9, ezgp80aa0j), so a
 * yard drew two pins and a retired id came back as a live row.
 *
 * Decided on evidence, the same evidence lib/dup-merge.mjs folds on: Barchart's
 * Farmers Cooperative row in each town carries the CoMark board's phone, the
 * Kansas roll licenses CoMark there, farcoop.com lists exactly those four
 * towns, and the two boards post the same basis and the same cash. The farcoop
 * files are retired (kept on disk, disabled), CoMark's boards stay, and
 * lib/elevid.mjs now keeps a folded id held by its board so no rename can hand
 * it out again (docs/ELEVATOR-IDS.md rules 6 and 7). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../lib/adapters/index.mjs";
import { filterLocation } from "../lib/parse.mjs";
import { assignIds, readLedger } from "../lib/elevid.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const json = (p) => JSON.parse(rd(p));
const digits = (p) => String(p || "").replace(/\D/g, "").slice(-10);

/* farcoop key -> [survivor, the Barchart row folded into the survivor] */
const TOWNS = {
  "farcoop-bentley": ["ceagrain-bentley", "known:3065"],
  "farcoop-halstead": ["ceagrain-halsteadwest", "known:Farmers Cooperative Elevator Company|Halstead|Halstead|KS"],
  "farcoop-mounthope": ["ceagrain-mthope", "known:Farmers Cooperative Elevator Company|Mount Hope|Mt. Hope|KS"],
  "farcoop-patterson": ["ceagrain-patterson", "known:Farmers Cooperative Elevator Company|Patterson|Burrton|KS"],
};
const crop = (c) => { c = String(c).toUpperCase();
  return c.startsWith("WHEAT") ? "wheat" : c.startsWith("CORN") ? "corn" : c.startsWith("MILO") ? "milo"
       : c.startsWith("SOY") || c.startsWith("BEAN") ? "soybeans" : c; };
/* What a board says per crop: the distinct (basis, cash) pairs it posts. */
const posted = (bids) => [...new Set(bids.map((b) => `${crop(b.commodity)} basis ${b.basisCents} cash ${b.cash}`))].sort();

const CAPTURE = rd("fixtures/cashbidssingle-farcoop-2026-10-27.html");
const COMARK = json("test/fixtures/comark-four-towns-2026-10-27.json").boards;

test("farcoop.com's board carries exactly the four CoMark towns", () => {
  const all = adapterFor("cashbidssingle")(CAPTURE, "https://www.farcoop.com/cash-bids");
  const ids = new Set(all.map((b) => String(b.locationId)));
  assert.deepEqual([...ids].sort(), Object.keys(TOWNS).map((k) => json(`sources/${k}.json`).locationId).sort());
});

for (const [fc, [cea]] of Object.entries(TOWNS)) {
  test(`${fc}: the same basis and the same cash as ${cea} on the Oct 27 settle, crop by crop`, () => {
    const m = json(`sources/${fc}.json`);
    const { kept } = filterLocation(adapterFor(m.platform)(CAPTURE, m.url), m.locationId);
    assert.ok(kept.length >= 6, `${fc}: ${kept.length} rows on the capture`);
    assert.deepEqual(posted(kept), posted(COMARK[cea].bids));
  });

  test(`${fc}: retired as ${cea}'s yard, on evidence still in the data`, () => {
    const m = json(`sources/${fc}.json`), s = json(`sources/${cea}.json`);
    assert.equal(m.enabled, false);
    assert.equal(m.inMerge, false);
    assert.match(m.retired, new RegExp(`same yard as sources/${cea}\\.json`));
    assert.doesNotMatch(m.retired, /—/);
    assert.notEqual(s.enabled, false, `${cea}, the survivor, is read`);
    /* The fold the retire leans on: Barchart's Farmers Cooperative row in
       this town carries the survivor's own phone. */
    const known = json("geocodes/places.json").known[TOWNS[fc][1].slice("known:".length)];
    assert.ok(known, `${TOWNS[fc][1]} is still in the Barchart list`);
    assert.equal(known.operator, "Farmers Cooperative Elevator Company");
    assert.equal(digits(known.phone), digits(s.phone), `${TOWNS[fc][1]} phone against ${cea}`);
  });
}

/* ── THE IDS, REPLAYED WITH THE REAL KEYS ─────────────────────────────── */
const BOARD = "ceagrain-halsteadwest", KNOWN = TOWNS["farcoop-halstead"][1], NEW = "farcoop-halstead";
const REAL = readLedger(join(ROOT, "data/elevator-ids.jsonl"));
const row = (id, o) => ({ id, state: "KS", lat: 38.0064, lon: -97.5118, claims: [], ...o });
const boardRow = row(BOARD, { operator: "CoMark Equity Alliance LLC", location: "HALSTEAD WEST", board: true });
const newRow = row(NEW, { operator: "Farmers Cooperative Elevator Company", location: "Halstead", lat: null, lon: null, board: true });
const fold = new Map([[KNOWN, { board: BOARD, rule: "phone", state: "KS",
                                operator: "Farmers Cooperative Elevator Company", location: "Halstead" }]]);
/* The ledger as it stood on Oct 26: the board and the Barchart row, no farcoop key, no hold yet. */
const oct26 = () => new Map([BOARD, KNOWN].map((k) => { const { heldBy, ...e } = REAL.get(k); return [k, e]; }));
const FOLDED_ID = "e049c48vt9";

test("the real ledger: the Barchart row's id is e049c48vt9 and the board's is its own", () => {
  assert.equal(REAL.get(KNOWN).id, FOLDED_ID);
  assert.equal(REAL.get(BOARD).id, "egz19x9jv6");
});

test("the cause, replayed: with no hold on the line, the folded id is handed to the new manifest as a rename", () => {
  /* Oct 27: the new board takes the Barchart row by name, so the row is
     neither live nor folded, and its id looks orphaned. */
  const b = assignIds([boardRow, newRow], oct26(), "2026-10-27");
  assert.equal(b.ids.get(NEW), FOLDED_ID, "what happened on Oct 27");
});

test("the fix: a fold writes its board on the line, and the next build will not hand the id out", () => {
  const a = assignIds([boardRow], oct26(), "2026-10-26", { folded: fold });
  assert.equal(a.ledger.get(KNOWN).heldBy, BOARD);
  assert.equal(a.ledger.get(KNOWN).id, FOLDED_ID, "the folded key keeps its own id");
  const b = assignIds([boardRow, newRow], a.ledger, "2026-10-27");
  assert.notEqual(b.ids.get(NEW), FOLDED_ID);
  assert.equal(b.ids.get(BOARD), "egz19x9jv6", "the board's id never moves");
  assert.equal(b.counts.renamed, 0);
  assert.equal(b.counts.renameHeld, 1);
  assert.deepEqual(b.counts.heldRenames, [{ key: NEW, wouldTake: FOLDED_ID, from: KNOWN, heldBy: BOARD }]);
  assert.equal(b.ledger.get(KNOWN).heldBy, BOARD, "the hold outlasts the fold");
  /* and a hold on a board that is gone is no hold: the id may be renamed again */
  const c = assignIds([newRow], a.ledger, "2026-10-27");
  assert.equal(c.ids.get(NEW), FOLDED_ID);
});

test("a held id is never a second live row: the Oct 27 key that took it is split if it is ever read again", () => {
  /* The committed ledger: farcoop-halstead has held e049c48vt9 since Oct 27. */
  const L = oct26();
  L.set(NEW, { key: NEW, id: FOLDED_ID, since: "2026-10-27", via: "rename", st: "KS",
               op: "Farmers Cooperative Elevator Company", loc: "Halstead" });
  const c = assignIds([boardRow, newRow], L, "2026-10-28", { folded: fold });
  assert.notEqual(c.ids.get(NEW), FOLDED_ID);
  assert.equal(c.ledger.get(NEW).via, "split");
  assert.equal(c.counts.splitHeld, 1);
  assert.equal(c.ledger.get(KNOWN).id, FOLDED_ID);
  assert.equal(c.ids.get(BOARD), "egz19x9jv6");
  /* Retired (not a row): nothing to split, and the id stays the board's fold. */
  const d = assignIds([boardRow], L, "2026-10-28", { folded: fold });
  assert.equal(d.counts.split, 0);
  assert.ok(![...d.ids.values()].includes(FOLDED_ID));
});

test("the committed directory: no drawn row holds an id that a fold gave to a board", () => {
  const dir = json("data/directory.json");
  const folded = new Map();               // folded elevId -> { key, board }
  for (const e of dir.elevators) for (const m of e.mergedFrom || []) if (m.elevId) folded.set(m.elevId, { key: m.id, board: e.id });
  assert.ok(folded.size > 100, `only ${folded.size} folded ids`);
  for (const e of dir.elevators) {
    const f = folded.get(e.elevId);
    if (f) assert.equal(e.id, f.board, `${e.id} draws ${e.elevId}, the id of ${f.key} folded into ${f.board}`);
  }
});

test("the committed directory: the four CoMark boards carry the Farmers Cooperative rows, and farcoop draws nothing", () => {
  const dir = json("data/directory.json");
  const L = readLedger(join(ROOT, "data/elevator-ids.jsonl"));
  const byId = new Map(dir.elevators.map((e) => [e.id, e]));
  for (const [fc, [cea, known]] of Object.entries(TOWNS)) {
    assert.ok(!byId.has(fc), `${fc} is still drawn`);
    const m = (byId.get(cea)?.mergedFrom || []).find((x) => x.id === known);
    assert.ok(m, `${known} is not folded into ${cea}`);
    assert.equal(m.rule, "phone");
    assert.equal(m.elevId, L.get(known).id);
  }
  assert.equal(byId.get("ceagrain-halsteadwest").mergedFrom.find((x) => x.id === KNOWN).elevId, FOLDED_ID);
  assert.equal(byId.get("ceagrain-bentley").mergedFrom.find((x) => x.id === "known:3065").elevId, "ezgp80aa0j");
});

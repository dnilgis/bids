/* A PERMANENT ID FOR EVERY ELEVATOR LOCATION.
 *
 * 2026-10-18. The directory's `id` is a working key, not an identity: a read
 * board is keyed on its source file name ("landus-ralston"), a Barchart row on
 * Barchart's number ("known:1041"), a licence row on state + name + town
 * ("reg:IL|northernpartnerscooperative|tonica"). Every one of those changes
 * when the thing it was made from changes: a source file is renamed, a grey
 * licence pin becomes a board we read, a roll respells the company. Anything
 * joined to the old key (weather, land, programs, a farmer's saved elevator)
 * then points at nothing.
 *
 * `elevId` is the id that does not move. The rule, in full (docs/ELEVATOR-IDS.md):
 *
 *   1. ONCE GIVEN, NEVER CHANGED, NEVER REUSED. data/elevator-ids.jsonl holds
 *      every key that ever had an id, one line each. A key in that file keeps
 *      its id for good. An id in that file is never minted again, even after
 *      every key that held it is gone.
 *   2. A NEW KEY THAT IS AN OLD YARD TAKES THE OLD YARD'S ID, and only on
 *      evidence the directory already trusts:
 *        claim   a source names the licence row (registryId) or Barchart row
 *                (sameAsKnown) it is: it takes that row's id.
 *        rename  the key is new, and exactly one id lost every key this build
 *                whose last row was the same operator in the same town and
 *                state (orgKey, lib/orgkey.mjs, the directory's own merge key),
 *                and exactly one new key matches it. Two candidates either
 *                way: no carry, a fresh id, and the count says so.
 *   3. OTHERWISE MINTED: "e" + 9 characters (Crockford base32) of SHA-256
 *      over the key it was first given, its state, operator key, town key and
 *      coordinate rounded to two decimals (about a kilometre). The hash makes
 *      a rebuilt ledger give the same id for the same first row; the ledger is
 *      what makes it permanent.
 *   4. COLLISION: if the minted id is already in the ledger (held now or ever),
 *      the hash is taken again over the same text plus "#1", "#2", ... until it
 *      is not.
 *   5. ONE ID, ONE ROW PER BUILD. If two live rows would hold one id (an old
 *      key came back beside the key that inherited its id), the row with a
 *      board keeps it, then the key that held it first; the other is given a
 *      fresh id and its ledger line is rewritten ("split"), counted.
 *
 *   6. FOLDED. A duplicate-suspect row folded into a board on evidence
 *      (lib/dup-merge.mjs) keeps its own key's id; the board holds it, so it
 *      is not an orphan for rule 2's rename. A folded key not yet in the
 *      ledger takes the board's id ("dup-merge:<rule>:<board key>").
 *      The ledger line says which board holds it (`heldBy`), and the hold
 *      outlasts the fold: a later build in which the folded row is gone for
 *      some other reason still sees the id as the board's while that board is
 *      live. 2026-10-28, the real case: Barchart's "Farmers Cooperative
 *      Elevator Company, Halstead" was folded by phone into
 *      ceagrain-halsteadwest; on Oct 27 a new manifest farcoop-halstead (the
 *      same yard on a second board) took that row by name, the row stopped
 *      being a suspect, its id looked orphaned, and rule 2 handed the board's
 *      folded id e049c48vt9 to the new manifest as a rename. Now a held id is
 *      never an orphan; the new key is minted, and `heldRenames` names it with
 *      the board that holds the id, so a person checks for a duplicate board.
 *   7. A HELD ID IS NEVER A SECOND LIVE ROW. A live key whose ledger id is held
 *      by a fold into a different live board is split (rule 5): the board
 *      keeps the id, the other key gets a fresh one.
 *
 * The ledger is JSON Lines so .gitattributes can merge it with `union`: two
 * runs that each added a key keep both lines. Reading it tolerates a key twice;
 * the earlier `since`, then the smaller id, wins, and the next write drops the
 * other.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { orgKey, operatorKey, placeKey } from "./orgkey.mjs";

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";   // Crockford, no i l o u

export function hashId(text, n = 0) {
  const h = createHash("sha256").update(n ? `${text}#${n}` : text).digest();
  let bits = 0, acc = 0, out = "";
  for (const byte of h) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < 9) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= 9) break;
  }
  return "e" + out;
}

export const ID_RE = /^e[0-9a-hjkmnp-tv-z]{9}$/;

/** The text an id is minted from. */
export function mintText(row) {
  const r2 = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v).toFixed(2) : "");
  return [String(row.id || ""), String(row.state || "").toUpperCase(), operatorKey(row.operator) || "",
          placeKey(row.state, row.location).split("|")[1] || "", r2(row.lat), r2(row.lon)].join("|");
}

export function readLedger(path) {
  const byKey = new Map();
  if (!path || !existsSync(path)) return byKey;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (!e || typeof e.key !== "string" || !ID_RE.test(e.id || "")) continue;
    const have = byKey.get(e.key);
    if (!have || (e.since || "") < (have.since || "") || ((e.since || "") === (have.since || "") && e.id < have.id))
      byKey.set(e.key, e);
  }
  return byKey;
}

export function writeLedger(path, byKey) {
  const lines = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((e) => JSON.stringify({ key: e.key, id: e.id, since: e.since, via: e.via,
                                 st: e.st ?? null, op: e.op ?? null, loc: e.loc ?? null,
                                 ...(e.heldBy ? { heldBy: e.heldBy } : {}) }));
  writeFileSync(path, lines.join("\n") + "\n");
}

/**
 * Give every row an elevId.
 * rows: [{ id, operator, location, state, lat, lon, board: bool, claims: [key] }]
 * Returns { ids: Map(rowKey -> elevId), ledger: Map, counts }.
 */
/* folded: Map(key -> board key, or { board, state, operator, location }). */
export function assignIds(rows, ledger, today, { folded = new Map() } = {}) {
  const L = new Map(ledger);
  const everIds = new Set([...L.values()].map((e) => e.id));
  const live = new Set(rows.map((r) => r.id));
  /* 6. FOLDED (lib/dup-merge.mjs): a key whose row was folded into a live
     board this build is not live, but its id is not lost either: the board
     holds it. So it is never an orphan a rename could carry. A folded key the
     ledger has never seen takes the board's id, like a claim. */
  const boardOf = (v) => (typeof v === "string" ? v : v?.board);
  const heldByFold = new Set([...folded].filter(([, v]) => live.has(boardOf(v))).map(([k]) => k));
  /* 6, the hold that outlasts the fold: a key folded on an earlier build
     (its line names the board in heldBy), not live now and not folded this
     build, whose board is still live. Its id is still the board's. */
  const heldEarlier = new Set([...L.values()]
    .filter((e) => e.heldBy && !live.has(e.key) && !heldByFold.has(e.key) && live.has(e.heldBy)).map((e) => e.key));
  const holderOf = new Map();             // held id -> { key, board }
  for (const k of heldByFold) if (L.has(k)) holderOf.set(L.get(k).id, { key: k, board: boardOf(folded.get(k)) });
  for (const k of heldEarlier) holderOf.set(L.get(k).id, { key: k, board: L.get(k).heldBy });
  const counts = { kept: 0, minted: 0, claimed: 0, renamed: 0, renameAmbiguous: 0, split: 0, collisions: 0,
                   heldEarlier: heldEarlier.size, renameHeld: 0, splitHeld: 0, heldRenames: [] };
  const line = (r, id, via) => ({ key: r.id, id, since: today, via,
                                  st: r.state || null, op: r.operator || null, loc: r.location || null });
  const mint = (r) => {
    const text = mintText(r);
    let n = 0, id = hashId(text);
    while (everIds.has(id)) { counts.collisions++; id = hashId(text, ++n); }
    everIds.add(id);
    return id;
  };

  /* Ids no live key holds this build, and the org key of their last row. */
  const heldNow = new Set(rows.filter((r) => L.has(r.id)).map((r) => L.get(r.id).id));
  const orphanByOrg = new Map();
  const heldOrphanByOrg = new Map();      // org key -> a held key that WOULD have been an orphan
  for (const e of L.values()) {
    if (live.has(e.key) || heldNow.has(e.id) || heldByFold.has(e.key)) continue;
    const k = orgKey(e.st, e.loc, e.op);
    if (!k) continue;
    if (heldEarlier.has(e.key)) { heldOrphanByOrg.set(k, e.key); continue; }
    if (!orphanByOrg.has(k)) orphanByOrg.set(k, new Set());
    orphanByOrg.get(k).add(e.id);
  }
  const fresh = rows.filter((r) => !L.has(r.id));
  const freshByOrg = new Map();
  for (const r of fresh) {
    const k = orgKey(r.state, r.location, r.operator);
    if (k) freshByOrg.set(k, (freshByOrg.get(k) ?? 0) + 1);
  }

  for (const r of fresh) {
    /* claim: a key this source says it is */
    const claimed = (r.claims || []).map((k) => L.get(k)).filter(Boolean);
    const cids = [...new Set(claimed.map((e) => e.id))];
    if (cids.length === 1 && !rows.some((o) => o !== r && L.get(o.id)?.id === cids[0])) {
      L.set(r.id, line(r, cids[0], "claim:" + claimed[0].key)); counts.claimed++; continue;
    }
    const k = orgKey(r.state, r.location, r.operator);
    const orph = k ? orphanByOrg.get(k) : null;
    if (orph && orph.size === 1 && freshByOrg.get(k) === 1) {
      const id = [...orph][0];
      L.set(r.id, line(r, id, "rename")); counts.renamed++;
      orphanByOrg.delete(k);
      continue;
    }
    if (orph && orph.size) counts.renameAmbiguous++;
    const held = k ? heldOrphanByOrg.get(k) : null;
    if (held) {
      /* The id this key would have taken is a board's folded id. Not carried:
         a fresh id, and the board is named, because a new key that is the
         same operator in the same town as a row folded into a board is very
         often that board's yard posted a second time. */
      counts.renameHeld++;
      counts.heldRenames.push({ key: r.id, wouldTake: L.get(held).id, from: held, heldBy: L.get(held).heldBy });
    }
    L.set(r.id, line(r, mint(r), "minted")); counts.minted++;
  }
  counts.kept = rows.length - fresh.length;
  /* A kept key's line remembers its row as it is now, so a later rename is
     matched against the latest name and town. The id, since and via never change. */
  for (const r of rows) {
    const { heldBy, ...e } = L.get(r.id);   // a live key is its own row: nothing holds it
    L.set(r.id, { ...e, st: r.state || null, op: r.operator || null, loc: r.location || null });
  }

  /* 7. A held id is never a second live row: the board holding it keeps it. */
  for (const r of rows) {
    const h = holderOf.get(L.get(r.id).id);
    if (!h || r.id === h.key || r.id === h.board) continue;
    L.set(r.id, line(r, mint(r), "split")); counts.split++; counts.splitHeld++;
  }

  /* One id, one live row. */
  const holders = new Map();
  for (const r of rows) {
    const id = L.get(r.id).id;
    if (!holders.has(id)) holders.set(id, []);
    holders.get(id).push(r);
  }
  for (const [, hs] of holders) {
    if (hs.length < 2) continue;
    hs.sort((a, b) => (b.board ? 1 : 0) - (a.board ? 1 : 0)
      || String(L.get(a.id).since).localeCompare(String(L.get(b.id).since)) || a.id.localeCompare(b.id));
    for (const r of hs.slice(1)) { L.set(r.id, line(r, mint(r), "split")); counts.split++; }
  }

  for (const k of heldByFold) {
    const v = folded.get(k), b = boardOf(v);
    if (L.has(k)) { L.set(k, { ...L.get(k), heldBy: b }); continue; }
    L.set(k, { key: k, id: L.get(b).id, since: today, via: "dup-merge:" + (v?.rule ? v.rule + ":" : "") + b,
               st: v?.state || null, op: v?.operator || null, loc: v?.location || null, heldBy: b });
    counts.foldedNew = (counts.foldedNew ?? 0) + 1;
  }
  counts.folded = heldByFold.size;

  const ids = new Map(rows.map((r) => [r.id, L.get(r.id).id]));
  return { ids, ledger: L, counts };
}

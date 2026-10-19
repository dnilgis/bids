/* A "MAY BE THE SAME YARD" PIN IS FOLDED INTO THE BOARD ONLY ON EVIDENCE.
 *
 * 2026-10-19. scripts/build_directory.mjs flags a Barchart row or a licence row
 * `duplicateSuspect` when we already read an elevator in its town. 1,429 rows
 * carried that flag on the 2026-10-19 build: each one a grey pin beside a board
 * that is very often the same yard, and each one a second count in the
 * "known, not read" figure. The flag is right to exist, because a town can
 * hold three elevators. This file decides which of those pins can be folded
 * into the board, and it decides on evidence, never on the town alone.
 *
 * EVIDENCE, per suspect row and per board on the map:
 *
 *   phone           the same ten digits, AND the board is in the same town or
 *                   within 400 m. The locality half is not decoration: 250
 *                   suspects on that build share a phone with a board in some
 *                   OTHER town (a co-op's head-office number printed against
 *                   every branch), and a phone alone would fold the branch
 *                   into whichever board answered first.
 *   near+operator   both rows carry a coordinate within 400 m (a quarter mile)
 *                   AND the operator is the same: operatorKey (lib/orgkey.mjs)
 *                   is equal, which already folds CO-OP / COOP / COOPERATIVE and
 *                   trailing INC / LLC / CO / COMPANY.
 *   near+alias      as above, with the two operator names a pair in
 *                   data/operator-aliases.json for that state. Each pair there
 *                   is cited to a declaration a person already made in a source
 *                   manifest (registryId / sameAsKnown naming a row under the
 *                   other name).
 *
 *   A phone veto, the repository's oldest rule: two ten-digit phones that
 *   differ are two businesses, and no name rule overrules them.
 *
 *   A board with the same phone and NO coordinate (and no comparable town) is
 *   a candidate but never enough on its own: it counts towards "two
 *   candidates", and alone it leaves the flag (counted phoneBoardUnplaced).
 *
 * ONE CANDIDATE OR NONE. A suspect with evidence for two boards is not folded
 * into either; it keeps its flag and is counted `ambiguous`.
 *
 * WHAT "WITHIN 400 m" MEANS ON THIS DATA, said plainly: most rows are placed at
 * a ZIP or town centroid (precision "town"), and two town-precision rows in one
 * town sit at the same point. For those the distance test is the town test, so
 * near+operator there is the same evidence the directory's orgKey merge already
 * trusts (same business, same town), and near+alias is that with a cited
 * alias. The reason string carries both precisions so a consumer can tell a
 * street-level match from a centroid one.
 *
 * Pure: no files, no clock. build_directory.mjs calls it; test/dup-merge.test.mjs
 * holds the cases. */
import { readFileSync, existsSync } from "node:fs";
import { operatorKey } from "./orgkey.mjs";

export const NEAR_METERS = 400;

export const digits10 = (p) => { const d = String(p || "").replace(/\D/g, "").slice(-10); return d.length === 10 ? d : ""; };
/* The directory's own town key (build_directory.mjs townKey): letters only. */
export const townKey = (st, town) => (st || "").toUpperCase() + "|" + String(town || "").toLowerCase().replace(/[^a-z]/g, "");

export function meters(a, b) {
  if (![a?.lat, a?.lon, b?.lat, b?.lon].every((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))) return null;
  const R = 6371008.8, t = (x) => (Number(x) * Math.PI) / 180;
  const dl = t(b.lat - a.lat), dn = t(b.lon - a.lon);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** data/operator-aliases.json -> Map("ST|KEYA|KEYB" -> entry), both orders. */
export function loadAliases(pathOrList) {
  let list = pathOrList;
  if (typeof pathOrList === "string") {
    if (!existsSync(pathOrList)) return new Map();
    list = JSON.parse(readFileSync(pathOrList, "utf8")).aliases || [];
  }
  const m = new Map();
  for (const a of list || []) {
    const ka = operatorKey(a.a), kb = operatorKey(a.b);
    for (const st of [].concat(a.states || [])) {
      const S = String(st).toUpperCase();
      m.set(`${S}|${ka}|${kb}`, a);
      m.set(`${S}|${kb}|${ka}`, a);
    }
  }
  return m;
}

/** "operator" | "alias" | null */
export function operatorMatch(state, a, b, aliases) {
  const ka = operatorKey(a), kb = operatorKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return "operator";
  if (aliases?.has(`${String(state || "").toUpperCase()}|${ka}|${kb}`)) return "alias";
  return null;
}

/** The evidence that suspect s is board b, or null. */
export function evidence(s, b, aliases) {
  if (String(s.state || "").toUpperCase() !== String(b.state || "").toUpperCase()) return null;
  const sameTown = townKey(s.state, s.location) === townKey(b.state, b.location) && townKey(s.state, s.location).length > 3;
  const m = meters(s, b);
  const near = m !== null && m <= NEAR_METERS;
  const ps = digits10(s.phone), pb = digits10(b.phone);
  const where = near ? `${Math.round(m)} m, ${s.precision || "?"}/${b.precision || "?"}` : "same town, no coordinate";
  if (ps && ps === pb && (sameTown || near))
    return { rule: "phone", meters: m, reason: `dup-merge: phone ${ps} (${where})` };
  /* Same phone, and the board has no coordinate and names no town we can
     compare ("ADM - Clinton Grain"). Not enough to fold on, but it is a
     candidate: it stops the suspect being folded into some OTHER board that
     happens to share the number and sit in the right town. */
  if (ps && ps === pb && meters(b, b) === null)
    return { rule: "phone", weak: true, meters: null, reason: `phone ${ps}, board has no coordinate` };
  if (!near) return null;
  if (ps && pb && ps !== pb) return null;                      // the phone veto
  const op = operatorMatch(s.state, s.operator, b.operator, aliases);
  if (op === "operator")
    return { rule: "near+operator", meters: m, reason: `dup-merge: same operator "${s.operator}" = "${b.operator}" (${where})` };
  if (op === "alias")
    return { rule: "near+alias", meters: m, reason: `dup-merge: alias "${s.operator}" = "${b.operator}" in ${String(s.state).toUpperCase()} (${where})` };
  return null;
}

/**
 * suspects, boards: [{ id, state, location, operator, phone, lat, lon, precision }]
 * Returns { merges: Map(suspectId -> { board, rule, reason, meters }),
 *           ambiguous: Map(suspectId -> [boardId...]), counts }.
 */
export function decideMerges(suspects, boards, aliases = new Map()) {
  const byState = new Map();
  for (const b of boards) {
    const st = String(b.state || "").toUpperCase();
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(b);
  }
  const merges = new Map(), ambiguous = new Map();
  const counts = { suspects: suspects.length, merged: 0, byRule: { phone: 0, "near+operator": 0, "near+alias": 0 },
                   ambiguous: 0, phoneBoardUnplaced: 0, stillFlagged: 0 };
  for (const s of suspects) {
    const hits = [];
    for (const b of byState.get(String(s.state || "").toUpperCase()) || []) {
      const e = evidence(s, b, aliases);
      if (e) hits.push({ board: b.id, ...e });
    }
    if (hits.length === 1 && !hits[0].weak) {
      merges.set(s.id, hits[0]); counts.merged++; counts.byRule[hits[0].rule]++;
    } else {
      if (hits.length > 1) { ambiguous.set(s.id, hits.map((h) => h.board)); counts.ambiguous++; }
      else if (hits.length === 1) counts.phoneBoardUnplaced++;
      counts.stillFlagged++;
    }
  }
  return { merges, ambiguous, counts };
}

/* A folded row's facts that the board row does not carry. Empty fields only:
   nothing here overwrites what the board publishes. County is deliberately not
   on the list: it would move the board's fips off its own coordinate. */
export const FILL_FIELDS = ["address", "phone", "capacity", "facility", "licences"];
export function fillEmpty(board, row) {
  for (const f of FILL_FIELDS)
    if ((board[f] === null || board[f] === undefined) && row[f] !== null && row[f] !== undefined) board[f] = row[f];
}

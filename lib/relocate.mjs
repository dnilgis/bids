/* FINDING A BOARD'S TABLE AGAIN AFTER ITS LAYOUT CHANGED -- 2026-10-27.
 *
 * Why: boards went dark when a table changed shape, not when the prices were
 * wrong. Frontier Cooperative (42 StoneHedge sources) changed its widget's
 * column set on 2026-10-15 from [date, month, change, basis, cash] to
 * [name, basis, cash, change], and every pass since has refused all 42 with
 * "a column set nobody has captured" (data/index.json, 1,119 fails by Oct 27).
 *
 * What this does, and all it does: given the column set a board shows now and
 * the column set it showed on its last good read, it says whether the new one
 * is the same table moved or reworded, and how sure it is. It never decides a
 * price. The adapter's own guards run afterwards, unchanged, on every row:
 *
 *   1. SIMILAR ENOUGH. Columns are compared by the job they do (cash, basis,
 *      futures price, contract month, delivery period, change), so a delivery
 *      column renamed from `date` to `name` is the same job. The score is the
 *      share of jobs the two sets have in common (Jaccard). Under
 *      MIN_SIMILARITY the new table is refused as a different table.
 *   2. NOT A WEAKER CHECK. A layout carries the check it can support: a
 *      futures price on the row (priced) is checked by cash - basis = futures;
 *      a named contract month (named) by the quote of that contract; neither
 *      (bare) only by "lands near SOME contract". A board whose last good read
 *      passed a named or priced check is never moved to a weaker one, because
 *      that would be a wider tolerance under another name (Sig's rule: never
 *      widen a tolerance or a rounding mode to make a refusal go away). The
 *      only way back to the old strength is the board's OWN statement of the
 *      missing column (for StoneHedge: the widget's delivery periods, which
 *      name each period's contract), never a value computed from cash and basis.
 *   3. NOTHING UNKNOWN. A column whose job is not known is refused: it might be
 *      the price we would be skipping.
 */

/* The job each column class does. `date` and `name` are both the delivery
   period; `change` is informational and never read as a price. */
export const ROLE = {
  cash: "cash", basis: "basis", price: "futures", month: "contract",
  date: "delivery", name: "delivery", change: "change",
};

/* How strong a check each kind of layout supports. Higher is stronger. */
export const GUARD_RANK = { bare: 1, named: 2, priced: 3 };

/* Half the jobs must be shared for two column sets to be the same table.
   Frontier's move scores 0.8 (4 of 5 jobs: it lost the contract column). */
export const MIN_SIMILARITY = 0.6;

const rolesOf = (keys) => new Set(keys.map((k) => ROLE[k]));

/** Jaccard similarity of the jobs two column sets do, 0..1. */
export function similarity(aKeys, bKeys) {
  const a = rolesOf(aKeys), b = rolesOf(bKeys);
  if (a.has(undefined) || b.has(undefined)) return 0;
  const inter = [...a].filter((r) => b.has(r)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

/** The kind of check a column set can support on its own columns. */
export function kindOf(keys) {
  const r = rolesOf(keys);
  if (r.has("futures") && r.has("contract")) return "priced";
  if (r.has("contract")) return "named";
  return "bare";
}

/**
 * Is `keys` (the board's columns now) the table last seen as `lastGood`?
 *
 * Returns { ok: true, kind, similarity, from, needsContract } or
 * { ok: false, why }. `needsContract` is true when the new columns alone would
 * only support a weaker check than the last good one, and the caller must
 * restore the contract from the board's own data or refuse.
 */
export function relocate(keys, lastGood, { minSimilarity = MIN_SIMILARITY } = {}) {
  const unknown = keys.filter((k) => !(k in ROLE));
  if (unknown.length)
    return { ok: false, why: `column(s) [${unknown.join(", ")}] do a job nobody has identified, so the table is not relocated` };
  if (!lastGood?.keys?.length)
    return { ok: false, why: "there is no last good layout for this board to compare with" };
  const r = rolesOf(keys);
  for (const need of ["cash", "basis", "delivery"])
    if (!r.has(need)) return { ok: false, why: `the new table has no ${need} column` };
  const sim = similarity(keys, lastGood.keys);
  const from = [...lastGood.keys].sort().join(",");
  if (sim < minSimilarity)
    return { ok: false, why: `the new column set matches the last good one [${from}] at ${sim.toFixed(2)}, under the ${minSimilarity} needed to call it the same table` };
  const kind = kindOf(keys);
  const was = lastGood.kind ?? kindOf(lastGood.keys);
  const needsContract = GUARD_RANK[kind] < GUARD_RANK[was];
  if (needsContract && !(was === "named" && kind === "bare"))
    return { ok: false, why: `the last good layout [${from}] supported a ${was} check and the new one only a ${kind} check; a weaker check is not substituted` };
  return { ok: true, kind: needsContract ? was : kind, similarity: sim, from, needsContract };
}

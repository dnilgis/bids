/* ONE YARD, TWO SOURCES: THE NEWER POSTING SPEAKS FOR IT. 2026-10-14.
 *
 * Bunge at Ladoga, IN can reach us two ways: the elevator posting its own
 * basis on agsist.com/post (sources/portal-bunge-ladoga-in.json, written by
 * scripts/portal-sources.mjs) and Bunge's morning cash-bid email
 * (sources/bunge-ladoga-email.json). Both are that one yard, and both say so
 * the way this repository already records it: they claim the same state
 * licence row in `registryId` (reg:IN|bungeusagrainllc|ladoga), which is what
 * makes build_directory.mjs drop the grey pin for it.
 *
 * So sources that share a registryId are one yard, and one of them speaks for
 * it at a time: the one whose board was priced most recently. For a portal
 * listing that is when the elevator last pressed save; for the email, when
 * Bunge sent it. A merchandiser who posts at 10am outranks that morning's
 * 7am email, and the next morning's email outranks yesterday's posting.
 *
 * The others are not deleted, they are set aside and counted (merge_bids.mjs
 * tallies their rows; build_directory.mjs leaves their pin off the map), and
 * the moment the winner is withdrawn on age the next newest speaks again,
 * because the rule is applied to boards that are still being published.
 *
 * No two sources shared a registryId before this, so nothing that worked
 * before 2026-10-14 is changed by it. */

/** registryId as a list: a source may claim one licence row or several. */
export const claimsOf = (s) => [].concat(s?.registryId ?? []).filter((x) => typeof x === "string" && x);

/**
 * entries: [{ id, registryId, pricedAt }]. Returns Map(loserId -> winnerId)
 * for every source sharing a yard (directly or through a chain of shared
 * claims) with one priced more recently. A source with no pricedAt never wins
 * over one that has one; a tie goes to the lower id, so a build is repeatable.
 */
export function yardLosers(entries) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const byClaim = new Map();
  for (const e of entries) {
    if (!e?.id) continue;
    parent.set(e.id, e.id);
    for (const c of claimsOf(e)) {
      if (byClaim.has(c)) union(e.id, byClaim.get(c)); else byClaim.set(c, e.id);
    }
  }
  const groups = new Map();
  for (const e of entries) {
    if (!e?.id || !claimsOf(e).length) continue;
    const r = find(e.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  }
  const t = (e) => { const v = Date.parse(e.pricedAt ?? ""); return Number.isFinite(v) ? v : -Infinity; };
  const out = new Map();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const win = g.slice().sort((a, b) => t(b) - t(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    for (const e of g) if (e.id !== win.id) out.set(e.id, win.id);
  }
  return out;
}

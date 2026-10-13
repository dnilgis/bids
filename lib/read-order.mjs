/* THE READ ORDER, AS ONE FUNCTION scripts/poll.mjs CALLS.
 *
 * This lived inline in poll.mjs, with a hand copy in test/read-order.test.mjs
 * "kept as the specification". The tests ran against the copy, so a change to
 * the script could pass them without the script ever being tested. Here there
 * is one copy, and both the script and the tests import it.
 *
 * The reasoning for each key is in poll.mjs above the call. What changed when
 * it moved here, on 2026-10-13, is below.
 *
 * ── A REFUSAL IS NOT A PAGE THAT FAILED ─────────────────────────────────────
 *
 * The page's streak was the WORST streak of any source on it. The argument was
 * that "the sources behind one page stand or fall together", and for a page
 * that does not answer that is true: one fetch, one verdict for all of them.
 *
 * It is not true of a refusal. `refused` means the page answered and one
 * source's part of it could not be published: "parsed 574 bids but none for
 * location 13901" is CVA's board, read fine, with Hooper no longer on it. It
 * cost what a good read costs. Counting it against the page put the other 52
 * CVA locations behind every clean page in the manifest.
 *
 * MEASURED on data/index.json of 2026-10-13T18:07Z: 9 shared pages had their
 * streak set by a refused source, dragging 269 sources with clean streaks:
 *
 *     ceagrain cashgrid     135 sources   one refused sibling at 461
 *     cvacoop365 cashgrid    54           Hooper and Bancroft at 1032
 *     frontiercooperative    42           three at 46
 *     farmerswin cashgrid    19           one at 1221
 *     countrypartners        13           one at 436
 *     keystonecoop 8, aglandfs 6, borderag 6, lfdfarmers 3
 *
 * Every one of the CVA, farmerswin and lfdfarmers rows was carried, last read
 * 4.2 hours earlier, reached only by the reprieve or at the wall. Two CVA
 * sources reached at the wall with 230ms left are what the index showed as
 * "no answer within 115ms" (see FETCH_FLOOR_MS in lib/deadline.mjs).
 *
 * So the page streak counts only siblings whose last verdict was NOT a
 * refusal. A refused source still carries its own streak, and a page where
 * EVERY source is refused costs one ordinary read a pass, which is what it is.
 *
 * ── THE PAGE HAS WAITED AS LONG AS ITS LONGEST-WAITING SOURCE ─────────────
 *
 * The "last attempted" keys took the LATEST attempt of any sibling. One source
 * reached at the wall then stamped the whole page as just read, while the
 * siblings the clock cut off kept their old stamps and sat at the back of the
 * tie. The page is fetched once for all of them, so it is due when ANY of them
 * is: these keys now take the EARLIEST stamp on the page.
 *
 * ── SIBLINGS ARE READ TOGETHER ─────────────────────────────────────────────
 *
 * The last key was a hash of the source id, so the 54 CVA sources, which tie
 * on every other key, were scattered through their group between other pages.
 * At the wall that splits a page: some siblings read, the rest unreached,
 * although the page itself had already been fetched for them. The hash of the
 * PAGE now comes before the hash of the id, so a page's sources sit together
 * and the wall cuts at most one page. Still a hash, never alphabetical. */
import { createHash } from "node:crypto";

/* ONE definition of the page key, which getPage() in poll.mjs also caches on. */
export const pageKeyOf = (s) => `${s.browserPage ?? ""}|${s.url}`;
export const operatorOf = (s) => s.operator || String(s.id).split("-")[0];
export const spread = (id) => parseInt(createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16);

export const STARVING_MS = 10 * 3600_000;
export const REPRIEVE_PAGES = 4;

const asMap = (m) => (m instanceof Map ? m : new Map(Object.entries(m ?? {})));

/** Order sources for one pass.
 *
 *  prevFails  id -> failure streak from the last index
 *  prevSeen   id -> epoch ms of the last attempt
 *  prevHealth id -> the last verdict (live, refused, broken, skipped)
 *
 *  Returns the sorted copy plus the per-page maps poll.mjs logs and uses. */
export function readOrder(sources, { prevFails = {}, prevSeen = {}, prevHealth = {}, now = Date.now() } = {}) {
  const fails = asMap(prevFails), seen = asMap(prevSeen), health = asMap(prevHealth);
  const pageFails = new Map(), lastSeen = new Map();
  for (const s of sources) {
    const k = pageKeyOf(s);
    const own = health.get(s.id) === "refused" ? 0 : (fails.get(s.id) ?? 0);
    pageFails.set(k, Math.max(pageFails.get(k) ?? 0, own));
    const t = seen.get(s.id);
    /* A source with no stamp has never been attempted: new, not starved. */
    if (t === undefined) continue;
    lastSeen.set(k, Math.min(lastSeen.get(k) ?? Infinity, t));
  }
  const reprieved = new Set(
    [...lastSeen.entries()]
      .filter(([, t]) => now - t > STARVING_MS)
      .sort((a, b) => a[1] - b[1])
      .slice(0, REPRIEVE_PAGES)
      .map(([k]) => k));
  /* A page none of whose sources has been attempted sorts as 0: first. */
  const seenOf = (k) => lastSeen.get(k) ?? 0;
  const order = [...sources].sort((a, b) => {
    const ka = pageKeyOf(a), kb = pageKeyOf(b);
    return ((reprieved.has(kb) ? 1 : 0) - (reprieved.has(ka) ? 1 : 0))
        || (pageFails.get(ka) - pageFails.get(kb))
        || (seenOf(ka) - seenOf(kb))
        || (spread(ka) - spread(kb))
        || (spread(a.id) - spread(b.id));
  });
  return { order, reprieved, pageFails };
}

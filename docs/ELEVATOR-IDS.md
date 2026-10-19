# Elevator ids and county codes

Every row in `data/directory.json` (read, stale, down and known alike) carries two join keys, added 2026-10-18:

| field | what it is |
|---|---|
| `elevId` | permanent id for the location, like `epb8e8r7nr` |
| `fips` | five-digit county FIPS code, or null |
| `fipsVia` | how the county was found (below) |
| `fipsSure` | false when the point is within 2 km of a county line on the outline, or was moved to the nearest county |
| `fipsWhy` | only when `fips` is null: why |

The same keys reach the feed: `data/merged-index.json` places carry `elevId` and `fips`; each `data/merged/*.json` shard carries all four; `data/merged-all.json` has an `elevators` map of source id to the four. They are copied from the directory by source id (`idsFromDirectory` in `scripts/merge_bids.mjs`), never made up in the merge. A source the directory has not seen yet gets nulls until the next directory build.

The working `id` (`landus-ralston`, `known:1041`, `reg:IL|northernpartnerscooperative|tonica`) is unchanged and still works. Use `elevId` to join anything that must survive a rename.

## The id rule

Code: `lib/elevid.mjs`. Ledger: `data/elevator-ids.jsonl`, one line per key that ever had an id.

1. **Once given, never changed, never reused.** A key in the ledger keeps its id for good. An id in the ledger is never minted again, even after every key that held it is gone. Lines are never deleted.
2. **A new key that is an old yard takes the old yard's id**, only on evidence the directory already trusts:
   - **claim**: a source names the licence row (`registryId`) or Barchart row (`sameAsKnown`) it is. It takes that row's id.
   - **same-yard**: a source that shares a licence row with one priced more recently (no row of its own) is written against the yard's id.
   - **rename**: the key is new, exactly one id lost all its keys this build, its last row was the same operator in the same town and state (`orgKey`, the directory's own merge key), and exactly one new key matches. Two candidates either way means no carry: a fresh id, counted as `renameAmbiguous`.
3. **Otherwise minted**: `e` plus 9 Crockford base32 characters of SHA-256 over the key it was first given, its state, operator key, town key and coordinate rounded to two decimals. The same first row gives the same id if the ledger is ever rebuilt; the ledger is what makes it permanent.
4. **Collision**: if the minted id is already in the ledger (held now or ever), hash the same text plus `#1`, `#2`, ... until it is not.
5. **One id, one row per build**: if two live rows would hold one id (an old key came back beside the key that inherited it), the row with a board keeps it, then the key that held it first. The other gets a fresh id and its ledger line is rewritten (`via: split`). Counted.

6. **Folded duplicates** (added 2026-10-19, `lib/dup-merge.mjs`): a Barchart or licence row flagged `duplicateSuspect` ("we already read an elevator in this town") is folded into a board only on evidence, and only when exactly one board has it:
   - **phone**: the same ten digits, and the board is in the same town or within 400 m (a quarter mile). A shared head-office number in another town is not enough.
   - **near+operator**: both rows within 400 m and the same `operatorKey` (co-op / coop / cooperative and trailing Inc / LLC / Co / Company folded).
   - **near+alias**: both rows within 400 m and the two names a pair in `data/operator-aliases.json` for that state. Every pair there is cited to source manifests that already declare a row under the other name (`registryId` / `sameAsKnown`), at least two manifests per pair.
   - Two ten-digit phones that differ veto a name match. A board with the same phone and no coordinate counts as a candidate but is never enough on its own. Two candidates: no fold, counted `ambiguous`. The town alone is never evidence.

   Most rows sit on a town centroid, so for two town-precision rows "within 400 m" is "same town"; the reason string carries both precisions.

   A folded row stops being a pin of its own. The board's elevId never changes. The board takes the folded row's address, phone, capacity, facility and licences where it had none, and lists it in `mergedFrom` (`id`, `elevId`, `rule`, `why`) so anything joined to the folded row's elevId can follow it to the board. The folded key keeps its own ledger line and id (rule 1); while its board is live it is held, so a rename (rule 2) can never carry it to another key. A folded key the ledger has never seen takes the board's id with `via: "dup-merge:<rule>:<board key>"`. If the evidence goes away, the row comes back as its own pin with the id it always had.

`.gitattributes` merges the ledger with `union`, so two runs that each added keys keep both. A key that appears twice after a merge: the earlier `since` wins, then the smaller id, and the next build writes one line.

A rename the rule cannot see (new operator name and new town at once) gets a new id. To carry it by hand, add a ledger line with the new key and the old id, `via: "manual: <why>"`.

`counts.elevIds` in the directory says how many ids were kept, minted, claimed, renamed, left ambiguous, split or folded on that build. `counts.dupMerge` gives the suspects before the fold, how many were folded by each rule, how many were ambiguous, and how many are still flagged (`counts.duplicateSuspects` is the still-flagged figure).

## The county rule

Code: `lib/county.mjs`. Outlines: `vendor/census-counties/counties.geo.json`, a copy of agsist.com's `data/atlas/counties.geo.json` (US Census cartographic boundary counties, 2010 vintage, 20m resolution, via plotly/datasets, rounded to 0.001 degree). Shannon SD is already 46102 and Wade Hampton AK 02158; Connecticut keeps its old county codes; Valdez-Cordova is still 02261.

Best evidence first:

| `fipsVia` | meaning |
|---|---|
| `licence-county` | the state licence roll names the county and it is exactly one county of the row's state |
| `point` | street-precision coordinate inside the county |
| `town-point` | ZIP or town centroid inside the county; a yard at the edge of town can be across the line |
| `county-point` | the coordinate is a county centroid |
| `nearest-in-state` | the point fell just outside every county of its own state (a coarse line along a river or state line); nearest county of that state within 5 km, never sure |

Null when: the row is in Canada, it has no coordinate, its point is in another state and no county of its own state is within 5 km, or the outline file is missing. `counts.fips` gives the totals, the reasons for nulls, and how often the roll's county and the point disagree (`licenceDisagreesWithPoint`).

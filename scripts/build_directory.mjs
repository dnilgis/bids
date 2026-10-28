#!/usr/bin/env node
/*
 * build_directory.mjs — one artefact that says what we know about every
 * elevator, including the ones we cannot read yet.
 *
 * WHY IT EXISTS
 *
 * Sig, 2026-08-27: "i want a complete directory of every elevator in the
 * country and their basis and data whenever possible, whoever we cant get, i
 * want a list of them" and "every elevator that we dont have i want greyed out
 * ... to indicate that i know you are out there, i just havent gotten to your
 * data yet."
 *
 * The gap list stops being a spreadsheet nobody opens and becomes the thing
 * you can see. That only works if "we have not got to you yet" and "we tried
 * and could not read you" are different states, because they are different
 * pieces of work.
 *
 *   read        we asked and got a board.
 *   refusing    we asked and it would not give us one. A bug or a redesign.
 *   broken      we asked and something threw. Ours to fix.
 *   known       we know this elevator exists and have not built a way in yet.
 *               Nothing carries this status today. It arrives with the state
 *               licence registries; the field exists now so the map does not
 *               have to change when it does.
 *
 * And separately from status: PLACED or not. An elevator we read perfectly can
 * still have no pin, because nobody has worked out where it is. Eight of them
 * on 2026-08-27. Conflating that with "no data" would hide real work.
 *
 * NO PRICES IN HERE. This is the directory: who, where, on what platform, when
 * we last looked. Prices live in data/<id>.json and change every pass; the
 * directory changes when an elevator does. Putting them in one file would make
 * every price move re-download the whole country, which is the same mistake
 * agsist's own slim/full split already avoided once.
 *
 * Node, no dependencies, reads only files already in the checkout.
 */
import { stateOf as uiState } from "../lib/freshness.mjs";
import { orgKey } from "../lib/orgkey.mjs";
import { yardLosers } from "../lib/same-yard.mjs";
import { awaitingFirstFile } from "../lib/sources.mjs";
import { assignIds, readLedger, writeLedger } from "../lib/elevid.mjs";
import { decideMerges, loadAliases, fillEmpty } from "../lib/dup-merge.mjs";
import { loadCounties, fipsFor } from "../lib/county.mjs";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };

const index = read(join(ROOT, "data", "index.json"), { sources: [] });
const geoFile = read(join(ROOT, "geocodes", "places.json"), {});
const geo = geoFile.places || {};
const noGeo = geoFile.unplaced || {};

/* The source files are the roster: index.json only lists what the last poll
   touched, so a source disabled or newly added between passes would silently
   appear or vanish from the map. The roster is the definitions on disk. */
const dir = join(ROOT, "sources");
const sourcesAll = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => read(join(dir, f), null)).filter(Boolean)
  : [];
/* NOT ACTIVE UNTIL ITS FIRST FILE EXISTS (lib/sources.mjs awaitingFirstFile):
   no pin, no licence row claimed, so the yard keeps whatever pin it had. */
const sources = sourcesAll.filter((s) => !awaitingFirstFile(s, ROOT, existsSync));

const live = new Map((index.sources || []).map((s) => [s.id, s]));

/* WHY health AND status ARE BOTH READ. poll.mjs sets `health` to live /
   refused / broken / skipped and mirrors it into `status`. Reading only one of
   them is how a guard in this repository went blind before. Take health,
   fall back. */
/* AND WHY AGE IS READ TOO.
 *
 * This function used to be four equality tests on `health` and a fall-through
 * to "known". Two things were wrong with that.
 *
 * The fall-through: a health word it did not recognise became "known", which
 * on the map is a GREY pin meaning "we know you exist and have not got to you
 * yet". Adding `skipped` to poll.mjs would silently have painted 127 elevators
 * as never-read when we were holding a good price for every one of them.
 * A default branch that means something specific is a trap, so there is now no
 * default: an unrecognised word is named and reported.
 *
 * The age: a source last read successfully twenty hours ago still says "live",
 * because nothing flips it. The map drew that as a green "reading its board"
 * pin forever -- the most confident colour on the page, on the one record with
 * the most reason to be doubted. The board and the merged feed both decide
 * this by age; the map now uses the same function they do, so the three cannot
 * disagree about whether an elevator has a price.
 */
const MAP_STATUS = { live: "read", late: "stale", down: "down" };
const stateOf = (s, l, nowMs) => {
  if (!l) return s.enabled === false ? "disabled" : "known";
  const h = l.health || l.status;
  if (!KNOWN_HEALTH.has(h)) {
    unknownHealth.set(h, (unknownHealth.get(h) ?? 0) + 1);
    return "down";     // loudly wrong-looking, never quietly "known"
  }
  /* The manifest's maxAgeH (Flash Grain: 2h) and the feed's own observedAt,
     so the map says "down" at the same moment the merge withdraws the price. */
  return MAP_STATUS[uiState({ health: h, checkedAt: l.checkedAt, observedAt: l.observedAt,
                              maxAgeH: s.maxAgeH ?? l.maxAgeH }, nowMs)];
};
const KNOWN_HEALTH = new Set(["live", "refused", "broken", "skipped"]);
const unknownHealth = new Map();

/* One clock for the whole build, so two pins cannot be judged a second apart. */
const NOW_MS = Date.now();

const elevators = sources
  .filter((s) => s.enabled !== false)
  .map((s) => {
    const l = live.get(s.id);
    const g = geo[s.id];
    const e = {
      id: s.id,
      operator: s.operator || null,
      location: s.location || null,
      state: (s.state || "").toUpperCase() || null,
      status: stateOf(s, l, NOW_MS),
      platform: s.platform || null,
      website: s.website || s.browserPage || null,
      commodities: l?.commodities ?? null,
      rows: l?.rows ?? null,
      checkedAt: l?.checkedAt ?? null,
      pricedAt: l?.pricedAt ?? null,
      /* THE PRICE'S STATE AND THE READ'S OUTCOME ARE TWO DIFFERENT FACTS.
         "stale" says the price is held and still published; "skipped" says why
         nothing newer arrived. Collapsing them into one word is what made a
         held elevator indistinguishable from one we have never touched. */
      health: l ? (l.health || l.status || null) : null,
      placed: Boolean(g),
    };
    if (g) { e.lat = g.lat; e.lon = g.lon; e.precision = g.precision; }
    /* The reason is the whole point of the gap list: "no pin" and "no data"
       are useless without why. */
    /* The geocoder knows exactly why it could not place this one; repeating a
       generic sentence here would throw that away and make the work queue
       useless. Fall back only when the table predates the reasons. */
    if (!g) e.why = noGeo[s.id] || "location not resolved";
    /* The map's words are about the PRICE (read / stale / down); the reason is
       about the READ, and the read is what a person goes and fixes. So the
       reason is taken whenever the last read failed, whatever the price's age
       has since made of it. */
    else if (l && (l.health || l.status) !== "live")
      e.why = l?.reason || l?.error || l?.note || "the last read did not succeed";
    return e;
  })
  ;

/* ONE YARD, ONE PIN. Sources that claim the same licence row (registryId) are
   one elevator reached two ways -- Bunge Ladoga posting on agsist.com and
   Bunge's morning email. The one priced most recently is the pin; a board past
   the withdrawal age does not count as priced. The same rule as the merge, from
   the same function, so the map and the feed name the same source. See
   lib/same-yard.mjs. */
const byIdSrc = new Map(sources.map((s) => [s.id, s]));
const yardGone = yardLosers(elevators.map((e) => ({ id: e.id, registryId: byIdSrc.get(e.id)?.registryId ?? null,
  pricedAt: e.status === "down" ? null : e.pricedAt })));
for (let i = elevators.length - 1; i >= 0; i--) if (yardGone.has(elevators[i].id)) elevators.splice(i, 1);
if (yardGone.size)
  console.log(`  ${yardGone.size} source(s) share a yard with one priced more recently and draw no pin of their own: `
    + [...yardGone].map(([a, b]) => `${a} -> ${b}`).join(", "));

/* ── the ones we only know about ──────────────────────────────────────────
   THE JOIN KEY HAD TO BE EARNED, and it is the same one the 2026-08-20 design
   settled on: a ten-digit phone, then state + ZIP + town. Operator name is
   never a key -- "Premier Cooperative" is a Wisconsin co-op AND a separate
   Illinois one, and "CHS" is two hundred businesses. A wrong match here does
   not merely double-count: it would hide a real elevator behind a grey pin, or
   grey out one we are reading, and either way the map would lie about the work
   left to do. When in doubt, do not match: a duplicate pin is visible and
   fixable, a silent merge is neither. */
const digits = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const townKey = (st, town) => (st || "").toUpperCase() + "|" +
  String(town || "").toLowerCase().replace(/[^a-z]/g, "");

/* ── THE SET IS BUILT FROM THE SOURCES THAT ARE ACTUALLY ON THE MAP ──────
   Found by reading this change adversarially, 2026-09-10, and it was already
   true of the phone rule above: `elevators` is built from the sources with
   `enabled !== false`, and these three sets were built from ALL of them. So a
   registry row could be dropped as "we already read that yard" against a
   manifest this build does not emit, and the elevator vanished from both
   sides. Measured on the 2026-09-09 data: eleven rows, and five of them left
   their operator with no pin in that town at all — Horizon Resources at
   Williston, North Dakota, lost the only row in the town.

   A disabled manifest is a board we have STOPPED reading. The licence roll
   naming that yard is then the only evidence left that it exists, which is
   exactly what a grey pin is for. */
const active = sources.filter((s) => s.enabled !== false);
const ourPhones = new Set(active.map((s) => digits(s.phone)).filter((d) => d.length === 10));
const ourTowns = new Set(active.map((s) => townKey(s.state, s.location)));
/* THE SAME BUSINESS IN THE SAME TOWN, WHERE THERE IS NO PHONE TO ASK.
   See lib/orgkey.mjs. This set is the elevators we read; the known-elevator
   rows are added to it below, once they exist. */
/* A MAP, NOT A SET, AND THE VALUE IS THE PHONES.
   The key merges on state, town and operator, and an operator can hold two
   things in one town: The Andersons' head office at 1947 Briarfield Blvd,
   Maumee, Ohio (419-482-5009) and The Andersons' elevator in Maumee
   (419-893-5050). Same state, same town, same name — and two different phone
   numbers, which is this project's strongest evidence that two rows are two
   things. Sixteen rows on the 2026-09-09 data say that, and the first version
   of this merge dropped every one of them.

   So the name key never overrules a phone. Where both rows carry ten digits
   and the digits differ, the row stays. */
const ourOrgs = new Map();
const addOrg = (state, location, operator, phone) => {
  const k = orgKey(state, location, operator);
  if (!k) return;
  if (!ourOrgs.has(k)) ourOrgs.set(k, new Set());
  const d = digits(phone);
  if (d.length === 10) ourOrgs.get(k).add(d);
};
for (const s of active) addOrg(s.state, s.location, s.operator, s.phone);

const knownRaw = geoFile.known || {};

/* ── DECLARED THE SAME, BY A PERSON, IN THE MANIFEST ──────────────────────
   The rule above is right to refuse a match on name and town: "a town can
   hold three elevators". But it leaves one case it can never close. Badger
   Grain Supply at Wheeler and Midwest Commodity Service at Baldwin publish
   their own feed, read here since 2026-09-21, and Barchart lists both under
   telephone numbers that are not the one office number their sites print
   (715.632.2319 x3 and 715-246-5573, against 715-704-0548). No phone will
   ever match, so each elevator drew one live pin and one grey
   "may be the same yard" pin beside it, for good.

   So a manifest may name the Barchart rows it IS, by their exact key, in
   `sameAsKnown`. That is a statement somebody made and can be read in the
   source file, not a guess this script makes — which is the line the rule
   above draws. A key that no longer exists is reported, not ignored, so a
   declaration cannot quietly go stale. Only an active source can declare: a
   disabled one is a board we stopped reading, and its grey pin comes back. */
const declaredSame = new Map();
for (const s of active)
  for (const kid of Array.isArray(s.sameAsKnown) ? s.sameAsKnown : [])
    declaredSame.set(String(kid), s.id);
for (const [kid, sid] of declaredSame)
  if (!(kid in knownRaw))
    console.warn(`  ${sid} declares sameAsKnown "${kid}", and no known elevator has that key any more`);
let declaredDropped = 0;

let merged = 0;
/* ── THE SAME BUSINESS, IN THE SAME TOWN, BY NAME — added 2026-10-02 ─────
   The registry rows below have been merged on orgKey (state + town + operator,
   legal forms folded) since 2026-09-09, with the phone allowed to veto it. The
   Barchart rows never were: they were only flagged "may be the same yard".
   Measured 2026-10-02: 617 Barchart rows carried exactly the orgKey of a board
   we read and no disagreeing phone (Farmers Coop of Dorchester at Pawnee City,
   Allied Cooperative at Stratford, ...), each a second pin on a yard already on
   the map and a second count in the "known, not read" figure agsist prints.
   The same rule now applies here, with the same veto: two ten-digit phones
   that differ keep the row (16 on that data). A different spelling of the name
   is NOT matched (420 same-town rows on that data); those keep the flag. */
let knownMergedByName = 0, knownKeptOnADifferentPhone = 0;
const known = Object.entries(knownRaw).filter(([kid]) => {
  if (!declaredSame.has(kid)) return true;
  declaredDropped++;
  return false;
}).filter(([, k]) => {
  const key = orgKey(k.state, k.location, k.operator);
  if (!key || !ourOrgs.has(key)) return true;
  const ph = digits(k.phone), theirs = ourOrgs.get(key);
  if (ph.length === 10 && theirs.size && !theirs.has(ph)) { knownKeptOnADifferentPhone++; return true; }
  knownMergedByName++;
  return false;
}).map(([kid, k]) => {
  const ph = digits(k.phone);
  const dup = (ph.length === 10 && ourPhones.has(ph)) || ourTowns.has(townKey(k.state, k.location));
  if (dup) merged++;
  return {
    id: "known:" + kid,
    operator: k.operator || null,
    location: k.location || null,
    state: k.state || null,
    status: "known",
    platform: null,
    website: null,
    commodities: null, rows: null, checkedAt: null, pricedAt: null,
    placed: true, lat: k.lat, lon: k.lon, precision: k.precision,
    branch: k.branch || null,
    address: k.address || null,
    phone: k.phone || null,
    suspect: k.suspect || undefined,
    knownFrom: k.source,
    why: k.suspect
      ? "known to exist; no adapter yet — and its coordinate is " + k.suspect
      : dup
        ? "we already read an elevator in this town — may be the same yard under another name"
        : "known to exist; no adapter for it yet",
    duplicateSuspect: dup || undefined,
  };
});
elevators.push(...known);
/* A registry row must merge against the Barchart facilities too, not only
   against the boards we read. Added after `known` is built, for the same reason
   knownPhones is: these are the rows a phone match already covers, and the
   national list has no phone. */
for (const k of Object.values(knownRaw)) addOrg(k.state, k.location, k.operator, k.phone);

/* ── state licence registries ─────────────────────────────────────────────
   These are the grey pins: a business the state says holds a grain dealer or
   warehouse licence, with nothing behind it yet.

   THE PHONE DECIDES. A ten-digit match against something we already read, or
   against a Barchart facility, means this IS that elevator under its licensed
   name — "Ursa Farmers Cooperative Co" on a licence and "URSA" on a board —
   and adding it would put two pins on one yard. Those are dropped, and counted,
   so the drop is visible rather than silent. A town match alone is not
   identity: a town can hold three elevators, so those stay and carry a flag. */
/* FROM THE RAW GEO ENTRIES, NOT THE MAPPED ONES. The objects pushed into
   `known` above never carried a phone field, so this set was empty and every
   registry duplicate sailed through: seeded with two businesses sharing a
   phone with a Barchart facility, it dropped zero. The phones live in
   geocodes/places.json, which is where they are read from now. */
const knownPhones = new Set(Object.values(knownRaw).map((k) => digits(k.phone))
                                  .filter((d) => d.length === 10));
const regRaw = geoFile.registry || {};
let regMergedPhone = 0, regSameTown = 0, regMergedByName = 0, regMergedWithin = 0,
    regPhoneDisagreed = 0;
/* THE ROW WITH THE MOST EVIDENCE KEEPS THE PIN.
   Two registries can name one yard — a state roll and USDA's national list —
   and only one row should survive. Which one is not arbitrary: a phone is the
   strongest key this project has and an address is the next, so a row carrying
   either is placed first and the later duplicate is the one dropped. The tie is
   broken on the id so the build is reproducible. */
const regRank = (r) => (digits(r.phone).length === 10 ? 2 : 0) + (r.address ? 1 : 0);
const regOrder = Object.entries(regRaw)
  .sort((a, b) => regRank(b[1]) - regRank(a[1]) || a[0].localeCompare(b[0]));
const regOrgs = new Map();
/* A source that names its registry row (registryId, e.g. a portal listing,
   2026-10-13) owns that row outright: its pin replaces the grey one whatever
   name it goes by, so the listing can show the name the elevator chose
   ("Bunge Ladoga") rather than the licence's ("Bunge USA Grain, LLC"). */
/* registryId may be a list: one yard can hold a licence under two names (Bunge's
   Decatur, IN plant is on Indiana's roll as Bunge North America East, LLC and on
   USDA's as Bunge North America, Inc.), and both grey pins are this one yard. */
const claimedRegistry = new Set(active.flatMap((s) => [].concat(s.registryId ?? [])).filter(Boolean));
let regClaimed = 0;
const registry = regOrder.map(([rid, r]) => {
  if (claimedRegistry.has("reg:" + rid)) { regClaimed++; return null; }
  const ph = digits(r.phone);
  if (ph.length === 10 && (ourPhones.has(ph) || knownPhones.has(ph))) { regMergedPhone++; return null; }
  /* ── AND WHERE THERE IS NO PHONE TO ASK ────────────────────────────────
     USDA's national warehouse list carries 4,613 sites and not one phone
     number, so the rule above cannot see any of them. 1,346 of those sites are
     elevators this directory already holds — measured 2026-09-09 — and keeping
     them would put two pins on one yard and inflate the denominator that
     /elevators divides by, which is the number this whole exercise exists to
     get right.

     THE TOWN IS WHAT MAKES THE NAME IDENTITY. On its own an operator name is
     forbidden as a key and the paragraph above says why. In one town it is
     evidence: two hundred CHS businesses, one CHS yard in Hennessey.

     A row dropped here is COUNTED, never silently discarded, and it is dropped
     rather than merged in: the surviving row already carries the better
     provenance, and rewriting a read elevator's fields from a licence roll
     would let a roster overwrite a board. */
  const key = orgKey(r.state, r.location, r.operator);
  if (key && ourOrgs.has(key)) {
    const theirs = ourOrgs.get(key);
    /* Two ten-digit numbers that are not the same number: keep the row and say
       so, rather than let a name-and-town match overrule the identity key this
       project trusts most. */
    if (ph.length === 10 && theirs.size && !theirs.has(ph)) regPhoneDisagreed++;
    else { regMergedByName++; return null; }
  }
  if (key && regOrgs.has(key)) {
    /* TWO ROLLS, ONE YARD, AND THE SECOND ONE IS NOT WORTHLESS.
       build_geocodes.py already merges these where the two rolls spell the
       name identically; this key is looser, so it catches pairs that one
       never saw — and the first version of it simply threw the loser away.
       Measured 2026-09-09: that lost the ONLY capacity figure for 45 yards and
       the only facility name for 53. The row is still dropped; what it knew is
       not. Empty fields only — nothing here overwrites a published value. */
    const keep = regOrgs.get(key);
    for (const f of ["capacity", "facility", "county", "address", "phone",
                     "licenceClass", "licenceStatus"])
      if (keep && !keep[f] && r[f]) keep[f] = r[f];
    if (keep && Array.isArray(r.licences))
      for (const l of r.licences)
        if (!(keep.licences || []).includes(l)) (keep.licences ||= []).push(l);
    regMergedWithin++;
    return null;
  }
  const sameTown = ourTowns.has(townKey(r.state, r.location));
  if (sameTown) regSameTown++;
  const row = {
    id: "reg:" + rid,
    operator: r.operator || null,
    location: r.location || null,
    state: r.state || null,
    status: "known",
    platform: null, website: null, commodities: null, rows: null,
    checkedAt: null, pricedAt: null,
    placed: true, lat: r.lat, lon: r.lon, precision: r.precision,
    county: r.county || null,
    address: r.address || null,
    /* Storage capacity is the best evidence any registry carries about whether
       this is a place a farmer can sell a load. Missouri publishes it; a name
       heuristic that mistook Landus and MFA for feed mills does not come close. */
    capacity: r.capacity || null,
    /* The yard's own name where the source gives one beside the company's:
       "ADM Processing Plant Elevator" under Archer-Daniels-Midland. Both are
       kept because they answer different questions — the parent is what matches
       a board, the facility is what a farmer calls the place. */
    facility: r.facility || null,
    licences: r.licences || null,
    /* Missouri cuts its company names at forty characters, mid-word. Sixteen of
       twenty-six were completed from the city column; the rest carry the flag
       so nothing downstream treats a cut name as the business's real one. */
    nameTruncated: r.nameTruncated || undefined,
    nameRepaired: r.nameRepaired || undefined,
    knownFrom: r.source,
    licenceClass: r.licenceClass || null,
    licenceStatus: r.licenceStatus || null,
    /* WHAT THIS ROW ACTUALLY CLAIMS.
       This read `(r.licences || ["grain"])[0]` and called everything a STATE
       licence. Two things arrived with the national list and broke both
       halves: 2,387 of its warehouses are licensed FEDERALLY, and 50 of them
       are printed "Unlicensed" and now carry no licence at all — where the old
       sentence would have said "holds a state undefined licence". A row says
       what its document says about it, or it says nothing. */
    why: ((r.licences || []).length > 1
            ? "holds both a dealer and a warehouse licence"
            : (r.licences || []).length === 1
              ? "holds a " + (r.licenceClass === "Federal" ? "federal" : "state")
                + " " + r.licences[0] + " licence"
              : "is listed as a grain warehouse and holds no licence on that list")
         + (r.licenceStatus && !/issued/i.test(r.licenceStatus)
              ? " — the list marks it " + r.licenceStatus.replace(/^\w\s*-\s*/, "") : "")
         + "; no bid feed found yet"
         + (sameTown ? " — and we already read an elevator in this town" : ""),
    duplicateSuspect: sameTown || undefined,
  };
  /* The row itself, not the key alone: a later duplicate fills this one's
     empty fields rather than being thrown away. */
  if (key) regOrgs.set(key, row);
  return row;
}).filter(Boolean);
elevators.push(...registry);

/* ── A "MAY BE THE SAME YARD" PIN FOLDED INTO THE BOARD, ON EVIDENCE ───────
   2026-10-19. Every row flagged duplicateSuspect above is checked against the
   boards on the map (lib/dup-merge.mjs): the same ten-digit phone in the same
   town or within 400 m, or within 400 m and the same operator (operatorKey, or
   a cited pair in data/operator-aliases.json), with two differing phones a
   veto. Exactly one board with evidence: the row is folded into it — it stops
   being a pin of its own, the board takes the facts it lacked (empty fields
   only), and `mergedFrom` on the board says which row, with its elevId and the
   reason. Two boards with evidence, or none: the flag stays. Never the town
   alone. The folded row's key keeps its own elevId in the ledger (rule 1) and
   is held there by the board, so no rename can hand it out
   (docs/ELEVATOR-IDS.md, rule 6). */
const ALIASES = loadAliases(join(ROOT, "data", "operator-aliases.json"));
const suspectsBefore = elevators.filter((e) => e.duplicateSuspect);
const boardsForMerge = elevators.filter((e) => e.status !== "known")
  .map((e) => ({ ...e, phone: byIdSrc.get(e.id)?.phone ?? null }));
const dup = decideMerges(suspectsBefore, boardsForMerge, ALIASES);
const foldedInto = new Map();            // suspect key -> { board, state, operator, location }
{
  const byId = new Map(elevators.map((e) => [e.id, e]));
  for (const [sid, m] of dup.merges) {
    const board = byId.get(m.board), row = byId.get(sid);
    fillEmpty(board, row);
    (board.mergedFrom ||= []).push({ id: sid, rule: m.rule, why: m.reason });
    foldedInto.set(sid, { board: m.board, rule: m.rule, state: row.state, operator: row.operator, location: row.location });
  }
  for (let i = elevators.length - 1; i >= 0; i--) if (foldedInto.has(elevators[i].id)) elevators.splice(i, 1);
}
/* A RETIRED BOARD NAMES WHERE ITS YARD IS READ. 2026-10-28 (bids#14, farcoop/CoMark): a disabled manifest with
   retiredInto: "<board id>" is listed in that board's mergedFrom (rule "retired"), so its ledger id follows the
   board downstream (agsist's build_ids folds it into the survivor) instead of going stale there. Mount Hope and
   Patterson's farcoop ids (minted Oct 27) were the real case. */
{
  const byId = new Map(elevators.map((e) => [e.id, e]));
  for (const s of sourcesAll) {
    if (s.enabled !== false || !s.retiredInto) continue;
    const board = byId.get(s.retiredInto);
    if (!board) { console.warn(`retiredInto: ${s.id} names ${s.retiredInto}, which is not on the map`); continue; }
    if ((board.mergedFrom ||= []).some((m) => m.id === s.id)) continue;
    board.mergedFrom.push({ id: s.id, rule: "retired", why: `dup-merge: retired board, the same yard (sources/${s.id}.json, retired note)` });
  }
}
const knownLeft = known.filter((e) => !foldedInto.has(e.id)).length;
const registryLeft = registry.filter((e) => !foldedInto.has(e.id)).length;

elevators.sort((a, b) => (a.state || "").localeCompare(b.state || "") ||
                         (a.operator || "").localeCompare(b.operator || "") ||
                         (a.location || "").localeCompare(b.location || ""));

/* ── JOIN KEYS: A PERMANENT ID AND A COUNTY, ON EVERY ROW ─────────────────
   2026-10-18. Weather, land, rent and program data are all by county, and a
   join needs an id that survives a rename. elevId comes from lib/elevid.mjs
   and the ledger data/elevator-ids.jsonl (never changed, never reused; the
   rule is in docs/ELEVATOR-IDS.md). fips comes from lib/county.mjs: the
   licence roll's county where it names one, else the point in the Census
   outline, with fipsVia saying which and fipsSure false near a county line.
   Additive fields only: nothing a consumer read before has moved. */
const LEDGER = join(ROOT, "data", "elevator-ids.jsonl");
const TODAY = new Date(NOW_MS).toISOString().slice(0, 10);
const idRows = elevators.map((e) => {
  const s = byIdSrc.get(e.id);
  const claims = s ? [...[].concat(s.registryId ?? []).filter(Boolean),
                      ...(Array.isArray(s.sameAsKnown) ? s.sameAsKnown : []).map((k) => "known:" + k)] : [];
  return { id: e.id, operator: e.operator, location: e.location, state: e.state,
           lat: e.lat ?? null, lon: e.lon ?? null, board: e.status !== "known", claims };
});
const idsOut = assignIds(idRows, readLedger(LEDGER), TODAY, { folded: foldedInto });
/* A new key that would have taken a board's folded id (docs/ELEVATOR-IDS.md
   rule 6): minted instead, and said here, because it is very often the same
   yard posted on a second board (farcoop-halstead and ceagrain-halsteadwest,
   2026-10-28). A person compares the two boards and retires one. */
for (const h of idsOut.counts.heldRenames)
  console.warn(`  ${h.key}: same operator and town as ${h.from}, which is folded into ${h.heldBy}; ` +
               `given a fresh id, not ${h.wouldTake}. Check whether ${h.key} is ${h.heldBy}'s yard on a second board.`);
/* A source that shares a yard with one priced more recently draws no row, but
   it is that yard: its key is written against the yard's id, so the day it
   becomes the one drawn, the id does not move. */
for (const [loser, winner] of yardGone) {
  const w = idsOut.ledger.get(winner), s = byIdSrc.get(loser);
  if (w && !idsOut.ledger.has(loser))
    idsOut.ledger.set(loser, { key: loser, id: w.id, since: TODAY, via: "same-yard:" + winner,
                               st: (s?.state || "").toUpperCase() || null, op: s?.operator || null, loc: s?.location || null });
}
writeLedger(LEDGER, idsOut.ledger);
const COUNTIES = loadCounties(join(ROOT, "vendor", "census-counties", "counties.geo.json"));
const fipsTally = { withFips: 0, sure: 0, byVia: {}, licenceDisagreesWithPoint: 0, why: {} };
for (let i = 0; i < elevators.length; i++) {
  const e = elevators[i];
  const f = fipsFor(COUNTIES, e);
  if (f.fips) {
    fipsTally.withFips++;
    if (f.fipsSure) fipsTally.sure++;
    fipsTally.byVia[f.fipsVia] = (fipsTally.byVia[f.fipsVia] ?? 0) + 1;
    /* How often the roll and the point disagree, so the choice above is a
       measured one and not only an argued one. */
    if (f.fipsVia === "licence-county" && e.placed) {
      const p = fipsFor(COUNTIES, { ...e, county: null });
      if (p.fips && p.fips !== f.fips) fipsTally.licenceDisagreesWithPoint++;
    }
  } else {
    const w = String(f.fipsWhy).replace(/"[^"]*"/g, '"..."').replace(/ in [^,]+, [A-Z]{2}, not in [A-Z]{2}$/, " in another state");
    fipsTally.why[w] = (fipsTally.why[w] ?? 0) + 1;
  }
  elevators[i] = { id: e.id, elevId: idsOut.ids.get(e.id), ...e, ...f };
  /* The folded row's own permanent id, so anything joined to it can follow it here. */
  if (e.mergedFrom)
    elevators[i].mergedFrom = e.mergedFrom.map((m) => ({ id: m.id, elevId: idsOut.ledger.get(m.id)?.id ?? null,
                                                          rule: m.rule, why: m.why }));
}

const tally = (fn) => elevators.reduce((m, e) => (m[fn(e)] = (m[fn(e)] || 0) + 1, m), {});
const counts = {
  total: elevators.length,
  byStatus: tally((e) => e.status),
  byPrecision: tally((e) => (e.placed ? e.precision : "unplaced")),
  placed: elevators.filter((e) => e.placed).length,
  states: Object.keys(tally((e) => e.state || "?")).length,
  /* Rows on the map after the dup-merge above folded some into their board. */
  knownOnly: knownLeft,
  fromRegistries: registryLeft,
  registryMergedByPhone: regMergedPhone,
  registryMergedByName: regMergedByName,
  registryClaimedBySource: regClaimed,
  registryMergedWithinRegistries: regMergedWithin,
  /* Kept BECAUSE of a phone, against a name-and-town match. */
  registryKeptOnADifferentPhone: regPhoneDisagreed,
  /* Still flagged: flagged in a town we read, and NOT folded into a board. */
  duplicateSuspects: merged + regSameTown - dup.counts.merged,
  /* lib/dup-merge.mjs: suspects before, folded by rule, ambiguous (evidence for
     two boards), phoneBoardUnplaced (the only same-phone board has no
     coordinate), stillFlagged. */
  dupMerge: { ...dup.counts, knownFolded: known.length - knownLeft, registryFolded: registry.length - registryLeft },
  /* Barchart rows a manifest declared it is, by key. Not in duplicateSuspects:
     they are not suspected, they are settled, and they are not on the map. */
  knownDeclaredSame: declaredDropped,
  /* Barchart rows dropped as the same operator in the same town as a board we
     read, and the ones kept because their phone says otherwise. */
  knownMergedByName,
  knownKeptOnADifferentPhone,
  operators: new Set(elevators.map((e) => e.operator)).size,
  /* elevId: every row has one. kept = key already in the ledger. */
  elevIds: idsOut.counts,
  fips: fipsTally,
};

writeFileSync(join(ROOT, "data", "directory.json"),
  JSON.stringify({
    generated: index.generated || new Date().toISOString(),
    note: "Every elevator this project knows of. 'read' means we have its board; " +
          "'known' means we know it exists and have not built a way in yet. " +
          "precision 'town' is a ZIP centroid, not the elevator itself. " +
          "elevId is permanent (docs/ELEVATOR-IDS.md); fips is the county, fipsVia how it was found, " +
          "fipsSure false when the point is near a county line on the 20m Census outline.",
    counts,
    elevators,
  }, null, 1) + "\n");

console.log("directory: %d elevators, %d placed, %d states, %d operators",
  counts.total, counts.placed, counts.states, counts.operators);
console.log("  status:   ", JSON.stringify(counts.byStatus));
/* A HEALTH WORD THIS BUILD DOES NOT KNOW IS A BUG IN THIS BUILD, SAID OUT LOUD.
   Silence here is what would have painted 127 held elevators grey. */
if (unknownHealth.size) {
  for (const [h, n] of unknownHealth)
    console.error(`::warning title=unknown health::${n} source(s) report health "${h}", which ` +
      `scripts/build_directory.mjs does not recognise. They are drawn as down, not as unread. ` +
      `Add it to KNOWN_HEALTH and MAP_STATUS.`);
}
console.log("  precision:", JSON.stringify(counts.byPrecision));
console.log("  elevId:   ", JSON.stringify(counts.elevIds));
console.log("  fips:      %d of %d rows (%d sure); by how: %s", fipsTally.withFips, elevators.length,
  fipsTally.sure, JSON.stringify(fipsTally.byVia));
console.log("  known-only: %d (%d in a town we already read — flagged, not hidden)",
  counts.knownOnly, counts.duplicateSuspects);
console.log("  dup-merge:  %d of %d flagged rows folded into their board (%s); %d ambiguous; %d still flagged",
  counts.dupMerge.merged, counts.dupMerge.suspects, JSON.stringify(counts.dupMerge.byRule),
  counts.dupMerge.ambiguous, counts.dupMerge.stillFlagged);
console.log("  barchart:   %d dropped as the same operator in the same town as a board we read, " +
  "%d kept because their phone differs", counts.knownMergedByName, counts.knownKeptOnADifferentPhone);
console.log("  registries: %d added, %d dropped as the same elevator by phone, " +
  "%d by name-and-town against what we already hold, %d against another registry",
  counts.fromRegistries, counts.registryMergedByPhone,
  counts.registryMergedByName, counts.registryMergedWithinRegistries);
console.log("              %d kept in a town we already hold because the two rows " +
  "publish different phone numbers", counts.registryKeptOnADifferentPhone);

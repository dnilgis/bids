/* Turn a page of their HTML into the file we publish, or refuse to.
 *
 * Pure: HTML in, an object or a thrown Refused out. No fetching, no
 * committing, no clock beyond what is handed to it. That is what makes the
 * guards testable without a network or a GitHub token.
 *
 * ONE IMPLEMENTATION, WHICH IS THE POINT.
 *
 * There were briefly two readers with two copies of this logic, and they had
 * already drifted: one emitted a `dropped` field the other did not, so the
 * same board read by each produced two different files. Nothing downstream
 * reads `dropped`, so the only symptom would have been a spurious commit every
 * time they handed off -- a price record recording a change in the *reader*
 * rather than a change in the *price*. `dropped` is returned alongside the
 * file now, not inside it.
 *
 * If you are about to copy this file so a second thing can use it: don't.
 * Import it.
 */
import { extractBids, checkIdentity, filterLocation, normLocationId } from "./parse.mjs";

export class Refused extends Error {}

/* A Refused, deliberately. Anything that already catches Refused keeps
   refusing, which is the safe direction if a caller has never heard of this. */
export class TornRead extends Refused {}

/* IS THIS THEIR PAGE'S FAULT OR OURS? -- 2026-08-20.
 *
 * The two answers go to different people. "refused" means we read a page and it
 * was not the board we wanted: their side, expected, hold the last good file
 * and wait. "broken" means our reader threw where it did not expect to: our
 * side, go and look. The dashboard sorts on it and a human acts on it.
 *
 * poll.mjs decided this with:
 *
 *     e instanceof Refused || e?.constructor?.name === "AghostRefused"
 *
 * -- a list of one, written when there was one adapter with its own refusal
 * class. There are now FOUR: AghostRefused, GrainDeskRefused, FragmentRefused
 * and DtnCsRefused. Three of them have been reported as "broken" ever since,
 * so albertlea, babgrain-auburn, sunriseag-buckman and farmerscoop-siouxcenter
 * would each have raised "our reader is broken" for what was in fact their page
 * changing shape -- sending somebody to read our code instead of their board.
 *
 * Found on 2026-08-20 by a deliberately corrupted fixture: the dtn-cs adapter
 * refused it correctly, with an exact message, and poll.mjs called it broken.
 *
 * Structural, not a list, because a list of class names is a list that gets out
 * of date exactly the way this one did. An adapter says "Refused" in its class
 * name or it does not get the benefit of the doubt. */
export const isRefusal = (e) =>
  e instanceof Refused || /(^|[a-z])Refused$/.test(e?.constructor?.name ?? "");

/* Corn futures move in quarter cents, and their board is computed live: the
   cash cell and the futures cell are not written in the same instant. Read the
   page mid-tick and cash reflects 463.25 while the futures cell still says 463,
   so the identity is out by exactly one tick.
 *
 * That is not a column shift. A column shift -- cash read out of the basis
 * column, or a row's worth of offset -- puts the identity out by TENS of
 * cents, because those columns hold numbers of completely different sizes.
 * Half a cent cannot be a column in the wrong place.
 *
 * So the two are told apart by size and handled differently: a torn read is
 * looked at again a few seconds later, a column shift is refused at once and
 * loudly. NOTHING IS PUBLISHED EITHER WAY until the identity balances exactly.
 * The retry does not lower the bar; it just stops a board caught mid-tick from
 * being reported as a structural failure. */
export const TICK_CENTS = 0.25;
export const TORN_MAX_CENTS = TICK_CENTS * 2;

/* THE RULE, ON ITS OWN, SO IT CAN BE TESTED ON ITS OWN.
 *
 * Given how far each failing row is out and how many rows there were:
 *
 *   "unexplained"  something is out by more than a tick or two, which is more
 *                  than a board caught mid-update can account for. Refuse.
 *   "unproven"     the failures are not a minority. The rows that balanced are
 *                  what proves the columns are right, and there are not enough
 *                  of them to prove anything. Refuse.
 *   "lagging"      a minority of rows out by no more than a tick, against a
 *                  majority exact to the cent. Their cell is behind; publish,
 *                  and do not publish the quote we could not check.
 *
 * THE FIRST ONE USED TO BE CALLED "shift", AND THAT WAS A CLAIM, NOT A VERDICT.
 *
 * Renamed 2026-08-19. The rule reads one number -- how far the worst row is
 * out -- and a magnitude alone cannot name a cause. A moved column, a futures
 * column serving a stale snapshot against fresh cash, and a single glitched
 * quote all arrive here looking the same. Calling it "shift" and printing
 * "Columns have moved." meant the log asserted a diagnosis the code had not
 * established, and on 2026-08-19 it said exactly that about a board whose
 * columns were provably in the right order.
 *
 * WHAT DID NOT CHANGE: the boundaries. Every input that was refused before is
 * refused now and every input that published before still publishes. The name
 * and the message were wrong; the decision was right. Pinned by test.
 *
 * Kept separate from buildFile because the fixture cannot produce every case:
 * only three of its futures cells belong to Boyceville rows, so a majority
 * failure is unreachable through it. A rule that can only be tested where the
 * data happens to allow is a rule with untested branches. */
export function classifyIdentity(offCents, keptCount) {
  if (!offCents.length) return "ok";
  if (Math.max(...offCents.map(Math.abs)) > TORN_MAX_CENTS) return "unexplained";
  if (offCents.length * 2 >= keptCount) return "unproven";
  return "lagging";
}

/* One eighth of a cent. Their futures column is quoted in eighths ("459-4" is
   459 and 4/8), so a gap that is a whole number of eighths is a gap between
   two quotes on their own grid. */
export const EIGHTH_CENTS = 0.125;

/* WHAT THE FAILING ROWS ACTUALLY LOOK LIKE -- OBSERVATIONS, NOT A DIAGNOSIS.
 *
 * This exists because of a refusal at 08:29 on 2026-08-19 that the log could
 * not explain. All seven rows were out; all seven in the same direction; all
 * seven by an exact number of eighths, grouped by contract month. Seven
 * minutes later the same board balanced to the cent on every row. Whatever
 * that was, it was not a page that had reordered its columns -- but the only
 * thing the log had said was "Columns have moved."
 *
 * So state the measurables and stop there. Every line below is something the
 * data says; none of them names a cause. A human reading the 6am log can draw
 * the conclusion, and the next person to hit this has the evidence rather
 * than somebody's guess about it.
 *
 * `futuresAt` is their Last Trade column, which exists precisely so this can
 * be checked: if the failing rows carry an older timestamp than the balancing
 * ones, their futures cell is behind its own cash and that is a fact rather
 * than an inference. On a board without the column the line is simply absent.
 */
/* A ROW IS IDENTIFIED BY ITS COMMODITY AND ITS DELIVERY, NEVER BY DELIVERY
 * ALONE -- 2026-08-20.
 *
 * A single-commodity board can get away with a delivery label as a key.
 * Boyceville is one, so nothing here ever noticed. Every Grain Desk source is
 * not: babgrain-auburn posts Soybeans and Corn, sunriseag-buckman posts
 * Soybeans, Oats and Corn, and `graindesk.mjs` sets `delivery` from the
 * delivery period, which is the SAME string across commodity groups.
 *
 * Keyed on delivery alone, `new Map(rows.map(r => [r.delivery, r]))` keeps
 * whichever commodity happens to be last, and the max-move rail then compares
 * corn against oats. Measured on a live-shaped board: a real one-dollar corn
 * move went unflagged while an unchanged board reported a fabricated move of
 * -5.56. Both directions are wrong and the second one is worse, because a rail
 * that cries wolf on every poll gets turned off. */
export const rowKey = (b) =>
  `${String(b?.commodity ?? "")}\u0000${String(b?.delivery ?? "")}`;

export function describeFailures(off, kept = []) {
  const notes = [];
  if (!off.length) return notes;

  const signed = off.map((r) => (typeof r.signedCents === "number" ? r.signedCents : null));
  if (signed.every((v) => v !== null && v > 0))
    notes.push(`All ${off.length} are out the same way: their quote is ABOVE cash minus basis.`);
  else if (signed.every((v) => v !== null && v < 0))
    notes.push(`All ${off.length} are out the same way: their quote is BELOW cash minus basis.`);
  else if (signed.every((v) => v !== null))
    notes.push(`They are out in both directions, which one lagging column does not do.`);

  const isEighth = (v) =>
    v !== null && Math.abs(Math.round(Math.abs(v) / EIGHTH_CENTS) * EIGHTH_CENTS - Math.abs(v)) < 1e-6;
  if (signed.every(isEighth))
    notes.push(`Every gap is a whole number of eighths of a cent, the grid their ` +
               `futures column is quoted on.`);

  /* Their own clock on the futures cell, if their board carries it. */
  const failed = new Set(off.map(rowKey));
  const stamp = (b) => b.futuresAt || null;
  const failedAt = [...new Set(kept.filter((b) => failed.has(rowKey(b))).map(stamp).filter(Boolean))];
  const okAt = [...new Set(kept.filter((b) => !failed.has(rowKey(b))).map(stamp).filter(Boolean))];
  if (failedAt.length) {
    notes.push(`Their Last Trade column reads ${failedAt.join(", ")} on the failing ` +
               `row(s)` + (okAt.length ? ` and ${okAt.join(", ")} on the rest.` : `.`));
  }
  return notes;
}

export const CONFIG = {
  locationId: "2121",
  location: "Boyceville",
  expect: /corn/i,
  floor: 2.0,      // a corn cash bid outside this is a decimal point in the
  ceiling: 12.0,   // wrong place, not a market. A sanity band, not a forecast.
};

/* PER-COMMODITY BANDS.
 *
 * `floor`/`ceiling` above are a CORN band. One band wide enough to admit corn
 * and soybeans admits a decimal-point error that lands between them, and
 * catching those is the band's only job. A source that posts more than one
 * commodity carries `bands` instead:
 *
 *     bands: { corn: [2, 12], soybeans: [6, 25], wheat: [3, 20] }
 *
 * A commodity with no band is REFUSED, not waved through. Adding a commodity
 * to a source is therefore a deliberate act, which is the point. */
/* DEFAULT BANDS, SO A NEW COMMODITY IS COVERED THE DAY IT APPEARS.
 *
 * The point of this repo is every commodity an elevator is buying. Before
 * these existed, `expect` was built from the source's own band keys and
 * anything else was filtered out BEFORE the guards ever saw it -- Boyceville
 * posts corn, and the day they added soybeans the file would have published
 * seven corn rows, `status: ok`, and no trace of beans anywhere. A whole
 * commodity gone with every signal reading healthy.
 *
 * These are decimal-point catchers, not forecasts: wide enough to survive a
 * real market, narrow enough that a misplaced point lands outside. A source
 * may override or extend them with its own `bands`. */
export const DEFAULT_BANDS = {
  /* Matching is substring, so the base name covers the variants an elevator
     actually prints: "Yellow Corn", "#2 US Yellow Corn", "Spring Wheat",
     "HRW Wheat", "Food Grade Soybeans", "Grain Sorghum" all land correctly. */
  corn:       [2.0, 12.0],
  soybean:    [6.0, 32.0],   // singular: catches "soybean" and "soybeans"
  bean:       [6.0, 32.0],   // boards that just say "Beans"
  wheat:      [3.0, 20.0],
  durum:      [4.0, 25.0],
  sorghum:    [2.0, 14.0],
  milo:       [2.0, 14.0],
  oat:        [1.5, 12.0],
  barley:     [2.0, 14.0],
  rye:        [2.0, 20.0],
  triticale:  [2.0, 16.0],
  sunflower:  [8.0, 45.0],
  canola:     [6.0, 35.0],
  flax:       [6.0, 40.0],
  mustard:    [8.0, 60.0],
  safflower:  [8.0, 45.0],
  buckwheat:  [4.0, 40.0],
  millet:     [3.0, 30.0],
  pea:        [4.0, 30.0],   // field peas
  lentil:     [8.0, 60.0],
  chickpea:   [10.0, 80.0],
  garbanzo:   [10.0, 80.0],
};

/* PRICED PER TON, NOT PER BUSHEL -- and therefore NOT given a default band.
 * DDGS, meal and hulls trade in the hundreds. A band meant for a per-bushel
 * crop would reject them on sight and, before the per-commodity split, would
 * have taken the whole board down with them. They are left unbanded so they
 * announce themselves in `withheld` and get a band with the right units when
 * somebody decides they belong on the site. */
export const KNOWN_UNBANDED = ["ddgs", "distillers", "meal", "hull", "gluten", "bran", "pellet"];

/* A BAND THAT IS NOT A PAIR OF NUMBERS IS NOT A BAND -- 2026-08-20.
 *
 * `bandFor` read `range[0]` and `range[1]` off whatever the manifest held. Write
 * `"corn": { "floor": 2, "ceiling": 12 }` instead of `[2, 12]` -- the obvious
 * mistake, because that IS the shape bandFor returns -- and both come back
 * undefined. The level check is `b.cash < band.floor || b.cash > band.ceiling`,
 * and both comparisons against undefined are false, so every price passes.
 *
 * Measured: a corn row of $40.75 with an internally consistent basis and
 * futures published green. The one guard whose entire job is catching a
 * misplaced decimal point had switched itself off, and the file said "ok".
 *
 * Nothing else validates these manifests -- they are hand-written JSON. So the
 * shape is checked here, at the only place that reads it, and a bad one
 * refuses the source by name instead of disarming it. */
export function validBand(range, where) {
  if (!Array.isArray(range) || range.length !== 2)
    throw new Refused(`band for ${where} must be a two-element array like [2.0, 12.0], got ` +
                      `${JSON.stringify(range)}. A band that is not a pair of numbers ` +
                      `silently disables the level check, so this refuses instead.`);
  const [floor, ceiling] = range;
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling))
    throw new Refused(`band for ${where} must be two finite numbers, got ` +
                      `${JSON.stringify(range)}.`);
  if (!(floor < ceiling))
    throw new Refused(`band for ${where} is [${floor}, ${ceiling}] -- the floor must be ` +
                      `below the ceiling or nothing can ever be inside it.`);
  return { floor, ceiling };
}

/* LONGEST NAME WINS, BECAUSE SUBSTRING MATCHING IN DECLARATION ORDER SHADOWS
 * ITS OWN ENTRIES -- 2026-08-20.
 *
 * `wheat` is declared before `buckwheat` and `pea` before `chickpea`, and the
 * old loop returned the first name contained in the commodity string. Both
 * later entries were unreachable: `Buckwheat` took the wheat band [3, 20] and
 * `Chickpeas` took the field-pea band [4, 30]. A real chickpea price of $32
 * then read as one row outside a band its own commodity sat inside -- the
 * decimal-point case -- and refused the whole elevator, corn included.
 *
 * Sorting candidates by name length makes the answer independent of the order
 * somebody happens to type the table in. */
function matchBand(table, key) {
  const names = Object.keys(table || {}).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const n = name.toLowerCase();
    if (key === n || key.includes(n)) return name;
  }
  return null;
}

/* HOW A SOURCE ROUNDS ITS CASH CELL, WHEN IT ROUNDS IN A KNOWABLE WAY.
 *
 * `cashRoundingCents` is a tolerance: it says "residuals up to this much carry
 * no information about column integrity". That is the right tool when all we
 * know is that a board displays two decimals. It is a blunt one, because it
 * accepts a residual in either direction and of any size up to the limit.
 *
 * Some boards round in a way we can state exactly. DTN Content Services is one.
 * Measured across 25 records captured live at Ag Partners on 2026-08-20:
 *
 *     cash == basis + futures exactly      4 of 25
 *     cash == ROUND(basis + futures)      11 of 25
 *     cash == FLOOR(basis + futures)      25 of 25
 *
 * and the only residuals present are 0, 0.25 and 0.75 cents — the eighths
 * remainder of their own futures quote, never anything else. Their cash cell is
 * the arithmetic TRUNCATED to the cent, always in the farmer's disfavour by
 * less than a cent, which is exactly what a grain buyer would do.
 *
 * So instead of handing this platform a three-quarter-cent tolerance and hoping,
 * state the rule: the residual must be at least zero and strictly less than one
 * cent. That is DIRECTIONAL and BOUNDED, so it is strictly stronger than
 * `cashRoundingCents: 0.75` — a board whose cash reads a cent HIGH than the
 * arithmetic still fails, and so does every column shift, which moves things by
 * tens of cents.
 *
 * A source declaring the wrong mode is caught the same way a wrong futuresUnits
 * is: the residuals stop fitting and the board refuses. */
export const CASH_ROUNDING = {
  exact:         null,                              // use cashRoundingCents
  /* Ag Partners. cash = FLOOR(basis + futures), always in the buyer's favour
     by under a cent. Measured 25 of 25 with residuals {0, 0.25, 0.75}. */
  "floor-cent":  (signed) => signed >= 0 && signed < 1,
  /* Premier Cooperative, found 2026-08-20 by running the probe against their
     page: cash = ROUND(basis + futures). 161 of 161 rows, residuals
     {-0.5, -0.25, 0, 0.25} -- the give-and-take signature of rounding to
     nearest, and floor explained only 89 of them. Half a cent EITHER WAY, so
     it is wider than floor-cent in one direction and narrower in the other;
     it is not a superset and the two must not be confused. */
  /* HALF ROUNDS UP, so the window is closed at the bottom and OPEN at the top.
     A residual of exactly +0.5 would mean their cash cell rounded DOWN from a
     half, which round-half-up never does -- the arithmetic would have produced
     the next cent up and the residual would read -0.5 instead. Premier's 161
     rows show -0.5 and never +0.5, which is that asymmetry visible in the data.
     Closing this interval at both ends would also put the guard half a cent
     wider than the counter in scripts/dtn-probe.mjs that measures it, and a
     measurement and a guard that disagree at their boundary are a bug waiting
     for the row that lands on it. If a platform ever rounds half-to-even it
     will produce +0.5, this will refuse, and refusing is the safe direction. */
  "round-cent":  (signed) => signed >= -0.5 && signed < 0.5,
};

export function roundingRule(source) {
  const name = source?.cashRounding;
  if (name === undefined || name === null) return null;
  if (!(name in CASH_ROUNDING))
    throw new Refused(`cashRounding "${name}" is not one of ` +
      `${Object.keys(CASH_ROUNDING).join(", ")}. Leave it out for a board whose cash cell ` +
      `is the arithmetic to the last digit.`);
  return CASH_ROUNDING[name];
}

/** Drop the identity failures a source's declared rounding fully accounts for. */
export function explainedByRounding(source, allOff, tol) {
  const rule = roundingRule(source);
  if (rule) return allOff.filter((r) => !rule(r.signedCents));
  return tol > 0 ? allOff.filter((r) => Math.abs(r.offCents) > tol) : allOff;
}

export function bandFor(source, commodity) {
  const key = String(commodity || "").toLowerCase().trim();

  /* The source's own bands win outright, including over KNOWN_UNBANDED: if
     somebody has worked out what a ton of distillers grain should cost and
     written it down, that is a decision, not an accident. */
  const ownName = matchBand(source.bands, key);
  if (ownName) return { ...validBand(source.bands[ownName], `"${commodity}" (${ownName})`),
                        named: ownName };

  /* PRICED PER TON: no default band, and now actually consulted. KNOWN_UNBANDED
     was declared with a comment explaining why these are left unbanded and had
     ZERO call sites, so `Soybean Meal` was quietly given the soybean band
     [6, 32] and `Corn Gluten Meal` the corn band [2, 12]. They were withheld
     anyway -- a per-ton price is far outside a per-bushel band -- but for the
     wrong stated reason, and a per-ton row that happened to land INSIDE its
     mismatched band would have taken the board down as a bad number. */
  if (KNOWN_UNBANDED.some((n) => key.includes(n))) return null;

  const stdName = matchBand(DEFAULT_BANDS, key);
  if (stdName) return { ...validBand(DEFAULT_BANDS[stdName], `"${commodity}" (${stdName})`),
                        named: stdName + " (default)" };

  if (!source.bands && typeof source.floor === "number" && typeof source.ceiling === "number")
    return { floor: source.floor, ceiling: source.ceiling, named: "legacy" };
  return null;
}

/* NOT EVERY BOARD QUOTES FUTURES IN EIGHTHS -- 2026-08-20.
 *
 * Big River writes Sep corn as "459-2", eighths of a cent, and `parseTicks`
 * turns that into 459.25 CENTS. Every guard downstream, and the published
 * `futuresPriceCents`, assume cents because that is the only board this system
 * had ever read.
 *
 * Ace Ethanol's board writes the same quote as "4.7850s" -- dollars. Run it
 * through as it stands and `futuresPrice` is 4.785, the derived value is 479,
 * and all fourteen rows fail the identity check by four hundred and seventy
 * cents. Measured against fixtures/ace-3578.html: "14 of 14 testable row(s)
 * fail cash - basis = futures". The reader refuses, which is right, but it
 * refuses a board that is entirely correct.
 *
 * So the unit is a property of the source and is declared in its manifest.
 * THIS IS SAFE TO DECLARE because it is self-checking: get it wrong in either
 * direction and every row is out by a factor of a hundred, which is orders of
 * magnitude past "unexplained", and the identity guard refuses the board. A
 * knob that cannot be set wrong without being caught is a knob worth having.
 *
 * Default is `cents`, so every existing source is untouched. */
export const FUTURES_UNITS = { cents: 1, ticks: 1, dollars: 100 };

export function futuresScale(source) {
  const u = String(source?.futuresUnits ?? "cents").toLowerCase();
  const scale = FUTURES_UNITS[u];
  if (scale === undefined)
    throw new Refused(`futuresUnits "${source.futuresUnits}" is not one of ` +
      `${Object.keys(FUTURES_UNITS).join(", ")}. Leave it out for a board quoting ` +
      `cents or eighths of a cent, which is the default.`);
  return scale;
}

export function scaleFutures(rows, source) {
  const scale = futuresScale(source);
  if (scale === 1) return rows;
  /* ROUNDED, BECAUSE 5.0375 * 100 IS 503.74999999999994 IN BINARY FLOATING
     POINT. Unrounded it publishes that verbatim, the identity check then works
     on a number that is not the one on their board, and every poll writes a
     different-looking file. Four decimals is well past an eighth of a cent
     (0.125) and well short of float noise. */
  return rows.map((b) => (typeof b.futuresPrice === "number"
    ? { ...b, futuresPrice: Number((b.futuresPrice * scale).toFixed(4)) } : b));
}

/**
 * @returns {{file: object, dropped: number, locations: string[], verified: number}}
 *   `file` is exactly what gets committed. The rest are diagnostics for the
 *   log line and are deliberately NOT in the file. `verified` is how many rows
 *   the identity check could actually test -- see the guard below for why a
 *   caller wants to know that and not just how many failed.
 */
/* `source` defaults to CONFIG so every existing caller and test is unchanged.
   `extract` is the platform adapter: HTML in, normalised rows out. The GUARDS
   below are shared by every source and are the reason a new platform is an
   adapter rather than a fork -- a second parser that skips the identity check
   is not a second source, it is a second way to publish a wrong number. */
export function buildFile(html, { now, sourceUrl, source = CONFIG, extract = extractBids }) {
  const all = extract(html, sourceUrl);
  if (!all.length)
    throw new Refused("0 bids parsed; their page layout has changed, or that URL is no longer a bid board");

  /* THE MANIFEST HAS TO SAY WHICH LOCATION, EVEN WHEN THE ANSWER IS "NONE".
   *
   * See normLocationId in parse.mjs: a missing key used to match every row on
   * the page. Requiring the key present makes `null` a decision somebody made
   * rather than a field somebody forgot. */
  if (!("locationId" in source))
    throw new Refused(
      `this source's manifest has no locationId. Set it to the page's own location ` +
      `key, or to null if the page carries exactly one location and does not key ` +
      `its rows. It cannot be left out: an absent id used to match every row on ` +
      `the page, which is how one town's bids end up on another town's board.`);

  const { kept: located0, dropped, locations } = filterLocation(all, source.locationId);
  const located = scaleFutures(located0, source);
  if (!located.length)
    throw new Refused(`parsed ${all.length} bids but none for location ${source.locationId}. ` +
                      `The page contained: ${locations.join(", ")}`);

  /* AND IF THE MANIFEST SAID "NONE", THE PAGE HAS TO HAVE ONE.
   *
   * `locationId: null` is a claim about their page: it carries one location and
   * does not key its rows. If the rows name more than one place, that claim is
   * false and there is no way left to tell whose price is whose. */
  if (normLocationId(source.locationId) === null) {
    const named = [...new Set(located.map((b) => String(b.location ?? "")).filter(Boolean))];
    if (named.length > 1)
      throw new Refused(
        `this source declares locationId null, which says their page carries one ` +
        `location -- but the rows name ${named.length}: ${named.join(", ")}. ` +
        `Nothing can be published under a single town until the rows can be told ` +
        `apart.`);
  }

  /* A QUOTE OF ZERO IS NOT A QUOTE, AND IT MAKES THE IDENTITY CHECK VACUOUS.
   *
   * Found live on 2026-08-19, the first poll after babgrain-auburn went in.
   * Two of its four Soybeans offers looked like this:
   *
   *     01 Jun 2026 to 30 Jun 2026   futures July 2026
   *     futuresPrice 0.0000   basisPrice -0.3075   standardCashPrice -0.3075
   *
   * July 2026 beans expired months ago. Their platform still carries the row,
   * computes cash = basis + futures, and with futures at zero publishes the
   * BASIS wearing a cash label. A soybean bid of minus thirty-one cents.
   *
   * The band guard caught it and refused the source, which is the system
   * working. But look at what the identity check did with the same row:
   *
   *     cash - basis  ==  -0.3075 - (-0.3075)  ==  0  ==  futures
   *
   * It PASSED. The one guard whose whole job is proving a number came out of
   * the right column is satisfied by any row where all three values are zero
   * or where cash and basis are the same number. A zero quote turns it into
   * 0 == 0 and it verifies nothing at all.
   *
   * So a zero futures quote is treated as a MISSING quote, everywhere, on
   * every platform -- not as a value. The row is withheld, named in the file,
   * and never counted as verified. It is not a refusal on its own: an expired
   * contract sitting on a board next to live ones is ordinary, and taking the
   * whole source down for it would lose the good rows too. If EVERY row is
   * like this there is nothing left to publish and the source refuses. */
  const zeroQuote = located.filter((b) => b.futuresPrice === 0);
  const kept = located.filter((b) => b.futuresPrice !== 0);
  if (!kept.length)
    throw new Refused(
      `all ${located.length} row(s) at ${source.location} quote a futures price of ` +
      `zero, so every cash figure on this board is its own basis and nothing can ` +
      `be checked against a real quote. Rows: ` +
      zeroQuote.map((b) => `${b.commodity} ${b.delivery}`).join(", ")
    );

  /* The structural check. Every other guard asks whether a number looks
     plausible; this asks whether it came out of the right column. A page that
     quietly reorders its columns while every value stays in range passes all
     the others and fails this one. */
  /* WHAT THE EVIDENCE SAID, AND WHAT CHANGED BECAUSE OF IT.
   *
   * Three runs failed on 2026-08-18 with identical numbers hours apart, which
   * a random mid-update read does not do. The log was widened to print every
   * failing row with its contract month, and the answer was unambiguous:
   *
   *     August     Sep 26   4.1125 - (-0.52) -> 463.25c but quoted 463c
   *     September  Sep 26   4.1725 - (-0.46) -> 463.25c but quoted 463c
   *     5 of 7 row(s) balanced.
   *
   * Every failure on the front month; every deferred month exact, including
   * ones carrying quarter cents. So their Sep 26 futures cell lags its own
   * cash by a tick, and it does not clear within a minute -- retrying was not
   * going to fix it, and refusing the whole board meant both sites going dark
   * in fourteen hours over a quarter of a cent on a column that is only there
   * to be checked against.
   *
   * THE RULE NOW, AND WHY IT IS NOT A SOFTENING.
   *
   * The identity check exists to prove a number came out of the right COLUMN.
   * A column shift moves every row by tens of cents, because cash, basis and
   * a futures quote hold numbers of completely different sizes. So:
   *
   *   - any row out by more than a tick or two  -> refuse, columns have moved
   *   - failures in the majority                -> refuse, nothing is proven
   *   - no row exact at all                     -> refuse, nothing is proven
   *   - otherwise                               -> the rows that balanced
   *                                                EXACTLY prove the columns,
   *                                                and the odd row out by a
   *                                                tick is their display
   *
   * The rows that pass are what does the proving, and they still have to pass
   * exactly. Nothing here lets a wrong column through: it takes a majority of
   * rows agreeing to the cent before a single tick-sized disagreement is
   * tolerated, and the row that disagreed is marked so nothing downstream can
   * quote its futures figure as verified. */
  /* DISPLAY PRECISION IS A PROPERTY OF THE SOURCE, NOT A REASON TO LOOSEN THE GUARD.
   *
   * The proof above rests on rows balancing EXACTLY. That works when a board
   * posts cash at the same resolution its futures move at. Boyceville does:
   * 4.5375 against a quarter-cent grid, and its rows balance to the cent.
   *
   * A board that rounds cash to two decimals cannot. Flash Grain posts
   * soybeans at 11.37 when the arithmetic says 11.3725, so every bean row sits
   * a quarter-cent off for ever. Two of its four rows are beans, the failures
   * were therefore never a minority, and a perfectly good board was refused.
   *
   * `cashRoundingCents` declares how much residual that source's own display
   * precision can account for. Rows inside it are not failures — their gap
   * carries no information about column integrity, so counting them dilutes
   * the proof rather than strengthening it.
   *
   * This does NOT weaken the check. A moved column shows up as tens of cents,
   * because cash, basis and a futures quote hold numbers of different sizes;
   * no rounding tolerance reaches that far. It stays 0 for Boyceville, so
   * nothing about the first source changes. And it is declared per source in
   * the manifest, which means adding it is a deliberate act with a reason. */
  const tol = Number(source.cashRoundingCents ?? 0);
  const allOff = checkIdentity(kept);
  const off = explainedByRounding(source, allOff, tol);

  /* THE MAJORITY IS A MAJORITY OF THE ROWS THAT WERE ACTUALLY TESTED.
   *
   * `checkIdentity` skips any row missing cash, basis or a quoted future --
   * that is stated in its own header. The verdict was nonetheless being taken
   * against `kept.length`, every row on the board, so rows the check had never
   * looked at padded the denominator that decides whether the failures are a
   * minority.
   *
   * Measured on a seven-row board where three rows carry a futures quote and
   * all three are a quarter of a cent behind their own cash: `off.length * 2 >=
   * 7` is false, the verdict is "lagging", and the file publishes three futures
   * quotes marked verified with NOT ONE row having balanced exactly. The
   * doctrine four comments above says "no row exact at all -> refuse, nothing
   * is proven". It scales: 1 of 3, 2 of 5, 3 of 7, 4 of 9 all-testable-rows
   * failing every read as "lagging".
   *
   * Against the tested count the same board is "unproven" and refuses. This
   * only ever moves the line toward refusing, never away from it, because the
   * tested count can never exceed the kept count. */
  const verifiable = kept.filter(
    (b) => b.cash != null && b.basis != null && b.futuresPrice != null
  );
  const verdict = classifyIdentity(off.map((r) => Math.abs(r.offCents)), verifiable.length);
  if (off.length) {
    const w = off.reduce((worst, r) =>
      Math.abs(r.offCents) > Math.abs(worst.offCents) ? r : worst);
    const worst = Math.abs(w.offCents);
    const monthOf = new Map(kept.map((b) => [rowKey(b), b.futures || "?"]));
    const atOf = new Map(kept.map((b) => [rowKey(b), b.futuresAt || null]));
    const detail = off.map((r) => {
      const at = atOf.get(rowKey(r));
      /* Signed. It used to print "+" whatever the direction, so a log of an
         all-one-way failure was indistinguishable from a scattered one. */
      const sign = r.signedCents > 0 ? "+" : "";
      return `      ${String(r.delivery).padEnd(10)} ${String(monthOf.get(rowKey(r)) || "?").padEnd(10)}` +
        ` cash ${r.cash}  basis ${r.basis}  ->  ${r.derivedCents}c ` +
        `but quoted ${r.quotedCents}c  (${sign}${r.signedCents}c)` +
        (at ? `  last trade ${at}` : "");
    }).join("\n");
    const notes = describeFailures(off, kept);
    const seen = notes.length ? `\n  ${notes.join("\n  ")}` : "";
    const where = `${off.length} of ${verifiable.length} testable row(s) fail ` +
      `cash - basis = futures` +
      (kept.length !== verifiable.length
        ? ` (${kept.length - verifiable.length} of ${kept.length} row(s) carry no quote and ` +
          `could not be tested)` : ``) + `:\n${detail}`;

    /* SAY WHAT IS ESTABLISHED AND NOTHING MORE.
     *
     * This message used to end "Columns have moved." It had established no
     * such thing: all it had measured was that the gap was bigger than a
     * mid-update tear can explain. On 2026-08-19 it printed that about a
     * board whose columns were in exactly the right order and which balanced
     * on all seven rows seven minutes later, and the morning went into
     * chasing a column shift that had never happened.
     *
     * The refusal is unchanged and correct: nothing here can be published
     * while the one check that proves we read the right columns is failing.
     * What changed is that the log now hands over the evidence instead of a
     * conclusion drawn from one number. */
    if (verdict === "unexplained")
      throw new Refused(
        `${where}\n  Worst is ${worst}c. That is more than the two ticks a board read ` +
        `mid-update can account for, so this is not a torn read -- but the size ` +
        `alone does not say what it is. A moved column, a stale futures column ` +
        `and a single bad quote all look like this from here. Refusing until it ` +
        `balances.${seen}`);

    if (verdict === "unproven")
      throw new Refused(
        `${where}\n  ${off.length} of ${verifiable.length} is not a minority, so the rows that ` +
        `balanced do not prove the columns are right. Refusing.${seen}`);
  }

  /* AND THE GUARD MUST HAVE ACTUALLY RUN.
   *
   * checkIdentity can only test a row that has all three of cash, basis and a
   * quoted future. It skips the rest. So zero failures has two meanings: every
   * row passed, or no row was testable — and the second one is a guard that
   * has silently switched itself off.
   *
   * That is reachable without any malice. Rename one header cell on their
   * side, "Futures" to "CME", and the futures column stops being recognised;
   * every futuresPrice parses as null; checkIdentity verifies 0 of 7 rows and
   * reports no failures; and the file publishes with the identity check
   * disabled and futuresPriceCents null on every row. Verified by doing
   * exactly that to the fixture.
   *
   * A structural check whose absence looks identical to its success is not a
   * check. Count what was verified and refuse if the answer is none. */
  if (!verifiable.length)
    throw new Refused(
      `parsed ${kept.length} row(s) at ${source.location} but could not run the ` +
      `cash - basis = futures check on any of them: no row carries all three of ` +
      `cash, basis and a quoted future. Their column headings have probably ` +
      `changed. Publishing now would publish with the one structural guard off.`
    );

  /* THE PUBLISHED BASIS HAS TO BE IN THE UNITS ITS FIELD NAME CLAIMS.
   *
   * `basisCents` is the field the Emmert sites render, and until today nothing
   * checked it. The identity guard reads `basis` in DOLLARS, so a basis
   * converted to cents with the wrong scale balances exactly like a right one
   * and publishes with every signal green. parse.mjs's old magnitude rule did
   * precisely that to any basis of three dollars or wider -- see basisToCents.
   *
   * On a row that carries cash and a quoted future the answer is not a guess:
   * cash in cents minus the quoted future IS the basis in cents. A unit error
   * is a factor of a hundred and lands hundreds of cents away; a lagging quote
   * or a rounded cash cell lands a fraction of a cent away. Five cents
   * separates those two worlds with room to spare, and anything bigger than a
   * tick or two has already been refused above. */
  const BASIS_UNIT_MAX_CENTS = 5;
  const wrongUnits = verifiable.filter((b) =>
    b.basisCents != null &&
    Math.abs(b.basisCents - (b.cash * 100 - b.futuresPrice)) > BASIS_UNIT_MAX_CENTS);
  if (wrongUnits.length) {
    const w = wrongUnits[0];
    throw new Refused(
      `${w.delivery} ${w.commodity} publishes basisCents ${w.basisCents}, but its own ` +
      `cash (${w.cash}) and quoted future (${w.futuresPrice}c) say ` +
      `${Number((w.cash * 100 - w.futuresPrice).toFixed(4))}c. ` +
      `${wrongUnits.length} of ${verifiable.length} row(s) disagree by more than ` +
      `${BASIS_UNIT_MAX_CENTS}c, which is a units problem rather than a price ` +
      `problem -- the identity check cannot see it because it reads basis in dollars.`);
  }

  /* EVERY COMMODITY THE BOARD POSTS, AND NOTHING DISAPPEARS QUIETLY.
   *
   * This used to filter on `source.expect` -- a regex built from the band keys
   * -- so a commodity with no band was gone before any guard ran and left no
   * mark on the file. Now an unbanded commodity is WITHHELD and named: it does
   * not publish (nothing unverifiable ever does) and it does not vanish. One
   * unknown commodity must not take the board down either, so this is per
   * commodity, the same way a failing source does not take the run down. */
  const withheld = [];

  /* The zero-quote rows, named. They are not a band failure and not a parse
     failure, so without this line they would simply not appear -- and a row
     that silently is not there is indistinguishable from a row that was never
     posted. `absent is not empty` applies to rows inside a board, not just to
     whole sources. */
  for (const b of zeroQuote)
    withheld.push({ commodity: b.commodity, rows: 1,
      why: `${b.delivery} quotes ${b.futures || "an unnamed contract"} at 0. ` +
           `A futures quote of zero is not a quote: it makes this row's cash ` +
           `figure equal its own basis (${b.cash}) and turns the ` +
           `cash - basis = futures check into 0 == 0, which verifies nothing.` });
  const byCommodity = new Map();
  for (const b of kept) {
    const name = String(b.commodity || "(unnamed)");
    if (!byCommodity.has(name)) byCommodity.set(name, []);
    byCommodity.get(name).push(b);
  }

  const corn = [];
  for (const [name, rows] of byCommodity) {
    const band = bandFor(source, name);
    if (!band) {
      withheld.push({ commodity: name, rows: rows.length,
        why: `no band configured and none of the defaults match "${name}". ` +
             `Add it to this source's bands, or to DEFAULT_BANDS, to publish it.` });
      continue;
    }
    const bad = rows.find((b) => b.cash == null);
    if (bad) throw new Refused(`${bad.delivery} ${name} has no cash bid`);

    /* OUT OF BAND: ALL vs SOME, because they mean different things.
     *
     * SOME rows outside a band the rest of the commodity sits inside is the
     * decimal-point case the band exists to catch -- one number is wrong, and
     * a wrong number must never publish. Refuse the board.
     *
     * ALL rows outside says the BAND is wrong, not the prices: the wrong
     * units, or a commodity we have mis-matched. Refusing the whole elevator
     * because they started buying something quoted per ton would be the tail
     * wagging the dog. Withhold that commodity, name it, publish the rest. */
    const outside = rows.filter((b) => b.cash < band.floor || b.cash > band.ceiling);
    if (outside.length && outside.length < rows.length) {
      const o = outside[0];
      throw new Refused(`${o.delivery} ${name} is ${o.cash}, outside ` +
        `${band.floor} to ${band.ceiling} (${band.named} band), while ` +
        `${rows.length - outside.length} other ${name} row(s) are inside it. ` +
        `One row out of a band its own commodity sits inside is a bad number.`);
    }
    if (outside.length === rows.length) {
      withheld.push({ commodity: name, rows: rows.length,
        why: `every row (${rows.map((b) => b.cash).join(", ")}) is outside the ` +
             `${band.floor}-${band.ceiling} ${band.named} band. That reads as the wrong ` +
             `band or the wrong units for this commodity, not as bad prices. ` +
             `Give it its own band on this source to publish it.` });
      continue;
    }
    corn.push(...rows);
  }

  if (!corn.length)
    throw new Refused(`nothing publishable at ${source.location}. Page had: ` +
      `${[...byCommodity.keys()].join(", ") || "nothing"}` +
      (withheld.length ? ` -- all withheld: ${withheld.map((w) => w.commodity).join(", ")}` : ""));

  const file = {
    /* Defaults keep the Boyceville file byte-identical; every other source
       overrides them from its manifest row. The schema string is part of the
       contract with the Emmert Worker, so it is defaulted, not computed. */
    schema: source.schema ?? "bigriver-boyceville/2",
    /* NO top-level `id`. It was added here and test/board.test.mjs caught it:
       the committed key set is pinned so a new key cannot churn the file on
       the next poll, and the Emmert Worker reads this shape. The source id is
       the FILENAME (data/<id>.json) and data/index.json is the map. */
    source: {
      name: source.operator ?? "Big River Resources",
      location: source.location,
      locationId: source.locationId,
      /* Published so a consumer can place this elevator without going back to
         the manifest. A price with no position is not usable on a map. */
      zip: source.zip ?? null,
      lat: source.lat ?? null,
      lon: source.lon ?? null,
      /* HOW A FARMER ACTUALLY REACHES THEM. A bid nobody can act on is
         trivia: every board on this site says "call to confirm", and the
         number to call belongs beside the price, not two clicks away. */
      contact: {
        phone: source.phone ?? null,
        email: source.email ?? null,
        website: source.website ?? null,
      },
      url: sourceUrl,
      note: source.publicNote ??
            "Their posted cash board, read by arrangement. Cash and basis are their own " +
            "commercial numbers. The futures quote is carried only so a consumer can " +
            "re-check cash minus basis; it is not redistributed as a price feed.",
    },
    /* TWO CLOCKS, AND THEY MEAN DIFFERENT THINGS.
         pricedAt   when their board last showed something different
         checkedAt  when we last successfully read it
       Collapsing them is a bug that was shipped and caught: with one timestamp
       that only moved when the price moved, a quiet weekend was indistinguish-
       able from a dead reader. On Monday the figure was 63 hours old, every
       downstream check failed, and both Emmert sites would have withdrawn a
       perfectly good price. A price being old is normal. Not having looked
       is not.

       buildFile stamps both with `now` because it cannot know the history.
       decide() carries the old pricedAt forward when the price has not moved.
       That split is why buildFile stays pure. */
    checkedAt: now,
    pricedAt: now,
    status: "ok",
    count: corn.length,
    /* With a null locationId there is no id to exclude by, and the guard above
       has already established the page names exactly one place -- so there is
       nothing else on it to report. Without this, `l.includes(null)` searched
       every label for the literal text "null" and listed our own location as
       somebody else's. */
    otherLocationsOnPage: normLocationId(source.locationId) === null
      ? [] : locations.filter((l) => !l.includes(String(source.locationId))),
    bids: corn
      .slice()
      .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999))
      .map((b, i) => ({
        seq: i,                                    // 0 = nearest delivery
        commodity: b.commodity,
        delivery: b.delivery,                      // "August", their own wording
        futuresMonth: (b.futures || "").replace(/\s*corn\s*$/i, "").trim() || null,
        cash: b.cash,                              // dollars
        basisDollars: b.basis,                     // dollars
        basisCents: b.basisCents,                  // cents
        /* THEIR QUOTE, INCLUDING WHEN IT LAGGED BY A TICK.
         *
         * This was briefly nulled on any row whose identity did not balance,
         * on the reasoning that a figure we could not check should not reach
         * a customer. Over-cautious, and it cost twice: it took both Emmert
         * sites dark when the consumer read null as a broken feed, and it
         * left a blank in the futures column of a live page.
         *
         * The caution was already spent by then. Nothing reaches this line
         * unless a MAJORITY of rows balanced to the cent -- which is what
         * proves the columns are right -- and unless every disagreement is
         * within a tick or two. What is left over is Big River's own
         * published cell, a quarter of a cent behind their own cash. That is
         * their number, not our guess, and it belongs on the page.
         *
         * `null` still travels for a row where they published no quote at
         * all, and the pages still print a dash for it. */
        futuresPriceCents: b.futuresPrice ?? null,
      })),
  };

  /* Their Last Trade stamps, for the log line only. Deliberately not in
     `file`: it moves on nearly every poll, and priceChanged() diffs the
     published rows, so carrying it would commit a price change every few
     minutes that recorded nothing but their clock. */
  const boardAt = [...new Set(corn.map((b) => b.futuresAt).filter(Boolean))];

  /* `withheld` is a DIAGNOSTIC, not a file key. test/board.test.mjs pins the
     committed key set so a new key cannot churn the file on the next poll, and
     the Emmert Worker reads this shape. It travels in the return value, into
     data/index.json and onto the status board instead. */
  return { file, dropped, locations, verified: verifiable.length, boardAt, withheld };
}

/* Did anything a reader would care about change?
 *
 * Compares ONLY what was observed on their board: the rows and how many there
 * are. Deliberately ignores both clocks -- a new checkedAt is not news -- and
 * deliberately ignores `status`.
 *
 * `status` used to be compared here, back when it was always the literal "ok"
 * and the comparison was therefore free. It is not free any more: decide() now
 * writes status "stale" when a board has shown the same numbers for a fortnight.
 * With status in this comparison, the very next poll saw our own annotation
 * differ from buildFile's fresh "ok", called it a price change, and stamped
 * pricedAt as now -- so the file that had just correctly reported a frozen
 * board immediately erased the evidence and looked fresh again. Caught by
 * simulating thirty days before it shipped.
 *
 * The rule this encodes: never diff a field you write yourself against a field
 * they publish. */
export const priceChanged = (before, after) =>
  !before || JSON.stringify(before.bids) !== JSON.stringify(after.bids) ||
  before.count !== after.count;

/* THE MAX-MOVE RAIL.
 *
 * This did not exist, and parse.mjs's header claimed it did: "The sanity band,
 * the max-move rail and the freshness gate all test whether a value looks
 * reasonable." Two of those three were fiction, so anyone reading the code's
 * own documentation believed a rail was protecting them.
 *
 * WHAT IT CATCHES THAT NOTHING ELSE DOES. Their futures quote glitches -- Dec
 * corn prints 584 instead of 484 -- and their board recomputes cash from it:
 * cash 5.29, basis -0.55. Now run every guard we have. 5.29 - (-0.55) = 5.84 =
 * 584c, so the identity check PASSES; the columns really are correct, the
 * inputs are not. 5.29 is inside the 2.00-12.00 sanity band. Corn rows present,
 * location present, all seven rows verifiable. The file publishes, and both
 * Emmert sites carry a corn bid a dollar over the market for up to fourteen
 * hours, with checkedAt perfectly fresh so nothing downstream objects. When
 * their board corrects, ours corrects silently too. The only trace is two
 * commits.
 *
 * The identity check proves a number came from the right COLUMN. It can say
 * nothing about MAGNITUDE. This is the guard for magnitude.
 *
 * Compared against the last COMMITTED read, which is at most a heartbeat old.
 * A delivery month with no previous reading is skipped -- new months appear on
 * their board all the time and have nothing to move from.
 */
export const MAX_MOVE = 0.75;

export function checkMove(previous, next, { maxMove = MAX_MOVE } = {}) {
  if (!previous || !Array.isArray(previous.bids)) return [];   // first run
  const before = new Map(previous.bids.map((b) => [rowKey(b), b]));
  const out = [];
  for (const b of next.bids) {
    const was = before.get(rowKey(b));
    if (!was || was.cash == null || b.cash == null) continue;
    const move = b.cash - was.cash;
    if (Math.abs(move) > maxMove)
      out.push({ commodity: b.commodity ?? null, delivery: b.delivery, from: was.cash, to: b.cash, move });
  }
  return out;
}

/* One serialisation, used by both readers and by the tests. If the Worker and
   the Action format the same object differently, git sees a change that isn't
   one and the history fills with noise. */
export const serialise = (file) => JSON.stringify(file, null, 2) + "\n";

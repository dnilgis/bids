#!/usr/bin/env node
/* EVERY MARKET A GRADABLE PARTNER RUNS, FROM THEIR OWN BOOTSTRAP.
 *
 * POET's public site loads one 202 KB response before it draws anything:
 *
 *     GET https://poet.gradable.com/api/commodities/merchandising/bootstrap
 *
 * and it names all THIRTY-SIX of their plants, each with a market id, a street
 * address, a state, a postcode and a coordinate their own geocoder produced.
 * The same call on adm.gradable.com does it for ADM. That body is committed as
 * fixtures/gradable-poet-bootstrap.json, captured in run 92448826700.
 *
 * WHY THIS MATTERS MORE THAN ONE ADAPTER. Every DTN manifest in this repository
 * carries `lat: null, lon: null` and the line "nobody has derived a coordinate
 * for this location and none will be invented", because the DTN payload holds a
 * location name and an id and nothing else. This payload holds the address.
 * Thirty-six towns that would otherwise each be a geocoding job are a read.
 *
 * IT WRITES NO SOURCE FILE. It prints skeletons for a person to look at, the
 * same contract scripts/dtn-probe.mjs keeps. `enabled` is false on every one:
 * an adapter proven against one market's bytes is not thirty-six boards proven.
 *
 *   node scripts/gradable-markets.mjs fixtures/gradable-poet-bootstrap.json
 *   node scripts/gradable-markets.mjs <body.json> --partner adm
 *   node scripts/gradable-markets.mjs <body.json> --json   # skeletons only
 */
import { readFileSync } from "node:fs";
import { marketsFrom, boardUrl } from "../lib/adapters/gradable.mjs";
import { countryOfState, CURRENCY_OF_COUNTRY } from "../lib/currency.mjs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] ?? d; };
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);

/* A slug from THEIR name, never from a guess about the town. "Big Stone City,
   SD" is display_name; the id keeps the state so two towns of one name in two
   states cannot collide the way Gaylord MN and Gaylord KS did. */
export const slugOf = (displayName) =>
  String(displayName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 26);

/* `capture` names where these bytes came from. It used to be a hardcoded
   "captured 2026-09-07 (discover run 92448826700)" inside the note, which was
   POET's capture and would have been printed on 152 ADM files. */
export function skeletonFor(m, partner, operatorSlug, capture = "capture not stated") {
  return {
    id: `${operatorSlug}-${slugOf(m.displayName)}`,
    operator: m.company ?? "SET THIS",
    location: m.city ?? m.displayName,
    state: m.state ?? "SET THIS",
    platform: "gradable",
    url: boardUrl(m.marketId, partner),
    /* A browser source has TWO urls and needs both. Theirs is the market page
       their own widget runs on. */
    browserPage: m.urlPath
      ? `https://${partner}.gradable.com/market${m.urlPath}`
      : `https://${partner}.gradable.com/market`,
    locationId: String(m.marketId),
    bands: {},                       // filled from the crops the board returns
    cadence: "grain-day",
    provenance: "scraped",
    enabled: false,
    /* THE ROUNDING IS THIS MARKET'S OWN, OR IT IS NOTHING — 2026-09-15.
     *
     * This line used to be the literal string "floor-cent" for every market,
     * with a note beside it saying "Their board declares cash_bid_rounding_mode
     * always_down". That sentence is true of POET and false of ADM, and until
     * ADM's bootstrap was captured whole there was no way to find out.
     *
     * Measured on fixtures/gradable-adm-bootstrap.json, 152 markets:
     *
     *     commodity_settings == {}   152 of 152
     *     declaredRounding == null   152 of 152
     *
     * POET declares a mode per market and says three different ones — 17
     * always_down, 10 half_down, 6 half_up, 2 absent. ADM declares none at
     * all. Writing "floor-cent" into 152 files would have put a number nobody
     * measured next to a note claiming their board said it.
     *
     * So it is theirs when they state one, and null when they do not, and a
     * null here is a manifest lib/adapters/gradable.mjs REFUSES to publish
     * until somebody counts the residuals on that market's own board. */
    cashRounding: m.cashRounding ?? null,
    cashRoundingCents: m.cashRounding ? 0 : null,
    /* THEIR OWN country_code, not an inference from the state. `currency` is
       deliberately absent here: lib/currency.mjs ranks a manifest's declaration
       BELOW what the feed states per row, and nothing in a bootstrap states a
       currency. It is filled from a board read or it is left out. */
    country: m.countryCode ?? null,
    lat: m.lat, lon: m.lon,
    zip: m.zip, address: m.address,
    phone: null, email: null,
    website: `https://${partner}.gradable.com/market${m.urlPath ?? ""}`,
    inMerge: true,
    note: `BUILT FROM ${partner.toUpperCase()}'S OWN BOOTSTRAP, ${capture}. ` +
          `market id, display name, address, state, zip and the coordinate are copied ` +
          `verbatim from that payload and nothing was looked up or derived. The coordinate ` +
          `is their geocoder's, recorded under geocodes["Google/Address"]. ` +
          (m.declaredRounding
            ? `Their board declares cash_bid_rounding_mode ${JSON.stringify(m.declaredRounding)}; ` +
              `cashRounding is that and not a count.`
            : `THEIR PAYLOAD DECLARES NO ROUNDING — commodity_settings is empty on this market — ` +
              `so cashRounding is null and no value has been assumed. It has to be counted from ` +
              `this market's own board before this file can publish anything.`),
    publicNote: "Their publicly posted cash board, read from the feed their own market page " +
      "asks for. Cash and basis are their own commercial numbers. The futures quote is " +
      "carried only so a consumer can re-check cash minus basis; it is not redistributed " +
      "as a price feed.",
    _pending: `HELD DISABLED. bands is empty until a read says which crops this market posts` +
      (m.declaredRounding ? `.` : `, and cashRounding is null until somebody counts the ` +
        `residuals on its board. Two measurements, both missing.`),
  };
}

/* ---------------------------------------------------------------------------
 * FILLING A SKELETON FROM A BOARD READ.
 *
 * `bands` and `cashRounding` are the two fields lib/sources.mjs will not let a
 * manifest publish without, and neither is in the bootstrap. Both are in
 * data/gradable/<partner>-boards.json, which scripts/gradable_boards.mjs wrote
 * by reading the boards themselves.
 *
 * NOTHING HERE DECIDES ANYTHING. A band is the band lib/board.mjs already
 * carries for that crop, copied out of the report. A rounding mode is the mode
 * the residuals admitted, copied out of the report. A crop the report could not
 * band gets NO band — it is named in the note and its rows are withheld, which
 * is what withholding is for.
 * ------------------------------------------------------------------------- */

/* TWO TESTABLE ROWS, NOT ONE. lib/rounding.mjs requires a margin of 2 before it
   will state a mode, because "one disagreeing row can be a typo on somebody's
   board and two independent ones are not". `exact` is exempt from that margin
   inside roundingEvidence — it is the absence of a rule rather than a rule — so
   a single row that happens to reconcile would come back "exact" with a sample
   of one. That is not enough to enable a board on. */
export const MIN_TESTABLE_TO_ENABLE = 2;

/** Index a boards report by market id. Reads, decides nothing. */
export function readingsByMarket(report) {
  const out = new Map();
  for (const m of report?.markets ?? []) out.set(String(m.marketId), m);
  return out;
}

/** Why this report may not be used, or null. */
export function reportRefusal(report, partner) {
  if (!report || typeof report !== "object") return "the boards report is not an object";
  if (report.transport === "rehearsal")
    return `that report is a REHEARSAL — one board replayed for every market. Its crops and ` +
           `residuals are one facility's, copied. It can never become a manifest.`;
  if (report.partner !== partner)
    return `the report is ${JSON.stringify(report.partner)} and this run is ${JSON.stringify(partner)}. ` +
           `One partner's crops must never be written into another's files.`;
  if (!Array.isArray(report.markets) || !report.markets.length)
    return "the report names no market";
  return null;
}

/** The bands a market's own board says it needs, and the crops that get none. */
export function bandsFromReading(reading) {
  const bands = {};
  const unbanded = [];
  for (const c of reading?.crops ?? []) {
    if (!c.band || !Array.isArray(c.range) || c.range.length !== 2) {
      unbanded.push(`${c.code} ${c.commodity}`);
      continue;
    }
    /* Several of their codes land on one band name — 11, 16 and U9 are all soft
       and hard red winter wheat. Writing the same pair twice is not a conflict;
       writing two DIFFERENT pairs under one name would be, and that is the case
       this refuses rather than letting the last one win. */
    const prev = bands[c.band];
    if (prev && (prev[0] !== c.range[0] || prev[1] !== c.range[1]))
      throw new Error(`${reading.marketId}: two different bands for "${c.band}" — ` +
                      `${JSON.stringify(prev)} and ${JSON.stringify(c.range)}`);
    bands[c.band] = [c.range[0], c.range[1]];
  }
  return { bands, unbanded };
}

/**
 * A skeleton with what the board read, filled in.
 *
 * `enabled` stays false unless `enable` is asked for AND the market cleared
 * every measurement: a band for at least one crop, a rounding mode the
 * residuals established, and enough testable rows to have established it.
 */
export function fillFromReading(skel, reading, { enable = false, failure = null } = {}) {
  const out = { ...skel };

  if (!reading) {
    out._pending = failure
      ? `HELD DISABLED. Its board was asked and did not read: ${failure}`
      : `HELD DISABLED. No board read covers this market, so bands is empty.`;
    return out;
  }

  const { bands, unbanded } = bandsFromReading(reading);
  out.bands = bands;

  const mode = reading.rounding?.confident ?? null;
  const testable = reading.rounding?.testable ?? 0;
  /* ABSENT, NOT NULL, AND THAT IS NOT A STYLE CHOICE — found by running it.
     lib/sources.mjs line 233 tests `s.cashRounding !== undefined`, so a null
     lands in the membership check and comes back `cashRounding "null" is not
     one of exact, floor-cent, ...`. Every one of 152 manifests was refused by
     the loader on exactly that. The committed POET manifests that declare no
     mode leave the KEY OUT, and so does this. */
  delete out.cashRounding;
  delete out.cashRoundingCents;
  if (mode === "exact") {
    /* lib/board.mjs, on roundingRule: "Leave it out for a board whose cash cell
       is the arithmetic to the last digit." So no mode is named and the
       tolerance is zero — the strictest the identity guard goes. */
    out.cashRoundingCents = 0;
  } else if (mode) {
    out.cashRounding = mode;
    out.cashRoundingCents = 0;
  }

  /* THE CURRENCY, BY WHICHEVER OF THEIR OWN FACTS ESTABLISHES IT — 2026-09-15.
   *
   * Their board rows carry `currency`, and lib/adapters/gradable.mjs now reads
   * it. But the first ADM run showed three Ontario markets — Blenheim,
   * Maidstone and Alvinston — whose rows state NO currency at all:
   * `currenciesSeen: []`, in bushels, posting Canadian corn, soybeans and
   * wheat. An earlier version of this held all three for it.
   *
   * THAT HOLD WAS STRICTER THAN THE REPOSITORY'S OWN RULE, and it was keeping
   * three real elevators off the board for a reason nothing requires.
   * lib/currency.mjs ranks the ways a currency can be known — payload,
   * declared, province — and both Canadian sources publishing TODAY sit on the
   * middle one: sources/addisgrain-oromedonte.json declares `"currency":
   * "CAD"` and data/addisgrain-oromedonte.json publishes `currencyVia:
   * "declared"`.
   *
   * So this does what Addis Grain does. Their rows first, because that is the
   * strongest tier there is. Failing that, their own `country_code` — "CAN" on
   * thirteen ADM markets, read from their payload, not inferred from a state
   * table — through CURRENCY_OF_COUNTRY, which is this repository's own.
   *
   * NEITHER IS A GUESS, AND BOTH ARE SELF-CHECKING. resolveCurrency reads the
   * feed before it reads the manifest and REFUSES when they disagree: "the
   * manifest declares CAD and the feed states USD on every row. The feed is the
   * elevator's own word and the manifest is ours, so ours is the one that is
   * wrong." A currency derived here that turns out wrong fails loudly on the
   * next pass rather than publishing.
   *
   * TWO CURRENCIES ON ONE BOARD IS STILL A HOLD, and it is not a nicety:
   * resolveCurrency THROWS on that, every pass, forever. Webberville, MI quotes
   * both CAD and USD. */
  const stated = reading.currency ?? null;
  const fromCountry = out.country ? (CURRENCY_OF_COUNTRY[out.country] ?? null) : null;

  /* WHEN THEIR OWN TWO FACTS DISAGREE, THIS DECLARES NEITHER — found by
   * building all 122 and loading them, 2026-09-15.
   *
   * Velva and Enderlin, North Dakota, are ADM canola plants. Their payload says
   * `country_code: "USA"` and their rows quote CAD per metric tonne, which is
   * how a US canola crush prices off the ICE Canada contract. Writing either
   * one as `currency` produced
   *
   *     "adm-velvand": country US and currency CAD disagree
   *
   * from lib/sources.mjs — twice, in every pass, on files that are DISABLED,
   * because loadSources validates before it skips a disabled source.
   *
   * Leaving the key out is not a dodge, it is the safe answer: resolveCurrency
   * reads the FEED before the manifest, so if either of these is ever enabled
   * its rows' own CAD wins on the `payload` tier — the strongest there is —
   * and no declaration of ours can overrule it. The market is held either way,
   * and the note records both facts. */
  const disagree = Boolean(stated && out.country && CURRENCY_OF_COUNTRY[out.country] !== stated);
  /* A BOARD QUOTING TWO CURRENCIES GETS NEITHER, AND GETS NOTHING FROM ITS
     COUNTRY EITHER. Falling back to the country there would stamp CAD on
     Webberville, MI — a board that quotes both CAD and USD — on the strength of
     a country that says nothing about which row is which. */
  const twoMoneys = (reading.currenciesSeen ?? []).length > 1;
  /* ONE DECISION, NOT TWO. The value and the sentence that says where it came
     from were computed by separate expressions, so reversing the precedence
     moved the value and left the note claiming the old source. Both come off
     the same list now, in order, and the note names whichever entry won. */
  const sources = [
    ["their board's own rows", stated],
    [`their payload's country_code (${out.country})`, fromCountry],
  ];
  const won = disagree || twoMoneys ? null : sources.find(([, v]) => v);
  const currency = won ? won[1] : null;
  const currencyVia = won ? won[0] : null;
  if (currency) out.currency = currency;
  else delete out.currency;

  const why = [];
  if (twoMoneys)
    why.push(`their rows state two currencies (${reading.currenciesSeen.join(", ")}) — ` +
             `lib/currency.mjs refuses a board that cannot say which money it is in`);
  else if (!disagree && !currency)
    why.push(`nothing establishes which money this board is in: their rows state none ` +
             `and their payload names no country`);
  /* A country their payload names and a currency their rows state must agree.
     lib/sources.mjs refuses the pair outright; this catches it before the file
     is written and says which two disagreed. */
  if (disagree)
    why.push(`their payload puts this market in ${out.country} and their rows quote ${stated}, ` +
             `so this file declares no currency and their rows would decide it`);

  /* EVERY ROW IN A UNIT THE BANDS ARE NOT IN. Watson SK, Carberry MB and
     Lloydminster AB post canola and nothing else, all of it per metric tonne.
     lib/board.mjs's canola band is [6, 35] PER BUSHEL; a tonne price is two
     orders of magnitude outside it and would be withheld row by row anyway.
     Holding the market says so once, instead of publishing a source that
     withholds everything it reads. */
  if (reading.rows > 0 && reading.rowsNotInBushels === reading.rows)
    why.push(`all ${reading.rows} of its rows are priced in ${(reading.units ?? []).join(", ") || "a unit it did not state"}, ` +
             `and every band in lib/board.mjs is per bushel`);
  if (!Object.keys(bands).length) why.push("their board posted no crop this repository has a band for");
  if (!mode) why.push(`the residuals established no rounding mode (${reading.roundingSaid ?? "not stated"})`);
  else if (testable < MIN_TESTABLE_TO_ENABLE)
    why.push(`only ${testable} testable row(s) — ${MIN_TESTABLE_TO_ENABLE} is the floor for stating a mode`);

  out.enabled = Boolean(enable && !why.length);

  out.note = `${skel.note} ` +
    (currency ? `CURRENCY IS ${currency}, FROM ${currencyVia}. ` : ``) +
    `BANDS AND ROUNDING COME FROM A BOARD READ, not from this payload: ` +
    `${reading.rows} row(s) over ${reading.crops.length} of their commodity codes, ` +
    `${testable} of them testable against cash - basis = futures, and the residuals ` +
    `${mode === "exact" ? `were zero on every one — so no cashRounding is declared and the ` +
      `identity guard stays exact` : mode ? `admit ${JSON.stringify(mode)} and nothing narrower` :
      `admit no single mode`}. ` +
    (unbanded.length
      ? `THEIR BOARD ALSO POSTS ${unbanded.join(", ")}, which lib/board.mjs has no band for; ` +
        `those rows are withheld loudly rather than published under a band nobody set.`
      : `Every crop their board posted has a band.`);

  out._pending = why.length
    ? `HELD DISABLED: ${why.join("; ")}.`
    : (out.enabled ? undefined : `Measured and ready. Not enabled because --enable was not asked for.`);
  if (out._pending === undefined) delete out._pending;
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("gradable-markets.mjs")) {
  if (!file) { console.error("usage: gradable-markets.mjs <bootstrap-body.json> [--partner poet] [--json]"); process.exit(2); }
  const partner = flag("partner", "poet");
  const operatorSlug = flag("slug", partner === "poet" ? "poetgrain" : partner);
  const capture = flag("capture", `captured from ${file}`);
  const markets = marketsFrom(readFileSync(file, "utf8"));

  const live = markets.filter((m) => !m.demo && m.publicSite);
  const skipped = markets.filter((m) => m.demo || !m.publicSite);

  /* --boards fills bands and cashRounding from a committed board read. Without
     it every skeleton comes out with empty bands and held disabled, which is
     what this script did before the boards job existed. */
  const boardsPath = flag("boards", null);
  let readings = new Map(), failures = new Map(), report = null;
  if (boardsPath) {
    report = JSON.parse(readFileSync(boardsPath, "utf8"));
    const why = reportRefusal(report, partner);
    if (why) { console.error(`::error::${why}`); process.exit(1); }
    readings = readingsByMarket(report);
    for (const f of report.failures ?? []) failures.set(String(f.marketId), f.why);
  }
  const enable = args.includes("--enable");
  if (enable && !boardsPath) {
    console.error("::error::--enable needs --boards. Nothing is enabled on a payload nobody read.");
    process.exit(1);
  }

  const build = (m) => {
    const skel = skeletonFor(m, partner, operatorSlug, capture);
    if (!boardsPath) return skel;
    return fillFromReading(skel, readings.get(String(m.marketId)),
                           { enable, failure: failures.get(String(m.marketId)) ?? null });
  };

  /* A MANIFEST WITH NO BAND IS NOT A FILE, IT IS THIRTY ERRORS A PASS.
     lib/sources.mjs refuses an empty `bands` and loadSources validates BEFORE
     it skips a disabled source, so writing the markets whose boards were never
     read would put an error per file into every run of the feed — measured at
     30 of 152 on the first build. A market with no board read gets no file at
     all; it is reported below and it waits for a read. */
  const publishable = (x) => Object.keys(x.bands ?? {}).length > 0;

  if (args.includes("--json")) {
    const built = live.map(build);
    console.log(JSON.stringify(boardsPath ? built.filter(publishable) : built, null, 2));
    process.exit(0);
  }

  if (boardsPath) {
    const all = live.map(build);
    const built = all.filter(publishable);
    const noFile = all.filter((x) => !publishable(x));
    const on = built.filter((x) => x.enabled);
    console.log(`${live.length} live market(s); ${readings.size} covered by ${boardsPath}` +
                ` (read ${report.capturedAt ?? "at an unstated time"} over ${report.transport}).\n`);
    const heldWhy = new Map();
    for (const x of built.filter((y) => !y.enabled))
      heldWhy.set(x._pending ?? "no reason recorded", (heldWhy.get(x._pending ?? "no reason recorded") ?? 0) + 1);
    console.log(`${built.length} manifest(s) written, ${noFile.length} market(s) get NO FILE ` +
                `(no band, so lib/sources.mjs would refuse them every pass).`);
    console.log(`${on.length} would publish${enable ? "" : " if --enable were asked for"}; ` +
                `${built.length - on.length} written but held.`);
    for (const [why, n] of [...heldWhy].sort((a, b) => b[1] - a[1]))
      console.log(`    ${String(n).padStart(4)}  ${why}`);
    const bandCounts = new Map();
    for (const x of built) for (const b of Object.keys(x.bands ?? {}))
      bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
    console.log(`\nbands written, by how many manifests carry them:`);
    for (const [b, n] of [...bandCounts].sort((a, b2) => b2[1] - a[1]))
      console.log(`    ${String(n).padStart(4)}  ${b}`);
    console.log(`\n--json prints them. Every enabled one has a band and a measured rounding.`);
    process.exit(0);
  }

  console.log(`${markets.length} market(s) in this bootstrap; ${live.length} carry a public site ` +
              `and are not demos.\n`);
  console.log(`  ${"market id".padEnd(11)} ${"town".padEnd(24)} ${"st".padEnd(3)} ${"zip".padEnd(6)} ` +
              `${"lat".padStart(9)} ${"lon".padStart(10)} ${"public".padStart(7)}  address`);
  for (const m of live)
    console.log(`  ${String(m.marketId).padEnd(11)} ${String(m.city ?? m.displayName).slice(0, 23).padEnd(24)} ` +
                `${String(m.state ?? "?").padEnd(3)} ${String(m.zip ?? "").padEnd(6)} ` +
                `${String(m.lat ?? "").padStart(9)} ${String(m.lon ?? "").padStart(10)} ` +
                `${String(m.publicInstruments ?? "").padStart(7)}  ${m.address ?? ""}`);
  for (const m of skipped)
    console.log(`  SKIPPED ${m.displayName} — ${m.demo ? "demo_market" : "no public site"}`);
  const total = live.reduce((a, m) => a + (m.publicInstruments ?? 0), 0);
  console.log(`\n${total} public instrument(s) across ${live.length} market(s), by their own count.`);
  console.log(`--json prints the manifest skeletons. Every one is enabled:false.`);
}

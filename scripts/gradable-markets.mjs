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

if (process.argv[1] && process.argv[1].endsWith("gradable-markets.mjs")) {
  if (!file) { console.error("usage: gradable-markets.mjs <bootstrap-body.json> [--partner poet] [--json]"); process.exit(2); }
  const partner = flag("partner", "poet");
  const operatorSlug = flag("slug", partner === "poet" ? "poetgrain" : partner);
  const capture = flag("capture", `captured from ${file}`);
  const markets = marketsFrom(readFileSync(file, "utf8"));

  const live = markets.filter((m) => !m.demo && m.publicSite);
  const skipped = markets.filter((m) => m.demo || !m.publicSite);

  if (args.includes("--json")) {
    console.log(JSON.stringify(live.map((m) => skeletonFor(m, partner, operatorSlug, capture)), null, 2));
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

#!/usr/bin/env node
/* WHAT IS BEHIND A DTN CONTENT SERVICES SITE ID, AND WHAT WOULD ITS MANIFESTS SAY?
 *
 *   GET https://api.dtn.com/markets/sites/<siteId>/cash-bids?units=us
 *   GET https://api.dtn.com/markets/sites/<siteId>/locations?units=us
 *   header: apikey: <key>
 *
 * One site id can carry a whole co-operative: Ag Partners' e0172401 returns
 * 176 records across THIRTEEN locations. So the expensive part of adding one of
 * these is not the adapter -- that is written -- it is finding out what came
 * back and writing thirteen manifests without inventing anything. This does
 * that part and writes nothing.
 *
 * WHY IT RUNS ON THE RUNNER. It needs a Chromium and real network, and the
 * sandbox has neither pointed at api.dtn.com. On the runner it is one
 * workflow_dispatch. Premier Cooperative (E0266901) is the next one: whether it
 * is three towns or thirty is one run away.
 *
 *   node scripts/dtn-probe.mjs --site E0266901 --page https://www.premiercooperative.com/agricultural/detailed-cash-bids
 *   node scripts/dtn-probe.mjs --site e0172401 --fixture fixtures/dtn-cs-agpartners-e0172401.json
 *
 * IT LOADS A PAGE RATHER THAN CALLING THE API, and it holds no key. DTN
 * answered the first version of this from the runner with "The api key is
 * valid, but it is valid to be used within a browser only" -- their gateway
 * scopes widget keys to browser use, so a server-side call cannot work however
 * valid the key is. The customer's own page carries their key in the clear,
 * because that is the only way a browser widget can work at all, so loading
 * that page needs nothing from us. See lib/cdp.mjs.
 *
 * THE ROUNDING MODE IS MEASURED, NOT GUESSED. `cashRounding` decides whether a
 * board's cash cell is the arithmetic exactly, rounded, or floored, and getting
 * it wrong either refuses a good board or loosens the one guard that proves the
 * columns are right. So the probe counts, per location, how many rows each rule
 * explains, and prints the residuals it actually saw. The manifest then states
 * what was observed. Ag Partners: floor 25 of 25, round 11 of 25, exact 4 of 25,
 * residuals {0, 0.25, 0.75} -- which is the eighths remainder and nothing else.
 */
import { readFileSync } from "node:fs";
import { extract } from "../lib/adapters/dtn-cs.mjs";
import { capture } from "../lib/cdp.mjs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] ?? d; };
const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)";
const BASE = flag("base", "https://api.dtn.com/markets");

/* ---- the measurement ----------------------------------------------------- */

/** Which rule explains this board's cash cell? Counts, never a conclusion. */
export function roundingEvidence(rows) {
  const cents = (n) => Math.round(n * 100);
  let exact = 0, round = 0, floor = 0, testable = 0;
  const residuals = new Set();
  for (const r of rows) {
    if (r.cash == null || r.basis == null || r.futuresPrice == null) continue;
    testable++;
    const derived = cents(r.basis) + r.futuresPrice;
    const cash = cents(r.cash);
    if (Math.abs(derived - cash) < 1e-9) exact++;
    if (Math.round(derived) === cash) round++;
    if (Math.floor(derived + 1e-9) === cash) floor++;
    residuals.add(Math.round((derived - cash) * 1000) / 1000);
  }
  /* Named only when a rule explains EVERY testable row. A rule that explains
     most of them explains none of them: the rows it misses are the ones that
     would have told us something. */
  let mode = null;
  if (testable && exact === testable) mode = "exact";
  else if (testable && floor === testable) mode = "floor-cent";
  return {
    testable, exact, round, floor, mode,
    residuals: [...residuals].sort((a, b) => a - b),
  };
}

/** One manifest per location, with everything the feed knows and nothing else. */
export function skeleton(rows, { siteId, url, page, operator }) {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.locationId)) byId.set(r.locationId, []);
    byId.get(r.locationId).push(r);
  }
  const out = [];
  for (const [locationId, mine] of byId) {
    const ev = roundingEvidence(mine);
    const commodities = [...new Set(mine.map((r) => r.commodity))].sort();
    /* Only the bands the feed's own commodities need. A band for something they
       do not post is a guess about a board nobody has read. */
    const bands = {};
    for (const c of commodities) {
      const k = c.toLowerCase();
      if (k.includes("corn")) bands.corn = [2.0, 12.0];
      else if (k.includes("soybean") || k.includes("bean")) bands.soybeans = [6.0, 25.0];
      else if (k.includes("wheat")) bands.wheat = [3.0, 20.0];
    }
    const slug = String(mine[0].location).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 22);
    out.push({
      _rows: mine.length, _commodities: commodities, _evidence: ev,
      manifest: {
        id: `${slug}`,
        operator: operator ?? "SET THIS",
        location: mine[0].location,
        state: "SET THIS",
        platform: "dtn-cs",
        url,
        /* The public page whose own widget asks for `url`. Required, because a
           browser source has two urls and needs both. */
        browserPage: page ?? "SET THIS",
        locationId,
        siteId,
        bands,
        /* Stated only when the evidence names it. Left out otherwise, which
           means the identity guard stays strict and the board will refuse
           loudly rather than publish under a mode nobody measured. */
        ...(ev.mode && ev.mode !== "exact" ? { cashRounding: ev.mode } : {}),
        cadence: "grain-day",
        provenance: "scraped",
        enabled: false,
        note: "SET THIS. Say where the location, the address and the coordinates came from.",
        cashRoundingCents: 0,
        publicNote: "Their publicly posted cash board, read from the feed their own website " +
          "reads. Cash and basis are their own commercial numbers. The futures quote is " +
          "carried only so a consumer can re-check cash minus basis; it is not " +
          "redistributed as a price feed.",
        zip: null,
        /* NULL, AND NOT A GUESS. The feed carries no coordinate. A town centroid
           is a different place from a yard -- measured at 1.4 miles on
           babgrain-auburn -- and a coordinate that is not derived from a source
           is not a coordinate. Geocode the street address and fill these in. */
        lat: null, lon: null,
        phone: null, email: null,
        website: "SET THIS",
        inMerge: true,
      },
    });
  }
  return out;
}

/* ---- the fetch ----------------------------------------------------------- */

/* KEPT, AND NOT USED BY THE SCRIPT BELOW. A direct call is still the right
   shape for any DTN endpoint that is not gated to browsers, and the header
   discipline is worth having written down: a key is a HEADER, never a query
   parameter, because this prints its URLs and this is a public repository
   whose Actions logs anybody can read. */
export async function ask(path, { key, base = BASE } = {}) {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const headers = { accept: "application/json", "user-agent": UA };
  if (key) headers.apikey = key;
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    return { url, status: res.status, ok: res.ok, body };
  } catch (e) {
    return { url, status: 0, ok: false, body: "", error: e.message };
  }
}

/* ---- the script ---------------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = flag("site");
  const fixture = flag("fixture");
  const page = flag("page");
  if (!site) { console.error("need --site <siteId>"); process.exit(2); }
  if (!fixture && !page) {
    console.error("need --page <the customer's public cash-bids page>, or --fixture <file>.\n" +
      "A direct call cannot work: DTN answers \"The api key is valid, but it is valid to be " +
      "used within a browser only\".");
    process.exit(2);
  }

  const url = `${BASE}/sites/${site}/cash-bids?units=us`;
  let body, from = url;

  if (fixture) {
    body = readFileSync(fixture, "utf8");
    console.log(`reading ${fixture} -- no browser, no request`);
  } else {
    console.log(`loading ${page} and waiting for ${BASE}/sites/${site}/cash-bids`);
    let got;
    try {
      got = await capture({ pageUrl: page, target: `${BASE}/sites/${site}/cash-bids` });
    } catch (e) {
      console.error(`::error title=nothing captured::${e.message}`);
      process.exit(1);
    }
    console.log(`captured HTTP ${got.status}, ${got.body.length} bytes from ${got.url}`);
    body = got.body;
    from = got.url;
  }

  let rows;
  try { rows = extract(body, from); }
  catch (e) { console.error(`the adapter refused it: ${e.message}`); process.exit(1); }

  const all = roundingEvidence(rows);
  console.log(`\n${rows.length} row(s), ${new Set(rows.map((r) => r.locationId)).size} location(s)`);
  console.log(`whole feed: exact ${all.exact}/${all.testable}, round ${all.round}/${all.testable}, ` +
              `floor ${all.floor}/${all.testable} -> ${all.mode ?? "NO RULE EXPLAINS EVERY ROW"}`);
  console.log(`residuals seen (cents): ${all.residuals.join(", ")}`);

  const skels = skeleton(rows, { siteId: site, url, page, operator: flag("operator") });
  for (const sk of skels) {
    console.log(`\n--- ${sk.manifest.location} (${sk.manifest.locationId}) — ${sk._rows} row(s): ` +
                `${sk._commodities.join(", ")} — ${sk._evidence.mode ?? "rounding UNRESOLVED"}`);
    console.log(JSON.stringify(sk.manifest, null, 2));
  }
  console.log(`\nWrote nothing. Fill in every SET THIS, geocode each address, then enable.`);
}

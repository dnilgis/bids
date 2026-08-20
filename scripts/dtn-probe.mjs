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
import { destinationReason } from "../lib/place.mjs";

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
     would have told us something.
     AND ONLY WHEN EXACTLY ONE RULE DOES. A board whose residuals all sit in
     [0, 0.5] is explained by floor-cent AND by round-cent, and the two are not
     the same promise -- floor would go on to accept +0.9 and round would go on
     to accept -0.4. Naming either one would be picking, and picking is what
     this function exists not to do. Say both and let a person look. */
  const explains = [];
  if (testable && exact === testable) explains.push("exact");
  if (testable && floor === testable) explains.push("floor-cent");
  if (testable && round === testable) explains.push("round-cent");
  /* `exact` subsumes the others by definition, so it is not an ambiguity. */
  const modes = explains.includes("exact") ? ["exact"] : explains;
  return {
    testable, exact, round, floor,
    modes,
    mode: modes.length === 1 ? modes[0] : null,
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
    /* IS THIS EVEN A TOWN? Half of what these boards call a "location" is a
       processor or a terminal, and a geocoder will answer for "Bunge PDC"
       without complaint. Flagged here so the person filling the manifest is
       asked rather than left to notice. */
    const notATown = destinationReason(mine[0].location);
    out.push({
      _rows: mine.length, _commodities: commodities, _evidence: ev,
      _notATown: notATown,
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

/* A LIST OF SITE IDS, BECAUSE THERE ARE EIGHT OF THEM NOW.
 *
 * The 2026-08-20 discover sweep turned up eight DTN site ids carrying
 * ninety-eight locations between them, every one readable by the adapter that
 * already exists. Eight button presses, eight logs to stitch together, is the
 * kind of friction that stops the work rather than slows it.
 *
 * One line per site:   <siteId>  <the customer's public page>  <operator name>
 *
 * The operator is the REST of the line, not a third token, because companies
 * have spaces in their names and "Country Partners Cooperative" is not three
 * co-operatives.
 */
export function parseProbeList(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
    /* A LINE THAT DOES NOT PARSE IS REPORTED, NOT SKIPPED. Silently dropping
       one is how a co-operative goes missing and nobody notices which. */
    if (!m) { out.push({ bad: line }); continue; }
    out.push({ siteId: m[1], page: m[2], operator: (m[3] ?? "").trim() || null });
  }
  return out;
}

/* ---- the script ---------------------------------------------------------- */

async function probeOne({ site, page, fixture, operator }) {
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
      /* ONE SITE FAILING MUST NOT END THE BATCH. Seven good answers are worth
         more than a clean exit code. */
      console.error(`::error title=nothing captured for ${site}::${e.message}`);
      return { site, ok: false, why: e.message };
    }
    console.log(`captured HTTP ${got.status}, ${got.body.length} bytes from ${got.url}`);
    body = got.body;
    from = got.url;
  }

  let rows;
  try { rows = extract(body, from); }
  catch (e) { console.error(`the adapter refused ${site}: ${e.message}`); return { site, ok: false, why: e.message }; }

  const all = roundingEvidence(rows);
  console.log(`\n${rows.length} row(s), ${new Set(rows.map((r) => r.locationId)).size} location(s)`);
  console.log(`whole feed: exact ${all.exact}/${all.testable}, round ${all.round}/${all.testable}, ` +
              `floor ${all.floor}/${all.testable} -> ` +
              (all.mode ?? (all.modes.length
                ? `AMBIGUOUS: ${all.modes.join(" and ")} both explain every row`
                : "NO RULE EXPLAINS EVERY ROW")));
  console.log(`residuals seen (cents): ${all.residuals.join(", ")}`);

  const skels = skeleton(rows, { siteId: site, url, page, operator });
  for (const sk of skels) {
    console.log(`\n--- ${sk.manifest.location} (${sk.manifest.locationId}) — ${sk._rows} row(s): ` +
                `${sk._commodities.join(", ")} — ${sk._evidence.mode ?? "rounding UNRESOLVED"}`);
    if (sk._notATown) console.log(`    NOT A TOWN? ${sk._notATown}`);
    console.log(JSON.stringify(sk.manifest, null, 2));
  }
  return { site, ok: true, rows: rows.length, locations: skels.length,
           flagged: skels.filter((sk) => sk._notATown).length, mode: all.mode ?? null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const listPath = flag("list");
  const jobs = listPath
    ? parseProbeList(readFileSync(listPath, "utf8"))
    : [{ siteId: flag("site"), page: flag("page"), fixture: flag("fixture"), operator: flag("operator") }];

  const broken = jobs.filter((j) => j.bad);
  for (const b of broken) console.error(`::error title=unreadable line::${b.bad}`);
  const todo = jobs.filter((j) => !j.bad);

  if (!todo.length || !todo[0].siteId) {
    console.error("need --site <siteId> with --page <url> or --fixture <file>, or --list <file>.\n" +
      "A direct call cannot work: DTN answers \"The api key is valid, but it is valid to be " +
      "used within a browser only\".");
    process.exit(2);
  }
  for (const j of todo)
    if (!j.fixture && !j.page) { console.error(`${j.siteId}: no page and no fixture`); process.exit(2); }

  const results = [];
  for (const [i, j] of todo.entries()) {
    console.log(`\n${"=".repeat(72)}\n[${i + 1}/${todo.length}] ${j.operator ?? j.siteId}  (${j.siteId})\n${"=".repeat(72)}`);
    results.push(await probeOne({ site: j.siteId, page: j.page, fixture: j.fixture, operator: j.operator }));
  }

  console.log(`\n${"=".repeat(72)}\nTALLY`);
  let towns = 0, flagged = 0;
  for (const r of results) {
    if (!r.ok) { console.log(`  FAILED   ${r.site}  ${r.why}`); continue; }
    towns += r.locations;
    flagged += r.flagged ?? 0;
    console.log(`  ok       ${r.site.padEnd(10)} ${String(r.rows).padStart(4)} row(s)  ` +
                `${String(r.locations).padStart(3)} location(s)` +
                `${r.flagged ? `, ${r.flagged} not obviously a town` : ""}  rounding: ${r.mode ?? "UNRESOLVED — do not enable"}`);
  }
  console.log(`  ${towns} location(s) across ${results.filter((r) => r.ok).length} of ${todo.length} site(s)` +
              (flagged ? `; ${flagged} need a human to say whether they are towns` : "") +
              (broken.length ? `; ${broken.length} unreadable line(s)` : ""));
  console.log(`\nWrote nothing. Fill in every SET THIS, geocode each address, then enable.`);
  if (results.some((r) => !r.ok) || broken.length) process.exitCode = 1;
}

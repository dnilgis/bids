/* MANIFESTS FOR THE CO-OPS THAT RENDER THEIR OWN BOARD, FROM CAPTURES ONLY.
 *
 *     node scripts/own-board-manifests.mjs            report only
 *     node scripts/own-board-manifests.mjs --write    write sources/<site>-<location>.json
 *
 * NEW Cooperative (lib/adapters/newcoop.mjs) and Nexus Cooperative
 * (lib/adapters/nexus.mjs) each publish every location on one page of their
 * own. Same contract as scripts/stonehedge-manifests.mjs and cih-manifests.mjs:
 * a manifest only for a location on a CAPTURED board with readable rows, whose
 * town and state the repository's own evidence settles.
 *
 * EVIDENCE: data/known-elevators.json, the frozen Barchart roster, and the state
 * licence rows in data/registries.json (Iowa's warehouse list names every NEW
 * Cooperative yard: 69 rows for 69 board locations). A label is placed when
 *   1. it IS a branch, or the town, of one of this operator's rows, in exactly
 *      one state; a trailing yard number ("Creston 1") is set aside for the
 *      match and kept in the label; or
 *   2. it writes its own "Town, ST" and is not a buyer's plant.
 * A label naming a BUYER (AGP, Cargill, POET, Valero, ADM, Golden Grain) is a
 * delivery point, not this co-op's yard. It is written only when the label
 * itself prints "Buyer Town, ST", and then with NO coordinate: the directory
 * files some of these at the co-op's own office (Nexus's "AGP Manning, IA" is
 * filed at Charles City), which would put a Manning bid 100 miles away.
 *
 * Coordinates are the roster's own town-precision ones for this operator, never
 * looked up. Rounding is measured per location on the capture. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extract as newcoop, BOARD_URL as NEWCOOP_URL } from "../lib/adapters/newcoop.mjs";
import { extract as nexus, BOARD_URL as NEXUS_URL } from "../lib/adapters/nexus.mjs";
import { bidsUrl as landusUrl, VERIFIED_BY as LANDUS_VERIFIED } from "../lib/adapters/landus.mjs";
const LANDUS_PAGE = "https://www.landus.ag/businesses/grain/grain-bids";
import { extract as cpicoop, BOARD_URL as CPI_URL } from "../lib/adapters/cpicoop.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const rd = (p) => readFileSync(ROOT + p, "utf8");
const CAPTURED = "2026-10-02";

export const SITES = {
  newcoop: { platform: "newcoop", url: NEWCOOP_URL, extract: newcoop, fixture: `fixtures/newcoop-cashbids-${CAPTURED}.html`,
             names: ["NEW Cooperative, Inc.", "New Cooperative, Inc."], operator: "NEW Cooperative, Inc.", website: "https://www.newcoop.com/", homeStates: ["IA"], browserPage: NEWCOOP_URL },
  nexus:   { platform: "nexus", url: NEXUS_URL, extract: nexus, fixture: `fixtures/nexus-cashbids-${CAPTURED}.html`,
             names: ["Nexus Cooperative"], operator: "Nexus Cooperative", website: "https://www.nexus.coop/", homeStates: ["IA", "MN"] },
  /* Cooperative Producers, Inc. bids milo per bushel as well, so its manifests carry a milo band. */
  cpicoop: { platform: "cpicoop", url: CPI_URL, extract: cpicoop, fixture: `fixtures/cpicoop-bids-${CAPTURED}.html`,
             names: ["Cooperative Producers, Inc.", "Cooperative Producers Inc", "Cooperative Producers, Inc"], operator: "Cooperative Producers, Inc.",
             website: "https://www.cpicoop.com/", homeStates: ["NE", "KS"], extraBands: { milo: [1.5, 12] } },
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/* THE ZIP TABLE, AS geocodes/places.json ALREADY HOLDS IT -- added 2026-10-02.
 * scripts/build_geocodes.py resolves every source's town through the bundled
 * `zipcodes` table and files the centroid under the source's id, saying which
 * town it resolved. Used here only when the roster has no coordinate, only
 * when the entry came from the ZIP table itself (via "zip-centroid", never a
 * copy of this manifest's own earlier value), and only when the town it
 * resolved is the town this manifest names. Town precision, and the note says
 * so. Until 2026-10-02 these manifests wrote "NO COORDINATE", which
 * scripts/geocode-fill.mjs rightly reads as "do not centroid this", so 72
 * Landus and CPI yards sat off the distance map with a confirmed town. */
const PLACES = existsSync(ROOT + "geocodes/places.json") ? JSON.parse(rd("geocodes/places.json")).places ?? {} : {};
const coordText = (c, p) => c.via === "zip"
  ? `Coordinate is the ZIP-table centroid of ${p.city}, ${p.state} (geocodes/places.json, from scripts/build_geocodes.py; town precision, which can be miles from the yard). The roster has none for it. `
  : `Coordinate is the roster's own for ${p.city}, ${p.state} (${c.precision ?? "town"} precision). `;
export function zipCentroid(id, city) {
  const e = PLACES[id];
  if (!e || e.via !== "zip-centroid" || e.precision !== "town") return null;
  if (norm(e.resolvedFrom) !== norm(city)) return null;
  if (!(e.lat > 24 && e.lat < 50 && e.lon > -125 && e.lon < -66)) return null;
  return { lat: e.lat, lon: e.lon, precision: "town", via: "zip" };
}
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const title = (s) => tidy(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
export const BUYER = /\b(agp|cargill|poet|valero|adm|golden grain|bunge|cgb)\b/i;
const STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));

export function evidence(names) {
  const want = new Set(names.map(norm));
  const known = JSON.parse(rd("data/known-elevators.json")).elevators
    .filter((e) => want.has(norm(e.facility || e.company)) && e.state)
    .map((e) => ({ src: "known", branch: tidy(e.branch), city: tidy(e.city), state: e.state, zip: e.zip || null, phone: e.phone || null }));
  const roster = JSON.parse(rd("data/roster/barchart-roster-2026-09-24.json")).facilities
    .filter((f) => want.has(norm(f.operator)))
    .map((f) => ({ src: "roster", branch: tidy(f.branch), city: tidy(f.city), state: f.state, zip: f.zip || null,
                   phone: f.phone || null, lat: f.lat ?? null, lon: f.lon ?? null, precision: f.coord_precision ?? null }));
  const reg = JSON.parse(rd("data/registries.json")).businesses
    .filter((b) => want.has(norm(b.name)) && b.state && b.city)
    .map((b) => ({ src: `registry (${b.source})`, branch: null, city: title(b.city), state: b.state, zip: b.zip || null, phone: b.phone || null }));
  return [...roster, ...known, ...reg];
}

/** Place one board label. */
export function place(label, rows) {
  const m = /^(.*?),\s*([A-Z]{2})$/.exec(tidy(label));
  const town = m && STATES.has(m[2]) ? tidy(m[1]) : tidy(label);
  const st = m && STATES.has(m[2]) ? m[2] : null;
  if (BUYER.test(label)) {
    if (!st) return { skip: `"${label}" names a buyer's plant and prints no "Town, ST", so there is no town to write` };
    const t = tidy(town.replace(BUYER, ""));
    if (!t) return { skip: `"${label}" names a buyer's plant and no town` };
    return { how: "destination", city: title(t), state: st, hits: [], destination: true };
  }
  const core = town.replace(/\s+\d+$/, "");
  const match = (r) => (r.branch && (norm(r.branch) === norm(label) || norm(r.branch) === norm(town) || norm(r.branch) === norm(core)))
                       || norm(r.city) === norm(core);
  let hits = rows.filter((r) => match(r) && (!st || r.state === st));
  const states = [...new Set(hits.map((r) => r.state))];
  if (hits.length && states.length === 1) {
    const cities = [...new Set(hits.map((r) => norm(r.city)))];
    if (cities.length === 1) return { how: "directory", city: hits[0].city, state: states[0], hits };
    const exact = hits.filter((r) => norm(r.city) === norm(core));
    if (exact.length) return { how: "directory", city: exact[0].city, state: states[0], hits: exact };
    return { skip: `"${label}" matches rows in more than one town: ${cities.join(", ")}` };
  }
  if (states.length > 1) return { skip: `"${label}" matches this operator in ${states.join(" and ")}` };
  if (st) return { how: "label", city: title(core), state: st, hits: [] };
  return { skip: `"${label}" is not a town or branch of this operator in the directory or the licence lists, and prints no state` };
}

/* LANDUS publishes its own list of locations, each with its town and state
   (/api/locations, fixtures/landus-locations-2026-10-02.json), and one bids
   request per location. Its manifests come from that list, not from rows: a
   location is written when its name and state place it by the same rules as
   the others. Only location 109 (Adair) has a captured bids response to build
   through the guards; the rest are verified by the first live poll. */
export const LANDUS = { fixture: `fixtures/landus-locations-${CAPTURED}.json`, names: ["Landus Cooperative", "Landus"],
  operator: "Landus Cooperative", website: "https://www.landus.ag/", homeStates: ["IA", "MN"] };

export function buildLandus() {
  const manifests = [], skipped = [];
  if (!existsSync(ROOT + LANDUS.fixture)) return { manifests, skipped: [{ tag: "landus", why: `no capture at ${LANDUS.fixture}` }] };
  const list = JSON.parse(rd(LANDUS.fixture));
  const ev = evidence(LANDUS.names);
  const coordOf = new Map();
  for (const r of ev.filter((x) => x.src === "roster" && x.lat != null && x.lon != null)) {
    const k = `${norm(r.city)}|${r.state}`; if (!coordOf.has(k)) coordOf.set(k, { lat: r.lat, lon: r.lon, precision: r.precision });
  }
  const owners = new Map();
  for (const [k, c] of coordOf) { const key = `${c.lat},${c.lon}`; owners.set(key, [...(owners.get(key) ?? []), k]); }
  for (const l of list) {
    const label = `${tidy(l.locationName)}, ${l.state}`;
    const tag = `landus: ${label}`;
    const p = place(label, ev);
    if (p.skip) { skipped.push({ tag, why: p.skip }); continue; }
    const k = `${norm(p.city)}|${p.state}`;
    let coord = p.destination ? null : coordOf.get(k) ?? null, coordWhy = null;
    if (!coord) coordWhy = `the roster has no coordinate for ${p.city}, ${p.state} under this operator`;
    else if ((owners.get(`${coord.lat},${coord.lon}`) ?? []).length > 1) { coordWhy = "a coordinate the roster gives two towns"; coord = null; }
    if (!coord && !coordWhy?.startsWith("a coordinate the roster gives two towns")) {
      const z = zipCentroid(`landus-${norm(l.locationName)}`, p.city);
      if (z) { coord = z; coordWhy = null; }
    }
    if (!coord && !LANDUS.homeStates.includes(p.state)) { skipped.push({ tag, why: `${p.city}, ${p.state} is outside ${LANDUS.homeStates.join("/")} with no coordinate` }); continue; }
    const zip = p.hits.map((h) => h.zip).find(Boolean) ?? null;
    const phone = p.hits.map((h) => h.phone).find(Boolean) ?? null;
    const m = {
      id: `landus-${norm(l.locationName)}`,
      operator: LANDUS.operator, location: tidy(l.locationName), state: p.state,
      platform: "landus", url: landusUrl(l.locationNumber), locationId: String(l.locationNumber),
      identityAlternative: LANDUS_VERIFIED,
      bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] },
      cadence: "grain-day", provenance: "scraped",
      /* READ THROUGH THEIR OWN PAGE, FIVE A PASS. The first live poll (run
         36964162657) asked all 50 with a plain request and www.landus.ag
         answered all 100 attempts HTTP 429, the first included: it refuses
         non-browser clients. Their page loads in a real browser, but asks for
         location 109 whatever its URL says, so lib/cdp.mjs captureFetched loads
         the page and fetches this location from inside it (PLATFORM_CAPTURE).
         PLATFORM_PACE limits a pass to five Landus locations. */
      browserPage: LANDUS_PAGE,
      enabled: true,
      note: null,
      publicNote: "Their publicly posted cash board, read from the feed their own website reads. Cash and basis are their own commercial numbers. "
        + "Their board names the futures contract and prints no price, so no futures price is republished; the CBOT quote is used only to check that the two columns were read correctly.",
      address: null, zip, lat: coord ? coord.lat : null, lon: coord ? coord.lon : null,
      ...(coord ? { latPrecision: coord.precision ?? "town" } : {}),
      phone, email: null, website: LANDUS.website, inMerge: true,
    };
    m.note = `GENERATED by scripts/own-board-manifests.mjs from ${LANDUS.fixture}, Landus's own location list (www.landus.ag/api/locations, captured ${CAPTURED}): `
      + `"${l.locationName}", ${l.state}, location number ${l.locationNumber}. Bids: ${m.url}. `
      + `PLACE: ${p.how === "directory" ? `matches ${p.hits.length} row(s) for Landus (${[...new Set(p.hits.map((h) => h.src))].join(", ")}) at ${p.city}, ${p.state}` : `Landus's own list names the town and state; no directory row for it, so no ZIP is taken`}. `
      + (coord ? coordText(coord, p) : `NO COORDINATE: ${coordWhy}. Read and published, kept off the distance map. `)
      + `IDENTITY: the board names its basis month and prints no futures price, so it publishes on identityAlternative "${LANDUS_VERIFIED}": `
      + `each row's cash - basis must land within 5c of the CBOT quote for the contract it names, from the shared quote pages. `
      + `TRANSPORT: read by loading ${LANDUS_PAGE} in a browser and fetching this location's /api/cash-bids from inside the page, the request their own location picker makes; `
      + `a plain server request is refused (HTTP 429 to all 100 attempts of the first poll, 2026-10-02). Five Landus locations are asked a pass, least recently asked first.`;
    manifests.push({ site: "landus", manifest: m, coordWhy });
  }
  return { manifests, skipped };
}

export function build() {
  const manifests = [], skipped = [];
  { const l = buildLandus(); manifests.push(...l.manifests); skipped.push(...l.skipped); }
  for (const [site, cfg] of Object.entries(SITES)) {
    if (!existsSync(ROOT + cfg.fixture)) { skipped.push({ tag: site, why: `no capture at ${cfg.fixture}` }); continue; }
    const rows = cfg.extract(rd(cfg.fixture), cfg.url);
    const ev = evidence(cfg.names);
    const coordOf = new Map();
    for (const r of ev.filter((x) => x.src === "roster" && x.lat != null && x.lon != null)) {
      const k = `${norm(r.city)}|${r.state}`;
      if (!coordOf.has(k)) coordOf.set(k, { lat: r.lat, lon: r.lon, precision: r.precision });
    }
    const owners = new Map();
    for (const [k, c] of coordOf) { const key = `${c.lat},${c.lon}`; owners.set(key, [...(owners.get(key) ?? []), k]); }
    const byLoc = new Map();
    for (const r of rows) { if (!byLoc.has(r.locationId)) byLoc.set(r.locationId, { name: r.location, rows: [] }); byLoc.get(r.locationId).rows.push(r); }
    const usedIds = new Set();
    for (const [locationId, loc] of byLoc) {
      const tag = `${site}: ${loc.name}`;
      const p = place(loc.name, ev);
      if (p.skip) { skipped.push({ tag, why: p.skip }); continue; }
      const k = `${norm(p.city)}|${p.state}`;
      let coord = p.destination ? null : coordOf.get(k) ?? null, coordWhy = null;
      if (p.destination) coordWhy = "a delivery point named for a buyer's plant; no coordinate is taken for it";
      else if (!coord) coordWhy = `the roster has no coordinate for ${p.city}, ${p.state} under this operator`;
      else if ((owners.get(`${coord.lat},${coord.lon}`) ?? []).length > 1) {
        coordWhy = `the roster gives ${p.city}, ${p.state} the same coordinate as ${owners.get(`${coord.lat},${coord.lon}`).filter((x) => x !== k).join(", ")}, a geocoder collision`;
        coord = null;
      }
      /* AN OUT-OF-STATE YARD WITH NO COORDINATE CANNOT BE CHECKED. test/state-outliers
         measures every source's distance from its operator's other locations;
         one with no coordinate outside the operator's home state is exactly the
         unverifiable pin that test exists to refuse. Reported, not written. */
      /* Only where a row names this operator in that town: a label alone confirms nothing. */
      if (!coord && !p.destination && p.how === "directory" && !coordWhy?.includes("geocoder collision")) {
        const z = zipCentroid(`${site}-${norm(loc.name)}`, p.city);
        if (z) { coord = z; coordWhy = null; }
      }
      const home = cfg.homeStates;
      if (!coord && home && !home.includes(p.state)) {
        skipped.push({ tag, why: `${p.city}, ${p.state} is outside ${cfg.operator}'s home state(s) (${home.join(", ")}) and has no coordinate in the roster or the repo's ZIP table, so nothing can check it` });
        continue;
      }
      const res = loc.rows.map((r) => Math.round((r.futuresPrice - (r.cash - r.basis) * 100) * 10000) / 10000);
      const lo = Math.min(...res), hi = Math.max(...res);
      const roundingOk = res.every((x) => Math.abs(x) < 1);
      const zip = p.hits.map((h) => h.zip).find(Boolean) ?? null;
      const phone = p.hits.map((h) => h.phone).find(Boolean) ?? null;
      let id = `${site}-${norm(loc.name)}`;
      if (usedIds.has(id)) { skipped.push({ tag, why: `id ${id} would collide with another location` }); continue; }
      usedIds.add(id);
      const how = p.how === "directory"
        ? `the label matches ${p.hits.length} row(s) for ${cfg.operator} (${[...new Set(p.hits.map((h) => h.src))].join(", ")}) at ${p.city}, ${p.state}`
        : p.how === "label" ? `the board's own label writes "${loc.name}"; no row for this operator names that town, so no ZIP and no coordinate are taken`
        : `DESTINATION: the label names a buyer's plant and its town, "${loc.name}". It is where the grain goes, not a ${cfg.operator} yard`;
      const m = {
        id,
        operator: cfg.operator,
        location: loc.name,
        state: p.state,
        platform: cfg.platform,
        url: cfg.url,
        ...(cfg.browserPage ? { browserPage: cfg.browserPage } : {}),
        locationId,
        bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20], ...(cfg.extraBands ?? {}) },
        cadence: "grain-day",
        provenance: "scraped",
        enabled: roundingOk,
        ...(roundingOk ? { cashRounding: "round-cent-both" } : {}),
        note: null,
        publicNote: `Their publicly posted cash board, read from their own website. Cash and basis are their own commercial numbers. `
          + `The futures price is printed on their board too and is carried only so a consumer can re-check cash minus basis.`,
        address: null,
        zip,
        lat: coord ? coord.lat : null,
        lon: coord ? coord.lon : null,
        ...(coord ? { latPrecision: coord.precision ?? "town" } : {}),
        phone,
        email: null,
        website: cfg.website,
        inMerge: true,
      };
      m.note = `GENERATED by scripts/own-board-manifests.mjs from ${cfg.fixture}, their own page ${cfg.url} captured ${CAPTURED} by capture.yml. `
        + `PROOF THE LOCATION IS ON THE BOARD: "${loc.name}" (locationId ${locationId}) with ${loc.rows.length} readable row(s). `
        + `PLACE: ${how}. `
        + (coord ? coordText(coord, p) : `NO COORDINATE: ${coordWhy}. Read and published, kept off the distance map. `)
        + `ROUNDING, measured on the capture: futures - (cash - basis) runs ${lo} to ${hi} cents across ${res.length} row(s)`
        + (roundingOk ? `, inside round-cent-both's open (-1, +1) bound.` : `, outside round-cent-both. Held disabled.`);
      if (!roundingOk) m._pending = `HELD DISABLED: residuals ${lo} to ${hi} cents on the ${CAPTURED} capture.`;
      manifests.push({ site, manifest: m, coordWhy });
    }
  }
  return { manifests, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { manifests, skipped } = build();
  const by = {}; for (const x of manifests) by[x.site] = (by[x.site] ?? 0) + 1;
  console.log(`manifests: ${manifests.length}`, by);
  for (const x of manifests) console.log(`  + ${x.manifest.id.padEnd(36)} ${x.manifest.location.padEnd(28)} ${x.manifest.state} ${x.manifest.lat != null ? "coord" : "     "} ${x.manifest.enabled ? "" : "HELD"}`);
  console.log(`not written: ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.tag} -- ${s.why}`);
  if (process.argv.includes("--write"))
    for (const x of manifests) {
      const p = `${ROOT}sources/${x.manifest.id}.json`;
      if (existsSync(p)) { console.log(`  = ${x.manifest.id}: exists, left alone`); continue; }
      writeFileSync(p, JSON.stringify(x.manifest, null, 2) + "\n");
    }
}

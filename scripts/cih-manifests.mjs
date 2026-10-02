/* THE CIH MANIFESTS, DERIVED FROM CAPTURES AND NOTHING ELSE.
 *
 *     node scripts/cih-manifests.mjs            report only
 *     node scripts/cih-manifests.mjs --write    write sources/<site>-<location>.json
 *
 * Same contract as scripts/stonehedge-manifests.mjs. A manifest exists only for
 * a location that is (1) a card on a CAPTURED CIH board (fixtures/cih-*.json,
 * capture.yml run 36954854588) with at least one row lib/adapters/cih.mjs reads,
 * and (2) identified by the repository's own evidence, data/known-elevators.json
 * or the frozen Barchart roster: which operator, which town, which STATE.
 *
 * IDENTITY, two ways and no third:
 *   branch  the card's label is the branch of a directory row for this operator;
 *   sole    the board carries ONE card and the operator has exactly ONE town in
 *           the directory. Most CIH customers are single plants (an ethanol plant,
 *           a soybean crusher) and title their one card with their own name.
 * A label with neither is REPORTED AND NOT WRITTEN.
 *
 * The coordinate is the roster's town-precision one, and only the roster's: a
 * town no roster row carries, or two towns sharing one point (a geocoder
 * collision), leaves lat and lon null, which lib/sources.mjs reads as "publish,
 * keep off the distance map".
 *
 * ROUNDING is measured here, on the captured rows, never assumed: every residual
 * futures - (cash - basis) must sit inside round-cent-both's open (-1, +1) cent
 * bound or the manifest is held disabled with the numbers in _pending. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extract, widgetUrl } from "../lib/adapters/cih.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const rd = (p) => readFileSync(ROOT + p, "utf8");
const CAPTURED = "2026-10-02";

/* site slug -> the CIH site number on the customer's page, the operator's name
   exactly as the directory spells it, and the page that embeds the widget.
   Ladd Elevator and Russell Grain are captured and have no usable directory
   identity for their cards, so they are listed and reported, never written. */
export const SITES = {
  alcorn:                    { siteId: "239483", operator: "Al-Corn Clean Fuel",               page: "https://al-corn.com/cash-bids/" },
  bushmillsethanol:          { siteId: "110773", operator: "Bushmills Ethanol Inc.",           page: "https://bushmillsethanol.com/corn-procurement-and-pricing/" },
  cvec:                      { siteId: "23921",  operator: "CVEC",                             page: "https://cvec.com/cash-bids/" },
  dencollc:                  { siteId: "98356",  operator: "Denco II LLC",                     page: "https://dencollc.com/" },
  eliteoctane:               { siteId: "22641",  operator: "Elite Octane",                     page: "https://eliteoctane.net/" },
  ggecorn:                   { siteId: "98951",  operator: "Golden Grain Energy",              page: "https://ggecorn.com/" },
  granitefallsenergy:        { siteId: "15460",  operator: "Granite Falls Energy LLC",         page: "https://granitefallsenergy.com/" },
  homelandenergysolutions:   { siteId: "15563",  operator: "Homeland Energy Solutions",        page: "https://www.homelandenergysolutions.com/grain-bids/" },
  huskerag:                  { siteId: "106378", operator: "Husker Ag, LLC",                   page: "https://huskerag.com/cash-bids/" },
  laddelevator:              { siteId: "25584",  operator: null,                               page: "https://laddelevator.com/bids/" },
  lincolnwayenergy:          { siteId: "106377", operator: "Lincolnway Energy LLC",            page: "https://lincolnwayenergy.com/corn-bids/" },
  littlesiouxcornprocessors: { siteId: "15569",  operator: "Little Sioux Corn Processors",     page: "https://littlesiouxcornprocessors.com/" },
  norfolkcrush:              { siteId: "132225", operator: "Norfolk Crush",                    page: "https://norfolkcrush.com/bid-offers-soybeans/" },
  redriverenergy:            { siteId: "22569",  operator: "Red River Energy",                 page: "https://redriverenergy.com/" },
  russellgrain:              { siteId: "23074",  operator: "Russell Grain, Inc.",              page: "https://russellgrain.com/" },
  sandhillsrenewables:       { siteId: "146145", operator: "Sandhills Renewable Energy, LLC",  page: "https://sandhillsrenewables.com/current-cash-bids/" },
  shellrocksoyprocessing:    { siteId: "113526", operator: "Shell Rock Soy Processing LLC",    page: "https://shellrocksoyprocessing.com/soybean-bids/" },
  siouxlandethanol:          { siteId: "15601",  operator: "Siouxland Ethanol LLC",            page: "https://siouxlandethanol.com/" },
  tremont:                   { siteId: "23103",  operator: "Tremont Co-operative Grain Co.",   page: "https://tremont.coop/" },
  uwgp:                      { siteId: "15603",  operator: "United Wisconsin Grain Producers", page: "https://uwgp.com/cash-bids/" },
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const fixture = (site) => `fixtures/cih-${site}-${CAPTURED}.json`;

/** Directory rows for one operator: known-elevators and the roster. */
export function evidence(operator) {
  if (!operator) return [];
  const known = JSON.parse(rd("data/known-elevators.json")).elevators
    .filter((e) => (e.facility === operator || e.company === operator) && e.state)
    .map((e) => ({ src: "known", branch: tidy(e.branch), city: tidy(e.city), state: e.state, zip: e.zip || null, phone: e.phone || null }));
  const roster = JSON.parse(rd("data/roster/barchart-roster-2026-09-24.json")).facilities
    .filter((f) => f.operator === operator)
    .map((f) => ({ src: "roster", branch: tidy(f.branch), city: tidy(f.city), state: f.state, zip: f.zip || null,
                   phone: f.phone || null, lat: f.lat ?? null, lon: f.lon ?? null, precision: f.coord_precision ?? null }));
  return [...roster, ...known];
}

/** Identify one card. null when the evidence does not say. */
export function identify(label, rows, cardCount) {
  const towns = (hs) => [...new Set(hs.map((r) => `${norm(r.city)}|${r.state}`))];
  const byBranch = rows.filter((r) => r.branch && norm(r.branch) === norm(label));
  if (byBranch.length) {
    const t = towns(byBranch);
    return t.length === 1 ? { how: "branch", city: byBranch[0].city, state: byBranch[0].state, hits: byBranch } : { ambiguous: t };
  }
  if (cardCount === 1) {
    const t = towns(rows);
    if (t.length === 1) return { how: "sole", city: rows[0].city, state: rows[0].state, hits: rows };
    if (t.length > 1) return { ambiguous: t };
  }
  return null;
}

/** Residuals in cents for one location's rows: futures - (cash - basis). */
export function residuals(rows) {
  return rows.map((r) => Math.round((r.futuresPrice - (r.cash - r.basis) * 100) * 10000) / 10000);
}

export function build() {
  const manifests = [], skipped = [];
  for (const [site, cfg] of Object.entries(SITES)) {
    if (!existsSync(ROOT + fixture(site))) { skipped.push({ tag: site, why: `no capture at ${fixture(site)}` }); continue; }
    const url = widgetUrl(cfg.siteId);
    let rows;
    try { rows = extract(rd(fixture(site)), url); }
    catch (e) { skipped.push({ tag: site, why: `the capture does not read: ${e.message}` }); continue; }
    const byLoc = new Map();
    for (const r of rows) { if (!byLoc.has(r.locationId)) byLoc.set(r.locationId, { name: r.location, rows: [] }); byLoc.get(r.locationId).rows.push(r); }
    const ev = evidence(cfg.operator);

    const coordOf = new Map();
    for (const r of ev.filter((x) => x.src === "roster" && x.lat != null && x.lon != null)) {
      const k = `${norm(r.city)}|${r.state}`;
      if (!coordOf.has(k)) coordOf.set(k, { lat: r.lat, lon: r.lon, precision: r.precision });
    }
    const owners = new Map();
    for (const [k, c] of coordOf) { const key = `${c.lat},${c.lon}`; owners.set(key, [...(owners.get(key) ?? []), k]); }

    for (const [locationId, loc] of byLoc) {
      const tag = `${site}: ${loc.name}`;
      if (!cfg.operator) { skipped.push({ tag, why: "the operator is in neither data/known-elevators.json nor the roster under any name checked, so no card can be identified" }); continue; }
      const id = identify(loc.name, ev, byLoc.size);
      if (!id) { skipped.push({ tag, why: `"${loc.name}" is not a branch of ${cfg.operator} in the directory, and the board has ${byLoc.size} cards, so the sole-location rule does not apply` }); continue; }
      if (id.ambiguous) { skipped.push({ tag, why: `"${loc.name}" matches more than one town: ${id.ambiguous.join(", ")}` }); continue; }

      const k = `${norm(id.city)}|${id.state}`;
      let coord = coordOf.get(k) ?? null, coordWhy = null;
      if (!coord) coordWhy = "the roster has no coordinate for this town";
      else if ((owners.get(`${coord.lat},${coord.lon}`) ?? []).length > 1) {
        coordWhy = `the roster gives ${id.city}, ${id.state} the same coordinate as ${owners.get(`${coord.lat},${coord.lon}`).filter((x) => x !== k).join(", ")}, a geocoder collision, not a fact`;
        coord = null;
      }
      const res = residuals(loc.rows);
      const lo = Math.min(...res), hi = Math.max(...res);
      const roundingOk = res.every((x) => Math.abs(x) < 1);
      const zip = id.hits.map((h) => h.zip).find(Boolean) ?? null;
      const phone = id.hits.map((h) => h.phone).find(Boolean) ?? null;
      const commodities = [...new Set(loc.rows.map((r) => r.commodity))];
      const m = {
        id: `${site}-${norm(loc.name)}`,
        operator: cfg.operator,
        location: loc.name,
        state: id.state,
        platform: "cih",
        url,
        locationId,
        siteId: cfg.siteId,
        bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] },
        cadence: "grain-day",
        provenance: "scraped",
        enabled: roundingOk,
        ...(roundingOk ? { cashRounding: "round-cent-both" } : {}),
        note: null,
        publicNote: "Their publicly posted cash board, read from the CIH widget their own website embeds. Cash and basis are their own commercial numbers. "
          + "The futures price is printed on their board too and is carried only so a consumer can re-check cash minus basis.",
        address: null,
        zip,
        lat: coord ? coord.lat : null,
        lon: coord ? coord.lon : null,
        ...(coord ? { latPrecision: coord.precision ?? "town" } : {}),
        phone,
        email: null,
        website: new URL(cfg.page).origin + "/",
        inMerge: true,
      };
      m.note = `GENERATED by scripts/cih-manifests.mjs from ${fixture(site)}, the CIH widget response their page at ${cfg.page} asked for, `
        + `captured ${CAPTURED} by capture.yml. PROOF THE LOCATION IS ON THE BOARD: a card "${loc.name}" with data-location-i-d ${locationId} and ${loc.rows.length} readable row(s) (${commodities.join(", ")}). `
        + `IDENTITY: ${id.how === "branch"
            ? `the card's label is the branch of a ${id.hits[0].src === "roster" ? "Barchart roster row" : "data/known-elevators.json row"} for ${cfg.operator}`
            : `the board carries one card and ${cfg.operator} has exactly one town in the directory`}: ${id.city}, ${id.state}${zip ? ` ${zip}` : ""}. `
        + (coord ? `Coordinate is the roster's own for ${id.city}, ${id.state} (${coord.precision ?? "town"} precision, not the plant). `
                 : `NO COORDINATE: ${coordWhy}. lat and lon are null on purpose, so it is read and published and kept off the distance map. `)
        + `ROUNDING, measured on the capture: futures - (cash - basis) runs ${lo} to ${hi} cents across ${res.length} row(s)`
        + (roundingOk ? `, all inside round-cent-both's open (-1, +1) bound, because the bid is posted to the cent against a four-decimal quote.`
                      : `, OUTSIDE round-cent-both. Held disabled.`);
      if (!roundingOk) m._pending = `HELD DISABLED: residuals ${lo} to ${hi} cents on the ${CAPTURED} capture do not fit round-cent-both.`;
      manifests.push({ site, manifest: m, coordWhy });
    }
  }
  return { manifests, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { manifests, skipped } = build();
  console.log(`manifests: ${manifests.length}`);
  for (const x of manifests) console.log(`  + ${x.manifest.id.padEnd(46)} ${x.manifest.location} -> ${x.manifest.state} ${x.manifest.enabled ? "" : "(HELD)"}${x.coordWhy ? "  [no coordinate]" : ""}`);
  console.log(`not written: ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.tag} -- ${s.why}`);
  if (process.argv.includes("--write"))
    for (const x of manifests) {
      const p = `${ROOT}sources/${x.manifest.id}.json`;
      if (existsSync(p)) { console.log(`  = ${x.manifest.id}: a manifest already exists, left alone`); continue; }
      writeFileSync(p, JSON.stringify(x.manifest, null, 2) + "\n");
    }
}

/* THE STONEHEDGE MANIFESTS, DERIVED FROM CAPTURES AND NOTHING ELSE.
 *
 *     node scripts/stonehedge-manifests.mjs            report only
 *     node scripts/stonehedge-manifests.mjs --write    write sources/<site>-<location>.json
 *
 * A manifest exists only for a location that is (1) on a CAPTURED board with at
 * least one real bid on it (a cash AND a basis, not "--"), and (2) identified by
 * the repository's own evidence: the frozen Barchart roster
 * (data/roster/barchart-roster-2026-09-24.json) or data/known-elevators.json,
 * which say which operator, which town and which STATE the board's label is.
 * The coordinate is the roster's town-precision one for that operator's town.
 *
 * A board label with no identity is REPORTED AND NOT WRITTEN. A label is not a
 * place: "Atlanta" is on Ag Valley's board and only known-elevators says it is
 * Atlanta, NE. Nothing here looks up a town, and nothing invents a coordinate:
 * where the evidence has no coordinate, or two towns share one (which is a
 * geocoder collision, not a fact), lat and lon are BOTH null, which is the
 * repository's documented path (lib/sources.mjs warnSource: read and published,
 * kept off the distance-sorted map).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument, layoutOf, VERIFIED_NAMED, VERIFIED_FIT, WIDGET_URL } from "../lib/adapters/stonehedge.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const rd = (p) => readFileSync(ROOT + p, "utf8");

/* site slug -> the operator's name in the roster, and the page that embeds the
   widget (data/gaps/stonehedge-probe.json: the page with componentSeen).
   Cendak and United Cooperative are on captured boards and NOT in the roster
   under these names. Until 2026-10-18 they stayed unwritten for that reason.

   `registry` (added 2026-10-18) is the second kind of identity evidence: the
   licence rolls build_directory.mjs already turns into grey pins
   (geocodes/places.json `registry`, USDA's warehouse list and the state rolls).
   A roll row names the operator, the town and the STATE, which is exactly what
   the roster supplies. It is read only for the operator spelled exactly as the
   roll spells it and only in the states listed, because "United Cooperative"
   is also a different co-op in Iowa. A label then names a place only when it
   is that town, or that town followed by one generic word ("Belmont Grain",
   "Esmond Elevator"), and no other label on the board names the same town:
   Ripon North and Ripon South are two yards the roll lists once, so neither is
   written. The manifest claims the roll row it matched (registryId) and the
   Barchart row it is (sameAsKnown), so its grey pin goes rather than sitting
   beside the live one. */
export const SITES = {
  agvalley:            { roster: "Ag Valley Co-op",          known: "Ag Valley Co-op",          home: "https://agvalley.com/" },
  cedarcountycoop:     { roster: "Cedar County Coop",        known: "Cedar County Coop",        home: "https://cedarcountycoop.com/" },
  cendakcooperative:   { roster: null,                       known: "CenDak Cooperative",       home: "https://cendakcooperative.com/",
                         registry: { operator: "CenDak Cooperative", states: ["ND"] } },
  frontiercooperative: { roster: "Frontier Cooperative",     known: "Frontier Cooperative",     home: "https://frontiercooperative.com/" },
  fullcircleag:        { roster: "Full Circle Ag",           known: "Full Circle Ag",           home: "https://fullcircleag.com/" },
  milnorgrain:         { roster: "Milnor Grain Company",     known: "Milnor Grain Company",     home: "https://milnorgrain.com/" },
  mrga:                { roster: "Maple River Grain",        known: "Maple River Grain",        home: "https://mrga.com/" },
  rivervalleycoop:     { roster: "River Valley Cooperative", known: "River Valley Cooperative", home: "https://rivervalleycoop.com/" },
  scottequityexchange: { roster: "Scott Equity Exchange",    known: "Scott Equity Exchange",    home: "https://scottequityexchange.com/" },
  unitedcooperative:   { roster: null,                       known: "United Cooperative",       home: "https://unitedcooperative.com/",
                         registry: { operator: "United Cooperative", states: ["WI"] } },
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const slug = norm;
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function pageFor(site) {
  const probe = JSON.parse(rd("data/gaps/stonehedge-probe.json"));
  const s = probe.sites.find((x) => x.site === `${site}.com`);
  const p = (s?.pages ?? []).find((x) => x.componentSeen);
  return p?.url ?? SITES[site].home;
}

/** Every place in a rendered board, with whether it carries a real bid. */
export function boardPlaces(site) {
  const html = rd(`fixtures/stonehedge-${site}-component-rendered.html`);
  const doc = parseDocument(html);
  const byName = new Map(doc.picker.options.map((o) => [norm(o.name), o.id]));
  const out = [];
  for (const g of doc.groups) {
    let bids = 0, kinds = new Set();
    for (const t of g.tables) {
      kinds.add(layoutOf(t).kind);
      for (const r of t.rows) {
        const c = r.cells;
        if (/^-?\d/.test(c.cash ?? "") && /^-?\d/.test(c.basis ?? "")) bids++;
      }
    }
    out.push({ name: tidy(g.name), id: byName.get(norm(g.name)) ?? null, bids, kind: [...kinds].join("+") });
  }
  return { html, places: out, picker: doc.picker.present };
}

/** Identity and coordinate evidence for one operator. */
export function evidence(site) {
  const cfg = SITES[site];
  if (cfg.registry) return registryEvidence(cfg);
  if (!cfg.roster) return { rows: [] };
  const roster = JSON.parse(rd("data/roster/barchart-roster-2026-09-24.json")).facilities
    .filter((f) => f.operator === cfg.roster)
    .map((f) => ({ src: "roster", id: f.id, branch: tidy(f.branch), city: tidy(f.city), state: f.state,
                   zip: f.zip || null, lat: f.lat ?? null, lon: f.lon ?? null,
                   precision: f.coord_precision ?? null, phone: f.phone || null, website: f.website || null }));
  const known = JSON.parse(rd("data/known-elevators.json")).elevators
    .filter((e) => (e.facility === cfg.known || e.company === cfg.known) && e.state)
    .map((e) => ({ src: "known", branch: tidy(e.branch), city: tidy(e.city), state: e.state,
                   zip: e.zip || null, phone: e.phone || null }));
  return { rows: [...roster, ...known] };
}

/* The licence-roll evidence for an operator the roster does not carry (see
   SITES). Two kinds of row, both already in this repository:
     registry  geocodes/places.json `registry`: the roll's own operator, town,
               state, and the coordinate build_directory.mjs draws for it.
     known     geocodes/places.json `known`, the Barchart facility list,
               joined to data/known-elevators.json by elevatorId; its
               `location` is the branch label ("Maddock Elevator").
   A coordinate is kept only at street or town precision. A county centroid is
   not a town. */
export function registryEvidence(cfg) {
  const geo = JSON.parse(rd("geocodes/places.json"));
  const { operator, states } = cfg.registry;
  const coord = (v) => (v.lat != null && v.lon != null && (v.precision === "street" || v.precision === "town"))
    ? { lat: v.lat, lon: v.lon, precision: v.precision } : null;
  const rows = [];
  for (const [rid, v] of Object.entries(geo.registry || {})) {
    if (v.operator !== operator || !states.includes(v.state)) continue;
    rows.push({ src: "registry", rid, branch: null, city: tidy(v.location), state: v.state,
                zip: null, phone: v.phone || null, coord: coord(v), roll: v.source });
  }
  const knownIds = new Map(JSON.parse(rd("data/known-elevators.json")).elevators
    .filter((e) => e.company === cfg.known && states.includes(e.state))
    .map((e) => [String(e.elevatorId), e]));
  for (const [kid, v] of Object.entries(geo.known || {})) {
    const e = knownIds.get(kid);
    if (!e || v.operator !== cfg.known || v.state !== e.state) continue;
    rows.push({ src: "known", kid, branch: tidy(v.location), city: tidy(e.city), state: e.state,
                zip: e.zip || null, phone: e.phone || null, coord: coord(v) });
  }
  return { rows };
}

/* One generic word a board puts after the town: "Belmont Grain". */
const TRAILING = /\s+(grain|elevator)$/i;

/* identify() for licence-roll evidence. The label is a branch, or the town,
   or the town plus one generic word; and the answer is one town. */
export function identifyRegistry(name, rows) {
  const tries = [tidy(name), tidy(name).replace(TRAILING, "")];
  for (const t of tries) {
    const n = norm(t);
    const byBranch = rows.filter((r) => r.branch && norm(r.branch) === n);
    const hits = byBranch.length ? byBranch : rows.filter((r) => norm(r.city) === n);
    if (!hits.length) continue;
    const towns = new Set(hits.map((r) => `${norm(r.city)}|${r.state}`));
    if (towns.size !== 1) return { ambiguous: [...towns] };
    /* every row of that town, not only the ones the label hit: the roll row and
       the Barchart row of one yard are both claimed */
    const k = [...towns][0];
    const all = rows.filter((r) => `${norm(r.city)}|${r.state}` === k);
    return { how: byBranch.length ? "branch" : t === tidy(name) ? "town" : "town+word",
             city: all.find((r) => r.src === "known")?.city ?? all[0].city, state: all[0].state, hits: all };
  }
  return null;
}

/* A label names a place when it IS a facility's branch, or - only when no
   branch says so - when it is the town of exactly one (city, state) the
   operator has. Two different answers is no answer. */
export function identify(name, rows) {
  const n = norm(name);
  let hits = rows.filter((r) => r.branch && norm(r.branch) === n);
  let how = "branch";
  if (!hits.length) {
    const byCity = rows.filter((r) => norm(r.city) === n);
    const towns = new Set(byCity.map((r) => `${norm(r.city)}|${r.state}`));
    if (towns.size === 1) { hits = byCity; how = "town"; }
  }
  if (!hits.length) return null;
  const towns = new Set(hits.map((r) => `${norm(r.city)}|${r.state}`));
  if (towns.size !== 1) return { ambiguous: [...towns] };
  return { how, city: hits[0].city, state: hits[0].state, hits };
}

export function build() {
  const manifests = [], skipped = [];
  for (const site of Object.keys(SITES)) {
    const { places, picker } = boardPlaces(site);
    const cfg = SITES[site];
    const ev = evidence(site);
    /* Coordinates by town, from the roster only, and a coordinate two different
       towns of one operator share is a geocoder collision. */
    const coordOf = new Map();
    for (const r of ev.rows.filter((x) => x.src === "roster" && x.lat != null && x.lon != null)) {
      const k = `${norm(r.city)}|${r.state}`;
      if (!coordOf.has(k)) coordOf.set(k, { lat: r.lat, lon: r.lon, precision: r.precision });
    }
    const owners = new Map();
    for (const [k, c] of coordOf) { const key = `${c.lat},${c.lon}`; owners.set(key, [...(owners.get(key) ?? []), k]); }

    for (const p of places) {
      const tag = `${site}: ${p.name}`;
      if (!p.bids) { skipped.push({ tag, why: "on the board with no real bid (every cash or basis is blank)" }); continue; }
      if (cfg.registry) { const r = registryManifest(site, cfg, p, places, ev, picker); if (r.skip) skipped.push({ tag, why: r.skip }); else manifests.push(r); continue; }
      if (!cfg.roster) { skipped.push({ tag, why: `${site} is not in the roster or known-elevators under any operator name, so no label here can be identified` }); continue; }
      const id = identify(p.name, ev.rows);
      if (!id) { skipped.push({ tag, why: "no roster or known-elevators row carries this label as a branch or as its only town" }); continue; }
      if (id.ambiguous) { skipped.push({ tag, why: `the label matches more than one town: ${id.ambiguous.join(", ")}` }); continue; }
      if (!p.id && picker) { skipped.push({ tag, why: "not in the widget's own location list" }); continue; }

      const k = `${norm(id.city)}|${id.state}`;
      let coord = coordOf.get(k) ?? null, coordWhy = null;
      if (!coord) coordWhy = "the roster has no coordinate for this town";
      else if ((owners.get(`${coord.lat},${coord.lon}`) ?? []).length > 1)
        { coordWhy = `the roster gives ${id.city}, ${id.state} the same coordinate as ${owners.get(`${coord.lat},${coord.lon}`).filter((x) => x !== k).join(", ")}, which is a geocoder collision, not a fact`; coord = null; }
      const roster = id.hits.find((h) => h.src === "roster") ?? id.hits[0];
      const zip = id.hits.map((h) => h.zip).find(Boolean) ?? null;
      const phone = id.hits.map((h) => h.phone).find(Boolean) ?? null;
      const kind = p.kind;
      /* The one-location embed draws no picker; its id is the embed's own locs= value. */
      let locationId = p.id;
      let idNote = p.id;
      if (locationId == null && !picker) {
        const l = embedLocs(site);
        if (l.length !== 1) { skipped.push({ tag, why: "the widget draws no location list and the customer's page does not name exactly one locs= id" }); continue; }
        locationId = l[0];
        idNote = `${l[0]} (the embed's own locs= value on ${pageFor(site)}; the widget draws no picker for one location)`;
      }
      const m = {
        id: `${site}-${slug(p.name)}`,
        operator: cfg.roster,
        location: p.name,
        state: id.state,
        platform: "stonehedge",
        url: WIDGET_URL,
        browserPage: pageFor(site),
        locationId,
        ...(kind === "named" ? { identityAlternative: VERIFIED_NAMED } : {}),
        ...(kind === "bare" ? { identityAlternative: VERIFIED_FIT } : {}),
        bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] },
        cadence: "grain-day",
        provenance: "scraped",
        enabled: true,
        ...(kind === "priced" ? { cashRounding: "round-cent-both" } : {}),
        note: null,
        publicNote: "Their publicly posted cash board, read from the widget their own website embeds. Cash and basis are their own commercial numbers. "
          + (kind === "priced"
            ? "The futures price is theirs too and is carried only so a consumer can re-check cash minus basis."
            : "This board prints no futures price, so none is republished; the CBOT quote is used only to check that the two columns were read correctly."),
        address: null,
        zip,
        lat: coord ? coord.lat : null,
        lon: coord ? coord.lon : null,
        ...(coord ? { latPrecision: coord.precision ?? "town" } : {}),
        phone,
        email: null,
        website: cfg.home,
        inMerge: true,
      };
      m.note = `GENERATED by scripts/stonehedge-manifests.mjs from fixtures/stonehedge-${site}-component-rendered.html, the widget's own rendered document captured 2026-09-26 (data/gaps/stonehedge-probe.json). `
        + `PROOF THE LOCATION IS ON THE BOARD: the document ${picker ? `names "${p.name}" in its own location list as id` : `has "${p.name}" as its only location heading; its id is`} ${idNote} and carries ${p.bids} real bid row(s) under it. `
        + `IDENTITY: ${id.how === "branch" ? `the board's label is the branch of a ${roster.src === "roster" ? "Barchart roster row" : "data/known-elevators.json row"} for ${cfg.roster}` : `the board's label is the only town ${cfg.roster} has in the roster and known-elevators`}: ${id.city}, ${id.state}${zip ? ` ${zip}` : ""}. `
        + (coord ? `Coordinate is the roster's own for ${id.city}, ${id.state} (${coord.precision ?? "town"} precision, not the yard). ` : `NO COORDINATE: ${coordWhy}. lat and lon are null on purpose, so it is read and published and kept off the distance map. `)
        + (kind === "priced"
          ? `The board prints a futures PRICE, so board.mjs's cash - basis = futures runs on every row; cashRounding round-cent-both was measured across 1,208 priced rows on four boards (residuals -0.5 to +0.75 cents).`
          : `The board prints ${kind === "named" ? "the contract MONTH and no price" : "cash and basis and no contract at all"}, so it publishes on identityAlternative "${kind === "named" ? VERIFIED_NAMED : VERIFIED_FIT}", which the adapter stamps only after the shared CBOT quote check passes on the whole board.`);
      const fix = ZIP_FIX[m.id];
      if (fix && m.zip === fix.from) {
        m.zip = fix.zip;
        m.note += `\n\nLOCATED (${fix.on}): ZIP ${fix.from} -> ${fix.zip}. ${fix.why}`;
      }
      manifests.push({ site, place: p, manifest: m, coordWhy });
    }
  }
  return { manifests, skipped };
}

/* One manifest from licence-roll evidence, or the reason there is none. */
function registryManifest(site, cfg, p, places, ev, picker) {
  const id = identifyRegistry(p.name, ev.rows);
  if (!id) return { skip: `no ${cfg.registry.operator} licence row in ${cfg.registry.states.join("/")} names this label's town` };
  if (id.ambiguous) return { skip: `the label matches more than one town: ${id.ambiguous.join(", ")}` };
  const k = `${norm(id.city)}|${id.state}`;
  const rivals = places.filter((q) => q !== p && q.bids).filter((q) => {
    const o = identifyRegistry(q.name, ev.rows);
    return o && !o.ambiguous && `${norm(o.city)}|${o.state}` === k;
  });
  if (rivals.length) return { skip: `${rivals.map((q) => q.name).join(", ")} names the same town (${id.city}, ${id.state}), and the roll lists it once: which yard is which is not on file` };
  if (!p.id && picker) return { skip: "not in the widget's own location list" };
  if (!p.id) return { skip: "the widget draws no location list; a licence-roll site is only written from its own picker" };

  /* The coordinate: a Barchart street address first, then the roll's town centroid. */
  const best = [...id.hits].sort((a, b) => (b.coord?.precision === "street") - (a.coord?.precision === "street"))
    .find((h) => h.coord);
  let coord = best ? best.coord : null, coordWhy = coord ? null : "no licence or Barchart row for this town carries a street or town coordinate";
  if (coord) {
    const same = ev.rows.filter((r) => r.coord && r.coord.lat === coord.lat && r.coord.lon === coord.lon
      && `${norm(r.city)}|${r.state}` !== k);
    if (same.length) { coordWhy = `${id.city}, ${id.state} has the same coordinate as ${[...new Set(same.map((r) => r.city))].join(", ")}, which is a geocoder collision, not a fact`; coord = null; }
  }
  const regs = id.hits.filter((h) => h.src === "registry").map((h) => "reg:" + h.rid).sort();
  const kids = id.hits.filter((h) => h.src === "known").map((h) => h.kid).sort();
  const zip = id.hits.map((h) => h.zip).find(Boolean) ?? null;
  const phone = id.hits.map((h) => h.phone).find(Boolean) ?? null;
  const kind = p.kind;
  const m = {
    id: `${site}-${slug(p.name)}`,
    operator: cfg.registry.operator,
    location: p.name,
    state: id.state,
    platform: "stonehedge",
    url: WIDGET_URL,
    browserPage: pageFor(site),
    locationId: p.id,
    ...(kind === "named" ? { identityAlternative: VERIFIED_NAMED } : {}),
    ...(kind === "bare" ? { identityAlternative: VERIFIED_FIT } : {}),
    bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] },
    cadence: "grain-day",
    provenance: "scraped",
    enabled: true,
    ...(kind === "priced" ? { cashRounding: "round-cent-both" } : {}),
    note: null,
    publicNote: "Their publicly posted cash board, read from the widget their own website embeds. Cash and basis are their own commercial numbers. "
      + (kind === "priced"
        ? "The futures price is theirs too and is carried only so a consumer can re-check cash minus basis."
        : "This board prints no futures price, so none is republished; the CBOT quote is used only to check that the two columns were read correctly."),
    address: null,
    zip,
    lat: coord ? coord.lat : null,
    lon: coord ? coord.lon : null,
    ...(coord ? { latPrecision: coord.precision } : {}),
    phone,
    email: null,
    website: cfg.home,
    inMerge: true,
    ...(regs.length ? { registryId: regs.length === 1 ? regs[0] : regs } : {}),
    ...(kids.length ? { sameAsKnown: kids } : {}),
  };
  const rolls = [...new Set(id.hits.filter((h) => h.src === "registry").map((h) => h.roll))];
  m.note = `GENERATED by scripts/stonehedge-manifests.mjs from fixtures/stonehedge-${site}-component-rendered.html, the widget's own rendered document captured 2026-09-26 (data/gaps/stonehedge-probe.json). `
    + `PROOF THE LOCATION IS ON THE BOARD: the document names "${p.name}" in its own location list as id ${p.id} and carries ${p.bids} real bid row(s) under it. `
    + `IDENTITY: ${cfg.registry.operator} is not in the Barchart roster under that name; the licence roll${rolls.length ? ` (${rolls.join(", ")})` : ""} and the Barchart facility list in geocodes/places.json are. `
    + (id.how === "branch" ? `The board's label is the branch of Barchart facility ${kids.join(", ")}` : id.how === "town" ? `The board's label is the town` : `The board's label is the town plus one generic word`)
    + ` of ${[...regs, ...kids.map((x) => "known:" + x)].join(", ")}: ${id.city}, ${id.state}${zip ? ` ${zip}` : ""}, and no other label on this board names that town. `
    + (coord ? `Coordinate is ${coord.precision === "street" ? "Barchart's street-level one" : "the town centroid the directory already draws for the licence row"} (${coord.precision} precision). ` : `NO COORDINATE: ${coordWhy}. lat and lon are null on purpose, so it is read and published and kept off the distance map. `)
    + (kind === "priced"
      ? `The board prints a futures PRICE, so board.mjs's cash - basis = futures runs on every row; cashRounding round-cent-both was measured across 1,208 priced rows on four boards (residuals -0.5 to +0.75 cents).`
      : `The board prints ${kind === "named" ? "the contract MONTH and no price" : "cash and basis and no contract at all"}, so it publishes on identityAlternative "${kind === "named" ? VERIFIED_NAMED : VERIFIED_FIT}", which the adapter stamps only after the shared CBOT quote check passes on the whole board.`);
  return { site, place: p, manifest: m, coordWhy };
}

/* A ZIP THE ROW CARRIES THAT IS NOT A ZIP. Added 2026-10-08. Applied only while
   the row still says `from`, so a corrected row wins. */
export const ZIP_FIX = {
  "frontiercooperative-stmary": { on: "2026-10-08", from: "68432", zip: "68443",
    why: "68432 is not a ZIP in the USPS table this repository uses (geocodes/zip-towns.json, data/zips), so nothing could place this yard. Nebraska's warehouse capacity report lists Frontier Cooperative Company at Saint Mary, Johnson County, and the USPS city table (the zipcodes package behind geocodes/zip-towns.json) lists Saint Mary as a place name of ZIP 68443 (Sterling) and of no other Nebraska ZIP. No street address was found, so no coordinate is set." },
};

/* The one-location embed draws no picker, so its id is the embed's own `locs=`
   value on the customer's page. */
export function embedLocs(site) {
  const html = rd(`fixtures/stonehedge-${site}-page.html`);
  const m = /component\/bids\?[^"'\s]*?locs=([A-Z0-9,%C]+)/.exec(html.replace(/&amp;/g, "&"));
  return m ? decodeURIComponent(m[1]).split(",") : [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { manifests, skipped } = build();
  const bySite = {};
  for (const x of manifests) bySite[x.site] = (bySite[x.site] ?? 0) + 1;
  console.log(`manifests: ${manifests.length}`, bySite);
  console.log(`not written: ${skipped.length}`);
  for (const s of skipped) console.log(`  ${s.tag} -- ${s.why}`);
  for (const x of manifests) if (x.coordWhy) console.log(`  null coordinate: ${x.manifest.id} -- ${x.coordWhy}`);
  if (process.argv.includes("--write"))
    for (const x of manifests)
      writeFileSync(`${ROOT}sources/${x.manifest.id}.json`, JSON.stringify(x.manifest, null, 2) + "\n");
}

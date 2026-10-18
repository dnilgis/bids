#!/usr/bin/env node
/* POINT THE AGRICHARTS CASHGRID READER AT BOARDS A CAPTURE CONFIRMED.
 *
 * 2026-10-18. capture.yml (save=elevsites) saved the bid pages of unread
 * companies, and the elevsites job said which ones run on AgriCharts. Each of
 * those pages loads
 *
 *     https://<host>.agricharts.com/inc/cashbids/cashbids-js.php?...
 *
 * and the saved answer carries the board's own location list: either the
 * `var bids = [...]` JSON (id, name, street, city, state, ZIP, coordinate, and
 * the bid rows under it) or a <select name="setLocation"> of id -> name. Those
 * ids are the same l= ids every cashgrid row link carries
 * (lib/agricharts-published.mjs), so the capture names the host and the id and
 * nothing is guessed.
 *
 *     node scripts/wire-captures.mjs --caps DIR [--config probe-lists/wire1-agricharts.json] [--write]
 *
 * DIR is a checkout of the elevsites branch's caps/<run>/ folder. Dry run is
 * the default: it prints every location it would write, every one it held back
 * and why, and every directory row each one would claim.
 *
 * WHAT IT WILL NOT DO
 *   - write a location some source already reads (same AgriCharts locationId);
 *   - overwrite a file in sources/;
 *   - name a town nobody published: the place comes from Barchart's directory
 *     (joinDirectory, the sweep's own join), else the board's own published
 *     city/state/ZIP when the ZIP agrees with the state, else one licence-roll
 *     row of the same company whose town IS the board's label; otherwise the
 *     location is reported, not written;
 *   - claim a directory row on a guess: a row is claimed only when its state
 *     and town agree with the location and, where a town holds two of the
 *     company's locations or the row names a sub-site "(Fgrange)", the names
 *     agree too.
 *
 * The board itself is NOT read here: the sandbox that wrote these could not
 * reach agricharts.com. The first poll is the first time the cashgrid
 * adapter's checks (named contract priced, heading agrees, delivery codes in
 * the headers) run on these boards, and a board that fails them is refused
 * there like any other.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bidsArray, locationsArray, plausible, shownLocation } from "../lib/agricharts-published.mjs";
import { cellText } from "../lib/adapters/agricharts.mjs";
import { familyOf } from "../lib/elevsites.mjs";
import { validateSource } from "../lib/sources.mjs";
import { joinDirectory, manifestFor, operatorSlug, slug, phoneOf } from "./agricharts-sweep.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* ---------- what the capture says ---------- */

/** Every location in one cashbids-js.php answer: id -> {id, label, city, state,
 *  zip, street, phone, lat, lon, rows, commodities, from}. Both groupings the
 *  widget serves are read: by location (each top entry IS a location) and by
 *  commodity (each bid carries its location). Inactive or hidden ones are left
 *  out, as lib/agricharts-published.mjs does. */
export function widgetLocations(body) {
  const out = new Map();
  const arr = bidsArray(body);
  const add = (L, commodity) => {
    if (!L || L.id == null) return;
    if (!shownLocation(L)) return;
    const id = String(L.id);
    const tidy = (v) => (v == null ? null : String(v).replace(/\s+/g, " ").trim() || null);
    const e = out.get(id) ?? {
      id, label: tidy(L.display_name) ?? tidy(L.name), city: tidy(L.city),
      state: tidy(L.state)?.toUpperCase() ?? null, zip: tidy(L.zip)?.slice(0, 5) ?? null,
      street: tidy(L.street1), phone: tidy(L.phone),
      lat: Number(L.latitude) || null, lon: Number(L.longitude) || null,
      rows: 0, commodities: new Set(), from: "json" };
    if (commodity) { e.rows++; e.commodities.add(String(commodity).trim()); }
    out.set(id, e);
  };
  if (Array.isArray(arr)) for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    if ("city" in t || "street1" in t) {
      add(t, null);
      for (const cb of t.cashbids ?? []) add(t, cb?.name ?? cb?.display_name);
    } else {
      for (const cb of t.cashbids ?? []) for (const L of cb?.locations ?? []) add(L, t.display_name || t.name);
    }
  }
  /* THE SELECTOR, where the page was filtered to one location. The JSON then
     holds only that one; the board's own <select name="setLocation"> lists the
     rest by id and name, and that is all it says about them. */
  const sel = String(body).match(/<select[^>]*name=\\?["'](?:setLocation|location_filter)\\?["'][^>]*>([\s\S]*?)<\/select>/i);
  if (sel) for (const o of sel[1].matchAll(/<option[^>]*value=\\?["'](\d+)\\?["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    const name = cellText(o[2].replace(/\\(["'\/])/g, "$1"));
    if (!name || /^all locations$/i.test(name) || out.has(o[1])) continue;
    out.set(o[1], { id: o[1], label: name, city: null, state: null, zip: null, street: null, phone: null,
                    lat: null, lon: null, rows: 0, commodities: new Set(), from: "select" });
  }
  /* THE WHOLE LOCATION LIST (`var locations`), which a filtered page still
     carries in full: each entry is the operator's own record for that id. It
     only FILLS a location the selector named and the bids list did not: a
     record that is in neither may be an office or a yard that posts nothing,
     and is not a board location on this evidence. */
  const all = locationsArray(body);
  if (Array.isArray(all)) for (const L of all) {
    if (!L || L.id == null || out.get(String(L.id))?.from !== "select" || !("city" in L || "street1" in L)) continue;
    const named = out.get(String(L.id));
    out.delete(String(L.id));
    add(L, null);
    const e = out.get(String(L.id));
    if (e) { e.from = "locations"; e.label = named.label ?? e.label; }
    else out.set(String(L.id), named);
  }
  return out;
}

/** Every AgriCharts widget answer in one capture folder: [{host, url, body}]. */
export function widgetsIn(responses) {
  const out = [];
  for (const e of responses) {
    let host;
    try { host = new URL(e.url).hostname.toLowerCase(); } catch { continue; }
    if (!e.body) continue;
    /* AN AGRICHARTS SITE ON THE OPERATOR'S OWN DOMAIN serves its cash page at
       /markets/cash.php with the board's own location_filter selector; the
       cashgrid is the same site's /markets/cashgrid.php. */
    const own = /\/markets\/cash\.php$/.test(new URL(e.url).pathname)
      && /name=["']location_filter["']/.test(e.body) && /agricharts\.com/.test(e.body);
    if (!own && !/^[a-z0-9_-]+\.agricharts\.com$/.test(host)) continue;
    if (!own && !/\/inc\/cashbids\/cashbids(-js)?\.php/.test(e.url)) continue;
    out.push({ host, url: e.url, body: e.body, capture: e._capture ?? null });
  }
  return out;
}

/** The other capture folders of the same site: a page filtered to one
 *  location lists the rest only by name in its selector, while the site's
 *  home page or another saved page often loads the same widget unfiltered,
 *  with every location's street, town and ZIP. Folders are matched on the
 *  website's host ("www-farmersco-operative-com", "farmersco-operative-com-..."). */
export function siblingCaptures(website, folders) {
  let host;
  try { host = new URL(website).hostname.toLowerCase().replace(/^www\./, ""); } catch { return []; }
  const stem = host.replace(/\./g, "-");
  return folders.filter((f) => {
    const name = f.split("/").pop().replace(/^www-/, "");
    return name === stem || name.startsWith(stem + "-");
  });
}

/* ---------- where a location is ---------- */

export const NOT_A_YARD = /all locations|^\s*hta\b|futures only|selling price|^disabled$|^\{/i;
export const OTHER_PLANT = /\b(adm|cargill|cgb|agp|bunge|poet|andersons|viterra|chs|verbio|ingredion|primient|tate)\b/i;

/** "Charleston (Fgrange)" -> {town: "Charleston", sub: "Fgrange"}. */
export function splitTown(t) {
  const m = String(t ?? "").match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return m ? { town: m[1].trim(), sub: m[2].trim() } : { town: String(t ?? "").trim(), sub: null };
}

/** Is every letter of `short` in `long`, in order? "mworth" in "middlesworth". */
export function subsequence(short, long) {
  const a = slug(short), b = slug(long);
  if (a.length < 3) return false;
  let i = 0;
  for (const c of b) if (c === a[i]) i++;
  return i === a.length;
}

/** The place for one location, or {why}. */
export function placeFor(loc, { known, operator, family, zipTowns }) {
  const label = loc.label;
  if (!label) return { why: "no name on the board" };
  const d = joinDirectory(known, operator, label);
  if (d && d.state && d.branch) {
    const z = d.zip ? zipTowns[String(d.zip).slice(0, 5)] : null;
    if (z && z[1] !== d.state)
      return { why: `Barchart lists ${d.branch} in ${d.city}, ${d.state} with ZIP ${d.zip}, which is ${z[1]}` };
    if (loc.state && loc.state !== d.state)
      return { why: `Barchart puts ${d.branch} in ${d.state} and the board publishes ${loc.state}` };
    return { branch: d.branch, city: d.city, state: d.state, zip: d.zip ?? null, phone: d.phone ?? null,
             via: "barchart", knownRow: d,
             coord: plausible(loc) && loc.state === d.state && slug(loc.city) === slug(d.city)
               ? { lat: loc.lat, lon: loc.lon, precision: loc.street ? "street" : "town" } : null };
  }
  if (loc.city && loc.state && loc.zip) {
    const z = zipTowns[loc.zip];
    if (!z) return { why: `the board publishes ZIP ${loc.zip}, which no ZIP table here knows` };
    if (z[1] !== loc.state)
      return { why: `the board publishes ${loc.city}, ${loc.state} with ZIP ${loc.zip}, which is ${z[1]}` };
    return { branch: label, city: loc.city, state: loc.state, zip: loc.zip, phone: loc.phone,
             via: "published", coord: plausible(loc) ? { lat: loc.lat, lon: loc.lon,
             precision: loc.street ? "street" : "town" } : null };
  }
  /* A LICENCE ROW WHOSE TOWN IS THE LABEL. The selector names the place and
     nothing else, so the only honest town is one a roll already gives this
     company under exactly that name, and only when there is one such row. */
  const rows = family.filter((r) => String(r.id).startsWith("reg:") && !splitTown(r.location).sub
    && slug(splitTown(r.location).town) === slug(label));
  const states = new Set(rows.map((r) => r.state));
  if (rows.length && states.size === 1) {
    const r = rows.find((x) => x.precision === "street") ?? rows.find((x) => x.precision === "town") ?? rows[0];
    if (r.precision === "county") return { why: `only a county-precision licence row names ${label}` };
    return { branch: label, city: splitTown(r.location).town, state: r.state, zip: null, phone: null,
             via: "roll", rollRow: r,
             coord: Number.isFinite(r.lat) ? { lat: r.lat, lon: r.lon, precision: r.precision } : null };
  }
  if (states.size > 1) return { why: `"${label}" is a town of this company in ${[...states].join(" and ")}` };
  return { why: `"${label}" is on the board's list, and no directory, published address or licence row places it` };
}

/* ---------- which unread rows each location is ---------- */

/** rows: the company's unread directory rows. locs: [{id, label, place}]. Returns Map(locId -> [rowId]). */
export function claimRows(rows, locs) {
  const claims = new Map(locs.map((l) => [l.id, []]));
  const townOf = (l) => [l.place.city, l.label].map(slug);
  const inTown = (r) => {
    const t = slug(splitTown(r.location).town);
    return locs.filter((l) => l.place.state === r.state && townOf(l).includes(t));
  };
  const taken = new Set();       // locations claimed by a row that named a sub-site
  const take = (r, l) => { claims.get(l.id).push(r.id); };
  /* Rows that name WHICH yard first: a Barchart branch, or "(Sub)". */
  const named = [], plain = [];
  for (const r of rows) {
    const { town, sub } = splitTown(r.location);
    const br = r.branch && slug(r.branch) !== slug(town) ? r.branch : null;
    (sub || br ? named : plain).push({ r, sub: sub || br, town });
  }
  for (const { r, sub } of named) {
    const c = inTown(r).filter((l) => slug(l.label) === slug(sub) || subsequence(sub, l.label));
    if (c.length === 1) { take(r, c[0]); taken.add(c[0].id); }
  }
  for (const { r, town } of plain) {
    const c = inTown(r);
    const exact = c.filter((l) => slug(l.label) === slug(town) || slug(l.place.branch) === slug(town));
    if (exact.length === 1) take(r, exact[0]);
    else if (!exact.length && c.length === 1 && !taken.has(c[0].id)) take(r, c[0]);
  }
  return claims;
}

/* ---------- one company ---------- */

export function planCompany(cfg, { responses, known, directory, zipTowns, sources, extra = [], rolls = [] }) {
  const read = new Map();
  for (const s of sources)
    if (/^agricharts/.test(s.platform ?? "") && s.locationId != null) read.set(String(s.locationId), s.id);
  const ids = new Set(sources.map((s) => s.id));
  const famKey = familyOf(cfg.family ?? cfg.company);
  /* THE SAME COMPANY ALREADY READ IN THAT TOWN, on any platform: a second
     source there is a second pin on one yard until somebody shows otherwise. */
  const readTowns = new Map();
  for (const s of sources)
    if (s.enabled !== false && (familyOf(s.operator) === famKey || familyOf(s.operator) === familyOf(cfg.operator)))
      for (const t of [s.location, s.labelInFeed, s.town].filter(Boolean))
        readTowns.set(`${s.state}|${slug(t)}`, s.id);
  const widgets = widgetsIn(responses).filter((w) => !cfg.host || w.host === cfg.host);
  if (!widgets.length) return { ok: false, why: "no AgriCharts widget answer in the capture" };
  const hosts = [...new Set(widgets.map((w) => w.host))];
  if (hosts.length > 1) return { ok: false, why: `the capture loads boards from ${hosts.join(", ")}; name one` };
  const host = hosts[0];
  const locs = new Map();
  /* The company's own capture first, then the same host's widget answers in
     the site's other saved pages (siblingCaptures), which fill a location the
     first one only named. Never another host. */
  const more = widgetsIn(extra ?? []).filter((w) => w.host === host);
  for (const w of [...widgets, ...more]) for (const [id, l] of widgetLocations(w.body)) {
    const have = locs.get(id);
    if (!have || (have.from === "select" && l.from !== "select")) locs.set(id, { ...l, capture: w.capture ?? null });
  }
  const fam = familyOf(cfg.family ?? cfg.company);
  const family = directory.filter((e) => e.status === "known" && familyOf(e.operator) === fam);
  const url = `https://${host}/markets/cashgrid.php`;
  const op = operatorSlug(url);
  const write = [], held = [], already = [];
  const labelCount = new Map();
  for (const l of locs.values()) labelCount.set(slug(l.label), (labelCount.get(slug(l.label)) ?? 0) + 1);
  for (const l of locs.values()) {
    if (labelCount.get(slug(l.label)) > 1 && !read.has(l.id)) { held.push({ id: l.id, label: l.label, why: `the board lists "${l.label}" under two ids; which is the yard is not in the capture` }); continue; }
    if (read.has(l.id)) { already.push({ id: l.id, label: l.label, source: read.get(l.id) }); continue; }
    if ((cfg.skip ?? []).includes(l.id)) { held.push({ id: l.id, label: l.label, why: cfg.skipWhy?.[l.id] ?? "held by hand" }); continue; }
    if (/^\s*DS\b|direct ship/i.test(l.label ?? "")) { held.push({ id: l.id, label: l.label, why: "a direct-ship delivery point, not a yard" }); continue; }
    if (NOT_A_YARD.test(l.label ?? "")) { held.push({ id: l.id, label: l.label, why: "the label names a contract or a list, not a place" }); continue; }
    const place = placeFor(l, { known, operator: cfg.operator, family, zipTowns });
    if (place.why) { held.push({ id: l.id, label: l.label, why: place.why }); continue; }
    /* ANOTHER COMPANY'S PLANT. "CGB-Albany" on Balk's board is a price
       delivered to CGB. Barchart lists some of these as the operator's own
       locations and then they are written; otherwise they are held. */
    if (place.via !== "barchart" && OTHER_PLANT.test(l.label ?? "")) { held.push({ id: l.id, label: l.label, why: "a delivered price at another company's plant, and no directory row lists it as this company's" }); continue; }
    /* A ONE-YARD COMPANY OFTEN LABELS ITS BOARD WITH ITS OWN NAME. The town is
       then the only name the location has. */
    const ownName = slug(cfg.operator).slice(0, 8);
    if (ownName.length >= 5 && slug(place.branch).includes(ownName) && place.city) place.branch = place.city;
    const dupe = [place.branch, place.city, l.label].map((t) => readTowns.get(`${place.state}|${slug(t)}`)).find(Boolean);
    if (dupe) { held.push({ id: l.id, label: l.label, why: `${dupe} already reads this company at ${place.branch}, ${place.state}` }); continue; }
    /* THE BOARD'S OWN ADDRESS PLACES IT; IT DOES NOT SAY WHOSE YARD IT IS.
       2026-10-18, from the var-locations records: FS Grain's board lists
       "Prairie Central-Pontiac" at Pontiac and "Exline" at Kankakee, and the
       Illinois roll licenses only Prairie Central Cooperative at Pontiac and
       only Prairie Creek Grain at Kankakee; StateLine's lists "Mankato" and
       "Fairmont", where the Minnesota roll licenses ADM, CHS and Green Plains
       and never StateLine. A location in a town whose licence rows name other
       companies and never this one is a price delivered to somebody else's
       yard until shown otherwise. A town no roll lists at all says nothing,
       and the board's own record stands. */
    if (place.via === "published") {
      const lm = String(l.label ?? "").match(/^(.+?),\s*([A-Z]{2})\b/);
      if (lm && (slug(lm[1]) !== slug(place.city) || lm[2] !== place.state)) {
        held.push({ id: l.id, label: l.label, why: `the label names ${lm[1]}, ${lm[2]} and the board's own record puts it in ${place.city}, ${place.state}` }); continue;
      }
      {
        const here = (rolls ?? []).filter((b) => b.state === place.state && slug(b.city) === slug(place.city));
        const opSlug = slug(cfg.operator);
        const ours = here.filter((b) => familyOf(b.name) === fam || familyOf(b.name) === familyOf(cfg.operator)
          || (opSlug.length >= 6 && slug(b.name).startsWith(opSlug)));
        if (here.length && !ours.length) {
          const names = [...new Set(here.map((b) => b.name))].slice(0, 3).join("; ");
          held.push({ id: l.id, label: l.label, why: `the licence roll names only ${names} at ${place.city}, ${place.state}, not this company, so "${l.label}" is likely a price delivered to their yard` }); continue;
        }
      }
    }
    write.push({ ...l, place });
  }
  const idOf = (l) => `${op}-${slug(l.place.branch)}`;
  const twice = new Set(write.map(idOf).filter((id, i, a) => a.indexOf(id) !== i));
  const unique = write.filter((l) => {
    if (!twice.has(idOf(l))) return true;
    held.push({ id: l.id, label: l.label, why: `two locations on this board would both be ${idOf(l)}; which is which is not in the capture` });
    return false;
  });
  const claims = claimRows(family, unique);
  const out = [];
  for (const l of unique) {
    const id = idOf(l);
    if (ids.has(id)) { held.push({ id: l.id, label: l.label, why: `source id ${id} is taken` }); continue; }
    const c = claims.get(l.id) ?? [];
    out.push({ id, loc: l, claims: c, claimRows: c.map((rid) => family.find((r) => r.id === rid)) });
  }
  return { ok: true, host, url, family, write: out, held, already };
}

export function manifest(cfg, host, url, w, { capture, run, byZip = new Map() }) {
  const p = w.loc.place;
  /* The board's own coordinate or the licence row's; else the ZIP's; else the
     one the directory already draws for a row this location claims. */
  const z = p.zip ? byZip.get(p.zip) : null;
  const claimed = (w.claimRows ?? []).find((r) => r && Number.isFinite(r.lat) && ["street", "town"].includes(r.precision));
  const coord = p.coord
    ?? (z ? { lat: z.lat, lon: z.lon, precision: "town", how: `the centroid of ZIP ${p.zip} (geocodes/zip-candidates.json)` } : null)
    ?? (claimed ? { lat: claimed.lat, lon: claimed.lon, precision: claimed.precision, how: `the coordinate data/directory.json already draws for ${claimed.id}` } : null);
  const dir = { branch: p.branch, city: p.city, state: p.state, zip: p.zip, phone: p.phone,
                ...(coord ? { coord } : {}) };
  const loc = { locationId: w.loc.id, rows: w.loc.rows, commodities: w.loc.commodities };
  const m = manifestFor({ id: w.id, operator: cfg.operator, website: cfg.website, url, loc, dir,
                          zipCoord: null, kind: "cashgrid" });
  if (cfg.browserPage) m.browserPage = cfg.browserPage;
  /* THE TOWN IS THE LOCATION, THE BOARD'S NAME FOR THE YARD IS THE LABEL, the
     way the CHS and Central United sources carry it: merge_bids.mjs keys a
     place on its town and tells two yards in one town apart by labelInFeed and
     locationId, and a declared Barchart row must sit in the manifest's town. */
  if (p.city) {
    m.location = p.city;
    if (slug(p.branch) !== slug(p.city)) m.labelInFeed = p.branch;
  }
  const seen = w.loc.from === "locations"
    ? `lists location ${w.loc.id} "${w.loc.label}" in its location selector, and the same answer's full location list (var locations) `
      + `publishes it at ${[w.loc.street, w.loc.city, w.loc.state, w.loc.zip].filter(Boolean).join(", ")}; the saved copy held no bid rows for it`
    : w.loc.from === "json"
    ? `lists location ${w.loc.id} "${w.loc.label}" with ${w.loc.rows} bid row(s)`
      + (w.loc.commodities.size ? ` in ${[...w.loc.commodities].join(", ")}` : "")
      + (w.loc.city ? `, published at ${[w.loc.street, w.loc.city, w.loc.state, w.loc.zip].filter(Boolean).join(", ")}` : "")
    : `lists location ${w.loc.id} "${w.loc.label}" in its own location selector (setLocation); the page was filtered to another location, so no rows for this one were in the saved copy`;
  const placeNote = p.via === "barchart"
    ? `PLACE: company, branch, town, state, ZIP and phone are copied from data/known-elevators.json (row ${p.knownRow.facility} | ${p.knownRow.branch} | ${p.knownRow.city}, ${p.knownRow.state}), joined on the board's label by the sweep's own joinDirectory().`
    : p.via === "published"
    ? `PLACE: the directory has no row for this label. Town, state, ZIP and phone are the operator's own, as published for location ${w.loc.id} in that same answer; the ZIP agrees with the state (geocodes/zip-towns.json).`
    : `PLACE: only the board's label names this location. The licence roll holds exactly one row of this company whose town is that label (${p.rollRow.id}: ${p.rollRow.location}, ${p.rollRow.state}), and that row is the town and the coordinate.`;
  const fromOther = w.loc.capture && w.loc.capture !== capture;
  m.note = `WRITTEN BY scripts/wire-captures.mjs from the elevsites capture ${capture} (capture.yml run ${run}, bids repo branch elevsites). `
    + `The operator's own bid page (${cfg.page}) loads https://${host}/inc/cashbids/cashbids-js.php, and the saved answer `
    + (fromOther ? `lists location ${w.loc.id} "${w.loc.label}" in its selector; the same site's page saved as ${w.loc.capture} loads the same widget unfiltered, and that answer ${seen}. `
                 : `${seen}. `)
    + `locationId is that id, the same l= id every cashgrid row link carries (lib/agricharts-published.mjs). `
    + `The poller reads ${url}, the page all other agricharts-cashgrid sources read; that page was NOT fetched when this was written `
    + `(the sandbox could not reach agricharts.com), so the first poll is the first run of the adapter's checks on this board.\n\n`
    + placeNote
    + (w.claims.length ? `\n\nCLAIMS: ${w.claims.join(", ")} (same company, same state and town${w.claims.length > 1 ? "; one yard on two lists" : ""}).` : "");
  m._pending = "cashRounding is round-cent-either, the rule measured for the cashgrid page across 6,228 rows on 45 boards; "
    + "this board's own rows have not been measured yet. "
    + (coord ? `lat/lon is ${coord.precision} precision: ${coord.how ?? (p.via === "roll" ? "the licence row's" : "the operator's own published coordinate")}.`
             : "lat/lon is null until `sync known` and `geocode fill` place it.");
  const sameAsKnown = w.claims.filter((c) => c.startsWith("known:")).map((c) => c.slice(6));
  const registryId = w.claims.filter((c) => c.startsWith("reg:"));
  if (sameAsKnown.length) m.sameAsKnown = sameAsKnown;
  if (registryId.length) m.registryId = registryId.length === 1 ? registryId[0] : registryId;
  return m;
}

/* ---------- the fixture: the capture's answer, trimmed ---------- */

export function trimmedFixture(cfg, host, responses, capture) {
  const out = { note: `Trimmed from the elevsites capture ${capture} (${cfg.page}): the location fields and bid count of each `
    + `AgriCharts location the widget answer published, nothing else. scripts/wire-captures.mjs wrote sources from it.`,
    host, locations: {} };
  for (const w of widgetsIn(responses).filter((x) => x.host === host))
    for (const [id, l] of widgetLocations(w.body)) {
      const have = out.locations[id];
      if (!have || (have.from === "select" && l.from !== "select"))
        out.locations[id] = { label: l.label, city: l.city, state: l.state, zip: l.zip, rows: l.rows, from: l.from,
                              ...(w.capture && w.capture !== capture ? { capture: w.capture } : {}) };
    }
  return out;
}

/* ---------- main ---------- */

function args(argv) {
  const o = { caps: null, config: "probe-lists/wire1-agricharts.json", write: false, run: "39090126520" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--caps") o.caps = argv[++i];
    else if (argv[i] === "--config") o.config = argv[++i];
    else if (argv[i] === "--write") o.write = true;
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const o = args(argv);
  if (!o.caps) { console.error("--caps DIR is required (a checkout of the elevsites branch's caps/<run>/)"); process.exit(2); }
  const rd = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
  const config = rd(o.config);
  const known = rd("data/known-elevators.json").elevators;
  const directory = rd("data/directory.json").elevators;
  const zipTowns = rd("geocodes/zip-towns.json").zips;
  const byZip = new Map(rd("geocodes/zip-candidates.json").zips.map((z) => [z.zip, z]));
  /* Every licence row as the state published it, including the ones the
     directory merged away: whose yard a town holds is a question about the
     roll, not about our pins. */
  const rolls = (rd("data/registries.json").businesses ?? []).filter((b) => b && b.state && b.city && b.name);
  const sources = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")));
  let nWrite = 0, nClaim = 0;
  const folders = readdirSync(o.caps).filter((c) => /^captures-\d+$/.test(c))
    .flatMap((c) => readdirSync(join(o.caps, c)).map((d) => `${c}/${d}`));
  for (const cfg of config.companies) {
    const file = join(o.caps, cfg.capture, "responses.json");
    if (!existsSync(file)) { console.log(`\n## ${cfg.company}: no capture at ${cfg.capture}`); continue; }
    const responses = JSON.parse(readFileSync(file, "utf8")).map((e) => ({ ...e, _capture: cfg.capture }));
    const extra = siblingCaptures(cfg.website, folders).filter((f) => f !== cfg.capture)
      .flatMap((f) => { try { return JSON.parse(readFileSync(join(o.caps, f, "responses.json"), "utf8")).map((e) => ({ ...e, _capture: f })); } catch { return []; } });
    const plan = planCompany(cfg, { responses, known, directory, zipTowns, sources, extra, rolls });
    console.log(`\n## ${cfg.company}${plan.ok ? ` (${plan.host})` : `: ${plan.why}`}`);
    if (!plan.ok) continue;
    for (const a of plan.already) console.log(`   read   ${a.id} ${a.label} -> ${a.source}`);
    for (const h of plan.held) console.log(`   held   ${h.id} ${h.label}: ${h.why}`);
    for (const w of plan.write) {
      const m = manifest(cfg, plan.host, plan.url, w, { capture: cfg.capture, run: o.run, byZip });
      const bad = validateSource(m, new Set());
      if (bad.length) { console.log(`   bad    ${w.id}: ${bad.join("; ")}`); continue; }
      console.log(`   write  ${w.id} (${w.loc.id} ${w.loc.label}; ${m.location}, ${m.state}; ${w.loc.place.via}) claims ${w.claims.join(", ") || "none"}`);
      nWrite++; nClaim += w.claims.length;
      if (o.write) {
        writeFileSync(join(ROOT, "sources", `${w.id}.json`), JSON.stringify(m, null, 2) + "\n");
        sources.push(m);
      }
    }
    if (o.write && plan.write.length) {
      const fx = join(ROOT, "fixtures", "wire1");
      mkdirSync(fx, { recursive: true });
      writeFileSync(join(fx, `agricharts-${operatorSlug(plan.url)}.json`),
        JSON.stringify(trimmedFixture(cfg, plan.host, [...responses, ...extra], cfg.capture), null, 1) + "\n");
    }
  }
  console.log(`\n${o.write ? "wrote" : "would write"} ${nWrite} source(s), claiming ${nClaim} directory row(s)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

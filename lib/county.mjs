/* A COUNTY FIPS CODE FOR AN ELEVATOR, AND HOW FAR TO TRUST IT.
 *
 * 2026-10-18. Weather, land values, rent, yields and farm programs are all
 * published by county. An elevator with only a name and a coordinate cannot be
 * joined to any of them, so every directory row now carries the five-digit
 * county FIPS code of where it is, and the reason we believe it.
 *
 * THE OUTLINES are vendor/census-counties/counties.geo.json, a copy of the file
 * agsist.com already ships for the Farmland Atlas (data/atlas/counties.geo.json):
 * US Census cartographic boundary counties, 2010 vintage, 20m resolution, as
 * republished by plotly/datasets, coordinates rounded to 0.001 degree. 20m is
 * a coarse outline. A point a kilometre or two from a county line can land on
 * the wrong side of it, and that is said on the row (fipsSure false) rather
 * than hidden.
 *
 * ORDER OF EVIDENCE, best first:
 *   licence-county  the state licence roll names the county, and that name is
 *                   a county of the row's state in the outline file. A roll
 *                   saying where its licensee is beats any coordinate we drew.
 *   point           a street-precision coordinate, inside that county.
 *   town-point      a ZIP or town centroid, inside that county. The elevator
 *                   is in or near that town; a yard on the edge of town can be
 *                   across the line.
 *   county-point    the coordinate is itself a county centroid.
 *   nearest-in-state the point fell just outside every county of its own state
 *                   (a coarse outline along a state line or a river); the
 *                   nearest county of that state within NEAREST_KM.
 * Anything else is null, with fipsWhy saying why. A missing code stays missing.
 *
 * Vintage notes carried from scripts/atlas_geometry.py in agsist: Shannon SD
 * is already 46102 and Wade Hampton AK 02158; Connecticut keeps its eight old
 * county codes (09001-09015), not the 2022 planning regions; Valdez-Cordova is
 * still 02261.
 *
 * Node, no dependencies.
 */
import { readFileSync, existsSync } from "node:fs";

export const NEAREST_KM = 5;
/* Within this of a county line on a 20m outline, a point is not called sure. */
export const EDGE_KM = 2;

const CANADA = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);

/** "St. Francis" / "Saint Francis" / "LaSalle" / "La Salle" -> one key. */
export function countyKey(name) {
  return String(name ?? "").toLowerCase()
    .replace(/\b(county|parish|borough|census area|city and borough|municipality)\b/g, "")
    .replace(/\bsaint\b/g, "st").replace(/\bste\b/g, "st").replace(/\bst\b\.?/g, "st")
    .replace(/[^a-z]/g, "");
}

/** Load the outlines once. Returns null when the file is not there (a scratch
 *  tree in a test), and every lookup then says so instead of throwing. */
export function loadCounties(path) {
  if (!path || !existsSync(path)) return null;
  const gj = JSON.parse(readFileSync(path, "utf8"));
  const feats = [];
  const byName = new Map();
  for (const f of gj.features || []) {
    const rings = [];
    const g = f.geometry || {};
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of polys) {
      rings.push(poly);
      for (const ring of poly) for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    const st = f.properties?.st || null;
    const e = { fips: String(f.id), name: f.properties?.name || null, st, polys: rings, bbox: [minX, minY, maxX, maxY] };
    feats.push(e);
    const k = st + "|" + countyKey(e.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }
  return { feats, byName, source: gj.source || null };
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inFeature(x, y, f) {
  const [a, b, c, d] = f.bbox;
  if (x < a || x > c || y < b || y > d) return false;
  for (const poly of f.polys) {
    if (!poly.length || !inRing(x, y, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

/** Kilometres from (lat, lon) to the nearest edge of feature f. */
export function edgeKm(lat, lon, f) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180), ky = 110.57;
  let best = Infinity;
  for (const poly of f.polys) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
      const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const dd = Math.sqrt(px * px + py * py);
      if (dd < best) best = dd;
    }
  }
  return best;
}

/** The county a licence roll names, when that name is one county of the state. */
export function countyByName(C, state, name) {
  if (!C || !state || !name) return null;
  const hit = C.byName.get(String(state).toUpperCase() + "|" + countyKey(name)) || [];
  return hit.length === 1 ? hit[0] : null;
}

/**
 * The FIPS code for one row: { fips, fipsVia, fipsSure } or { fips: null, fipsWhy }.
 * row: { state, lat, lon, precision, county? }
 */
export function fipsFor(C, row) {
  const st = String(row.state || "").toUpperCase();
  if (CANADA.has(st)) return { fips: null, fipsWhy: "in Canada; FIPS codes are US counties" };
  if (!C) return { fips: null, fipsWhy: "the county outlines (vendor/census-counties) were not found" };
  if (row.county) {
    const c = countyByName(C, st, row.county);
    if (c) return { fips: c.fips, fipsVia: "licence-county", fipsSure: true };
  }
  const lat = Number(row.lat), lon = Number(row.lon);
  if (row.lat == null || row.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon))
    return { fips: null, fipsWhy: row.county ? `no coordinate, and the licence roll's county "${row.county}" is not one county of ${st || "an unknown state"}` : "no coordinate" };
  if (!st) return { fips: null, fipsWhy: "no state on the row, so a county cannot be checked against it" };
  const via = row.precision === "street" ? "point" : row.precision === "county" ? "county-point" : "town-point";
  const hits = C.feats.filter((f) => inFeature(lon, lat, f));
  const own = hits.filter((f) => f.st === st);
  if (own.length === 1) {
    const f = own[0];
    /* A county centroid is the middle of its county by construction; it is
       never near a line. Every other point is checked against the edge. */
    const sure = via === "county-point" || edgeKm(lat, lon, f) >= EDGE_KM;
    return { fips: f.fips, fipsVia: via, fipsSure: sure };
  }
  if (own.length > 1) return { fips: null, fipsWhy: `the point falls in ${own.map((f) => f.fips).join(" and ")}, which overlap on the outline` };
  /* Outside every county of its own state: a coarse line, or a wrong point. */
  let best = null, bestKm = Infinity;
  for (const f of C.feats) {
    if (f.st !== st) continue;
    const [a, b, c, d] = f.bbox;
    const pad = NEAREST_KM / 80;
    if (lon < a - pad || lon > c + pad || lat < b - pad || lat > d + pad) continue;
    const k = edgeKm(lat, lon, f);
    if (k < bestKm) { bestKm = k; best = f; }
  }
  if (best && bestKm <= NEAREST_KM)
    return { fips: best.fips, fipsVia: "nearest-in-state", fipsSure: false };
  if (hits.length)
    return { fips: null, fipsWhy: `the coordinate is in ${hits[0].name}, ${hits[0].st}, not in ${st}` };
  return { fips: null, fipsWhy: "the coordinate is outside every US county" };
}

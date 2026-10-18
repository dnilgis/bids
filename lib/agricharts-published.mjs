/* WHERE AN AGRICHARTS LOCATION IS, IN THE OPERATOR'S OWN WORDS.
 *
 * Every AgriCharts customer's cash-bid widget loads
 *
 *     https://<label>.agricharts.com/inc/cashbids/cashbids-js.php?...
 *
 * and the answer opens with `var bids = [ ... ]`: one object per location, with
 * the same id the cashgrid board's l= links carry, and the location's street,
 * city, state, ZIP, phone and latitude/longitude as the operator entered them
 * into the platform. Found 2026-10-01 in Alcivia's capture (capture.yml run
 * 36956170275): 15 locations, every one with a street address and a coordinate,
 * ids 79427 (Baldwin) ... 79418 (Whitewater), the same ids sources/alciviacoop-*
 * carry.
 *
 * Until now a location the directory did not know was "NO DIRECTORY MATCH — no
 * town, so no manifest": 791 lines across two sweeps on 2026-10-02. This is the
 * board's own answer to that question. It is used only where the directory has
 * none, and it is labelled as what it is wherever it lands. */

export const QUERY = "filter=all&location=&commodity=&groupby=location&width=100%25&showtimestamp=1&format=table"
  + "&fields=name%2Cnotes%2Cbasismonth%2Cfutures%2Cprice%2Cbasis%2Cfutureschange&groupheading=table"
  + "&bidsort=commodity&dateformat=%25m%2F%25d%2F%25Y&months=11";

/** The platform host for an AgriCharts board URL, or null. A mobile board's
 *  host (<label>.mobile.agricharts.com) maps to <label>.agricharts.com. */
export function platformHost(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const m = /^([a-z0-9_-]+)\.(?:mobile\.)?agricharts\.com$/.exec(h);
  return m ? `${m[1]}.agricharts.com` : null;
}

export function publishedUrl(host) {
  return `https://${host}/inc/cashbids/cashbids-js.php?${QUERY}`;
}

/** The JSON array after `var bids = `, or null. Brackets inside strings are skipped. */
export function bidsArray(body) { return varArray(body, "bids"); }

/** The JSON array after `var locations = `, or null. The widget sends the
 *  operator's whole location list here (id, street, town, state, ZIP,
 *  coordinate, county, FIPS) even when `var bids` was filtered to one
 *  location. Found 2026-10-18 in the Farmers Coop (Dorchester) home page
 *  capture: 85 locations, DILLER 4605 at 603 Commercial St, Diller NE 68342. */
export function locationsArray(body) { return varArray(body, "locations"); }

export function varArray(body, name) {
  const s = String(body ?? "");
  const k = s.indexOf(`var ${name} = `);
  if (k < 0) return null;
  const start = s.indexOf("[", k);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const STATE = /^[A-Z]{2}$/;
const tidy = (v) => (v == null ? null : String(v).replace(/\s+/g, " ").trim() || null);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };

/** Is this location shown? The widget writes its flags two ways: "1"/"0" on
 *  most hosts, true/false on others (farmersco-operative.agricharts.com,
 *  2026-10-18 capture). Reading only the strings called every location of the
 *  second kind inactive, and those yards were held as unplaced although the
 *  answer carried their street, town, ZIP and coordinate. */
const yes = (v) => v === true || v === 1 || v === "1" || v === "true";
export function shownLocation(l) {
  const active = l?.active == null || yes(l.active);
  const hidden = l?.hide_on_sites_and_apis != null && yes(l.hide_on_sites_and_apis);
  return active && !hidden;
}

/** Locations as published: id -> { name, street, city, state, zip, phone, lat, lon }. Hidden or inactive ones are left out. */
export function parsePublished(body) {
  const arr = bidsArray(body);
  if (!Array.isArray(arr)) return null;
  const out = {};
  for (const l of arr) {
    if (!l || l.id == null) continue;
    if (!shownLocation(l)) continue;
    const state = tidy(l.state)?.toUpperCase() ?? null;
    out[String(l.id)] = {
      name: tidy(l.display_name) ?? tidy(l.name),
      street: tidy(l.street1),
      city: tidy(l.city),
      state: state && STATE.test(state) ? state : null,
      zip: tidy(l.zip),
      phone: tidy(l.phone),
      lat: num(l.latitude),
      lon: num(l.longitude),
    };
  }
  return out;
}

/** A coordinate inside the continental US or southern Canada, or null. Same box test/geocodes.test.mjs holds sources to. */
export function plausible(p) {
  if (!p || p.lat == null || p.lon == null) return false;
  return p.lat > 24 && p.lat < 60 && p.lon > -130 && p.lon < -52;
}

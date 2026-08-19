/* THE SOURCE MANIFEST.
 *
 * One row per elevator location. Adding an elevator is a JSON file, not code —
 * that is the whole design goal, and the thing to protect as this goes from
 * two sources to hundreds.
 *
 * WHAT IS DELIBERATELY *NOT* PER-SOURCE
 *
 * The guards. `cash - basis = quoted futures`, the plausibility band, the two
 * clocks, hold-and-withdraw. A source that could opt out of those is not a
 * source, it is a second way to publish a wrong number, and at three hundred
 * elevators nobody is checking by eye. A new platform gets an ADAPTER — HTML
 * in, normalised rows out — and inherits every guard.
 */

export const PLATFORMS = ["cashbidssingle", "aghost", "first-party"];

const REQUIRED = ["id", "operator", "location", "platform", "url"];

/** Validate one source. Returns [] when clean, else a list of complaints. */
export function validateSource(s, seenIds = new Set()) {
  const bad = [];
  const id = s && s.id ? `"${s.id}"` : "(no id)";
  if (!s || typeof s !== "object") return ["source is not an object"];
  for (const k of REQUIRED) if (!s[k]) bad.push(`${id}: missing ${k}`);
  if (s.id && seenIds.has(s.id)) bad.push(`${id}: duplicate id`);
  if (s.platform && !PLATFORMS.includes(s.platform))
    bad.push(`${id}: unknown platform "${s.platform}" (known: ${PLATFORMS.join(", ")})`);
  if (s.url && !/^https?:\/\//.test(s.url)) bad.push(`${id}: url is not absolute`);

  /* A source with no band publishes nothing, so an empty `bands` is a silent
     outage rather than a config error. Say it at load time. */
  if (!s.bands || !Object.keys(s.bands).length)
    bad.push(`${id}: no bands. Every commodity needs a floor and ceiling before it can publish.`);
  else
    for (const [c, r] of Object.entries(s.bands)) {
      if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => typeof n === "number"))
        bad.push(`${id}: band for ${c} must be [floor, ceiling]`);
      else if (!(r[0] < r[1])) bad.push(`${id}: band for ${c} is inverted or empty`);
    }
  /* Coordinates are not optional for a source that is meant to appear on a
     distance-sorted map. Warn rather than reject: a source can be useful to the
     dashboard before it is useful to the site. */
  for (const k of ["lat", "lon"])
    if (s[k] !== undefined && typeof s[k] !== "number")
      bad.push(`${id}: ${k} must be a number`);
  if (s.lat === undefined || s.lon === undefined)
    bad.push(`${id}: no lat/lon. Without coordinates this source cannot be placed on the cash-bids map and will never be seen.`);
  if (s.cashRoundingCents !== undefined &&
      !(typeof s.cashRoundingCents === "number" && s.cashRoundingCents >= 0 && s.cashRoundingCents <= 1))
    bad.push(`${id}: cashRoundingCents must be 0-1 (cents). Larger than a tick or two is not rounding.`);
  if (s.enabled !== undefined && typeof s.enabled !== "boolean")
    bad.push(`${id}: enabled must be true or false`);
  return bad;
}

/** Turn a manifest row into the shape buildFile() wants. */
export function toConfig(s) {
  return {
    id: s.id,
    locationId: String(s.locationId ?? ""),
    location: s.location,
    /* Which commodities this source is expected to post. Built from the bands,
       so the two cannot drift: if it has a band it is expected, and if it is
       expected it has a band. */
    expect: new RegExp(Object.keys(s.bands).join("|"), "i"),
    bands: s.bands,
    cashRoundingCents: s.cashRoundingCents ?? 0,
    zip: s.zip ?? null, lat: s.lat ?? null, lon: s.lon ?? null,
    phone: s.phone ?? null, email: s.email ?? null, website: s.website ?? null,
    operator: s.operator,
    schema: s.schema ?? `${s.platform}/1`,
    publicNote: s.publicNote,
  };
}

/**
 * @param {Array} rows parsed manifest rows
 * @returns {{sources: Array, errors: string[]}} enabled sources only; a source
 *   that fails validation is DROPPED and reported, never half-loaded.
 */
export function loadSources(rows) {
  const errors = [];
  const seen = new Set();
  const sources = [];
  for (const r of rows) {
    const bad = validateSource(r, seen);
    if (r && r.id) seen.add(r.id);
    if (bad.length) { errors.push(...bad); continue; }
    if (r.enabled === false) continue;
    sources.push(r);
  }
  return { sources, errors };
}

/* EVERY URL A SOURCE WILL ANSWER ON, IN ORDER.
   fetch.mjs tried the apex then the www host, because one of them redirecting
   or failing DNS is not the elevator being down. poll.mjs shipped with a single
   URL and lost that. A source may list `altUrls`; the apex/www twin is added
   automatically because forgetting it is the common case. */
export function urlsFor(s) {
  const out = [s.url, ...(s.altUrls ?? [])];
  try {
    const u = new URL(s.url);
    const twin = u.hostname.startsWith("www.")
      ? u.hostname.slice(4) : `www.${u.hostname}`;
    const alt = new URL(s.url); alt.hostname = twin;
    out.push(alt.toString());
  } catch { /* a malformed url is caught by validation, not here */ }
  return [...new Set(out)];
}

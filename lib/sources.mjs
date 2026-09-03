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

export const PLATFORMS = ["cashbidssingle", "aghost", "fragment", "graindesk", "dtn-cs", "bushel",
                          /* AgriCharts, read through the mobile board. A manifest naming a platform
                             that is not in this list is DROPPED at load, so an adapter that exists
                             and a platform that is not listed is a source that silently never runs. */
                          "agricharts", "agricharts-cashgrid",
                          "first-party"];

/* WHAT COMES BACK ON THE WIRE, WHICH IS NOT THE SAME QUESTION AS WHICH ADAPTER
   READS IT. poll.mjs sends `Accept: text/html` to everything and refuses any
   body under 500 bytes, and both of those are HTML assumptions: a JSON feed for
   a one-location elevator can legitimately be 300 bytes, and it would have been
   thrown away as "too short" with a message about their page having changed.
   The JSON adapters all say something precise about an empty or malformed body,
   so on those the body is handed straight to them. */
export const PLATFORM_WIRE = {
  cashbidssingle: "html",
  aghost: "html",
  fragment: "html",
  graindesk: "json",
  "dtn-cs": "json",
  bushel: "json",
  /* AgriCharts' mobile board is plain server-rendered HTML — no widget, no key,
     no JavaScript. The smallest capture is 8.5KB, so the 500-byte floor is no
     risk here and is worth keeping: a shell page served in its place is exactly
     what it exists to catch. */
  agricharts: "html",
  "agricharts-cashgrid": "html",
  "first-party": "json",
};
export const wireOf = (platform) => PLATFORM_WIRE[platform] ?? "html";

/* HOW THE BODY IS OBTAINED, WHICH IS A THIRD QUESTION AGAIN.
 *
 * Everything here was `fetch` until 2026-08-20, when DTN Content Services
 * answered a probe from the Actions runner with:
 *
 *   "The api key is valid, but it is valid to be used within a browser only."
 *
 * The key was valid, the site id was valid, the path was right. Their gateway
 * scopes those widget keys to browser use and no server-side request passes it
 * — which is also why every path under /markets/ answered 403 whether or not it
 * existed. A `browser` source is loaded in a real Chromium on the customer's
 * own public page, and what we read is the response their own widget asked for.
 * See lib/cdp.mjs. */
/* Bushel joins dtn-cs on the browser: the board is fetched by the customer's
   own page at runtime, so a plain GET of the page returns a shell. We hold no
   credential -- theirs is public in their page, as it must be for a widget. */
export const PLATFORM_TRANSPORT = { "dtn-cs": "browser", bushel: "browser" };
export const transportOf = (platform) => PLATFORM_TRANSPORT[platform] ?? "fetch";

/* https, or loopback.
   An http page on a public host would put a cash board on an unauthenticated
   wire, which is the same objection the `url` check makes. Loopback is not a
   wire -- and without this the whole browser path could only ever be tested
   against the live internet, which is not a test. */
export function isBrowsablePage(u) {
  if (/^https:\/\//.test(u)) return true;
  try {
    const h = new URL(u).hostname;
    return /^http:\/\//.test(u) && (h === "127.0.0.1" || h === "localhost" || h === "::1");
  } catch { return false; }
}

/* Declared knobs, so a typo is caught at load rather than at 3am on a Sunday.
   The values themselves live in board.mjs; these are the names a manifest may
   use, kept here because this is the file that reads manifests. */
export const CASH_ROUNDING_MODES = ["exact", "floor-cent", "round-cent"];
export const FUTURES_UNITS = ["cents", "ticks", "dollars"];

const REQUIRED = ["id", "operator", "location", "platform", "url"];

/* NOT EVERY COMPLAINT SHOULD DROP A SOURCE, AND THIS FILE USED TO SAY SO WHILE
 * DOING THE OPPOSITE. The lat/lon check carried the comment "Warn rather than
 * reject: a source can be useful to the dashboard before it is useful to the
 * site" and then pushed onto the list that drops it. sunriseag-buckman ships
 * with `lat: null, lon: null` on purpose -- the Census geocoder returns zero
 * matches for its address and a coordinate that is not derived from a source is
 * not a coordinate -- so under the old code that source was silently thrown
 * away at load, which is the one outcome the comment was arguing against.
 *
 * Two channels now. `validateSource` still returns the fatal list. `warnSource`
 * returns the things worth saying that must not cost an elevator its reading. */
export function warnSource(s) {
  const notes = [];
  const id = s && s.id ? `"${s.id}"` : "(no id)";
  if (s?.lat === null || s?.lon === null)
    notes.push(`${id}: no coordinates. It will be read and published, but it cannot be ` +
               `placed on the cash-bids map and no farmer will find it by distance.`);
  if (s?.inMerge === false)
    notes.push(`${id}: inMerge is false, so it is read but deliberately kept off the map.`);
  return notes;
}

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

  /* A PLACEHOLDER IS NOT A VALUE -- 2026-08-29.
   *
   * dtn-probe.yml prints a manifest skeleton with "SET THIS" in every field it
   * cannot measure, and says so: "Fill in every SET THIS in the output ... and
   * only then commit a manifest and enable it." FORTY-THREE sources were
   * committed and enabled with `"website": "SET THIS"` still in them -- Allied,
   * Country Partners, Premier, Country Visions, Ag-Land FS and Insight FS, 43
   * of the 255 green pins, every one of them live and priced within the day.
   *
   * Nothing caught it because nothing looked. The checks below ask whether a
   * field is PRESENT; none asked whether what is in it is real. A skipped step
   * that leaves its own marker behind is the cheapest possible thing to catch,
   * and this is the line that catches it. */
  for (const [k, v] of Object.entries(s))
    if (typeof v === "string" && /^\s*SET[ _-]?THIS\s*$/i.test(v))
      bad.push(`${id}: ${k} is still the probe's "SET THIS" placeholder. The skeleton was ` +
               `committed without being filled in. For a browser source the website is the ` +
               `origin of its own browserPage; everything else has to be measured or looked up.`);

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
  /* A coordinate is a number or an explicit null. Null says somebody looked and
     could not derive one; missing says nobody has looked. Half a coordinate is
     neither -- it puts a pin in the Gulf of Guinea -- so both or neither. */
  for (const k of ["lat", "lon"])
    if (!(k in s))
      bad.push(`${id}: no ${k}. Set it, or set it to null to say plainly that no coordinate could be derived.`);
    else if (s[k] !== null && typeof s[k] !== "number")
      bad.push(`${id}: ${k} must be a number or null`);
  if ("lat" in s && "lon" in s && (s.lat === null) !== (s.lon === null))
    bad.push(`${id}: lat and lon must both be numbers or both be null. Half a coordinate is not a place.`);
  if (typeof s.lat === "number" && typeof s.lon === "number") {
    if (!(s.lat > 24 && s.lat < 50 && s.lon > -125 && s.lon < -66))
      bad.push(`${id}: ${s.lat},${s.lon} is not in the continental US. A transposed pair reads as a plausible number and lands in the wrong hemisphere.`);
  }

  /* THE MANIFEST HAS TO SAY WHICH LOCATION, EVEN WHEN THE ANSWER IS "NONE".
     `null` means their page carries one location and does not key its rows;
     missing used to match EVERY row on the page, which is how one town's bids
     end up on another town's board. See normLocationId in parse.mjs. */
  /* A browser source has TWO urls and needs both: `url` is the response we are
     waiting for, `browserPage` is the page that will ask for it. Without the
     second there is nothing to load and the source would wait out its timeout
     on every poll. */
  if (s.platform && transportOf(s.platform) === "browser") {
    if (!s.browserPage)
      bad.push(`${id}: platform "${s.platform}" is read through a browser and needs browserPage — the public page whose own widget requests ${s.url ?? "that url"}.`);
    else if (!isBrowsablePage(s.browserPage))
      bad.push(`${id}: browserPage must be an https url (or a loopback address, for tests)`);
  } else if (s.browserPage) {
    bad.push(`${id}: has browserPage but platform "${s.platform}" is not read through a browser, so nothing would use it.`);
  }

  if (!("locationId" in s))
    bad.push(`${id}: no locationId. Set it to their page's own location key, or to null if the page carries exactly one location and does not key its rows.`);

  if (s.cashRounding !== undefined && !CASH_ROUNDING_MODES.includes(s.cashRounding))
    bad.push(`${id}: cashRounding "${s.cashRounding}" is not one of ${CASH_ROUNDING_MODES.join(", ")}`);
  if (s.futuresUnits !== undefined && !FUTURES_UNITS.includes(s.futuresUnits))
    bad.push(`${id}: futuresUnits "${s.futuresUnits}" is not one of ${FUTURES_UNITS.join(", ")}`);

  /* SECRETS LIVE IN REPO SECRETS. A manifest may say WHICH secret to use and
     must never say what it is -- including by carrying it in the url, where
     every log line, every error message and every redirect would keep it. */
  if ("apiKey" in s)
    bad.push(`${id}: carries an apiKey. Use apiKeyEnv with the NAME of a repo secret.`);
  if (s.url && /[?&]apikey=/i.test(s.url))
    bad.push(`${id}: has a key in its url. Use apiKeyEnv; poll.mjs sends it as a header so it stays out of the logs.`);
  if (s.apiKeyEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(String(s.apiKeyEnv)))
    bad.push(`${id}: apiKeyEnv should be the NAME of an environment variable, not a value.`);
  /* A list of strings, and nothing else: a bare string would silently match
     every symbol that starts with any of its characters. */
  if (s.foreignQuote !== undefined &&
      !(Array.isArray(s.foreignQuote) && s.foreignQuote.length &&
        s.foreignQuote.every((p) => typeof p === "string" && p.trim().length)))
    bad.push(`${id}: foreignQuote must be a non-empty array of futures-symbol ` +
      `prefixes, e.g. ["RS"] for ICE canola. Leave it out for a board whose every ` +
      `quote is in the same unit and currency as its cash.`);
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
    /* FAITHFULLY, INCLUDING THE NULL. This used to be
       `String(s.locationId ?? "")`, which turned a deliberate null into an
       empty string and, worse, meant the key was always present by the time
       buildFile saw it -- so buildFile's own "the manifest must say which
       location" guard could never fire. A conversion that makes a guard
       downstream unreachable is not a conversion, it is a hole. */
    locationId: s.locationId === null || s.locationId === undefined
      ? null : String(s.locationId),
    location: s.location,
    /* Which commodities this source is expected to post. Built from the bands,
       so the two cannot drift: if it has a band it is expected, and if it is
       expected it has a band. */
    expect: new RegExp(Object.keys(s.bands).join("|"), "i"),
    bands: s.bands,
    cashRoundingCents: s.cashRoundingCents ?? 0,
    foreignQuote: s.foreignQuote ?? undefined,
    /* The two knobs added 2026-08-20. Both were live in board.mjs and neither
       reached it, because this function is the only thing that hands a
       manifest to buildFile and it did not carry them. A knob nothing passes
       through is a knob that silently does nothing. */
    cashRounding: s.cashRounding,
    futuresUnits: s.futuresUnits,
    /* WHAT THIS SOURCE PUBLISHES ON WHEN ITS BOARD HAS NO FUTURES COLUMN.
       AgriCharts boards carry cash, basis and a futures CHANGE and no price, so
       cash - basis = futures can never run on them. buildFile refuses such a
       source unless it names the alternative AND every row carries that same
       stamp from the adapter. It has to travel through here or the declaration
       silently does nothing and the source refuses for a reason nobody can
       find -- see the note above about knobs that do not reach board.mjs. */
    identityAlternative: s.identityAlternative ?? null,
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
  const warnings = [];
  for (const r of rows) {
    const bad = validateSource(r, seen);
    if (r && r.id) seen.add(r.id);
    if (bad.length) { errors.push(...bad); continue; }
    if (r.enabled === false) continue;
    warnings.push(...warnSource(r));
    sources.push(r);
  }
  return { sources, errors, warnings };
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

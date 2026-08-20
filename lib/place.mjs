/* IS THIS A TOWN, OR IS IT SOMEWHERE THE GRAIN GOES?
 *
 * A DTN board's "location" column is whatever the co-operative typed. Most of
 * them are the co-op's own elevators and are towns. A good many are not:
 *
 *   ADM Havana   Bunge PDC   Valero CC   Tharaldson Ethanol   AGP-Hastings
 *   Shell Rock Soy   Viserion Mcgregor   BioUrja   ICP   Big River Dyersville
 *   Green America-Ord   CHS Havana   Red Wing Grain LLC
 *
 * Those are DELIVERY DESTINATIONS -- a processor, a terminal, an ethanol
 * plant, sometimes a joint venture -- quoted through the same board because a
 * farmer can haul there against the co-op's contract. They are real bids and
 * worth carrying. They are NOT towns.
 *
 * The reason this matters is the manifest. Every source file carries a town, a
 * street address and a geocode, and AGSIST puts a pin on a map with them. Ask
 * a geocoder for "Bunge PDC" and it will hand back a coordinate somewhere,
 * with no error, and a bid will appear on the map at a place nobody chose.
 * Rule one of this project is not to invent a town or a coordinate, and the
 * quiet way to break it is to accept a name that merely looks like one.
 *
 * SO THIS FLAGS, IT DOES NOT DECIDE. It cannot know that "Monica" is a village
 * in Illinois and "Alto" is one too, and it is not going to guess. What it can
 * do is say "this one has a company's name in it, look before you geocode",
 * which turns a silent assumption into a question. False positives cost a
 * glance. False negatives cost a pin in the wrong county.
 */

/* Grain buyers whose name on a board means a destination rather than a town.
   Every one of these was READ OFF A REAL ROSTER captured on 2026-08-20, not
   recalled from general knowledge. */
export const BUYERS = [
  "adm", "agp", "andersons", "biourja", "bunge", "cargill", "cgb", "chs",
  "consolidated grain", "gavilon", "green america", "green plains", "icp",
  "louis dreyfus", "poet", "scoular", "shell rock", "tharaldson", "valero",
  "viserion", "big river",
];

/* Words that describe a facility, not a place. "Soy" is here because
   "Shell Rock Soy" is a crush plant; "Rapids" is NOT, because Wisconsin
   Rapids is a city. */
export const FACILITY = [
  "ethanol", "elevator", "terminal", "processing", "processors", "plant",
  "crush", "soy", "biodiesel", "mill", "milling", "feeds", "feed",
];

/* Company suffixes and company words. A town is not an LLC, and it is not a
   co-operative either -- several boards use the operator's OWN name as a
   location ("UNITED QUALITY COOP") to mean "at our house". "grain" is on this
   list and is safe there: American towns are not called Something Grain, but
   elevators are, and "Alton Grain" on Clifford's board is Alton Grain Terminal
   in Hillsboro rather than a town called Alton Grain. */
export const SUFFIX = [
  "llc", "l.l.c.", "inc", "inc.", "co.", "corp", "corporation", "ltd",
  "coop", "co-op", "cooperative", "company", "grain", "agri", "farmers",
];

/* NOT A PLACE AT ALL. Boards use these to mean "here", and a geocoder will
   cheerfully return a coordinate for the word "Local". Measured on the
   2026-08-20 rosters: both Clifford Farmers and United Quality use it. */
export const PLACEHOLDER = ["local", "home", "house", "main", "office", "n/a", "other", "various"];

const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/* Why this name is suspect, or null if nothing about it is.
   The REASON is returned rather than a bare boolean, because a flag a person
   cannot see the grounds for is a flag they learn to click past. */
export function destinationReason(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  const w = words(raw);

  if (PLACEHOLDER.includes(low) || (w.length === 1 && PLACEHOLDER.includes(w[0])))
    return `"${raw}" is a placeholder, not a place — find out which yard it means`;

  for (const b of BUYERS)
    if (b.includes(" ") ? low.includes(b) : w.includes(b))
      return `"${raw}" carries a grain buyer's name (${b}) — a destination, not a town`;

  for (const f of FACILITY)
    if (w.includes(f))
      return `"${raw}" names a facility (${f}) — check it is a town before geocoding`;

  for (const s of SUFFIX)
    if (w.includes(s))
      return `"${raw}" carries a company suffix (${s}) — a business, not a place`;

  /* A joint venture or a "company-town" pair: two capitalised halves joined by
     a hyphen or a slash. "Ft Atkinson/Waucoma" trips this and is two towns,
     which is exactly the case a person needs to see rather than a machine
     resolve. */
  if (/[-/]/.test(raw) && /[A-Za-z]{2}\s*[-/]\s*[A-Za-z]{2}/.test(raw))
    return `"${raw}" joins two names — decide which town this bid belongs to, or whether it is one`;

  return null;
}

export const looksLikeDestination = (name) => destinationReason(name) !== null;

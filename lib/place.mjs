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

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT A BOARD CALLS ITS OWN YARD.
   ═══════════════════════════════════════════════════════════════════════════
   Run 91852779678 read 36 Scoular locations posting real prices across twelve
   states and placed none of them, because none of the labels is a bare town:

       Big Springs, NE          Scoular Goodland         Grainton Cash Bids
       Minneapolis, KS          Scoular-Downs            Coolidge Cash Bids
       Scoular - Butte, MT      Scoular Idalia           Goodland Crush, KS
       Madrid, NE Ethanol       AGP - Manning            Bunge - Council Bluffs

   Four things are stacked on the town: the operator's own name, cash-bid
   boilerplate, a state code, and a facility qualifier. Peel them and most of
   these are ordinary towns with the state already stated — no directory lookup
   needed to know that Big Springs is in Nebraska, because the board says so.

   THE OPERATOR'S NAME COMES OFF FIRST, AND THE ORDER IS THE WHOLE POINT.
   destinationReason() flags "Scoular Goodland" as a destination, and on
   anybody else's board it would be right. On SCOULAR'S board it is Scoular's
   yard at Goodland. Ask about the remainder, not the label — otherwise a
   merchant can never publish its own elevators. Strip first, then ask, and
   "AGP - Manning" and "Bunge - Council Bluffs" are still refused, because AGP
   and Bunge are not Scoular.

   WHAT IS NOT DONE HERE. No town is invented and no state is guessed: a state
   is taken only where the board writes one, and a label that peels down to
   nothing, to an initialism, or to somebody else's name is refused with the
   reason. Rule 1. */

export const US_STATES = new Set(
  ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS "
   + "MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV "
   + "WI WY").split(" "));

/* Trailing furniture. Repeated, because it stacks: "Scoular Adrian Cash Bids". */
const LABEL_BOILER = /\s*[-–—:|]?\s*(cash\s*bids?|grain\s*bids?|cash\s*prices?|bids?|prices?|board)\s*$/i;
const LABEL_LEAD = /^\s*(delivered|delivery|bids?\s*(?:for|at)|cash\s*bids?)\s+/i;

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function normaliseLabel(rawLabel, operator = "") {
  const raw = String(rawLabel ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { town: null, state: null, why: "the board gave no label at all" };

  let s = raw;
  let state = null;

  /* THE STATE, WHERE THE BOARD WRITES ONE. Comma-delimited only. A bare
     trailing "NE" could be half a town name; ", NE" is a state, and twenty of
     the thirty-six write it that way. It is not always last -- "Madrid, NE
     Ethanol" puts a facility word after it -- so the match is anywhere and
     what follows is kept as a qualifier rather than dropped silently. */
  const st = s.match(/,\s*([A-Za-z]{2})\b(.*)$/);
  if (st && US_STATES.has(st[1].toUpperCase())) {
    state = st[1].toUpperCase();
    s = (s.slice(0, st.index) + " " + st[2]).replace(/\s+/g, " ").trim();
  }

  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(LABEL_BOILER, "").replace(LABEL_LEAD, "").trim();
    if (s === before) break;
  }

  /* THE OPERATOR'S OWN NAME, off the front, one word at a time. "ScoularView"
     is the operator and "Scoular" is what the labels say, so this compares
     slugs by prefix rather than by equality. It stops as soon as removing a
     word would empty the label: "Farm Service Elevator" on Farm Service
     Elevator's board peels to nothing, which is a refusal, not a town. */
  const op = norm(operator);
  let peeled = false;
  if (op.length >= 4) {
    let words = s.split(/[\s\-–—]+/).filter(Boolean);
    while (words.length > 1) {
      const w = norm(words[0]);
      if (w.length >= 3 && (op.startsWith(w) || w.startsWith(op.slice(0, 6)))) { words.shift(); peeled = true; }
      else break;
    }
    s = words.join(" ").replace(/^[\s\-–—:|]+/, "").trim();
  }
  s = s.replace(/^[\s\-–—:|,]+|[\s\-–—:|,]+$/g, "").trim();

  if (!s || s.length < 3)
    return { town: null, state, why: `"${raw}" is nothing but the operator's name and boilerplate` };

  /* WHAT IS LEFT IS STILL THE OPERATOR -- BUT ONLY IF WE TOOK SOMETHING OFF.
     The word-by-word peel stops while more than one word remains, so "One
     Earth Energy Cash Bids" on One Earth Energy's own board came out as
     "Earth Energy": a company with its first word missing, dressed up as a
     town.
     
     `peeled` is why this is not simply "is the label inside the operator
     name". CO-OPS ARE NAMED AFTER THEIR TOWNS. Berthold Farmers' board says
     "Berthold" and that is the town of Berthold, North Dakota -- the manifest
     written for it on run 91852779678 is correct. A label the board wrote
     whole stands on its own; only a fragment this function manufactured has
     to prove it is not just the company again. */
  if (peeled && op.length >= 4 && norm(s).length >= 3 && op.includes(norm(s)))
    return { town: null, state, why: `"${raw}" is the operator's own name — the board does not say which yard` };

  /* A LABEL THIS REPOSITORY WROTE ITSELF. extractListBids() falls back to
     "location 2451" when a board names nothing, and that string must never
     round-trip into a town: it would put a place called Location 2451 on a
     map, sourced from our own placeholder. */
  if (/^location\s+(\d+|unknown)$/i.test(s))
    return { town: null, state, why: `"${raw}" is this repository's own placeholder, not a name the board gave` };

  /* AN INITIALISM IS NOT A TOWN. "NWGG", "PGG", "FGC" -- three of these came
     back on this run. A geocoder will happily place them somewhere. */
  if (/^[A-Z0-9]{2,5}$/.test(s) && !/[aeiou]/i.test(s.slice(1)))
    return { town: null, state, why: `"${raw}" peels to the initialism "${s}" — find out which yard it means` };

  const why = destinationReason(s);
  if (why) return { town: null, state, why };

  return { town: s, state, why: null };
}

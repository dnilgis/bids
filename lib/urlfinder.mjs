/* GUESSING A CO-OPERATIVE'S WEBSITE, AND THEN PROVING IT IS THEIRS.
 *
 * THE WALL THIS EXISTS TO CLIMB, measured 2026-09-08 at 8ccdba6:
 *
 *     4,982  elevators this project knows exist
 *       887  we have a board for
 *     4,270  with NO WEBSITE ON FILE — no URL, so nothing to ask
 *     2,385  of those carrying a phone number
 *
 * State licence rolls grow the denominator and can never grow the numerator:
 * states publish LICENSEES, not URLs. Tonight's registries run added 2,247 rows
 * to the directory and, by construction, zero readable boards. The numerator
 * only moves when a name becomes a URL.
 *
 * THERE IS NO SEARCH ENGINE HERE, and there is not going to be one. So the
 * method is the only honest one left: derive candidate hostnames from the
 * business's own name by a fixed mechanical rule, fetch them, and then REFUSE
 * every one that cannot be proved to belong to that business.
 *
 * WHAT COUNTS AS PROOF — and this is the whole design.
 *
 *   PHONE   The ten-digit phone we already hold appears on the page. That is
 *           identity, and it is the same rule scripts/build_directory.mjs
 *           already uses to decide a licence row and a board are one elevator
 *           ("THE PHONE DECIDES"). Only this is accepted.
 *
 *   TOWN    The town and state appear, and at least one substantial word of the
 *           business's name. NOT identity, and it is not treated as any: that
 *           same comment in build_directory.mjs says it outright — "a town
 *           match alone is not identity: a town can hold three elevators".
 *           Recorded, put on a worklist for a person, never written in as a
 *           website.
 *
 *   NONE    Rejected, with the reason kept, because a rejection nobody can see
 *           the grounds for is a rejection nobody can correct.
 *
 * A guessed domain that answers 200 proves only that SOMEBODY owns it. Half the
 * short agricultural .coms in the country are parked, and a parking page will
 * happily render the word "grain". The verification is not a formality here; it
 * is the entire difference between this and making things up.
 *
 * WHY NOT lib/place.mjs's SUFFIX LIST. It exists to answer a different question
 * — "is this string a town?" — and for that job "farmers", "grain" and
 * "cooperative" are noise to be stripped. For guessing a hostname they are the
 * signal: farmerscoop.com, cenexgrain.com. Same words, opposite verdicts, so
 * this file keeps its own list of LEGAL tails only and says why here rather
 * than importing the wrong one because it was nearer.
 *
 * Everything in this file is pure. The fetching, the budget, the ledger and the
 * robots check live in scripts/urlfinder.mjs, so all of the below is testable
 * with no network — which matters, because the sandbox this was written in has
 * no route to any of these hosts and the runner is what measures the yield.
 */

/** Last ten digits, exactly as scripts/build_directory.mjs computes them. */
export const digits10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

/* A NUMBER THAT IS NOT A PHONE NUMBER. data/known-elevators.json carries
   "9999999999" for CGB's Pine Bluff facility — a filler somebody typed into a
   form. It is ten digits, so digits10 is perfectly happy with it, and a page
   with a long run of nines would then "prove" an elevator. One row today; the
   check costs nothing and the failure it prevents is the exact one this whole
   tool is built to avoid. */
export const isPlaceholderPhone = (p) => {
  const d = digits10(p);
  if (d.length !== 10) return false;
  return new Set(d).size <= 2
    || "01234567890".includes(d) || "09876543210".includes(d);
};

/** A phone this project may use as identity: ten digits, and not filler. */
export const usablePhone = (p) => digits10(p).length === 10 && !isPlaceholderPhone(p);

/* LEGAL TAILS ONLY. "cooperative" is not here and must not be: it is half the
   hostnames this is trying to guess. "co" is, because a trailing "Co" is a
   company word — but it is only ever stripped from the END, so "Co-op Elevator"
   and "Country Grain" are untouched. */
export const LEGAL_TAIL = new Set([
  "llc", "llp", "lc", "lp", "inc", "incorporated", "corp", "corporation",
  "ltd", "limited", "co", "company", "companies", "pllc", "plc",
]);

const clean = (s) => String(s ?? "").toLowerCase()
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The business's name as words, with legal tails and a leading "the" removed.
 * Returns [] for a name that is nothing but legal boilerplate.
 */
export function nameCore(name) {
  let w = clean(name).split(" ").filter(Boolean);
  while (w.length && w[0] === "the") w = w.slice(1);
  while (w.length > 1 && LEGAL_TAIL.has(w[w.length - 1])) w = w.slice(0, -1);
  return w;
}

/* TLDs, in the order they are tried. `.coop` is not decoration: it is a
   sponsored TLD restricted to actual co-operatives, so a .coop that answers is
   already evidence of a kind no .com can offer. It still has to prove itself. */
export const TLDS = [".com", ".coop", ".net"];

export const MAX_CANDIDATES = 8;

/**
 * Candidate hostnames for one business, best first, deduped and capped.
 *
 * Derived from the NAME only. The town is deliberately not spliced in: a
 * business called Farmers Cooperative in Dorchester does not thereby own
 * dorchesterfarmers.com, and inventing a host out of two facts we hold is how a
 * plausible wrong answer gets manufactured. If the name does not suggest it,
 * this returns fewer candidates rather than worse ones.
 */
export function candidateHosts(name, { limit = MAX_CANDIDATES } = {}) {
  const core = nameCore(name);
  if (!core.length) return [];

  const stems = [];
  const push = (words) => {
    const s = words.join("");
    /* Three characters is not a hostname anybody can be identified by, and a
       forty-character one is not a hostname anybody registered. */
    if (s.length >= 5 && s.length <= 40 && !stems.includes(s)) stems.push(s);
  };

  push(core);
  /* "cooperative" -> "coop" is the single most common abbreviation on these
     sites; it is a substitution, not a guess about the business. */
  const abbrev = core.map((w) => (w === "cooperative" ? "coop" : w));
  push(abbrev);
  /* The co-operative word dropped entirely: Ursa Farmers Cooperative Co is
     ursafarmers.com.

     THIS IS THE STEM THAT COULD GO GENERIC, and it was measured before being
     left alone. Across the 2,385 businesses carrying a phone on 2026-09-08 it
     collapses to a single word for FIFTEEN of them, twelve distinct: landus,
     aspinwall, maxyield, nexus, silveredge, stateline, farmers x3, united,
     premier, and key/pro/new — the last three already refused by the
     five-character floor above. So the whole exposure is three requests to
     hosts that are certainly somebody else's, out of roughly nineteen thousand,
     and each of them is refused by the verification anyway. A stoplist of
     generic words would be a list recalled rather than measured, for that. */
  const noCoop = abbrev.filter((w) => w !== "coop");
  if (noCoop.length) push(noCoop);
  /* The first two words, for the long registered names — "Farmers Cooperative
     Elevator Company of Hanska" is farmerscoop.com's problem, not ours. */
  if (abbrev.length > 2) push(abbrev.slice(0, 2));

  const hosts = [];
  for (const tld of TLDS)
    for (const s of stems) {
      if (hosts.length >= limit) return hosts;
      hosts.push(s + tld);
    }
  return hosts;
}

/** Tags out, entities loosened, whitespace collapsed. Not a parser; a sieve. */
export const textOf = (html) => String(html ?? "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ");

/* A ten-digit phone, however the page happens to punctuate it or mark it up.
   The gaps allow "(715) 555-1234", "715.555.1234", "7155551234" and "tel:+1...".
   They are bounded at EIGHT characters on purpose: an unbounded gap turns three
   unrelated numbers scattered down a page into a match, and the entire value of
   this check is that a match means something.

   TRIED TWICE, ON THE RAW HTML AND ON THE STRIPPED TEXT, because a real page
   writes this:

       <span>217</span>-<span>964</span>-<span>2131</span>

   which is fourteen characters between the groups and was refused by the first
   version of this. Widening the gap to reach it would have loosened the bound
   on every page; stripping the tags first leaves a gap of three and loosens
   nothing at all. */
export function phoneOnPage(html, phone) {
  if (!usablePhone(phone)) return false;
  const d = digits10(phone);
  const g = (a, b) => d.slice(a, b).split("").join("\\s*");
  const re = new RegExp(`${g(0, 3)}\\D{0,8}${g(3, 6)}\\D{0,8}${g(6, 10)}`);
  const raw = String(html ?? "");
  return re.test(raw) || re.test(textOf(raw));
}

/* THE SECOND PROOF: THE STREET ADDRESS — added 2026-09-08, and measured first.
 *
 * The phone alone reaches 575 of the 2,373 named businesses that yield a
 * candidate hostname. Iowa and Missouri publish a phone; Arkansas, South Dakota,
 * Nebraska, Indiana, North Dakota, Texas, Washington and Idaho publish none, and
 * Ohio and Wisconsin publish a STREET ADDRESS instead. Counting the committed
 * gap list on 2026-09-08:
 *
 *     2,373  named, and a candidate hostname can be derived
 *       575  carry a ten-digit phone
 *       827  carry a street address
 *     1,115  carry one or the other  <- what this tool can ever prove
 *     1,258  carry NEITHER           <- findable, never provable, so never filed
 *
 * A house number beside its own street name, in the right town, in the right
 * state, is identity in the same way a phone is: "1529 Highway 193, Wynne AR"
 * is one yard. The bar is deliberately all four at once — number, street word,
 * town, state — because any one of them alone is a coincidence waiting to
 * happen, and "201 W. Washington" matching a page that says "Washington" would
 * be exactly that.
 *
 * WHAT IT REFUSES TO READ. A post-office box is not a place: the registry rows
 * carry "4337 Hwy 158PO Box 549" and "PO Box 617", and a box number matched
 * against a page is a number matched against nothing. The box is stripped
 * before the number is taken. If what is left has no house number and no street
 * word, this proof is simply not available for that row, which is the honest
 * outcome rather than a weaker rule.
 */
const ADDRESS_NOISE = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|box)\b[\s#]*\d*/gi;

/* Street TYPES and directionals identify nothing — every address in the county
   has one — so they are stripped and what is left has to carry the row. That
   includes "highway" and "hwy": on a rural address the identifying part is the
   ROUTE NUMBER, and dropping every numeric token was the first version's bug —
   "1529 Highway 193" reduced to the word "highway", which is a match against
   half of Arkansas. Numbers other than the house number are kept. */
const ADDRESS_GENERIC = new Set([
  "north", "south", "east", "west", "northeast", "northwest", "southeast",
  "southwest", "street", "road", "drive", "lane", "avenue", "court", "place",
  "suite", "unit", "highway", "hwy", "route", "rte", "blvd", "boulevard",
  "circle", "trail", "parkway", "county", "state", "main",
]);

export function addressParts(address) {
  const raw = String(address ?? "")
    /* "158PO Box 549" — the registries run them together with no separator. */
    .replace(/(\d)(P\.?O\.?\s*Box)/gi, "$1 $2")
    .replace(ADDRESS_NOISE, " ")
    .replace(/\s+/g, " ").trim();
  const num = raw.match(/(^|\s)(\d{1,6})(?=\s|$|[a-zA-Z])/);
  const number = num ? num[2] : null;
  const words = raw.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
    .filter(Boolean)
    .filter((w) => !ADDRESS_GENERIC.has(w))
    .filter((w) => (/^\d+$/.test(w) ? w !== number && w.length >= 2 : w.length >= 3));
  return { number, words: [...new Set(words)] };
}

/**
 * The house number standing beside one of its own street words.
 *
 * MEASURED IN WORDS, NOT CHARACTERS — corrected before shipping. A character
 * gap has to be about twenty to admit "1529 Highway 193", where the street type
 * sits between the two identifying numbers, and at twenty it also admits
 * "Founded 1529. Call about route 193", which is nineteen characters of
 * unrelated prose. A real address puts at most a street type and a directional
 * between the number and the rest of it, so the bound is TWO INTERVENING WORDS
 * and the contrived case falls outside it at four.
 *
 * It does not stand alone in any case: `verdict` requires the town AND the
 * state alongside before an address may prove anything.
 */
export const ADDRESS_GAP_WORDS = 2;

export function addressOnPage(html, address) {
  const { number, words } = addressParts(address);
  if (!number || !words.length) return false;
  const text = textOf(html);
  const near = `(?:\\s+\\S+){0,${ADDRESS_GAP_WORDS}}\\s+`;
  for (const w of words) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${number}\\b${near}${esc}\\b|\\b${esc}\\b${near}${number}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

export const STATE_NAMES = {
  AL: "alabama", AR: "arkansas", AZ: "arizona", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia", IA: "iowa",
  ID: "idaho", IL: "illinois", IN: "indiana", KS: "kansas", KY: "kentucky",
  LA: "louisiana", MA: "massachusetts", MD: "maryland", ME: "maine",
  MI: "michigan", MN: "minnesota", MO: "missouri", MS: "mississippi",
  MT: "montana", NC: "north carolina", ND: "north dakota", NE: "nebraska",
  NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NV: "nevada",
  NY: "new york", OH: "ohio", OK: "oklahoma", OR: "oregon",
  PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
  SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah",
  VA: "virginia", VT: "vermont", WA: "washington", WI: "wisconsin",
  WV: "west virginia", WY: "wyoming",
};

const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");

/**
 * What this page says about this business. Counts and booleans only, never a
 * verdict — `verdict()` below turns them into one, so the two can be tested
 * apart and so a change to the threshold is visible as a change to one line.
 */
export function evidenceIn(html, business) {
  const text = textOf(html).toLowerCase();
  const st = String(business?.state ?? "").toUpperCase();
  const city = clean(business?.city);

  const stateNamed = Boolean(
    st && (wordRe(st.toLowerCase()).test(text)
        || (STATE_NAMES[st] && text.includes(STATE_NAMES[st]))));

  return {
    phone: phoneOnPage(html, business?.phone),
    address: addressOnPage(html, business?.address),
    town: Boolean(city && city.length >= 3 && wordRe(city).test(text)),
    state: stateNamed,
    /* Words of four letters or more, so "of", "the" and "co" cannot carry it. */
    nameTokens: nameCore(business?.name).filter((w) => w.length >= 4)
      .filter((w) => wordRe(w).test(text)).length,
    bytes: String(html ?? "").length,
  };
}

/**
 * TWO verdicts may become a website and they are named apart, so the ledger
 * always says WHICH proof carried a row and either can be retired without
 * touching the other.
 *
 *   phone    the ten-digit phone we hold is on the page. Identity.
 *   address  the house number beside its own street word, AND the town, AND
 *            the state. Identity, and it needs all four.
 *   town-only  looks right, proves nothing, goes to a person.
 */
export const PROVED = new Set(["phone", "address"]);

export function verdict(ev) {
  if (!ev) return "none";
  if (ev.phone) return "phone";
  if (ev.address && ev.town && ev.state) return "address";
  if (ev.town && ev.state && ev.nameTokens >= 1) return "town-only";
  return "none";
}

/** One line a person can read, for the ledger and the worklist. */
export function describeEvidence(ev, host) {
  if (!ev) return `${host}: nothing fetched`;
  const bits = [
    ev.phone ? "the phone we hold is on the page" : "the phone we hold is NOT on the page",
    ev.address ? "the street address we hold is on the page" : "the street address is not on the page",
    ev.town ? "the town is named" : "the town is not named",
    ev.state ? "the state is named" : "the state is not named",
    `${ev.nameTokens} word(s) of the business name appear`,
  ];
  return `${host}: ${bits.join("; ")} (${ev.bytes} bytes)`;
}

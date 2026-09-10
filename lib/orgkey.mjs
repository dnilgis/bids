/*
 * orgkey.mjs — one key that says "this is the same business in the same town".
 *
 * WHY IT EXISTS
 *
 * Every merge in this repository until now has been decided by a TEN-DIGIT
 * PHONE. That rule is good and it stays: build_directory.mjs drops a registry
 * row whose phone matches an elevator we already read, because a phone is
 * identity and a name is not.
 *
 * USDA's national warehouse list has no phone column at all. Not a sparse one —
 * none. So every one of its rows would sail past the phone rule, and a great
 * many of them are elevators this repository already holds.
 *
 * MEASURED END TO END, on the pipeline as it ships (2026-09-10). The file
 * offers 4,613 sites. data/directory.json went from 4,984 rows to 7,927, and
 * the three merge rules dropped, between them, 78 rows on a phone match, 889
 * because we already hold that yard under another name, and 58 because a second
 * licence roll had already named it. build_geocodes.py had merged a further 736
 * before any of that, where two rolls spell the business identically.
 *
 * Appending blind would have put the directory near 9,600 rows, and the
 * coverage percentage on /elevators divides by that number. An inflated
 * denominator is worse than the undercount it was meant to correct, because it
 * looks like progress.
 *
 * WHAT THIS IS NOT. It is not "match on the operator name". build_directory.mjs
 * has carried a paragraph since 2026-08-20 about why that is forbidden:
 * "Premier Cooperative" is a Wisconsin co-op AND a separate Illinois one, and
 * "CHS" is two hundred businesses. That paragraph still stands. This key is the
 * TRIPLE — state, town, operator — and the town is what makes it identity. Two
 * hundred CHS businesses, but only one CHS yard in Hennessey, Oklahoma.
 *
 * WHAT IT NORMALISES, AND WHAT IT REFUSES TO
 *
 *   stripped   a trailing legal form, and only a trailing one: INC, LLC, LC,
 *              LP, LLP, LTD, CO, CORP, ULC, PLC, PC, PLLC. "CHS Inc." and "CHS"
 *              are the same business; the suffix is a filing detail.
 *   folded     COMPANY -> CO (then stripped), INCORPORATED -> INC, COOPERATIVE
 *              and CO-OP -> COOP, ASSOCIATION -> ASSN, "&" -> AND, a leading
 *              THE. These are spellings of one word, not different words.
 *   left alone COOP, ASSN, ELEVATOR, GRAIN, FARMERS and every other word in the
 *              name. Stripping those would collapse "Farmers Coop Elevator
 *              Assn." into "Farmers Cooperative", which are two businesses, and
 *              a silent merge hides a real elevator behind somebody else's pin.
 *              A duplicate pin is visible and fixable. A silent merge is
 *              neither, so this key errs towards keeping two rows.
 *
 * WHAT IT KNOWINGLY LEAVES ON THE TABLE, measured 2026-09-10: about 327 pairs
 * survive in one town where one operator name is a word-for-word prefix of the
 * other — "Agtegra" and "Agtegra Cooperative" in 39 towns, "Central Valley Ag"
 * and "Central Valley Ag Cooperative" in 30, "Kanza Coop" and "Kanza
 * Cooperative Association" in 20. Almost all of those are one yard with two
 * pins. A prefix rule would take them, and it would also take a name that
 * genuinely extends another — so it is not in here, it is written down, and it
 * is the next thing worth doing to this file rather than something to guess at
 * on the way past.
 */

/* A trailing legal form. Order does not matter; the strip loops. */
const LEGAL = new Set(["INC", "LLC", "LC", "LP", "LLP", "LTD", "LIMITED",
                       "CO", "CORP", "CORPORATION", "ULC", "PLC", "PC", "PLLC"]);

/* Spellings of one word. Applied per word, before the strip. */
const FOLD = new Map([
  ["COMPANY", "CO"], ["INCORPORATED", "INC"], ["COOPERATIVE", "COOP"],
  ["ASSOCIATION", "ASSN"], ["ASSOC", "ASSN"], ["CORPORATION", "CORP"],
]);

export function operatorWords(name) {
  const raw = String(name || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!raw) return [];
  const w = raw.split(/\s+/);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    /* "Co-op" and "Co op" arrive here as two words because the hyphen went to
       whitespace with everything else. Rejoining them is the difference between
       RIVERCOUNTRYCOOP and RIVERCOUNTRYCOOP — the same business written twice,
       which is the entire job of this file. */
    if (w[i] === "CO" && (w[i + 1] === "OP" || w[i + 1] === "OPERATIVE")) {
      out.push("COOP");
      i++;
      continue;
    }
    out.push(FOLD.get(w[i]) || w[i]);
  }
  /* A leading THE is not part of the name: "The DeLong Co." and "DeLong
     Company" are one business across northern Illinois. Only leading, and only
     when something follows it. */
  if (out.length > 1 && out[0] === "THE") out.shift();
  return out;
}

export function operatorKey(name) {
  const w = operatorWords(name);
  /* NEVER TO NOTHING. "Grain Co LLC" would strip to an empty string and then
     match every other name that stripped to nothing. One word always stays. */
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join("");
}

/* The town half. Digits are kept — "Highway 30" is a place — and case and
   punctuation are not. */
export const placeKey = (state, town) =>
  String(state || "").toUpperCase().replace(/[^A-Z]/g, "") + "|" +
  String(town || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* THE KEY. Empty when either half is empty: a row with no state or no town is
   not identified by this, and must not be merged away by it. */
export function orgKey(state, town, operator) {
  const p = placeKey(state, town);
  const o = operatorKey(operator);
  if (!o || p.startsWith("|") || p.endsWith("|")) return "";
  return p + "|" + o;
}

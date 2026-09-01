/* CROP CLASSIFICATION, PRICE UNITS AND PLAUSIBILITY — ONE DEFINITION, TWO READERS.
 *
 * This file exists because two of them existed. AGSIST's cash-bids.html grew a
 * classify()/ppu()/PPU_BAND set against the Barchart response, and this repo grew
 * its own reading of scraped boards, and scripts/fetch_bids.py carried a comment
 * saying its parsing "MUST stay in lockstep with cash-bids.html". Two copies of a
 * rule that has to agree is a defect with a date on it, not an architecture.
 *
 * ── WHAT IS AND IS NOT NORMALISED ────────────────────────────────────────────
 *
 * THE ELEVATOR'S OWN WORDS ARE NEVER OVERWRITTEN. A board that says
 * "Wheat, HRS 14%" is quoting a protein spec, and that spec is money. This repo
 * keys its rows on `location␟commodity␟delivery` using the board's own strings
 * and that stays true. `crop()` ADDS a bucket beside the label; it never replaces
 * it. Anything that renders a bid shows the label. Anything that SELECTS a bid --
 * "best corn bid near me" -- uses the bucket.
 *
 * ── WHY BARCHART'S OWN `category` IS NOT TRUSTED ─────────────────────────────
 *
 * Measured 2026-09-01 against the committed response: Barchart returns
 *
 *     commodity "Soybean Meal"   category "soybeans"   Mankato, MN
 *
 * Soybean meal is a processing byproduct sold by the ton. Carried into a
 * soybeans bucket it competes for "highest soybean bid" against a per-bushel
 * price, which is the FJ Krob failure that PPU_BAND was written for -- a per-ton
 * row rescaled until it looked sensible and then ranked first. So every row is
 * re-classified here, whoever it came from, and the byproduct test runs FIRST.
 *
 * ── WHAT THE OLD CLASSIFIER MISSED, MEASURED ON REAL LABELS ──────────────────
 *
 * Run over all 60 distinct commodity strings in this repo's 3,431 scraped bids
 * and all 75 in the Barchart response, AGSIST's classify() dropped 142 rows into
 * "other" that are not other:
 *
 *     Milo                129 rows   grain sorghum; Barchart has 549 more
 *     Soft Red Winter       6 rows   wheat, with the word "wheat" left off
 *     Hard Red Winter       3 rows   wheat
 *     Spring Wht            2 rows   wheat, abbreviated
 *     Soft White Winter     2 rows   wheat
 *
 * Sorghum and oats are buckets now because the data has them, not because a
 * bucket seemed tidy. Canola, durum and yellow peas stay "other": they are real
 * grains this site does not carry a futures page for, and putting them anywhere
 * else would be an answer we cannot back.
 */

/* Byproducts and processed feeds. Sold by the ton, quoted in a different unit,
 * and never the thing a grower means by "what's corn worth". This runs before
 * anything else, so "Soybean Meal" and "Corn Gluten" cannot reach a grain bucket
 * through the word they contain. */
const BYPRODUCT = /\b(meal|hulls?|pellets?|oil|flour|ddgs?|distillers?|gluten|midds?|bran)\b/i;

/* Wheat classes spelled out with the word "wheat" left off. Every one of these
 * is a real label from a real board -- these are not hypotheticals. */
const WHEAT_CLASS = /\b(hrw|hrs|srw|sww|dns|mgex|kcbt)\b|\b(?:hard|soft)\s+(?:red|white)\b|\bspring\s+wh?t\b|\bwinter\s+wh?e?a?t\b/i;

export const CROPS = ["corn", "soybeans", "wheat", "sorghum", "oats", "other"];

/**
 * The bucket a label belongs in. Never the label itself.
 * @param {string} name the board's own commodity string, verbatim
 * @returns {"corn"|"soybeans"|"wheat"|"sorghum"|"oats"|"other"}
 */
export function crop(name) {
  const n = (name || "").toLowerCase();
  if (!n.trim()) return "other";
  if (BYPRODUCT.test(n)) return "other";
  /* Sorghum before corn: "milo" carries neither word, but a board that writes
   * "Milo/Corn" is quoting sorghum against the corn board and is still sorghum. */
  if (/\b(milo|sorghum)\b/.test(n)) return "sorghum";
  if (n.includes("corn") || /\b(#?2\s*yc|yc)\b/.test(n)) return "corn";
  if (n.includes("soy") || /\bbeans?\b/.test(n)) return "soybeans";
  if (n.includes("wheat") || WHEAT_CLASS.test(n)) return "wheat";
  if (/\boats?\b/.test(n)) return "oats";
  return "other";
}

/* ── PRICE UNITS ─────────────────────────────────────────────────────────────
 *
 * ppu() divides anything over 30 by 100 because some feeds quote cents. That is
 * right for a cents-quoted bushel and a silent disaster for a per-ton price: FJ
 * Krob of Walker, Iowa posted SOYBEANS at 120.083, the page rescaled it to $1.20,
 * called it soybeans and made it the best bean bid on the board -- then sorted on
 * the raw 120.083 while printing $1.20. So the rescale is kept, and a band
 * decides afterwards whether the result can be a bushel price at all.
 *
 * A row outside its own band is WITHHELD AND COUNTED. It is never rescaled until
 * it looks sensible, and it is never silently dropped. */
export const PPU_BAND = {
  corn:     [2, 12],
  soybeans: [6, 32],
  wheat:    [3, 20],
  sorghum:  [2, 14],
  oats:     [1, 10],
};

export function ppu(raw) {
  if (raw == null || !Number.isFinite(raw)) return null;
  return raw > 30 ? raw / 100 : raw;
}

/**
 * Is this a plausible per-bushel price for its crop?
 * Unbanded crops ("other") are not our call and pass.
 */
export function plausible(cash, cropName) {
  const band = PPU_BAND[cropName];
  if (!band) return true;
  const p = ppu(cash);
  return p != null && p >= band[0] && p <= band[1];
}

/* ── BASIS ───────────────────────────────────────────────────────────────────
 *
 * Boards quote basis in dollars (-0.60) and in cents (-60) and this repo's own
 * rows carry BOTH. Barchart carries dollars only. |b| < 5 is the discriminator
 * AGSIST has used since the beginning: no cash-grain basis is 5 dollars off the
 * board, and no basis in cents is under 5 cents often enough to matter -- and
 * when it is, dollars and cents agree to within a rounding step anyway. */
export function basisCents(b) {
  if (b == null || !Number.isFinite(b)) return null;
  return Math.abs(b) < 5 ? Math.round(b * 100) : Math.round(b);
}

export function basisDollars(b) {
  const c = basisCents(b);
  return c == null ? null : c / 100;
}

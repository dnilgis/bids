/* WHAT PERIOD IS THIS BID FOR? — AND HOW SURE ARE WE.
 *
 * WHY THIS EXISTS. AGSIST's basis map averages every basis a location quotes
 * into one number per commodity. Measured 2026-09-01 on the committed Barchart
 * response: 53 locations quote more than one delivery period, the median spread
 * being averaged is 15c, and ADM Grain's corn runs from +0.05 to +1.00 — a 95c
 * spread flattened into a single dot on a map. Nearby basis and deferred basis
 * are different markets. Averaging them produces a number that describes no bid
 * anyone can actually hit.
 *
 * To group like with like, the merged feed needs a comparable period key. The
 * boards do not give one: 429 distinct delivery strings across 3,431 scraped
 * bids, in about forty different shapes.
 *
 * ── THE RULE THIS FILE OBEYS ─────────────────────────────────────────────────
 *
 * DO NOT INVENT A PERIOD. A string this cannot read returns key `null` with
 * `via: "unreadable"`, and the run COUNTS those. It never rounds a guess into a
 * month. Every key that IS produced carries `via` saying how it was made, the
 * same way a filled coordinate carries `latPrecision` and a derived state
 * carries `stateDerivedBy`.
 *
 * ── SEASONS ARE THEIR OWN BUCKET, NOT A GUESS AT MONTHS ──────────────────────
 *
 * "New Crop 26", "Fall 26", "Harvest 2026" are not vague — they are a contract
 * concept elevators use consistently, and comparing one elevator's new crop to
 * another's is comparing like with like. But new-crop corn moves in October and
 * new-crop beans in September, so resolving a season to MONTHS would need the
 * crop and would still be a guess about that elevator's intent. So a season gets
 * its own key ("newcrop-2026") and never merges with a month key. Two honest
 * buckets beat one invented one.
 */

const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const MONRX = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/* The one-letter contract-month pairs boards write as "O/N26", "A/M 2027".
 * These are the CBOT letters, not initials of the month name — and they are the
 * reason this is a table and not a regex over first letters: J is January, July
 * AND June, and only position tells them apart. Where a letter is genuinely
 * ambiguous it is left out rather than guessed. */
const PAIR = { "o/n": [10, 11], "s/o": [9, 10], "n/d": [11, 12], "d/j": [12, 1],
               "j/f": [1, 2], "f/m": [2, 3], "a/m": [4, 5], "m/j": [5, 6],
               "j/a": [7, 8], "a/s": [8, 9], "m/a": [3, 4] };

/* "N/C" and "O/C" are new crop and old crop — the boards write them beside the
 * commodity ("N/C Corn", "27 N/C Soybeans"). "NEW '26" and "26 Crop" are the
 * same idea with the words rearranged. All measured, none invented. */
const SEASON = /\b(new\s*crop|newcrop|n\/c|nc|new|fall|harvest|crop)\b|\b(old\s*crop|oldcrop|o\/c)\b/i;
const OLDCROP = /\b(old\s*crop|oldcrop|o\/c)\b/i;
const SPOT   = /\b(cash|spot|in\s*store|instore|open\s*storage|current|immediate|now|delivered\s*now)\b/i;

const pad = (n) => String(n).padStart(2, "0");
const ym  = (y, m) => `${y}-${pad(m)}`;

/* A two-digit year is this century. Boards have written '26 for 2026 since
 * boards existed; nothing in this data is from 1926. */
const year4 = (s) => {
  const n = parseInt(s, 10);
  return n >= 1000 ? n : 2000 + n;
};

/**
 * @param {string} raw the board's own delivery string, verbatim
 * @param {string|Date} [asOf] when the board was read — used ONLY to resolve a
 *        month written with no year, and recorded in `via` when it is.
 * @returns {{key:string|null, start:string|null, end:string|null, via:string, label:string}}
 */
export function delivery(raw, asOf) {
  const label = (raw == null ? "" : String(raw)).trim();
  const out = (key, via, start = null, end = null) => ({ key, start, end, via, label });
  if (!label) return out(null, "unreadable");
  const s = label.toLowerCase().replace(/\s+/g, " ");

  /* 1. AN EXPLICIT RANGE BEATS EVERYTHING ELSE ON THE LINE.
        "July 2027 (01 Jul 2027 to 31 Jul 2027)" and "New Crop 2026 (15 Sep 2026
        to 31 Oct 2026)" both carry a prose label AND the dates the elevator
        means. The dates are the answer; the prose is decoration. Note the first
        example — a board writing "Mar 2026 (01 Jul 2026 to 31 Jul 2026)" is not
        a typo we get to correct, and reading the dates avoids having to. */
  const range = s.match(new RegExp(
    `(\\d{1,2}) (${MONRX}) (\\d{4}) (?:to|-|–|through) (\\d{1,2}) (${MONRX}) (\\d{4})`, "i"));
  if (range) {
    const [, d1, m1, y1, d2, m2, y2] = range;
    const a = MON[m1.slice(0, 3)], b = MON[m2.slice(0, 3)];
    const start = `${y1}-${pad(a)}-${pad(d1)}`, end = `${y2}-${pad(b)}-${pad(d2)}`;
    const key = (y1 === y2 && a === b) ? ym(y1, a) : `${ym(y1, a)}/${ym(y2, b)}`;
    return out(key, "explicit-range", start, end);
  }

  /* 2. AN ISO-ISH DATE. 152 rows arrive as "20260930" — one day, which is the
        last day of the delivery month on every board that writes them this way.
        The day is kept; the key is its month. */
  const iso = s.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (iso) {
    const [, y, m, d] = iso;
    const mi = parseInt(m, 10);
    if (mi >= 1 && mi <= 12) {
      const day = `${y}-${m}-${d}`;
      return out(ym(y, mi), "iso-date", day, day);
    }
  }

  /* 3. A MONTH PAIR — "Oct/Nov 26", "OCT-NOV 2026", "Jan-Mar 27", "O/N26".
        A range of months, kept as a range: an elevator quoting Oct/Nov is
        offering one price for either, and flattening it to October would make it
        compete with a genuine October-only bid. */
  const pairWord = s.match(new RegExp(`\\b(${MONRX})\\s*[/-]\\s*(${MONRX})\\b\\s*'?(\\d{2,4})?`, "i"));
  if (pairWord) {
    const a = MON[pairWord[1].slice(0, 3)], b = MON[pairWord[2].slice(0, 3)];
    const yr = pairWord[3] ? year4(pairWord[3]) : yearFor(a, asOf);
    if (yr) {
      const y2 = b < a ? yr + 1 : yr;   // Dec/Jan rolls the year
      return out(`${ym(yr, a)}/${ym(y2, b)}`, pairWord[3] ? "month-pair" : "month-pair-inferred-year");
    }
  }
  const pairLetters = s.match(/\b([a-z]\/[a-z])\s*'?(\d{2,4})\b/);
  if (pairLetters && PAIR[pairLetters[1]]) {
    const [a, b] = PAIR[pairLetters[1]];
    const yr = year4(pairLetters[2]);
    const y2 = b < a ? yr + 1 : yr;
    return out(`${ym(yr, a)}/${ym(y2, b)}`, "contract-pair");
  }

  /* 3b. A QUARTER, written as month initials: "JFM 2027", "OND 26". Unambiguous
        because the three letters must be consecutive months. */
  const QTR = { jfm: [1, 3], amj: [4, 6], jas: [7, 9], ond: [10, 12],
                fma: [2, 4], mjj: [5, 7], aso: [8, 10], ndj: [11, 1] };
  const qtr = s.match(/\b([a-z]{3})\s*'?(\d{2,4})\b/);
  if (qtr && QTR[qtr[1]] && !MON[qtr[1]]) {
    const [a, b] = QTR[qtr[1]];
    const yr = year4(qtr[2]);
    const y2 = b < a ? yr + 1 : yr;
    return out(`${ym(yr, a)}/${ym(y2, b)}`, "quarter");
  }

  /* 4. A SEASON. Its own bucket — see the header. A season with no year cannot
        be placed at all, because "new crop" said in September means this autumn
        and said in March means the one coming; that is a guess and it is refused. */
  if (SEASON.test(s)) {
    /* A NAMED MONTH BEATS THE SEASON THAT INTRODUCES IT. "New Crop July 2027" is
       a July 2027 bid; the elevator has already told us which month it means, and
       filing it under a season would put it beside bids that mean six different
       things. So a month WITH ITS OWN YEAR falls through to rule 5. */
    const named = s.match(new RegExp(`\\b(${MONRX})(?![a-z])\\s*['\\-/]?\\s*(\\d{4}|\\d{2})\\b`, "i"));
    if (!named) {
      const y = s.match(/\b'?(\d{4}|\d{2})\b/);
      const old = OLDCROP.test(s);
      if (y) return out(`${old ? "oldcrop" : "newcrop"}-${year4(y[1])}`, "season");
      return out(null, "unreadable-season-no-year");
    }
  }

  /* 5. A PLAIN MONTH, with a year or without one. */
  /* NO \b AFTER THE MONTH NAME. "Sep26" has a letter against a digit, and both
     are word characters, so there is no boundary there to match — 49 rows across
     "Sep26", "Dec26", "Nov26", "July27" read as unreadable until this was
     measured. The boundary is replaced by an explicit "not another letter". */
  /* THE SEPARATOR IS PART OF THE SHAPE. "OCT-26" was reading as a bare month and
     then INFERRING 2026 from the read date — the right answer by the wrong route,
     which would have gone wrong the moment a board was re-read in another year.
     Caught by asserting `via`, not just the key: a test that checks only the
     answer cannot tell a fact from a lucky guess. */
  const mon = s.match(new RegExp(`\\b(${MONRX})(?![a-z])\\s*['\\-/]?\\s*(\\d{4}|\\d{2})?`, "i"));
  if (mon) {
    const m = MON[mon[1].slice(0, 3)];
    if (mon[2]) return out(ym(year4(mon[2]), m), "month-year");
    const yr = yearFor(m, asOf);
    if (yr) return out(ym(yr, m), "month-inferred-year");
    return out(null, "unreadable-month-no-year");
  }

  /* 6. SPOT. "Cash", "In Store", "Open Storage" — a price for grain in hand.
        Deliberately last: "Cash Bid (01 Jul 2026 to 21 Aug 2026)" is a dated
        range that happens to be labelled Cash, and rule 1 has already taken it. */
  if (SPOT.test(s)) return out("spot", "spot-word");

  return out(null, "unreadable");
}

/* A MONTH WITH NO YEAR IS THE NEXT ONE COMING, AND SAYS SO.
 * A board read on 1 September 2026 quoting "Dec" means December 2026, not 2027;
 * quoting "Mar" it means March 2027. The nearest future occurrence, counting the
 * current month as present, is the only reading a grower would recognise. It is
 * still an inference, so it is reported as one in `via` and never blended with a
 * month the board actually dated. Without an asOf there is nothing to reckon
 * from and the answer is null, not today's date. */
function yearFor(month, asOf) {
  if (!asOf) return null;
  const d = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return month >= m ? y : y + 1;
}

export { yearFor as _yearFor };

/* THE CBOT QUOTE, FROM MORE THAN ONE PLACE.
 *
 * Every board on the platforms in lib/adapters/index.mjs SHARED_PAGES is
 * checked against CBOT futures quotes, and a board with no quote refuses
 * rather than publish unchecked. Until 2026-11-24 those quotes came from one
 * host. When it answered HTTP 500 from the pass after 2026-11-20T15:08Z,
 * 1,367 sources refused on that ground alone and froze for four days. One
 * host's outage must not freeze the network again, so the quote now has
 * providers, read in order, and none of them shares another's machinery:
 *
 *   agricharts  the platform's own quote feed, then its mobile pages
 *               (lib/adapters/agricharts.mjs quoteSources)
 *   agsist      agsist's published futures file, data/prices.json on its
 *               main branch, which its own price job rewrites every 15
 *               minutes in the day session and hourly overnight. Delayed
 *               quotes it already shows on its pages, read from GitHub's raw
 *               host, not from AgriCharts.
 *
 * Every provider answers in one contract shape (lib/adapters/agricharts.mjs
 * parseQuotes): symbol, root, monthCode, year, lastCents, unit, at, plus
 * tradedAt (the trade time, when the provider gives a real trade clock, else
 * null), settlements (session date -> settlement in cents) and source (who
 * said it). Every row an adapter prices or checks off a contract records that
 * contract's source as its `quoteSource`.
 *
 * WHAT IS NEVER DONE HERE: supply a number the board check did not get from a
 * provider, or pick a winner when two providers disagree. Per contract:
 *
 *   1. A quote whose trade date is older than QUOTE_MAX_AGE_DAYS is missing,
 *      and so is every quote of a source whose newest trade is older than
 *      the last CBOT session that had closed (lastClosedSession).
 *   2. The first provider, in order, with a fresh quote is the one used.
 *   3. When two providers both carry a fresh quote and can be compared at the
 *      same moment (the same session's settlement, or two last trades within
 *      SAME_MOMENT_S of each other, both on a real trade clock; agsist's file
 *      has no trade clock, so against it only settlements are compared), a
 *      gap of more than one tick withholds
 *      that contract from both: it is handed on unpriced, so every row priced
 *      off it refuses, and the gap is logged.
 *
 * The board check itself is not touched: the same tolerance, the same
 * refusal when no fresh quote exists. */

import { mergeQuotes, quoteSources, isQuotePage, GRAIN_ROOTS } from "./adapters/agricharts.mjs";
import { centralDate, centralParts, centralToUtc } from "./central.mjs";

export class QuotesRefused extends Error {}

export const AGSIST_PRICES_URL = "https://raw.githubusercontent.com/dnilgis/agsist/main/data/prices.json";

/* ONE TICK, IN CENTS, PER ROOT. The grains trade in quarters of a cent a
   bushel; rough rice in half a cent a hundredweight ($0.005). */
export const TICK_CENTS = { ZC: 0.25, ZS: 0.25, ZW: 0.25, KE: 0.25, MW: 0.25, ZO: 0.25, ZR: 0.5 };

/* HOW OLD A QUOTE MAY BE, IN CENTRAL CALENDAR DAYS FROM ITS TRADE DATE.
   The longest regular closure of the CBOT grains is a holiday weekend: the
   last trade of a Thursday or a Friday, and nothing again until the Sunday
   or Monday evening session, three Central dates later, and a thin deferred
   contract may not trade until the next morning. Four days covers that and
   nothing longer, so a quote from a source that has stopped updating is
   missing, not a price. */
export const QUOTE_MAX_AGE_DAYS = 4;

/* THE SESSION A SOURCE MUST HAVE REACHED. Four days per contract leaves room
   for a thin deferred that has not traded (ZOK27 had no trade on 2026-11-24;
   both sources still dated it 11-23 after that day's close), but it let a
   whole source frozen at a Friday close pass until Wednesday. So a source as
   a whole is held to the CBOT calendar: once a session's day trading has
   closed (13:20 Central), a live source carries at least one trade from that
   session, and a source whose newest trade date is older is missing, every
   contract in it. Weekends and the dates below are not sessions.

   CBOT grain holidays (CME Group holiday calendar). A date missing here
   holds sources to a session that never traded, so a source is refused on
   that holiday rather than waved through; extend the list each year. */
export const CBOT_CLOSED = new Set([
  "2026-11-26",   // Thanksgiving
  "2026-12-25",   // Christmas
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const CBOT_CLOSE_HM = [13, 20];

const ymdShift = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/** Whether the CBOT grains hold a session on this Central date ("YYYY-MM-DD"). */
export function cbotSessionDay(ymd) {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !CBOT_CLOSED.has(ymd);
}

/** The most recent session whose day trading had closed by `now` (its Central date), or null. */
export function lastClosedSession(now) {
  const t = new Date(now).getTime();
  let d = centralDate(new Date(t));
  for (let i = 0; i < 15; i++, d = ymdShift(d, -1)) {
    if (!cbotSessionDay(d)) continue;
    const [y, m, dd] = d.split("-").map(Number);
    if (centralToUtc(y, m, dd, ...CBOT_CLOSE_HM).getTime() <= t) return d;
  }
  return null;
}

/** null when one source's answer reached the last closed session, else why every quote in it is missing. */
export function sourceBehind(contracts, now) {
  const due = lastClosedSession(now);
  if (!due) return null;
  const dates = (contracts ?? []).filter((q) => q?.priced && q.lastCents != null)
    .map((q) => tradeDateOf(q, now)).filter(Boolean).sort();
  if (!dates.length) return null;
  const newest = dates[dates.length - 1];
  return newest < due
    ? `its newest trade is dated ${newest}, before the ${due} session, which had closed; `
      + `the source has stopped updating`
    : null;
}

/* Two last trades this close together are the same moment, and only when both
   stamps are trade clocks. The feed's tradetime is one (ZSF27 1238.25 traded
   at 18:31:45Z in the 2026-11-24 capture). agsist's close_time is not: it is
   the clock of agsist's own fetch (min(now, the price's stamp)) or a fixed
   19:20Z for the day's last price, so its 1239.00 "at 18:35:29Z" is what the
   fetch read then, not a trade at that second. Comparing it against a trade
   withheld front months about hourly with both sources healthy; agsist quotes
   therefore carry tradedAt null, and are compared on settlements only. */
export const SAME_MOMENT_S = 60;

/* ---------- agsist's published futures file ---------- */

/* agsist's price job runs on its own clock, not the exchange's (agsist,
   .github/workflows/prices.yml, the `hours` step): Central time, Sunday from
   18:45, Monday to Thursday before 14:00 and from 18:45, Friday before 14:00
   and from 23:30, Saturday before 02:00. It runs on exchange holidays too,
   so the file is rewritten whenever this says open, whether or not the
   market traded. */
export function agsistScheduleOpen(d) {
  const p = centralParts(d);
  const hm = p.H * 100 + p.M;
  switch (p.dow) {
    case 7: return hm >= 1845;
    case 1: case 2: case 3: case 4: return hm < 1400 || hm >= 1845;
    case 5: return hm < 1400 || hm >= 2330;
    case 6: return hm < 200;
    default: return false;
  }
}

/* Minutes that schedule was open between two instants, in five-minute steps. */
export function agsistOpenMinutes(from, to) {
  const a = Date.parse(from), b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  let n = 0;
  for (let t = a; t < b && t < a + 8 * 864e5; t += 5 * 60e3) if (agsistScheduleOpen(new Date(t))) n += 5;
  return n;
}

/* THE FILE MUST BE ALIVE. It is rewritten at least hourly whenever its
   schedule is open; two open hours without a rewrite is a job that stopped,
   and every quote in it is missing, however recent its trade date looks.
   In the CBOT day session it is rewritten about every 15 minutes (the longest
   real gap, 2026-11-18 to 11-24, about 20 minutes), so there 45 open minutes
   without a rewrite already means the job stopped. */
export const AGSIST_MAX_OPEN_MIN = 120;
export const AGSIST_MAX_OPEN_MIN_DAY = 45;

/* The CBOT grains' day session, Central: Monday to Friday 08:30 to 13:20. */
export function cbotDaySession(d) {
  const p = centralParts(d);
  const hm = p.H * 100 + p.M;
  return p.dow >= 1 && p.dow <= 5 && hm >= 830 && hm < 1320;
}
/** The file-age limit, in open minutes of agsist's schedule, at `now`. */
export const agsistAgeLimit = (now) => (cbotDaySession(new Date(now)) ? AGSIST_MAX_OPEN_MIN_DAY : AGSIST_MAX_OPEN_MIN);

const AGSIST_TICKER = /^(ZC|ZS|ZW|KE|MW|ZO|ZR)([FGHJKMNQUVXZ])(\d{2})\.CBT$/;
/* Rice is quoted in dollars per hundredweight on Yahoo (18.79), the grains in
   cents per bushel (434.25). The file carries rice only as the continuous
   ZR=F, which names no month, so no rice contract is read from it. */
const AGSIST_DOLLAR_ROOTS = new Set(["ZR", "MW"]);

export function isAgsistPrices(body) {
  try {
    const j = JSON.parse(String(body ?? ""));
    return !!(j && typeof j.quotes === "object" && j.quotes && Number.isFinite(Date.parse(j.fetched)));
  } catch { return false; }
}

const onGrid = (cents, root) => {
  const tick = TICK_CENTS[root];
  const n = Math.round(cents / tick);
  return Math.abs(n * tick - cents) < 1e-3 ? Math.round(n * tick * 1e4) / 1e4 : null;
};
const mdyOf = (ymd) => { const [y, m, d] = ymd.split("-"); return `${m}/${d}/${y.slice(2)}`; };

/** agsist data/prices.json -> contracts, one per dated grain contract. Throws when it is not that file. */
export function parseAgsistPrices(body) {
  if (!isAgsistPrices(body)) throw new QuotesRefused("not agsist's prices file (no `quotes` and `fetched`)");
  const j = JSON.parse(String(body));
  const skip = new Set([...(Array.isArray(j.stale_keys) ? j.stale_keys : []),
                        ...Object.keys(j.withheld_keys ?? {}), ...(j.retired_keys ?? [])]);
  const bySymbol = new Map();
  for (const [key, v] of Object.entries(j.quotes)) {
    if (skip.has(key) || !v || typeof v !== "object") continue;
    const sm = String(v.ticker ?? "").match(AGSIST_TICKER);
    if (!sm) continue;
    const root = sm[1], symbol = `${sm[1]}${sm[2]}${sm[3]}`;
    if (bySymbol.has(symbol)) continue;     // "corn-nearby" repeats "corn-dec26"
    const toCents = (x) => (typeof x === "number" && x > 0
      ? onGrid(AGSIST_DOLLAR_ROOTS.has(root) ? x * 100 : x, root) : null);
    /* THE TRADE DATE IS close_date, AND THERE IS NO TRADE CLOCK. close_time
       is agsist's fetch clock (or a fixed 19:20Z for the day's last price) and
       a settled entry ("settle", every weekend and holiday file) has none at
       all; neither is a trade time, so neither is read as one. */
    const closeDate = /^\d{4}-\d{2}-\d{2}$/.test(v.close_date ?? "") ? v.close_date : null;
    const close = toCents(v.close);
    if (close === null || !closeDate) continue;
    const settlements = {};
    for (const [d, px] of Object.entries(v.settles ?? {})) {
      const c = toCents(px);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && c !== null) settlements[d] = c;
    }
    if (v.close_kind === "settle") settlements[closeDate] = close;
    /* PRICED FROM THE SETTLEMENT when the file carries one for the session its
       price belongs to; otherwise from its last price. */
    const settled = settlements[closeDate] != null;
    const cents = settled ? settlements[closeDate] : close;
    const grain = GRAIN_ROOTS[root];
    const stamp = Date.parse(v.close_time);
    bySymbol.set(symbol, {
      symbol, root, monthCode: sm[2], year: 2000 + Number(sm[3]),
      name: grain.name, title: null,
      lastCents: cents, lastRaw: String(settled && v.close_kind !== "settle" ? v.settles[closeDate] : v.close),
      priced: true, unit: grain.unit, grain: grain.name,
      notation: AGSIST_DOLLAR_ROOTS.has(root) ? "dollars" : "cents",
      settled, flag: settled ? "s" : null,
      priceKind: settled ? "settlement" : "last",
      changeCents: settled ? settleChange(settlements, closeDate)
        : typeof v.netChange === "number" ? toCentsSigned(v.netChange, root) : null,
      at: mdyOf(closeDate),
      tradedAt: null,
      fetchedAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null,
      settlements,
      fileWrittenAt: new Date(Date.parse(j.fetched)).toISOString(),
      source: "agsist",
    });
  }
  if (!bySymbol.size) throw new QuotesRefused("agsist's prices file carries no dated grain contract");
  return [...bySymbol.values()];
}
const toCentsSigned = (x, root) => Math.round((AGSIST_DOLLAR_ROOTS.has(root) ? x * 100 : x) * 1e4) / 1e4;
/* A settlement's change: from the session's settlement before it, when the file has one. */
const settleChange = (settlements, day) => {
  const prev = Object.keys(settlements).filter((d) => d < day).sort().pop();
  return prev ? Math.round((settlements[day] - settlements[prev]) * 1e4) / 1e4 : null;
};

/* ---------- freshness and agreement ---------- */

/** The Central trade date ("YYYY-MM-DD") a quote carries, or null. */
export function tradeDateOf(q, now) {
  if (q?.tradedAt && Number.isFinite(Date.parse(q.tradedAt))) return centralDate(new Date(q.tradedAt));
  const at = String(q?.at ?? "").trim();
  const d = at.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (d) return `20${d[3]}-${d[1]}-${d[2]}`;
  /* a clock with no date is a trade today, on their clock */
  if (/^\d{1,2}:\d{2}/.test(at) && now) return centralDate(new Date(now));
  return null;
}

/** { ok, why } for one quote at `now`. */
export function freshness(q, now) {
  const today = centralDate(new Date(now));
  const td = tradeDateOf(q, now);
  if (!td) return { ok: false, why: `${q.symbol} (${q.source}) carries no trade date` };
  const days = Math.round((Date.parse(today) - Date.parse(td)) / 864e5);
  if (days > QUOTE_MAX_AGE_DAYS)
    return { ok: false, why: `${q.symbol} (${q.source}) last traded ${td}, ${days} days before ${today}; `
      + `older than ${QUOTE_MAX_AGE_DAYS} days is missing` };
  if (days < -1) return { ok: false, why: `${q.symbol} (${q.source}) is dated ${td}, after ${today}` };
  if (q.fileWrittenAt) {
    const open = agsistOpenMinutes(q.fileWrittenAt, now);
    const limit = agsistAgeLimit(now);
    if (open > limit)
      return { ok: false, why: `${q.symbol} (${q.source}): the file was last written ${q.fileWrittenAt}, `
        + `${open} minutes of its own schedule ago (limit ${limit}`
        + `${limit === AGSIST_MAX_OPEN_MIN_DAY ? " in the day session" : ""})` };
  }
  return { ok: true, why: null };
}

/** Compare two quotes for one contract where they describe the same moment. */
export function compareQuotes(a, b) {
  const tick = TICK_CENTS[a.root] ?? 0.25;
  const out = { compared: 0, gap: null };
  const off = (x, y) => Math.abs(x - y) > tick + 1e-6;
  for (const [d, sa] of Object.entries(a.settlements ?? {})) {
    const sb = b.settlements?.[d];
    if (sb == null) continue;
    out.compared++;
    if (off(sa, sb) && !out.gap)
      out.gap = `${a.symbol} settlement for ${d}: ${a.source} ${sa}c, ${b.source} ${sb}c (more than one tick, ${tick}c)`;
  }
  /* Last trades only on two real trade clocks: a quote with tradedAt null
     (agsist's, whose stamp is its fetch clock) never reaches this branch. */
  const ta = a.tradedAt ? Date.parse(a.tradedAt) : NaN, tb = b.tradedAt ? Date.parse(b.tradedAt) : NaN;
  if (!a.settled && !b.settled && Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= SAME_MOMENT_S * 1e3) {
    out.compared++;
    if (off(a.lastCents, b.lastCents) && !out.gap)
      out.gap = `${a.symbol} last trade: ${a.source} ${a.lastCents}c at ${a.tradedAt}, ${b.source} `
        + `${b.lastCents}c at ${b.tradedAt} (more than one tick, ${tick}c)`;
  }
  return out;
}

/* PER CONTRACT, IN PROVIDER ORDER. `answers` is [{ source, contracts }] with
   the first provider first. Returns one entry per symbol: the quote used
   (tagged with its source, and `confirmedBy` the providers that agreed with
   it), or the contract unpriced with `missing` or `withheld` saying why. The
   list carries a non-enumerable `notes` for the run log. */
export function combineQuotes(answers, { now = new Date() } = {}) {
  const notes = { used: {}, confirmed: 0, stale: [], withheld: [] };
  const order = [], bySymbol = new Map();
  /* a source behind the CBOT calendar: every quote in its answer is missing */
  const behind = new Map();
  for (const a of answers ?? []) {
    const why = sourceBehind(a.contracts, now);
    if (why) for (const q of a.contracts ?? []) behind.set(q, `${q.symbol} (${q.source ?? a.source}): ${why}`);
  }
  const fresher = (q) => (behind.has(q) ? { ok: false, why: behind.get(q) } : freshness(q, now));
  for (const a of answers ?? [])
    for (const q of a.contracts ?? []) {
      if (!q?.symbol) continue;
      if (!bySymbol.has(q.symbol)) { bySymbol.set(q.symbol, []); order.push(q.symbol); }
      bySymbol.get(q.symbol).push(q);
    }
  const out = [];
  for (const symbol of order) {
    const qs = bySymbol.get(symbol);
    const priced = qs.filter((q) => q.priced && q.lastCents != null);
    if (!priced.length) { out.push(qs[0]); continue; }
    const fresh = [];
    for (const q of priced) {
      const f = fresher(q);
      if (f.ok) fresh.push(q); else notes.stale.push(f.why);
    }
    if (!fresh.length) {
      out.push({ ...priced[0], priced: false, lastCents: null,
                 missing: `no fresh quote: ${priced.map((q) => fresher(q).why).join("; ")}` });
      continue;
    }
    const [first, ...rest] = fresh;
    let gap = null;
    const confirmedBy = [];
    for (let i = 0; i < fresh.length && !gap; i++)
      for (let k = i + 1; k < fresh.length && !gap; k++) {
        const c = compareQuotes(fresh[i], fresh[k]);
        if (c.gap) gap = c.gap;
        else if (i === 0 && c.compared) confirmedBy.push(fresh[k].source);
      }
    if (gap) {
      notes.withheld.push(gap);
      out.push({ ...first, priced: false, lastCents: null, withheld: `the quote sources disagree: ${gap}` });
      continue;
    }
    if (confirmedBy.length) notes.confirmed++;
    notes.used[first.source] = (notes.used[first.source] ?? 0) + 1;
    out.push(rest.length ? { ...first, confirmedBy } : first);
  }
  Object.defineProperty(out, "notes", { value: notes, enumerable: false });
  return out;
}

/* ---------- the providers, and reading them ---------- */

export const QUOTE_PROVIDERS = [
  { source: "agricharts", sets: quoteSources(), accepts: isQuotePage, read: (bodies) => mergeQuotes(bodies) },
  { source: "agsist", sets: [[AGSIST_PRICES_URL]], accepts: isAgsistPrices, read: (bodies) => parseAgsistPrices(bodies[0]) },
];

/* URL SETS IN ORDER, THE NEXT ONLY WHEN THIS ONE GAVE NOTHING. Every url of a
   set is asked; a 200 that is not the expected page (`accepts`: an error
   page, a login) counts as a failure. If a set yields at least one page the
   later sets are not asked; if it yields none, what it said is logged and the
   next set is asked. Only the failures of the set that was used, or of every
   set when none answered, are returned as problems.

   `get(url)` resolves to { ok: true, body } or { ok: false, error }; the
   poller and both sweeps each wrap their own fetch in it, so this one
   function is what all three run. */
export async function readSets(sets, get, { accepts = null, log = () => {}, label = "" } = {}) {
  const bodies = [], problems = [], skipped = [];
  let used = null;
  for (let si = 0; si < sets.length; si++) {
    const setProblems = [];
    for (const u of sets[si]) {
      let r;
      try { r = await get(u); } catch (e) { r = { ok: false, error: e.message }; }
      if (!r?.ok) { setProblems.push(`${u} -> ${r?.error ?? "no answer"}`); continue; }
      const body = r.body ?? "";
      if (!body.length) { setProblems.push(`${u} -> empty response`); continue; }
      if (accepts && !accepts(body)) { setProblems.push(`${u} -> not the expected page`); continue; }
      bodies.push(body);
    }
    if (bodies.length || si === sets.length - 1) {
      problems.push(...skipped, ...setProblems);
      if (bodies.length) used = si;
      break;
    }
    skipped.push(...setProblems);
    log(`${label}page set ${si + 1} of ${sets.length} gave nothing `
      + `(${setProblems.slice(0, 2).join("; ")}); asking the next`);
  }
  return { bodies, problems, used };
}

/* A SHARED PAGE SPEC, READ. For a spec with `providers` (the CBOT quote) each
   provider's sets are read on their own and the answers combined per
   contract; otherwise the spec's own `urls` and `alternates` are read and
   handed to its `build`. Returns { ctx, problems, notes }: ctx null when
   nothing usable came back. */
export async function readShared(spec, get, { now = new Date(), log = () => {} } = {}) {
  if (!spec.providers) {
    const r = await readSets([spec.urls, ...(spec.alternates ?? [])], get, { accepts: spec.accepts, log });
    let ctx = null;
    const problems = [...r.problems];
    if (r.bodies.length) {
      try { ctx = spec.build(r.bodies); }
      catch (e) { problems.push(`the ${r.bodies.length} page(s) that answered would not parse: ${e.message}`); }
    }
    return { ctx, problems, notes: null };
  }
  const parsed = [], problems = [];
  for (const p of spec.providers) {
    const r = await readSets(p.sets, get, { accepts: p.accepts, log, label: `${p.source}: ` });
    problems.push(...r.problems.map((x) => `${p.source}: ${x}`));
    if (!r.bodies.length) continue;
    try { parsed.push({ source: p.source, contracts: p.read(r.bodies) }); }
    catch (e) { problems.push(`${p.source}: the ${r.bodies.length} page(s) that answered would not parse: ${e.message}`); }
  }
  if (!parsed.length) return { ctx: null, problems, notes: null };
  const contracts = combineQuotes(parsed, { now });
  return { ctx: { contracts }, problems, notes: contracts.notes };
}

/** One line for the run log: who answered, what was confirmed, withheld, stale. */
export function describeQuotes(contracts) {
  const n = contracts?.notes;
  if (!n) return null;
  const used = Object.entries(n.used).map(([s, c]) => `${c} from ${s}`).join(", ") || "none";
  return `quotes: ${used}; ${n.confirmed} confirmed by a second source; `
    + `${n.withheld.length} withheld (sources disagree)${n.withheld.length ? `: ${n.withheld.slice(0, 3).join(" | ")}` : ""}; `
    + `${n.stale.length} stale`;
}

/* THE RUN LOG'S WARNINGS FOR ONE SHARED SPEC, as the lines the poller prints.
   A failure of the first provider (or of a spec with no providers) is the
   shared-page warning it always was. When the first provider read cleanly and
   only a later one failed, that later provider gets a warning of its own: the
   boards still publish on the first, without the second-source check, which is
   a different thing from the shared pages failing. [] when nothing failed. */
export function sharedWarnings(platform, spec, problems, ctx) {
  if (!problems?.length) return [];
  const first = spec.providers?.[0]?.source;
  const tagOf = (p) => (spec.providers ?? []).find((x) => p.startsWith(`${x.source}: `))?.source ?? null;
  const later = spec.providers ? problems.filter((p) => { const t = tagOf(p); return t && t !== first; }) : [];
  const own = problems.filter((p) => !later.includes(p));
  const out = [];
  if (own.length)
    out.push(`::warning title=${platform} shared page(s)::${own.length} failed — `
      + `${spec.why}. ${own.slice(0, 4).join("; ")}`
      + `${ctx ? " The rest were read and the platform continues on those."
              : spec.optional ? ` Nothing was read; ${platform} publishes on its own printed futures price `
                + `this pass, without this cross-check.`
              : " Nothing was read, so every " + platform + " source will refuse this pass rather "
                + "than publish unchecked."}`);
  for (const source of [...new Set(later.map(tagOf))]) {
    const mine = later.filter((p) => tagOf(p) === source);
    out.push(`::warning title=${platform} second quote source::${source} could not be read `
      + `(${mine.length} failure(s)): ${mine.slice(0, 2).join("; ")}.`
      + `${own.length ? "" : ` ${first} was read; quotes come from it alone this pass, without a second-source check.`}`);
  }
  return out;
}

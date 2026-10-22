/* ADAPTER: elevators that post their own basis on agsist.com.
 *
 * An elevator (the first is Bunge at Ladoga, IN) keeps its own listing from a
 * private link on agsist.com/post: basis by crop and delivery period, hours,
 * a contact and a short note. The agsist Worker serves every active listing
 * in one public document:
 *
 *   GET https://agsist-api.dnilgis.workers.dev/elev/feed
 *   { ok: true, generated_at: ISO,
 *     elevators: [{ id: "bunge-ladoga-in", name, town, state, zip, lat, lon, active: true,
 *                   contact: { name, phone }, hours: { text, harvest },
 *                   closed_until: ISO | null, note: string | null,
 *                   bids: [{ crop: "corn", period: "Oct/Nov", start: "2026-10-01",
 *                            end: "2026-11-30", futures: "ZCZ26", basis: -0.35 }],
 *                   bids_updated_at: ISO, info_updated_at: ISO, created_at: ISO }] }
 *
 * WHAT THE ELEVATOR POSTS IS A BASIS, NOT A CASH PRICE. Their cash price is
 * that basis on the contract they name, so cash here is the CBOT quote for
 * that contract, from the shared quote pages the poller reads once a pass,
 * plus their basis. Nothing else is added. The quote is not republished: like
 * every other board that names its contract and prints no price, the row
 * carries futuresPrice null and is stamped VERIFIED_BY, which each portal
 * source declares as its identityAlternative.
 *
 * cash - basis = futures would pass here by construction, so it is not run and
 * nothing is claimed for it. What the stamp says instead: every field the
 * elevator typed passed the checks below, and the contract it named was
 * quoted on this pass.
 *
 * ONE FETCH FOR EVERY PORTAL ELEVATOR. Each portal source has this same url
 * and its own locationId (the listing id), so getPage() fetches the feed once
 * and buildFile keeps each source's own rows, the way one dtn-cs call carries
 * thirteen towns.
 *
 * pricedAt IS WHEN THE ELEVATOR LAST POSTED (bids_updated_at), not when we
 * computed a cash figure. Every row carries it as `postedAt` and poll.mjs hands
 * it to decide(), so a basis Wyatt set on Monday reads as Monday's on Thursday
 * even though the futures under it moved.
 *
 * ROWS WHOSE DELIVERY HAS ENDED ARE LEFT OUT. `end` before today in
 * America/Chicago (the elevator's own calendar) and the row is gone, quietly:
 * an expired period is not a fault. Anything else the elevator typed that does
 * not pass is refused per row and named in `unreconciled`. */
import { bandFor } from "../board.mjs";
import { delivery as readDelivery } from "../delivery.mjs";

export class PortalRefused extends Error {}

export const VERIFIED_BY = "agsist-portal:posted-basis+named-contract-quoted";
export const FEED_URL = "https://agsist-api.dnilgis.workers.dev/elev/feed";
export const SOURCE_PREFIX = "portal-";
export const sourceIdOf = (listingId) => `${SOURCE_PREFIX}${listingId}`;

export const CROPS = {
  corn:     { commodity: "Corn",     root: "ZC", months: "HKNUZ" },
  soybeans: { commodity: "Soybeans", root: "ZS", months: "FHKNQUX" },
  wheat:    { commodity: "Wheat",    root: "ZW", months: "HKNUZ" },
};
export const BASIS_MIN = -3.0, BASIS_MAX = 2.0;
export const PERIOD_MAX = 16, NOTE_MAX = 140, MAX_BIDS = 12;
const ID_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY_RX = /^(\d{4})-(\d{2})-(\d{2})$/;

const isDay = (s) => {
  const m = DAY_RX.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const isIso = (s) => typeof s === "string" && s.length >= 10 && Number.isFinite(Date.parse(s));
const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Today's date where the elevator is, "YYYY-MM-DD". */
export function chicagoDay(ms) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymOf = (day) => day.slice(0, 7);
/** The period key lib/delivery.mjs would give these dates: one month, or first/last. */
export function datesKey(start, end) {
  const a = ymOf(start), b = ymOf(end);
  return a === b ? a : `${a}/${b}`;
}

/* THE DELIVERY LABEL IS THE ELEVATOR'S OWN WORDS, AND IT HAS TO MEAN THE DATES.
 *
 * The merge reads a period out of the label (lib/delivery.mjs) and agsist sorts
 * and expires rows on it. "Oct/Nov" reads correctly; "Harvest" reads as nothing
 * and "Dec/Jan" guesses its year. So the label is kept as typed when it reads
 * as the same months the dates say, and otherwise the months are added in
 * brackets from the dates the elevator set: "Harvest (Oct/Nov 2026)". Nothing
 * is added that the elevator did not enter. If no form reads right the label
 * goes out as typed, and the merge counts it unreadable rather than guessing.
 * "Jan" for January 2028, read in October 2026, would be taken as January 2027,
 * so it goes out as "Jan 2028". */
export function deliveryLabel(period, start, end, asOf) {
  const want = datesKey(start, end);
  const reads = (s) => readDelivery(s, asOf).key === want;
  if (reads(period)) return period;
  const [ys, ms] = [start.slice(0, 4), +start.slice(5, 7)];
  const [ye, me] = [end.slice(0, 4), +end.slice(5, 7)];
  const forms = ys === ye
    ? (ms === me ? [`${MON[ms - 1]} ${ys}`] : [`${MON[ms - 1]}/${MON[me - 1]} ${ys}`])
    : [`${MON[ms - 1]}/${MON[me - 1]} ${ys.slice(2)}-${ye.slice(2)}`];
  /* Their words with the year, then their words with the months in brackets. */
  const year = ys === ye ? ys : `${ys.slice(2)}-${ye.slice(2)}`;
  for (const s of [`${period} ${year}`, ...forms.map((f) => `${period} (${f})`)])
    if (reads(s)) return s;
  return period;
}

/* ---------- the feed ---------- */

/** The feed, checked at the top level. Throws PortalRefused on anything that is not it. */
export function parseFeed(body) {
  let d;
  try { d = JSON.parse(String(body)); }
  catch (e) { throw new PortalRefused(`the portal feed is not JSON (${e.message}): ${String(body).slice(0, 120)}`); }
  if (!d || typeof d !== "object" || d.ok !== true)
    throw new PortalRefused(`the portal feed did not say ok: ${String(body).slice(0, 160)}`);
  if (!Array.isArray(d.elevators))
    throw new PortalRefused(`the portal feed has no elevators array; keys ${JSON.stringify(Object.keys(d))}`);
  if (!isIso(d.generated_at))
    throw new PortalRefused(`the portal feed has no readable generated_at (${JSON.stringify(d.generated_at)})`);
  return d;
}

/** Why one listing cannot be read at all, or null. Its bids are checked one by one later. */
export function listingProblem(e) {
  if (!e || typeof e !== "object") return "a listing that is not an object";
  if (!ID_RX.test(String(e.id ?? ""))) return `listing id ${JSON.stringify(e.id)} is not a lowercase slug`;
  if (!str(e.name)) return "no name";
  if (!str(e.town)) return "no town";
  if (!/^[A-Z]{2}$/.test(String(e.state ?? ""))) return `state ${JSON.stringify(e.state)} is not two capitals`;
  if (typeof e.lat !== "number" || typeof e.lon !== "number" || !Number.isFinite(e.lat) || !Number.isFinite(e.lon))
    return "no numeric lat/lon";
  if (!Array.isArray(e.bids)) return "no bids array";
  if (e.bids.length > MAX_BIDS) return `${e.bids.length} bid rows, more than the ${MAX_BIDS} a listing may carry`;
  if (!isIso(e.bids_updated_at)) return `bids_updated_at ${JSON.stringify(e.bids_updated_at)} is not a time`;
  return null;
}

/** Why one bid row cannot publish, or null. */
export function bidProblem(b) {
  if (!b || typeof b !== "object") return "a bid row that is not an object";
  const c = CROPS[b.crop];
  if (!c) return `crop ${JSON.stringify(b.crop)} is not corn, soybeans or wheat`;
  const period = str(b.period);
  if (!period || period.length > PERIOD_MAX) return `period ${JSON.stringify(b.period)} is empty or over ${PERIOD_MAX} characters`;
  if (!isDay(b.start) || !isDay(b.end)) return `start/end ${JSON.stringify(b.start)}..${JSON.stringify(b.end)} are not dates`;
  if (b.start > b.end) return `start ${b.start} is after end ${b.end}`;
  const m = /^(ZC|ZS|ZW)([FGHJKMNQUVXZ])(\d{2})$/.exec(String(b.futures ?? ""));
  if (!m) return `futures ${JSON.stringify(b.futures)} is not a CBOT corn, bean or wheat symbol`;
  if (m[1] !== c.root) return `${b.crop} is priced off ${c.root}, not ${m[1]}`;
  if (!c.months.includes(m[2])) return `${c.root} has no ${m[2]} contract`;
  if (typeof b.basis !== "number" || !Number.isFinite(b.basis)) return `basis ${JSON.stringify(b.basis)} is not a number`;
  if (b.basis < BASIS_MIN || b.basis > BASIS_MAX) return `basis ${b.basis} is outside ${BASIS_MIN}..${BASIS_MAX}`;
  if (Math.abs(b.basis * 100 - Math.round(b.basis * 100)) > 1e-6) return `basis ${b.basis} has more than two decimals`;
  return null;
}

/** The public facts about a listing that travel beside its bids. No email: the feed has none and this adds none. */
export function listingInfo(e) {
  const t = (v, max = 200) => { const s = str(v); return s ? s.slice(0, max) : null; };
  return {
    listingId: e.id,
    name: t(e.name),
    contactName: t(e.contact?.name, 80),
    hours: t(e.hours?.text),
    harvestHours: t(e.hours?.harvest),
    note: t(e.note, NOTE_MAX),
    closedUntil: isIso(e.closed_until) ? e.closed_until : null,
    infoUpdatedAt: isIso(e.info_updated_at) ? e.info_updated_at : null,
  };
}

/* ---------- the adapter ---------- */

export function extract(body, sourceUrl = "", shared = null) {
  const d = parseFeed(body);
  const contracts = shared?.contracts;
  if (!Array.isArray(contracts) || !contracts.length)
    throw new PortalRefused("the portal posts a basis and names its contract; with no CBOT quotes this pass "
      + "there is no cash price to give, and none is guessed");
  const bySymbol = new Map(contracts.filter((c) => c.priced && c.symbol && Number.isFinite(c.lastCents))
    .map((c) => [c.symbol, c]));
  const nowMs = Number.isFinite(shared?.nowMs) ? shared.nowMs : Date.now();
  const today = chicagoDay(nowMs);
  const asOf = new Date(nowMs).toISOString();

  const rows = [], unreconciled = [], present = new Set(), expired = [];
  let seq = 0;
  for (const e of d.elevators) {
    const bad = listingProblem(e);
    if (bad) { unreconciled.push({ location: String(e?.id ?? "?"), commodity: "", delivery: "", why: bad }); continue; }
    if (e.active === false) continue;   // the feed carries active listings only; belt and braces
    present.add(e.id);
    for (const b of e.bids) {
      const why = (w) => unreconciled.push({ location: e.id, commodity: String(b?.crop ?? ""), delivery: String(b?.period ?? ""), why: w });
      const p = bidProblem(b);
      if (p) { why(p); continue; }
      if (b.end < today) { expired.push({ location: e.id, crop: b.crop, period: b.period, end: b.end }); continue; }
      const q = bySymbol.get(b.futures);
      if (!q) { why(`${b.futures} is not on this pass's CBOT quote pages, so there is no cash price to give`); continue; }
      const c = CROPS[b.crop];
      const cents = q.lastCents + Math.round(b.basis * 100);
      const cash = Math.round(cents * 100) / 10000;
      const label = deliveryLabel(str(b.period), b.start, b.end, asOf);
      rows.push({
        seq: seq++, location: e.name.trim(), locationId: e.id, commodity: c.commodity, delivery: label,
        deliveryStart: b.start, deliveryEnd: b.end,
        cash, basis: b.basis, basisCents: Math.round(b.basis * 100),
        futures: b.futures, futuresPrice: null, futuresAt: q.at ?? null, futuresFlag: null, futuresChange: null,
        unit: "bushel", source: sourceUrl, verifiedBy: VERIFIED_BY, postedAt: e.bids_updated_at,
        raw: `${e.id} | ${b.crop} | ${b.period} | ${b.start}..${b.end} | ${b.futures} | ${b.basis}`,
      });
    }
  }
  Object.defineProperty(rows, "unreconciled", { value: unreconciled, enumerable: false });
  /* Which listings the feed carries, rows or not. A listing that is here with
     nothing current is posting nothing, which buildFile says as an empty
     board, not as a page that lost a location. */
  Object.defineProperty(rows, "present", { value: present, enumerable: false });
  Object.defineProperty(rows, "expired", { value: expired, enumerable: false });
  return rows;
}

/* Every portal row is one of three crops, and each has a default band. Kept
   here so the generator and the tests agree on what a portal source declares. */
export const PORTAL_BANDS = { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] };
export const bandsCover = (bands = PORTAL_BANDS) =>
  Object.values(CROPS).every((c) => !!bandFor({ bands }, c.commodity));

export default extract;

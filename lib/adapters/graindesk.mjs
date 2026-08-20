/* ADAPTER — DTN Grain Desk, the "Grain Discovery" cash-bids widget.
 *
 * THE CLEANEST SOURCE IN THE SYSTEM, AND THE ONE THAT SCALES FURTHEST.
 *
 * Albert Lea Elevator's page configures its board like this:
 *
 *     window.initGdCashBidsWidget(widgetId, { companyToken: "albertleaelevator", … })
 *
 * and the widget's own bundle answers the only question that mattered:
 *
 *     static async getCashBids(e) {
 *       if (!e) throw new Error("Company token is required");
 *       const t = (e => Rf[e] ?? Hf)(e);
 *       return (await Of.get(`${t}/public-sites/${e}/cash-bids`,
 *                            { headers: { Accept: "application/json" } })).data;
 *     }
 *
 * So the board is:
 *
 *     GET https://marketplace.graindiscovery.com/api/public-sites/<companyToken>/cash-bids
 *
 * JSON, no key, no session. And the company token is the company's own slug,
 * which means every elevator on this platform is one string away rather than
 * one adapter away. `Rf` in that snippet is a per-customer override map
 * (lockiefarms has its own host), so a source may carry `apiBase` when a
 * company is not on the shared marketplace host.
 *
 * THE SHAPE
 *   [ { commodity: { name, … }, offers: [ { destination, deliveryPeriod,
 *       comments, futuresMonth, futuresPrice, futuresChange, basisPrice,
 *       standardCashPrice, convertedCashPrice }, … ] }, … ]
 *
 * futuresPrice is already in CENTS ("472.5000"); cash and basis are dollars.
 * Observed at Albert Lea: 4.2750 − (−0.4500) = 4.7250 = 472.50, exactly. This
 * platform does not round, so a source on it should declare
 * cashRoundingCents 0 and let the identity guard be strict.
 */

export class GrainDeskRefused extends Error {}

/** A number, or null. "" and null are null, never zero. */
export function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /^[+-]?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}

export function describe(json) {
  const s = String(json);
  let parsed;
  try { parsed = JSON.parse(s); } catch { return `${s.length} bytes, not JSON, starts: ${JSON.stringify(s.slice(0, 120))}`; }
  if (!Array.isArray(parsed)) return `${s.length} bytes of JSON, but a ${typeof parsed}, not the expected array. Keys: ${JSON.stringify(Object.keys(parsed ?? {}).slice(0, 12))}`;
  const groups = parsed.map((g) => `${g?.commodity?.name ?? "(unnamed)"}×${(g?.offers ?? []).length}`);
  const dests = [...new Set(parsed.flatMap((g) => (g?.offers ?? []).map((o) => o?.destination)).filter(Boolean))];
  return `${s.length} bytes · ${parsed.length} commodity group(s): ${groups.join(", ")} · destinations: ${JSON.stringify(dests)}`;
}

export function extract(body, sourceUrl = "") {
  let data;
  try { data = JSON.parse(String(body)); }
  catch (e) {
    /* An HTML error page parses as "not JSON", and saying so beats saying
       "0 bids", which reads downstream as "they are not bidding today". */
    throw new GrainDeskRefused(`the response is not JSON (${e.message}). ${describe(body)}`);
  }
  if (!Array.isArray(data)) throw new GrainDeskRefused(`expected an array of commodity groups. ${describe(body)}`);
  if (!data.length) throw new GrainDeskRefused(`the array is empty — this company token returned no commodities at all. ${describe(body)}`);

  const out = [];
  let seq = 0;
  let sawOffer = false;
  for (const group of data) {
    const commodity = String(group?.commodity?.name ?? "").trim();
    if (!commodity) throw new GrainDeskRefused(`a commodity group has no name. ${describe(body)}`);
    for (const o of group?.offers ?? []) {
      sawOffer = true;
      const location = String(o?.destination ?? "").trim();
      const cash = num(o?.standardCashPrice);
      const basis = num(o?.basisPrice);
      const futuresPrice = num(o?.futuresPrice);
      const period = String(o?.deliveryPeriod ?? "").trim();
      const comments = String(o?.comments ?? "").trim();
      /* Absent is not empty. A row missing any of these is skipped, never
         defaulted -- the whole point of the guards downstream is that they see
         real numbers or nothing. */
      if (!location || !period || cash == null || basis == null || futuresPrice == null) continue;

      out.push({
        seq: seq++,
        location,
        locationId: location,
        commodity,
        /* Their own label first when they give one ("New Crop 2026"), with the
           dates kept beside it so two offers can never collapse into one row. */
        delivery: comments ? `${comments} (${period})` : period,
        cash: Math.round(cash * 10000) / 10000,
        basis: Math.round(basis * 10000) / 10000,
        basisCents: Math.round(basis * 100),
        futures: String(o?.futuresMonth ?? "").trim() || null,
        futuresPrice,
        futuresAt: null,
        futuresFlag: null,
        source: sourceUrl,
        raw: `${location} ${commodity} ${period}${comments ? ` ${comments}` : ""}`,
      });
    }
  }
  if (!out.length) {
    throw new GrainDeskRefused(sawOffer
      ? `every offer was incomplete — no row carried a destination, a cash price, a basis and a futures price together. ${describe(body)}`
      : `the company token resolved but no commodity group carried any offers. ${describe(body)}`);
  }
  return out;
}

/** The board URL for a company token. `apiBase` overrides the shared host. */
export function cashBidsUrl(companyToken, apiBase = "https://marketplace.graindiscovery.com/api") {
  if (!companyToken) throw new GrainDeskRefused("a company token is required");
  return `${String(apiBase).replace(/\/+$/, "")}/public-sites/${encodeURIComponent(companyToken)}/cash-bids`;
}

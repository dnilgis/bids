/* ADAPTER — a server-rendered cash-bid table, fetched as an HTML fragment.
 *
 * Found on Farmers Cooperative Society (Sioux Center, IA), whose own page does
 *
 *     U("js-dtn-bids",          "/ajax/homepage/dtn-cash-bids")
 *     U("js-cash-bids-details", `/ajax/pages/dtn-cash-bids?location=${id}`)
 *
 * and drops the answer straight into the page. There is no widget, no key and
 * no JavaScript in the way: their server renders the board and hands over the
 * markup. It is the cheapest read of any platform met so far.
 *
 * WHAT THIS ADAPTER ASSUMES, AND WHAT IT REFUSES
 *
 * One panel per commodity. Each panel is an <h1> naming the town and the crop
 * followed by a <table> whose <thead> LABELS the columns. Column order is read
 * from those labels rather than assumed, because a template that gains a column
 * one day would otherwise shift every value one place to the left and publish
 * basis as cash. If a label we need is missing, the panel is refused.
 *
 * Exports `extract(html, sourceUrl)` with the same row shape as the other
 * adapters, so buildFile() applies exactly the same guards to it.
 */

/* The eighths reader lives in the AgHost adapter because that is where the
   first tick-shaped price appeared. Importing it keeps ONE implementation of
   "473'0 means 473.5 cents, and 473' means refuse" -- the bug that froze the
   Boyceville feed on 2026-08-19 was a second, sloppier copy of exactly this. */
import { parseEighths } from "./aghost.mjs";

export class FragmentRefused extends Error {}

const ENTITIES = { "&#039;": "'", "&#39;": "'", "&apos;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
const decode = (s) => String(s).replace(/&(?:#0?39|#x27|apos|quot|amp|lt|gt|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? ENTITIES[m] ?? m);
const text = (h) => decode(String(h).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Column labels we understand, normalised. Anything else is ignored. */
const COLUMN = {
  "delivery date": "delivery", "delivery": "delivery", "delivery period": "delivery",
  "cash-price": "cash", "cash price": "cash", "cash": "cash", "price": "cash",
  "basis": "basis",
  "basis-month": "futuresMonth", "basis month": "futuresMonth",
  "futures-month": "futuresMonth", "futures month": "futuresMonth",
  "futures-price": "futuresPrice", "futures price": "futuresPrice", "futures": "futuresPrice",
  "futures-change": "change", "futures change": "change", "change": "change",
  "comments": "comments", "comment": "comments",
};

/** The commodity names the page's own tab buttons declare, e.g. ["Corn", "Soybean"]. */
export function tabCommodities(html) {
  return [...String(html).matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)]
    .map((m) => text(m[1]))
    .filter((t) => /\bbids?$/i.test(t))
    .map((t) => t.replace(/\s*bids?$/i, "").trim())
    .filter(Boolean);
}

/* "Sioux Center Corn Bids" -> { location: "Sioux Center", commodity: "Corn" }
 *
 * SPLIT ON WHAT THE PAGE ITSELF DECLARES, NOT ON WHITESPACE.
 * Taking the last word as the commodity works until a town is called Corning
 * or a crop is called "Spring Wheat". The tab buttons name the commodities
 * outright, so match the heading against those and let the remainder be the
 * town. When nothing matches, refuse: a wrong location silently attaches a
 * town's prices to a different town. */
export function splitHeading(heading, commodities) {
  const h = text(heading);
  const bare = h.replace(/\s*bids?$/i, "").trim();
  for (const c of commodities) {
    const re = new RegExp(`\\s*${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    if (re.test(bare)) {
      const location = bare.replace(re, "").trim();
      if (location) return { location, commodity: c };
    }
  }
  return null;
}

/** [{label, index}] from a <thead>, normalised through COLUMN. */
export function headerMap(table) {
  const thead = String(table).match(/<thead[\s\S]*?<\/thead>/i);
  if (!thead) return null;
  const map = {};
  [...thead[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].forEach((m, i) => {
    const key = COLUMN[text(m[1]).toLowerCase()];
    if (key && !(key in map)) map[key] = i;
  });
  return map;
}

const REQUIRED = ["delivery", "cash", "basis", "futuresMonth", "futuresPrice"];

/** A number, or null. "" and "—" and "n/a" are null, never zero. */
export function num(t) {
  const s = String(t ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  return /^[+-]?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}

export function extract(html, sourceUrl = "") {
  const commodities = tabCommodities(html);
  const panels = [...String(html).matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>([\s\S]*?)<\/table>/gi)];
  if (!panels.length) throw new FragmentRefused(`no "<h1> … </table>" panel on this fragment. ${describe(html)}`);

  /* THE SECOND HEADING DROPS THE TOWN.
     Sioux Center's fragment reads "Sioux Center Corn Bids" and then plain
     "Soybean Bids" -- the town is stated once and assumed after. Inheriting it
     is right for a fragment that covers one town, and wrong the moment a
     fragment covers two, so it is allowed ONLY when every heading that does
     name a town names the same one. Otherwise refuse: a wrong town silently
     files one elevator's prices under another's name, and the guards downstream
     have no way to see it. */
  const named = panels.map(([, h]) => splitHeading(h, commodities)).filter(Boolean);
  const towns = [...new Set(named.map((w) => w.location))];
  const soleTown = towns.length === 1 ? towns[0] : null;

  const out = [];
  let seq = 0;
  for (const [, heading, rest] of panels) {
    let who = splitHeading(heading, commodities);
    if (!who) {
      const bare = text(heading).replace(/\s*bids?$/i, "").trim();
      const commodity = commodities.find((c) => c.toLowerCase() === bare.toLowerCase());
      if (commodity && soleTown) who = { location: soleTown, commodity };
    }
    if (!who) throw new FragmentRefused(
      `cannot tell the town from the crop in ${JSON.stringify(text(heading))} ` +
      `(the page's tabs name ${JSON.stringify(commodities)}` +
      `${towns.length > 1 ? `, and the fragment names ${towns.length} towns: ${JSON.stringify(towns)}` : ""})`);

    const table = `${rest}</table>`;
    const cols = headerMap(table);
    if (!cols) throw new FragmentRefused(`${who.location} ${who.commodity}: the table has no <thead>, so the columns cannot be labelled`);
    const missing = REQUIRED.filter((k) => !(k in cols));
    if (missing.length) throw new FragmentRefused(
      `${who.location} ${who.commodity}: the header is missing ${missing.join(", ")}. Their template has changed shape.`);

    const body = table.match(/<tbody[\s\S]*?<\/tbody>/i);
    if (!body) throw new FragmentRefused(`${who.location} ${who.commodity}: the table has no <tbody>`);

    for (const tr of [...body[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1])) {
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => text(m[1]));
      if (!cells.length) continue;
      const at = (k) => (cols[k] == null ? null : cells[cols[k]] ?? null);

      /* Number("") IS 0, AND A ZERO CASH PRICE IS A FREE BUSHEL.
         An empty cell must drop its row, not coerce to a number. Parse
         strictly: a value is a number only if it looks like one. */
      const cash = num(at("cash"));
      const basis = num(at("basis"));
      const futuresPrice = parseEighths(at("futuresPrice") ?? "");
      const delivery = at("delivery");
      const futures = at("futuresMonth");
      /* A blank row is a blank row. Absent is not empty: skip it, do not coerce
         it to zero and publish a free bushel. */
      if (!delivery || cash == null || basis == null || futuresPrice == null) continue;

      out.push({
        seq: seq++,
        location: who.location,
        locationId: who.location,
        commodity: who.commodity,
        delivery,
        cash: Math.round(cash * 100) / 100,
        basis: Math.round(basis * 100) / 100,
        basisCents: Math.round(basis * 100),
        futures,
        futuresPrice,
        futuresAt: null,
        futuresFlag: null,
        source: sourceUrl,
        raw: `${who.location} ${who.commodity} ${delivery}`,
      });
    }
  }
  if (!out.length) throw new FragmentRefused(`the fragment parsed but carried no complete row. ${describe(html)}`);
  return out;
}

export function describe(html) {
  const h = String(html);
  return [
    `${h.length} bytes`,
    `${(h.match(/<table/gi) || []).length} table(s)`,
    `${(h.match(/<h1/gi) || []).length} heading(s)`,
    `tabs ${JSON.stringify(tabCommodities(h))}`,
    `${(h.match(/<tr/gi) || []).length} row(s)`,
  ].join(" · ");
}

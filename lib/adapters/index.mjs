/* Platform -> extractor. Adding a platform is a line here plus an adapter file;
   it is never a change to the guards. */
import { extractBids } from "../parse.mjs";
import { extract as aghost } from "./aghost.mjs";
import { extract as fragment } from "./fragment.mjs";
import { extract as graindesk } from "./graindesk.mjs";
import { extract as bushel } from "./bushel.mjs";
import { extract as dtnCs } from "./dtn-cs.mjs";
import { extract as agricharts, quoteUrls as agrichartsQuoteUrls,
         mergeQuotes as agrichartsMergeQuotes } from "./agricharts.mjs";

export const ADAPTERS = {
  cashbidssingle: extractBids,
  /* Bushel's GetBidsList aggregator. TEN operators behind one shape and seven
     of them CHS regions -- the widest single door in the queue. Read through a
     browser: the board is fetched by their own page's script.
     See lib/adapters/bushel.mjs. */
  bushel,
  aghost,
  /* A board their own server renders and hands over as an HTML fragment --
     no widget, no key, no JavaScript. See lib/adapters/fragment.mjs. */
  fragment,
  /* DTN Grain Desk. Public JSON keyed by the company's own slug -- the widest
     door found so far. See lib/adapters/graindesk.mjs. */
  graindesk,
  /* DTN Content Services cash-bids-table-widget. Keyed by an E-number site id
     and an API key, both published in the customer's own page. One site id can
     carry a whole co-op: Ag Partners' returns 13 locations in one call.
     See lib/adapters/dtn-cs.mjs. */
  "dtn-cs": dtnCs,
  /* AgriCharts, read through the mobile board. 211 sites, ~945 locations, one
     shape. Its board carries cash, basis and a futures CHANGE and no futures
     PRICE, so it cannot satisfy cash - basis = futures and does not pretend
     to: it publishes only on a declared alternative that lib/board.mjs
     enforces per row. It is the one adapter that needs a page it did not
     fetch itself -- see SHARED_PAGES. */
  agricharts,
  /* A board Sig publishes himself. Cheapest adapter in the system and the only
     one that cannot break from outside — it reads a bids.json we wrote. */
  "first-party": (html) => { try { return JSON.parse(html).bids ?? []; } catch { return []; } },
};

/* ---------------------------------------------------------------------------
 * A PAGE THAT IS THE SAME FOR EVERY SOURCE ON A PLATFORM.
 *
 * AgriCharts' cash board publishes no futures price. The quote is on a sibling
 * page — and it is CBOT's number, not the co-op's, so the same seven pages
 * answer for all 211 sites. Fetching them per source would be 211 x 7 requests
 * a pass to say the same thing; fetching them once and handing them to every
 * source is 7.
 *
 * This is a list, not an if-statement in the poller. Adding a platform that
 * needs one stays a line here plus an adapter file.
 *
 * WHAT HAPPENS WHEN IT FAILS: nothing is defaulted. The poller passes whatever
 * it got, and an adapter that needs a page it did not receive refuses that
 * source — which withholds a price rather than publishing an unchecked one.
 * --------------------------------------------------------------------------- */
export const SHARED_PAGES = {
  agricharts: {
    urls: agrichartsQuoteUrls(),
    /* Bodies in, context out. The context is what an adapter's third argument
       receives, and its shape is the adapter's business. */
    build: (bodies) => ({ contracts: agrichartsMergeQuotes(bodies) }),
    why: "the CBOT futures quote their cash board does not carry",
  },
};

/* `shared` is the per-pass context for this platform, from SHARED_PAGES, or
   undefined. Every adapter written before this takes (html, url) and ignores a
   third argument, so passing one costs them nothing. */
export function adapterFor(platform, shared) {
  const a = ADAPTERS[platform];
  if (!a) throw new Error(`no adapter for platform "${platform}"`);
  if (shared === undefined) return a;
  return (html, url) => a(html, url, shared);
}

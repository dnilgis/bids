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
import { extract as agrichartsCashgrid } from "./agricharts-cashgrid.mjs";
import { extract as gradable } from "./gradable.mjs";
import { extract as heartland } from "./heartland.mjs";
import { extract as emmert } from "./emmert.mjs";
import { extract as stonehedge } from "./stonehedge.mjs";
import { extract as cih } from "./cih.mjs";
import { extract as newcoop } from "./newcoop.mjs";
import { extract as nexus } from "./nexus.mjs";
import { extract as landus } from "./landus.mjs";
import { extract as cpicoop } from "./cpicoop.mjs";
import { extract as fivestar } from "./fivestar.mjs";

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
  /* THE SAME PLATFORM, THE OTHER BOARD. AgriCharts serves a mobile board at
     <sub>.mobile.agricharts.com/cash/prices.php and a cashgrid at
     /markets/cashgrid.php, and they are different documents: the first prints
     cash and leaves us to fit the contract, the second prints a basis and
     NAMES the contract. Measured 2026-09-03, the mobile route reaches 18 of
     211 AgriCharts sites; 45 of 47 captured cashgrid boards read here. */
  "agricharts-cashgrid": agrichartsCashgrid,
  /* Gradable — POET's 36 plants and ADM. The only board in the system that
     DECLARES its own rounding mode and hands over a coordinate for the
     facility. See lib/adapters/gradable.mjs. */
  gradable,
  /* HEARTLAND CO-OP'S OWN CLOSING BOARD, and the only matrix in the system:
     the delivery periods are COLUMN HEADINGS and the locations are rows. One
     request carries 129 rows across 4 commodity tables, and it covers all 48
     Heartland facilities data/known-elevators.json holds from Barchart plus
     six the roster does not have. Like AgriCharts it prints no futures price,
     so it needs the shared CBOT quote pages and publishes on a declared
     alternative. See lib/adapters/heartland.mjs. */
  heartland,
  /* TWO ELEVATORS THAT PUBLISH THEIR OWN FEED. Badger Grain Supply and
     Midwest Commodity Service post bids.json beside their index.html under
     CC0, with cash and basis and no futures price. Read the feed rather than
     the table it renders. See lib/adapters/emmert.mjs. */
  "emmert-cash-bids": emmert,
  /* StoneHedge (StoneX) widget, read from its RENDERED document. Six column
     layouts across ten operators, detected from the header row. Four print a
     futures price and are proved by cash - basis = futures; the other two name
     the contract (or nothing) and publish on a declared alternative against the
     shared CBOT quote pages. See lib/adapters/stonehedge.mjs. */
  stonehedge,
  /* CIH (cihedging.com) cash-bid widget. Public: the site number is in the
     path and the answer is a JSON string of the widget's HTML, a card per
     location, each row printing the contract AND its futures price, so
     cash - basis = futures proves it. Found 2026-10-01 behind thirty sites
     discover had filed as AgHost. See lib/adapters/cih.mjs. */
  cih,
  /* TWO CO-OPS THAT RENDER THEIR OWN BOARD. NEW Cooperative (69 locations,
     futures in CBOT ticks, basis in cents) and Nexus Cooperative (36 locations,
     StoneHedge data on their own page). One request each, no key. See
     lib/adapters/newcoop.mjs and lib/adapters/nexus.mjs. */
  newcoop,
  nexus,
  /* Landus Cooperative's own JSON, one request per location. Names its contract
     and prints no price, so it publishes on the shared CBOT quotes like
     Heartland. See lib/adapters/landus.mjs. */
  landus,
  /* Cooperative Producers, Inc.: its own server-rendered board, 27 locations,
     futures in ticks. See lib/adapters/cpicoop.mjs. */
  cpicoop,
  /* Five Star Cooperative: its own table, cash and basis only. See lib/adapters/fivestar.mjs. */
  fivestar,
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
  /* The same seven pages. scripts/poll.mjs keys its cache on this URL LIST,
     not on the platform name, so both platforms share one fetch and one parse
     — which is what this comment claimed before it was true. */
  "agricharts-cashgrid": {
    urls: agrichartsQuoteUrls(),
    /* Bodies in, context out. The context is what an adapter's third argument
       receives, and its shape is the adapter's business. */
    build: (bodies) => ({ contracts: agrichartsMergeQuotes(bodies) }),
    why: "the CBOT futures quote their cash board does not carry",
  },
  /* THE SAME SEVEN PAGES AGAIN. Heartland's board names its contract in the
     column heading and prints no price for it, so the quote is what says the
     heading was read off the right column. poll.mjs keys its cache on the URL
     LIST, so this is a third platform sharing one fetch and one parse. */
  heartland: {
    urls: agrichartsQuoteUrls(),
    build: (bodies) => ({ contracts: agrichartsMergeQuotes(bodies) }),
    why: "the CBOT futures quote their closing board names but does not price",
  },
  /* THE SAME SEVEN PAGES A FOURTH TIME. Six of StoneHedge's ten operators print a
     contract month and no price, and one prints neither; the quote is what says
     cash - basis landed on the contract the row names. The other four print a
     price and ignore this. Cached on the URL list like the three above. */
  stonehedge: {
    urls: agrichartsQuoteUrls(),
    build: (bodies) => ({ contracts: agrichartsMergeQuotes(bodies) }),
    why: "the CBOT futures quote a StoneHedge board that names its contract (or does not) cannot carry",
  },
  /* THE SAME SEVEN PAGES A FIFTH TIME. Landus names its basis month and prints
     no price. Cached on the URL list like the others. */
  landus: {
    urls: agrichartsQuoteUrls(),
    build: (bodies) => ({ contracts: agrichartsMergeQuotes(bodies) }),
    why: "the CBOT futures quote Landus names but does not price",
  },
  /* The same seven pages: Five Star prints no futures at all, so its rows are
     checked against the quotes before they publish. */
  fivestar: {
    urls: agrichartsQuoteUrls(),
    build: (bodies) => ({ contracts: agrichartsMergeQuotes(bodies) }),
    why: "the CBOT futures quote Five Star's board does not print",
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

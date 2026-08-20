/* Platform -> extractor. Adding a platform is a line here plus an adapter file;
   it is never a change to the guards. */
import { extractBids } from "../parse.mjs";
import { extract as aghost } from "./aghost.mjs";
import { extract as fragment } from "./fragment.mjs";
import { extract as graindesk } from "./graindesk.mjs";

export const ADAPTERS = {
  cashbidssingle: extractBids,
  aghost,
  /* A board their own server renders and hands over as an HTML fragment --
     no widget, no key, no JavaScript. See lib/adapters/fragment.mjs. */
  fragment,
  /* DTN Grain Desk. Public JSON keyed by the company's own slug -- the widest
     door found so far. See lib/adapters/graindesk.mjs. */
  graindesk,
  /* A board Sig publishes himself. Cheapest adapter in the system and the only
     one that cannot break from outside — it reads a bids.json we wrote. */
  "first-party": (html) => { try { return JSON.parse(html).bids ?? []; } catch { return []; } },
};

export function adapterFor(platform) {
  const a = ADAPTERS[platform];
  if (!a) throw new Error(`no adapter for platform "${platform}"`);
  return a;
}

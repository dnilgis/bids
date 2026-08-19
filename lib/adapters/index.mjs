/* Platform -> extractor. Adding a platform is a line here plus an adapter file;
   it is never a change to the guards. */
import { extractBids } from "../parse.mjs";
import { extract as aghost } from "./aghost.mjs";

export const ADAPTERS = {
  cashbidssingle: extractBids,
  aghost,
  /* A board Sig publishes himself. Cheapest adapter in the system and the only
     one that cannot break from outside — it reads a bids.json we wrote. */
  "first-party": (html) => { try { return JSON.parse(html).bids ?? []; } catch { return []; } },
};

export function adapterFor(platform) {
  const a = ADAPTERS[platform];
  if (!a) throw new Error(`no adapter for platform "${platform}"`);
  return a;
}

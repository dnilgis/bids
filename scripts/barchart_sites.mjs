#!/usr/bin/env node
/* THE SEVEN HUNDRED WEBSITES BARCHART GAVE US, AS A PROBE LIST.
 *
 * data/known-elevators.json is the Barchart directory harvest: 727 facilities,
 * 705 of them carrying the operator's own website. That subscription is
 * cancelled, so those 727 are a frozen snapshot — they will never refresh and
 * they are grey pins forever unless somebody asks what board each site runs.
 *
 * 699 DISTINCT HOSTS FOR 705 FACILITIES. Barchart's directory is per facility
 * and each row carries its operator's URL, so the list is very nearly one site
 * per elevator — but that is only true of the DIRECTORY. A single operator page
 * routinely serves a whole board: chs-illinois.com advertises twenty-three
 * locations from one call. So the yield of identifying a host is not one pin,
 * it is however many that operator quotes.
 *
 * Hosts we already read are dropped, matched with and without `www.` — the same
 * co-operative under two spellings is one site, and probing it again is asking
 * a stranger's server for something we already have.
 *
 *   node scripts/barchart_sites.mjs > probe-lists/barchart-sites.txt
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const bare = (u) => String(u || "").trim().toLowerCase()
  .replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");

const known = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8"));
const have = new Set();
for (const f of readdirSync(join(ROOT, "sources")).filter((x) => x.endsWith(".json"))) {
  const s = JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8"));
  for (const k of ["browserPage", "website", "url"]) if (s[k]) have.add(bare(s[k]));
}

const seen = new Map();                    // host -> how many facilities behind it
for (const e of known.elevators || []) {
  const h = bare(e.url);
  /* A HOST, NOT A PATH. Barchart's url field is the operator's home page and
     nothing deeper, so there is no cash-bids path to preserve — and no reason
     to probe the same host once per facility. */
  if (!h || !h.includes(".") || have.has(h)) continue;
  seen.set(h, (seen.get(h) ?? 0) + 1);
}

const out = [...seen.keys()].sort();
for (const h of out) console.log("https://" + h + "/");
console.error(`${out.length} host(s) to ask, covering ` +
              `${[...seen.values()].reduce((a, b) => a + b, 0)} facilit(ies); ` +
              `${have.size} host(s) already read were skipped`);

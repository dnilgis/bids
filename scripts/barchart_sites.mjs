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

/* AN EMPTY LIST IS NOT A FINISHED SWEEP -- 2026-09-07.
 *
 * This script reads `e.url` off every record in data/known-elevators.json.
 * That file is synced from agsist, its shape changed, and its records now carry
 *
 *     facility, branch, city, state, zip, phone, source
 *
 * and no url at all. The file SAYS SO in its own header: `counts.with_url` is
 * 0. Nothing here asked, so this printed an empty list, exit 0, "0 host(s) to
 * ask" on stderr where nobody reads it.
 *
 * discover-sweep.yml runs every three hours off that list. With an empty list
 * `--resume` prints "nothing left to ask — the sweep is complete" and exits 0,
 * so the workflow that exists because Sig said "I want every elevator in the
 * country" has been GREEN AND IDLE, reporting completeness, for as long as the
 * directory has been urlless. Verified 2026-09-07 by running it: 1804 records,
 * 0 with a url, 249 hosts skipped as already read, 0 to ask.
 *
 * A run whose failure looks exactly like its success is not a run. If the
 * directory carries no url on any record, that is a regression in the input and
 * it is reported as one, loudly, with a non-zero exit. `--allow-empty` is there
 * for the day the sweep genuinely finishes, and has to be typed by a person. */
const withUrl = (known.elevators || []).filter((e) => e && e.url).length;
const out = [...seen.keys()].sort();
for (const h of out) console.log("https://" + h + "/");
console.error(`${out.length} host(s) to ask, covering ` +
              `${[...seen.values()].reduce((a, b) => a + b, 0)} facilit(ies); ` +
              `${have.size} host(s) already read were skipped`);
if (!withUrl && !process.argv.includes("--allow-empty")) {
  console.error(`::error title=the directory carries no websites::` +
    `data/known-elevators.json holds ${(known.elevators || []).length} record(s) and NOT ONE has a ` +
    `url field, so this list is empty for a reason that has nothing to do with the sweep being ` +
    `finished. Its own counts.with_url reads ${known.counts?.with_url ?? "absent"}. ` +
    `The sync that writes it (sync_known.yml, from agsist) has changed shape. ` +
    `Pass --allow-empty only when the emptiness is the answer.`);
  process.exit(3);
}

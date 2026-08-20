#!/usr/bin/env node
/* WHAT BOARD IS THIS CO-OPERATIVE RUNNING, AND WHAT DOES IT NEED FROM US?
 *
 * RECON. It writes nothing into data/ and publishes no number. The output is
 * the log.
 *
 * WHY THIS AND NOT dtn-probe.mjs
 *
 * dtn-probe answers "what is behind THIS DTN site id" and needs the site id
 * before it can ask. That was fine for one co-operative found by reading a
 * DevTools panel over Sig's shoulder. It does not scale to the ninety-two
 * operators the 2026-08-20 sweep turned up, and it only speaks DTN.
 *
 * This asks the prior question -- what does this page actually call? -- for a
 * LIST of pages in ONE run. The site id, the slug, the StoneX key, the AgHost
 * cid: all of them stop being inputs and become outputs.
 *
 * IT RUNS ON THE RUNNER. The workspace this was written in sits behind an
 * allowlist proxy that answers nothing for every elevator on earth; measured
 * 2026-08-20, curl to premiercooperative.com, api.dtn.com and agpartners.net
 * all returned 000. GitHub Actions has no such limit, and it already has the
 * Chromium this needs.
 *
 *   node scripts/discover.mjs <url> [url...]
 *   node scripts/discover.mjs --list probe-lists/discover-candidates.txt
 *
 * ONE PAGE AT A TIME, DELIBERATELY. These are other people's websites and the
 * point is to read a board they publish, not to be a load generator.
 */
import { readFileSync } from "node:fs";
import { captureAll } from "../lib/cdp.mjs";

/* HOW A PLATFORM IS RECOGNISED, and what it needs before it can be a source.
 *
 * `id` pulls the ONE fact a manifest cannot be written without. Where that is
 * absent the platform still matches -- knowing a board is Barchart and not
 * knowing its key is a better answer than "unknown", because it says which
 * adapter to write next. */
export const SIGNATURES = [
  { platform: "dtn-cs", adapter: "lib/adapters/dtn-cs.mjs",
    test: (u) => /(^|\.)api\.dtn\.com$/.test(host(u)) && /\/markets\/sites\/[^/]+\/cash-bids/.test(path(u)),
    id: (u) => ({ siteId: path(u).match(/\/markets\/sites\/([^/]+)\/cash-bids/)?.[1] ?? null }) },

  { platform: "graindesk", adapter: "lib/adapters/graindesk.mjs",
    test: (u) => /graindiscovery\.com$/.test(host(u)) && /\/api\/public-sites\//.test(path(u)),
    id: (u) => ({ slug: path(u).match(/\/api\/public-sites\/([^/]+)/)?.[1] ?? null }) },

  { platform: "aghost", adapter: "lib/adapters/aghost.mjs",
    test: (u) => /aghost\.net$/.test(host(u)) || /\/index\.cfm/i.test(path(u)),
    id: (u) => ({ cid: param(u, "cid"), sid: param(u, "sid"), mid: param(u, "mid") }) },

  { platform: "cashbidssingle", adapter: "lib/parse.mjs",
    test: (u) => /cashbidssingle/i.test(path(u)),
    id: (u) => ({ board: path(u).match(/cashbidssingle-?(\w+)?/i)?.[1] ?? null }) },

  { platform: "fragment", adapter: "lib/adapters/fragment.mjs",
    test: (u) => /\/ajax\/.*(cash-bids|dtn)/i.test(path(u)),
    id: () => ({}) },

  /* BELOW THIS LINE THERE IS NO ADAPTER YET. Naming them is the point: the
     sweep found these families on dozens of co-operatives each, so the next
     adapter written should be the one with the most towns behind it, and that
     is a question this log can answer instead of a guess. */
  { platform: "stonehedge", adapter: null,
    test: (u) => /stonehedge\.stonex\.com$/.test(host(u)) || /stonex/i.test(host(u)),
    id: (u) => ({ key: param(u, "key") ? "<present>" : null }) },

  { platform: "barchart", adapter: null,
    test: (u) => /barchart\.com$/.test(host(u)),
    id: () => ({}) },

  { platform: "bushel", adapter: null,
    test: (u) => /bushelpowered\.com$/.test(host(u)) || /bushelsites\.com$/.test(host(u)),
    id: () => ({}) },

  { platform: "agricharts", adapter: null,
    test: (u) => /agricharts\.com$/.test(host(u)) || /\/markets\/cashgrid\.php/i.test(path(u)),
    id: () => ({}) },
];

export function fingerprint(url) {
  for (const s of SIGNATURES) {
    let hit = false;
    try { hit = s.test(url); } catch { hit = false; }
    if (hit) return { platform: s.platform, adapter: s.adapter, ...s.id(url) };
  }
  return null;
}

/* WHICH RESPONSES ON THIS PAGE ARE THE BOARD?
 *
 * A page calls its analytics, its consent banner and its font CDN too. This
 * keeps only responses a SIGNATURE claims, so an operator running two boards
 * (it happens -- a co-op that merged) shows both instead of the first one. */
export function findFeeds(result) {
  const out = [];
  for (const r of result.responses ?? []) {
    const f = fingerprint(r.url);
    if (!f) continue;
    out.push({ ...f, url: r.url, status: r.status, mime: r.mime,
               bytes: r.body?.length ?? 0, body: r.body ?? null });
  }
  return dedupe(out);
}

/* One page load asks the same endpoint more than once -- a widget that
   refreshes, a retry after a 401. Reporting it three times reads as three
   boards. Keyed on the platform and its identifying facts, NOT on the URL,
   because the URL carries a cache-buster. */
function dedupe(feeds) {
  const seen = new Map();
  for (const f of feeds) {
    const { url, status, mime, bytes, body, ...key } = f;
    const k = JSON.stringify(key);
    if (!seen.has(k) || (seen.get(k).bytes === 0 && bytes > 0)) seen.set(k, f);
  }
  return [...seen.values()];
}

/* HOW MANY TOWNS ARE BEHIND THIS FEED?
 *
 * The whole point of the exercise: Ag Partners' one site id carried thirteen.
 * A feed worth an adapter is a feed with towns behind it, and this is the
 * number that decides which adapter gets written next.
 *
 * It counts DISTINCT values of whichever location-ish key the payload uses,
 * and returns null rather than a guess when it cannot see one. NULL IS NOT
 * ZERO: "this feed lists no towns" and "this shape is not one I can count"
 * are different findings and the log must not merge them. */
export function countLocations(body) {
  if (!body) return null;
  let j; try { j = JSON.parse(body); } catch { return null; }
  const rows = Array.isArray(j) ? j : (j.data ?? j.bids ?? j.results ?? j.items ?? null);
  if (!Array.isArray(rows) || !rows.length) return null;
  for (const key of ["location", "site", "locationName", "deliveryLocation", "elevator"]) {
    const vals = rows.map((r) => r?.[key]).filter((v) => v != null);
    if (vals.length !== rows.length) continue;
    return new Set(vals.map((v) => (typeof v === "object" ? (v.id ?? v.name ?? JSON.stringify(v)) : v))).size;
  }
  return null;
}

const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const path = (u) => { try { return new URL(u).pathname + new URL(u).search; } catch { return ""; } };
const param = (u, k) => { try { return new URL(u).searchParams.get(k); } catch { return null; } };

/* Blank lines and `#` comments, so the candidate list can carry its own
   provenance next to each URL instead of in a separate file that drifts.
 *
 * A DECLARATION AND NOT A `const` ARROW. The runnable block below is top-level
 * code, it runs before a `const` further down the file is initialised, and the
 * only symptom was `Cannot access 'readList' before initialization` at the
 * moment somebody first passed --list. Declarations hoist; arrows do not. */
export function readList(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, "").trim())
             .filter((l) => l && !l.startsWith("#"));
}

/* ---- the runnable part ---------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const li = args.indexOf("--list");
  const all = li === -1
    ? args.filter((a) => !a.startsWith("--"))
    : readList(readFileSync(args[li + 1], "utf8"));

  /* IN SLICES, BECAUSE ONE RUN IS NOT ALL OF THEM. Fifty-six pages at up to
     45 seconds each is forty minutes of wall clock in the worst case, and a
     job that dies at minute fifty-nine reports nothing at all. `--start` and
     `--limit` make the batch resumable from the log rather than restartable
     from the beginning. */
  const num = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return dflt;
    const v = Number(args[i + 1]);
    if (!Number.isInteger(v) || v < 0) {
      console.error(`--${name} must be a non-negative whole number, got "${args[i + 1]}"`);
      process.exit(2);
    }
    return v;
  };
  const start = num("start", 0);
  const limit = num("limit", 0);
  const urls = all.slice(start, limit ? start + limit : undefined);
  if (all.length && start >= all.length) {
    // `slice: 60..59 of 56` was the first version of this message. A backwards
    // range is not a range, and printing one is printing a number that is not
    // true of anything.
    console.error(`--start ${start} is past the end of a list of ${all.length}`);
    process.exit(2);
  }
  if (urls.length && (start || limit))
    console.log(`slice: ${start}..${start + urls.length - 1} of ${all.length}`);

  if (!urls.length) {
    console.error("usage: discover.mjs <url>... | --list <file>");
    process.exit(2);
  }

  console.log(`asking ${urls.length} page(s), one at a time\n`);
  const tally = new Map();
  let withFeed = 0;

  for (const [i, pageUrl] of urls.entries()) {
    console.log(`── [${i + 1}/${urls.length}] ${pageUrl}`);
    const result = await captureAll({ pageUrl });
    const feeds = findFeeds(result);
    if (result.error) console.log(`   note: ${result.error}`);
    console.log(`   ${result.responses.length} response(s), ${feeds.length} feed(s)` +
                `${result.quiet ? "" : ", network never went quiet"}`);

    if (!feeds.length) {
      /* A page with no recognised feed is the interesting case, so it gets the
         evidence rather than a shrug: these hosts are the next signature. */
      const hosts = [...new Set(result.responses.map((r) => host(r.url)).filter(Boolean))];
      console.log(`   NO KNOWN PLATFORM. hosts seen: ${hosts.slice(0, 15).join(", ") || "none"}`);
    } else withFeed++;

    for (const f of feeds) {
      const { platform, adapter, url, status, mime, bytes, body, ...id } = f;
      const towns = countLocations(body);
      tally.set(platform, (tally.get(platform) ?? 0) + 1);
      console.log(`   ${platform}${adapter ? "" : "  (NO ADAPTER YET)"}`);
      console.log(`     ${status} ${mime} ${bytes}B  ${url}`);
      const facts = Object.entries(id).filter(([, v]) => v != null);
      if (facts.length) console.log(`     ${facts.map(([k, v]) => `${k}=${v}`).join("  ")}`);
      console.log(`     locations in payload: ${towns ?? "not countable from this shape"}`);
    }
    console.log("");
  }

  console.log("── tally");
  console.log(`pages asked: ${urls.length}; pages with a recognised feed: ${withFeed}`);
  /* NO SILENT CAPS. A slice that covered 20 of 56 must say so, or the tally
     reads as a complete survey of the list. */
  if (urls.length < all.length)
    console.log(`NOT ASKED: ${all.length - urls.length} of ${all.length} remain; resume with --start ${start + urls.length}`);
  for (const [p, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    const known = SIGNATURES.find((s) => s.platform === p)?.adapter;
    console.log(`  ${String(n).padStart(3)}  ${p}${known ? "" : "   <- no adapter; this is the queue"}`);
  }
}

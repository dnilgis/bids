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
  { platform: "dtn-cs", adapter: "lib/adapters/dtn-cs.mjs", family: /(^|\.)dtn\.com$/,
    test: (u) => /(^|\.)api\.dtn\.com$/.test(host(u)) && /\/markets\/sites\/[^/]+\/cash-bids/.test(path(u)),
    id: (u) => ({ siteId: path(u).match(/\/markets\/sites\/([^/]+)\/cash-bids/)?.[1] ?? null }) },

  { platform: "graindesk", adapter: "lib/adapters/graindesk.mjs", family: /graindiscovery\.com$/,
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
  { platform: "stonehedge", adapter: null, family: /stonex\.com$/,
    test: (u) => /stonehedge\.stonex\.com$/.test(host(u)) || /stonex/i.test(host(u)),
    id: (u) => ({ key: param(u, "key") ? "<present>" : null }) },

  { platform: "barchart", adapter: null, family: /barchart\.com$/,
    test: (u) => /barchart\.com$/.test(host(u)),
    id: () => ({}) },

  { platform: "bushel", adapter: null,
    /* bushelops.com TOO. The 2026-08-20 run watched Gateway FS call
       centre.bushelops.com and futures.bushelops.com and reported "no known
       platform", because this line listed only the two hostnames we had
       already seen. Three brands, one company. */
    test: (u) => /(bushelpowered|bushelsites|bushelops)\.com$/.test(host(u)),
    family: /(bushelpowered|bushelsites|bushelops)\.com$/,
    id: () => ({}) },

  { platform: "agricharts", adapter: null, family: /agricharts\.com$/,
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
    /* bytes IS NULL WHEN THERE IS NO BODY, and 0 only when the body was read
       and was empty. The 2026-08-20 run printed "0B" for StoneHedge, Barchart
       and Pearl City alike; three of those never handed a body over and one
       answered 403, and the log made them look like the same finding. This is
       the null-is-not-zero rule that countLocations already follows. */
    out.push({ ...f, url: r.url, status: r.status, mime: r.mime,
               bytes: r.body == null ? null : r.body.length,
               truncated: r.truncated === true, body: r.body ?? null });
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
    /* PREFER A COPY THAT ACTUALLY HAS A BODY. This compared `bytes === 0`
       until bytes learned to be null for "no body handed over", at which point
       `null === 0` is false and the empty copy won every time. Ask the
       question directly instead of through its old proxy. */
    const better = !seen.has(k) || (seen.get(k).body == null && body != null);
    if (better) seen.set(k, f);
  }
  return [...seen.values()];
}

/* WHAT DID THIS PAGE ACTUALLY TELL US?
 *
 * Three outcomes, and collapsing any two of them loses the batch's value:
 *
 *   feeds        we can name the platform; write or reuse an adapter
 *   no-platform  the page loaded and runs something we do not recognise --
 *                THIS IS THE QUEUE, and the hosts it did call are the lead
 *   unreachable  the page never loaded; this says nothing about the operator
 *                and belongs in a retry, not in a finding
 *
 * `no-platform` and `unreachable` both present as zero feeds, which is exactly
 * why this is a function with a test rather than an `if` in a print statement.
 */
export function verdict(result, feeds = findFeeds(result)) {
  if (feeds.length) return { kind: "feeds", feeds };
  if (result?.navError) return { kind: "unreachable", why: result.navError };
  if (result?.error) return { kind: "unreachable", why: result.error };
  const hosts = [...new Set((result?.responses ?? []).map((r) => hostOf(r.url)).filter(Boolean))];
  /* A NEAR MISS IS NOT A MISS. Five Star called api.dtn.com 204 times and this
     reported "no known platform", because no response matched the ONE DTN path
     we know. The host is the lead: it says which vendor they run and that our
     signature for that vendor is too narrow. Losing that to a shrug is how a
     readable board gets filed as unreadable. */
  /* The lead CARRIES ITS HOST, because not every host in a vendor's domain is
     a board: Topflight calls agwx.dtn.com, which is DTN's weather product and
     no use to us. Naming the host lets that be dismissed in a glance instead
     of costing a probe. */
  const leads = [];
  for (const sig of SIGNATURES) {
    if (!sig.family) continue;
    for (const h of hosts) if (sig.family.test(h)) leads.push({ platform: sig.platform, host: h });
  }
  return { kind: "no-platform", hosts, leads };
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

function hostOf(u) { return host(u); }
/* THE NAMES BEHIND THE FEED, not just how many.
 *
 * Ag-Land FS came back on 2026-08-20 as "dtn-cs, siteId e0030901, locations in
 * payload: 13" -- correct, and not enough to write a single source file,
 * because a source file needs the town. The bytes were already in hand; the
 * log just did not say. Thirteen towns are thirteen source files.
 *
 * Returns null, never [], when the shape is not one it can read: an empty
 * roster and an unreadable one are different findings. */
export function roster(body) {
  if (!body) return null;
  let j; try { j = JSON.parse(body); } catch { return null; }
  const rows = Array.isArray(j) ? j : (j.data ?? j.bids ?? j.results ?? j.items ?? null);
  if (!Array.isArray(rows) || !rows.length) return null;
  for (const key of ["location", "site", "locationName", "deliveryLocation", "elevator"]) {
    const vals = rows.map((r) => r?.[key]).filter((v) => v != null);
    if (vals.length !== rows.length) continue;
    const seen = new Map();
    for (const v of vals) {
      const id = typeof v === "object" ? (v.id ?? v.name ?? null) : v;
      const name = typeof v === "object" ? (v.name ?? String(v.id ?? "")) : String(v);
      if (!seen.has(String(id))) seen.set(String(id), { id, name });
    }
    return [...seen.values()];
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
  let withFeed = 0, unreachable = 0;

  for (const [i, pageUrl] of urls.entries()) {
    console.log(`── [${i + 1}/${urls.length}] ${pageUrl}`);
    const result = await captureAll({ pageUrl });
    const feeds = findFeeds(result);
    const v = verdict(result, feeds);
    console.log(`   ${result.responses.length} response(s), ${feeds.length} feed(s)` +
                `${result.quiet ? "" : ", network never went quiet"}`);

    if (v.kind === "unreachable") {
      unreachable++;
      console.log(`   THE PAGE DID NOT LOAD: ${v.why}`);
      console.log(`   -- a retry, NOT a finding about this operator`);
    } else if (v.kind === "no-platform") {
      /* The interesting case, so it gets the evidence rather than a shrug:
         these hosts are the next signature. */
      console.log(`   NO KNOWN PLATFORM. hosts seen: ${v.hosts.slice(0, 15).join(", ") || "none"}`);
      for (const l of v.leads)
        console.log(`   LEAD: ${l.host} is ${l.platform}'s domain -- the vendor is right, our signature is too narrow`);
    } else withFeed++;

    for (const f of feeds) {
      const { platform, adapter, url, status, mime, bytes, truncated, body, ...id } = f;
      const towns = countLocations(body);
      const names = roster(body);
      tally.set(platform, (tally.get(platform) ?? 0) + 1);
      console.log(`   ${platform}${adapter ? "" : "  (NO ADAPTER YET)"}`);
      const size = bytes == null ? "NO BODY HANDED OVER" : `${bytes}B${truncated ? " (TRUNCATED at the cap)" : ""}`;
      console.log(`     ${status} ${mime} ${size}  ${url}`);
      const facts = Object.entries(id).filter(([, v]) => v != null);
      if (facts.length) console.log(`     ${facts.map(([k, v]) => `${k}=${v}`).join("  ")}`);
      console.log(`     locations in payload: ${towns ?? "not countable from this shape"}`);
      if (names) for (const n of names) console.log(`       ${String(n.id).padStart(8)}  ${n.name}`);
    }
    console.log("");
  }

  console.log("── tally");
  console.log(`pages asked: ${urls.length}; with a recognised feed: ${withFeed}; ` +
              `unreachable (retry these): ${unreachable}; ` +
              `loaded but unrecognised (the queue): ${urls.length - withFeed - unreachable}`);
  /* NO SILENT CAPS. A slice that covered 20 of 56 must say so, or the tally
     reads as a complete survey of the list. */
  if (urls.length < all.length)
    console.log(`NOT ASKED: ${all.length - urls.length} of ${all.length} remain; resume with --start ${start + urls.length}`);
  for (const [p, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    const known = SIGNATURES.find((s) => s.platform === p)?.adapter;
    console.log(`  ${String(n).padStart(3)}  ${p}${known ? "" : "   <- no adapter; this is the queue"}`);
  }
}

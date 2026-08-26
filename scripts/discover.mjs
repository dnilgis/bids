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
  /* THE ENDPOINT IS PART OF THE IDENTITY HERE TOO, AND LEAVING IT OUT HID THE
   * BOARD — the same fault, in the same file, that the Bushel note below
   * describes, repeated on a different vendor.
   *
   * `key` is present on `stonehedge.stonex.com/component/bids` and absent on
   * every `api.stonehedge.stonex.com/...` call the app makes afterwards. So
   * every one of those collapsed to a single `{key: null}` entry in dedupe(),
   * and a page that asked for six things reported one.
   *
   * Measured 2026-08-23 on United Cooperative, Beaver Dam: 151 responses, and
   * the log showed exactly two distinct StoneX URLs. `component/bids` turned
   * out to be a REACT APP SHELL — 21,050 bytes with no table, no row and no
   * price in it — so the board is whatever that app fetches once it boots, and
   * that is precisely what was being deduped away. */
  { platform: "stonehedge", adapter: null, family: /stonex\.com$/,
    test: (u) => /stonehedge\.stonex\.com$/.test(host(u)) || /stonex/i.test(host(u)),
    id: (u) => ({ key: param(u, "key") ? "<present>" : null, endpoint: endpointOf(u) }) },

  { platform: "barchart", adapter: null, family: /barchart\.com$/,
    test: (u) => /barchart\.com$/.test(host(u)),
    /* Same reasoning: `id: () => ({})` made every Barchart response on a page
       one response. Their widgets are addressed by a `module` query parameter,
       so that is the fact worth keeping. */
    id: (u) => ({ module: param(u, "module"), endpoint: endpointOf(u) }) },

  /* THE ADAPTER HAS EXISTED SINCE 2026-08-21 AND THIS LINE STILL SAID null.
   *
   * lib/adapters/bushel.mjs is written, wired into lib/adapters/index.mjs,
   * carries a fixture, and reads it: 24 rows across Mitchell, Chamberlain,
   * Corsica and Wagner, every row with a futures price, so the identity guard
   * runs. sources/chsfarmersalliance-mitchell.json is built from it.
   *
   * Because this said null, the 2026-08-23 sweep filed FORTY-SEVEN Bushel feeds
   * under "no adapter; this is the queue" — the largest pile in the tally, and
   * the one thing on it that was already finished. A stale flag reads exactly
   * like unfinished work, and that is expensive: it is the difference between
   * "the biggest job left" and "wire the source files". */
  { platform: "bushel", adapter: "lib/adapters/bushel.mjs",
    /* bushelops.com TOO. The 2026-08-20 run watched Gateway FS call
       centre.bushelops.com and futures.bushelops.com and reported "no known
       platform", because this line listed only the two hostnames we had
       already seen. Three brands, one company. */
    test: (u) => /(bushelpowered|bushelsites|bushelops)\.com$/.test(host(u)),
    family: /(bushelpowered|bushelsites|bushelops)\.com$/,
    /* THE ENDPOINT IS PART OF THE IDENTITY, AND LEAVING IT OUT HID THE BOARD.
     *
     * `id: () => ({})` made every Bushel response on a page collapse to one in
     * dedupe(), which keys on the platform plus its identifying facts. On the
     * 2026-08-21 run all ten pages reported a single Bushel "feed": the
     * 899-byte GetMarketsConfig, carrying a CME logo and the sentence "Quotes
     * delayed a minimum of ten minutes". The board -- 81,051 bytes of it from
     * CHS Illinois -- was a sibling response that deduped away silently.
     *
     * Two generations are in use and both are real:
     *   api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList
     *   futures.bushelops.com/api/v1/cash-bids
     * Keying on the final path segment keeps them apart from each other and
     * from the config, so a page shows what it actually asked for. */
    id: (u) => { try { return { endpoint: new URL(u).pathname.split("/").filter(Boolean).pop() ?? null }; }
                 catch { return { endpoint: null }; } } },

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
/* A STYLESHEET IS NOT A BOARD.
 *
 * Keeping the endpoint in the identity stopped sibling calls deduping away and
 * immediately let one through that should never have counted:
 * `shared.websol.barchart.com/css/barchart-bootstrap.css` was reported as a
 * Barchart feed on 2026-08-23, with its own line and its own "locations in
 * payload". It matched because the signature claims the whole barchart.com
 * family, and before the endpoint went into the identity it had quietly
 * collapsed into the real one.
 *
 * Scripts are NOT excluded. Barchart's widget is served as text/javascript and
 * a JSONP body is a real board; dropping those would lose the thing we are
 * looking for. Only the things that cannot carry a price are refused. */
/* A FRAMEWORK'S OWN BUILD OUTPUT IS NOT A BOARD -- 2026-08-26.
 *
 * Measured on the first national sweep. One 60-page run reported "587 barchart"
 * in its tally and the queue looked like the biggest job in the repository. It
 * was not. Barchart's marketplace is a Next.js app, and the signature claims
 * the whole barchart.com family, so EVERY hashed chunk under /_next/static/
 * counted as a feed: turbopack-0gbhr29l6e26t.js, 0yt~xtmvnzeiu.js, and
 * hundreds more. The real surface was TEN responses to one endpoint,
 * connect.api.barchart.com/graphql.
 *
 * A tally that says 587 when the answer is 10 is worse than no tally: it is
 * the number a person uses to decide what to work on next.
 *
 * Scripts stay eligible in general and that is deliberate -- Barchart's own
 * widget is served as text/javascript and a JSONP body is a real board, so
 * excluding scripts wholesale would drop the thing we are hunting. What is
 * excluded here is narrower and cannot be anything else: a bundler's
 * content-hashed output and its manifests, which are emitted by the build and
 * never carry a price. */
export const isBuildArtefact = (url) =>
  /\/_next\/static\//.test(String(url)) ||
  /\/_(build|ssg|clientMiddleware)Manifest\.js(\?|$)/.test(String(url)) ||
  /\/turbopack-[a-z0-9]+\.js(\?|$)/i.test(String(url));

export const isAsset = (url, mime = "") =>
  /^(image|font|video|audio)\//.test(mime) || /text\/css/.test(mime) ||
  isBuildArtefact(url) ||
  /\.(css|woff2?|ttf|otf|png|jpe?g|svg|gif|ico|map)(\?|$)/i.test(String(url));

export function findFeeds(result) {
  const out = [];
  for (const r of result.responses ?? []) {
    const f = fingerprint(r.url);
    if (!f) continue;
    if (isAsset(r.url, r.mime)) continue;
    /* bytes IS NULL WHEN THERE IS NO BODY, and 0 only when the body was read
       and was empty. The 2026-08-20 run printed "0B" for StoneHedge, Barchart
       and Pearl City alike; three of those never handed a body over and one
       answered 403, and the log made them look like the same finding. This is
       the null-is-not-zero rule that countLocations already follows. */
    out.push({ ...f, url: r.url, status: r.status, mime: r.mime,
               bytes: r.body == null ? null : r.body.length,
               truncated: r.truncated === true, body: r.body ?? null,
               /* AND WHY THERE IS NO BODY, when there is none. Carried up from
                  cdp.mjs, which used to swallow the reason: on 2026-08-22 all
                  three StoneHedge pages reported no body and nothing said
                  whether the response was empty, evicted, or refused. Those
                  need different next moves and read identically in the log. */
               bodyError: r.bodyError ?? null, bodyNote: r.bodyNote ?? null,
               rescue: r.rescue ?? null });
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
    /* rescue, bodyError and bodyNote are DIAGNOSTICS, not identity.
     *
     * They were added to the feed record on 2026-08-23 and landed in `key` by
     * accident, because this destructure names what to EXCLUDE. The effect
     * showed up on CHS Illinois the same night: one GetBidsList and one
     * GetMarketsConfig each appeared TWICE in the tally, once as itself and
     * once as its own rescued copy, and a page that asked for two things
     * reported four. */
    const { url, status, mime, bytes, body, rescue, bodyError, bodyNote, ...key } = f;
    const k = JSON.stringify(key);

    /* PREFER THE COPY WITH THE MOST BODY, not merely the first one that has any.
     *
     * This asked "does the incumbent lack a body and the challenger have one",
     * which was right when the only choice was something or nothing. The rescue
     * made a third case: on CHS Illinois the rescued GetBidsList came back as a
     * 288-byte "Whitelabel Error Page" — a body, and the wrong one — while the
     * real board was 80,009 bytes. Whichever arrived first would have won.
     * A board is not smaller than its own error page. */
    const prev = seen.get(k);
    const size = (r) => (r?.body == null ? -1 : r.body.length);
    if (!prev || size(f) > size(prev)) seen.set(k, f);
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
/* A BYTE COUNT IS NOT EVIDENCE.
 *
 * The 2026-08-20 sweep found ten Bushel operators -- seven of them CHS regions,
 * the largest single win left -- and reported each one as
 * `200 application/json 899B  .../GetMarketsConfig`. Eight hundred and
 * ninety-nine bytes that we captured, held, and threw away. A config that small
 * is almost certainly naming the endpoint that carries the board, which is the
 * one thing we needed and the one thing the log did not say.
 *
 * So: when a feed's body taught us nothing structural -- no location count, no
 * roster -- and it is small enough to read, print it. Bounded hard, because the
 * point is to name the next request and not to paste a page into a log.
 */
/* Is this body worth printing?
 *
 * Only when it taught us NOTHING structural — no location count, no roster —
 * because those are the answer and the body is only ever a lead. And only when
 * it is small: a config that names the next request is hundreds of bytes, a
 * board is tens of thousands, and pasting a board into a log helps nobody.
 *
 * Extracted from the reporting block because a decision inside a `for` loop in
 * a runnable script is a decision no test can reach — it survived mutation
 * until it was pulled out here. */
/* SHOULD WE LIST WHAT ELSE THE PAGE ASKED FOR?
 *
 * `candidates` was only printed when NOTHING was recognised, and that hid it
 * exactly where it was needed. The ten Bushel pages each made 33 requests and
 * matched exactly one "feed" -- an 899-byte GetMarketsConfig carrying
 * disclaimer text and a CME logo. So the page counted as recognised, the
 * candidate list stayed silent, and the board sat unnamed among the other 32.
 *
 * Recognising the WRONG thing is worse than recognising nothing, because it
 * suppresses the evidence. The real question is not "did a signature match"
 * but "did we come away knowing where the board is" -- a roster or a location
 * count. Without one of those, show the page's other traffic whatever matched. */
/* WHAT SHAPE IS THIS, WITHOUT PASTING IT INTO THE LOG?
 *
 * The Bushel board from CHS Illinois is 81,051 bytes. Nobody can write an
 * adapter without seeing its structure, and nobody wants eighty kilobytes in a
 * run log. What an adapter author actually needs is small: is it an array or
 * an object, how many entries, what keys does an entry have, and what does one
 * value of each look like.
 *
 * Values are TRUNCATED HARD and only scalars are shown, so a board's prices
 * appear as evidence of a column's type and never as a redistributed quote. */
/* HAND BACK ONE REAL BODY, ON PURPOSE AND ON REQUEST.
 *
 * `shape` is enough to see a board's columns and NOT enough to write an
 * adapter against. Bushel's first visible row reads cash 4.52, basis -0.22,
 * futures 4.7525 -- and 4.7525 - 0.22 is 4.5325, which neither floors nor
 * rounds to 4.52. That is a unit conversion, a different contract on that row,
 * or a column read wrongly, and the difference decides what the adapter does.
 * Guessing which would be inventing a number.
 *
 * So: `--dump <substring>` prints the WHOLE body of a matching feed, once,
 * because somebody asked for it. Keys are redacted. Aim it at a small board --
 * CHS Farmers Alliance is nine kilobytes against CHS Illinois' eighty -- and
 * pair it with `--limit 1` so one page answers and the log stays readable. */
export function dumpable(feeds, want, maxBytes = 250000) {
  if (!want) return [];
  return (feeds ?? []).filter((f) =>
    f.body != null && f.body.length > 0 && f.body.length <= maxBytes &&
    `${f.url} ${f.endpoint ?? ""}`.toLowerCase().includes(String(want).toLowerCase()));
}

export function shape(body, { maxKeys = 40, sample = 28 } = {}) {
  let v;
  try { v = JSON.parse(String(body)); } catch { return null; }
  /* A BARE SCALAR IS NOT A SHAPE. `String(null)` is the valid JSON document
     `null`, which parses happily and used to be reported as `: null` -- a
     shape for a body that does not exist. Same for a response that is just a
     number or a quoted string. */
  if (v === null || typeof v !== "object") return null;

  const scalar = (x) => {
    if (x === null) return "null";
    if (typeof x === "string") return JSON.stringify(x.length > sample ? x.slice(0, sample) + "…" : x);
    if (typeof x === "object") return Array.isArray(x) ? `[${x.length}]` : `{${Object.keys(x).length}}`;
    return String(x);
  };
  const describe = (o, path, out) => {
    if (Array.isArray(o)) {
      out.push(`${path || "(root)"}: array of ${o.length}`);
      if (o.length) describe(o[0], `${path}[0]`, out);
      return;
    }
    if (o && typeof o === "object") {
      const keys = Object.keys(o);
      out.push(`${path || "(root)"}: object, ${keys.length} key(s)`);
      for (const k of keys.slice(0, maxKeys)) {
        const val = o[k];
        if (Array.isArray(val) && val.length && typeof val[0] === "object")
          describe(val[0], `${path}.${k}[0]`, out);
        else out.push(`  ${path ? path + "." : ""}${k} = ${scalar(val)}`);
      }
      if (keys.length > maxKeys) out.push(`  … and ${keys.length - maxKeys} more key(s)`);
      return;
    }
    out.push(`${path}: ${scalar(o)}`);
  };
  const out = [];
  describe(v, "", out);
  return out;
}

export function shouldListCandidates(feeds, towns, rosters) {
  if (!feeds || !feeds.length) return true;
  const learned = (towns ?? []).some((t) => t != null) ||
                  (rosters ?? []).some((r) => r && r.length);
  return !learned;
}

export function shouldPeek({ towns, names, bytes, maxBytes = 4000 }) {
  if (towns != null) return false;
  if (names && names.length) return false;
  if (bytes == null) return false;
  return bytes > 0 && bytes <= maxBytes;
}

export function peek(body, limit = 1400) {
  if (body == null) return null;
  const flat = String(body).replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const clean = redactBody(flat);
  return clean.length > limit ? `${clean.slice(0, limit)}… [+${clean.length - limit} more]` : clean;
}

/* Their key is public in their own page, and it still does not go in our log.
 * Same reasoning as redactUrl in cdp.mjs, applied to a body.
 *
 * IT LET ONE THROUGH, AND A PUBLIC ACTIONS LOG IS WHERE IT LANDED.
 *
 * Measured 2026-08-23. `--dump` printed United Cooperative's StoneHedge board,
 * and inside that body sat a PERCENT-ENCODED copy of the widget URL:
 *
 *     …%2Fcomponent%2Fbids%3Fkey%3D<their key>%26cols%3D…
 *
 * Two separate holes, and the first is the embarrassing one:
 *
 *   1. `key=` was not in the query-style list AT ALL. It listed api_key, token,
 *      secret and sig. The JSON form `"key": "…"` on the line above was
 *      covered, so the name was clearly meant to be there — it just was not.
 *   2. Nothing handled `%3D`. A URL embedded in a page as a parameter is
 *      encoded, and encoded is the form that actually turns up.
 *
 * redactUrl in cdp.mjs had been doing its job throughout: every URL printed in
 * the log says <redacted>. This was the same key arriving by another road. */
export function redactBody(text) {
  const NAMES = "api_?key|key|token|secret|sig|password|bearer";
  return String(text ?? "")
    .replace(new RegExp(`("(?:${NAMES})"\\s*:\\s*")[^"]*(")`, "gi"), "$1<redacted>$2")
    /* Plain `key=value`, to the next separator. */
    .replace(new RegExp(`\\b((?:${NAMES})=)[^&"'\\s<>]+`, "gi"), "$1<redacted>")
    /* And `key%3Dvalue`, which ends at %26 — the encoded ampersand.
     *
     * NO \b HERE, AND THAT IS THE WHOLE POINT. In `…%3Fkey%3D…` the character
     * before `key` is the `F` of `%3F`, which is a word character, so a word
     * boundary never fires and the first version of this fix still leaked.
     * The separator in an encoded URL IS the encoding, so the encodings are
     * named explicitly: %3F for ?, %26 for &, %3B for ;. */
    .replace(new RegExp(`(^|[^A-Za-z0-9_]|%3[Ff]|%26|%3[Bb])((?:${NAMES})%3[Dd])(?:(?!%26)[^&"'\\s<>])+`, "gi"),
             "$1$2<redacted>");
}

/* What did a page we could not classify actually serve?
 *
 * "NO KNOWN PLATFORM. hosts seen: …" names the neighbourhood and not the door.
 * Twenty-nine pages sit in that pile, and some of them are a shape we already
 * read under a URL we did not expect -- which is exactly what Ace Ethanol was
 * an hour before it became a source file. Ranked so the thing most likely to be
 * a board is first. */
export function candidates(result, limit = 8, always = null) {
  const score = (r) => {
    let n = 0;
    if (/json|xml|csv/i.test(r.mime ?? "")) n += 3;
    if (/text\/plain/i.test(r.mime ?? "")) n += 1;
    if (/\b(bid|bids|cash|grain|market|quote|price|cashgrid|component)\b/i.test(r.url ?? "")) n += 3;
    if ((r.bytes ?? (r.body ? r.body.length : 0)) > 400) n += 1;
    if (/\.(js|css|png|svg|woff2?)(\?|$)/i.test(r.url ?? "")) n -= 4;
    return n;
  };
  const ok = (result?.responses ?? [])
    .filter((r) => (r.status ?? 0) >= 200 && (r.status ?? 0) < 400)
    .map((r) => ({ ...r, _s: score(r) }))
    .sort((a, b) => b._s - a._s || (b.body?.length ?? 0) - (a.body?.length ?? 0));

  /* EVERYTHING THE MATCHED VENDOR SERVED, WHATEVER THE CAP SAYS.
   *
   * The cap keeps a page's hundred-and-fifty responses out of the log, and on
   * 2026-08-23 it kept the answer out too: United Cooperative made 151
   * requests, the top eight were printed, and `stonehedge.stonex.com/component/
   * bids` turned out to be a React shell with no prices in it. Whatever the app
   * fetched next was somewhere in the other 143.
   *
   * A vendor host does not serve a hundred things, so when a platform HAS been
   * matched, every response from its family is shown. That is bounded by the
   * vendor, and it is the one list worth reading in full. */
  const forced = always
    ? ok.filter((r) => { try { return always.test(new URL(r.url).hostname.toLowerCase()); }
                         catch { return false; } })
    : [];
  const rest = ok.filter((r) => r._s > 0 && !forced.includes(r)).slice(0, limit);
  return [...forced, ...rest];
}

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
/* The path, without the query, as an identity. Used by the signatures whose
   vendor serves several different things off one host: keeping the endpoint
   is what stops six sibling calls deduping into one. */
const endpointOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, "") || "/"; }
                            catch { return null; } };

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

/* A PAGE IS A URL, AND ANYTHING ELSE IS A TYPO.
 *
 * 2026-08-21: a stray "s" in the workflow's `urls` box silently overrode a
 * `list` selection of bushel-candidates. The run asked one page, called "s",
 * got "Cannot navigate to invalid URL", and reported it in the tally as one
 * UNREACHABLE page -- which reads exactly like an operator whose site was down
 * and is worth a retry. A typo must not be able to impersonate a finding.
 *
 * http and https only: a `file:` or `data:` argument is not a co-operative's
 * cash-bid page, and pointing a browser at the runner's own disk is not a
 * thing this tool should be able to be asked to do. */
/* The refusal, as lines, or null when the batch is fit to run.
 *
 * THIS IS THE THIRD TIME TONIGHT A DECISION HAS BEEN PULLED OUT OF A RUNNABLE
 * BLOCK because no test could reach it: the probe's not-a-town flag, the
 * discover body peek, and now this. The mutation harness runs `node --test`,
 * and `if (import.meta.url === ...)` is by definition not under test. Anything
 * that decides something belongs above this line, and the runnable block below
 * should only ever be plumbing. */
export function refuseRun(all) {
  const bad = badTargets(all);
  if (!bad.length) return null;
  return [
    ...bad.map((b) => `::error title=not a page::${JSON.stringify(b)} is not an http(s) url`),
    `${bad.length} of ${all.length} entr${all.length === 1 ? "y is" : "ies are"} not a page. ` +
    `Nothing was asked. If you meant to use a candidate list, LEAVE THE urls BOX EMPTY.`,
  ];
}

export function badTargets(urls) {
  return (urls ?? []).filter((u) => {
    try { return !/^https?:$/.test(new URL(u).protocol); }
    catch { return true; }
  });
}

/* ---- the runnable part ---------------------------------------------- */

/* A flag's value, or null. Declared before the runnable block uses it. */
let ARGS = [];
const flagValue = (name) => {
  const i = ARGS.indexOf(`--${name}`);
  return i === -1 ? null : (ARGS[i + 1] ?? null);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  ARGS = args;
  const li = args.indexOf("--list");
  const all = li === -1
    ? args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--dump"))
    : readList(readFileSync(args[li + 1], "utf8"));

  /* Refuse the whole run rather than ask for it. One bad entry among twenty is
     a typo in the box, not a co-operative worth probing, and a run that quietly
     drops it is a run whose tally cannot be trusted. */
  const refusal = refuseRun(all);
  if (refusal) { for (const line of refusal) console.error(line); process.exit(2); }

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

  /* STOP BEFORE THE JOB DOES, AND SAY WHERE TO RESUME.
   *
   * Twice on 2026-08-23 a sweep was killed by the workflow's 55-minute wall
   * mid-page: once at 24 of 44. Everything already read had been printed, so
   * nothing was lost — but the run ended with no tally, no platform counts and,
   * worst of all, no resume line, so the next run's --start had to be counted
   * by hand out of the log.
   *
   * A budget the script owns fixes that. It checks the clock BETWEEN pages,
   * never mid-page, so a page is never half-reported; and when it stops early
   * it prints exactly the same tally and resume line a full run would.
   *
   * Default 45 minutes against the workflow's 55, which leaves room for the
   * slowest single page to finish. --budget 0 turns it off. */
  const budgetMin = Number(flagValue("budget", "45"));
  const budgetMs = Number.isFinite(budgetMin) && budgetMin > 0 ? budgetMin * 60_000 : Infinity;
  const began = Date.now();

  console.log(`asking ${urls.length} page(s), one at a time` +
              (budgetMs === Infinity ? "" : `, stopping after ${budgetMin} minute(s)`) + `\n`);
  const tally = new Map();
  let withFeed = 0, unreachable = 0;
  let asked = 0, stoppedEarly = false;

  for (const [i, pageUrl] of urls.entries()) {
    if (Date.now() - began > budgetMs) {
      stoppedEarly = true;
      console.log(`\n── STOPPING: ${budgetMin} minute(s) spent, ${urls.length - i} page(s) of this ` +
                  `slice not asked. The tally below covers the ${i} that were.`);
      break;
    }
    asked++;
    console.log(`── [${i + 1}/${urls.length}] ${pageUrl}`);
    /* HOW LONG TO WAIT ON ONE PAGE, and why it is now a knob.
     *
     * ALCIVIA's board comes from a <script src> pointing at
     * alciviacoop.agricharts.com/inc/cashbids/cashbids.php. Four runs on
     * 2026-08-25 reported "MATCHED, BUT NO BOARD FOUND", and the last one --
     * with --dump able to see every response at any status -- proved the
     * request is NEVER MADE. Not refused: absent. And every one of those runs
     * also said "network never went quiet", meaning the page was still going
     * when the 45-second window shut on it.
     *
     * That is one page in a hundred and three kilobytes of Elementor markup
     * with sixty-five requests in flight, and the widget in question sits
     * near the end of the article. So the honest next question is not "which
     * URL" -- it is "was it ever going to get there".
     *
     * --patience <seconds> answers it. Default unchanged at 45. */
    const patienceS = Number(flagValue("patience", "45"));
    const result = await captureAll({
      pageUrl,
      timeoutMs: Math.max(5, patienceS) * 1000,
      /* A page that never goes quiet is exactly this case, so the settle
         window grows with the wait rather than staying at 2.5 seconds. */
      quietMs: patienceS > 45 ? 5000 : 2500,
    });
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
      const cands = candidates(result);
      if (cands.length) {
        console.log(`   WHAT IT DID SERVE, most board-like first:`);
        for (const c of cands)
          console.log(`     ${c.status} ${c.mime || "?"} ${c.bytes ?? c.body?.length ?? 0}B  ${c.url}`);
      }
    } else withFeed++;

    const towns_ = feeds.map((f) => countLocations(f.body));
    const rosters_ = feeds.map((f) => roster(f.body));
    if (v.kind !== "no-platform" && v.kind !== "dead" && shouldListCandidates(feeds, towns_, rosters_)) {
      /* Scoped to the families actually matched on this page, so "show me
         everything" cannot become "show me the analytics too". */
      const fams = SIGNATURES.filter((sg) => feeds.some((f) => f.platform === sg.platform) && sg.family)
                             .map((sg) => sg.family.source);
      const always = fams.length ? new RegExp(fams.join("|")) : null;
      const cands = candidates(result, 8, always);
      if (cands.length) {
        console.log(`   MATCHED, BUT NO BOARD FOUND. What else it asked for, most board-like first:`);
        for (const c of cands)
          console.log(`     ${c.status} ${c.mime || "?"} ${c.bytes ?? c.body?.length ?? 0}B  ${c.url}`);
      }
    }

    /* DUMP LOOKS AT EVERYTHING THE PAGE SERVED, not only at what we scored as
       a feed. ALCIVIA and Landmark run agricharts and ask for no JSON at all:
       their board is inside 103KB of server-rendered HTML at the page's own
       address, so the only response worth dumping was in `cands` and --dump
       could not reach it. The flag exists to say "show me the bytes", and
       "which list did we file them under" is our bookkeeping, not the user's.
       Measured 2026-08-25: three runs of discover on those two pages, every
       one reporting "MATCHED, BUT NO BOARD FOUND" and no way to see why. */
    /* EVERY RESPONSE, WHATEVER ITS STATUS AND WHEREVER IT RANKED.
     *
     * candidates() drops anything outside 200-399 and then keeps a top slice,
     * which is right for a summary and wrong for --dump. ALCIVIA's board comes
     * from a <script src> at alciviacoop.agricharts.com/inc/cashbids/
     * cashbids.php, and agricharts answers a request it does not like with a
     * 403 -- so if that is what happened on their own page, the one response
     * that explains everything was being filtered out before dump could see
     * it. Three runs on 2026-08-25 came back "MATCHED, BUT NO BOARD FOUND"
     * with no way to tell whether the request was never made or was made and
     * refused. Those are completely different problems and the log could not
     * tell them apart.
     *
     * A status is information. It is not a reason to withhold the body. */
    const everything = [...(feeds ?? []), ...(result?.responses ?? [])];
    for (const d of dumpable(everything, flagValue("dump"))) {
      console.log(`   (status ${d.status ?? "?"}, ${d.mime || "no mime"})`);
      console.log(`   FULL BODY of ${d.url} (${d.body.length} bytes), because --dump asked:`);
      console.log(redactBody(d.body));
      console.log(`   end of body`);
    }

    /* A PAGE THAT RAN OUT OF CLOCK SAYS SO, LOUDLY. Otherwise it reads as a
       page with fewer feeds on it than it really has, which is the one wrong
       conclusion this tool must never invite. */
    if (result?.bodyWall) console.log(`   RAN OUT OF CLOCK: ${result.bodyWall}`);

    for (const f of feeds) {
      const { platform, adapter, url, status, mime, bytes, truncated, body,
              bodyError, bodyNote, rescue, ...id } = f;
      const towns = countLocations(body);
      const names = roster(body);
      tally.set(platform, (tally.get(platform) ?? 0) + 1);
      console.log(`   ${platform}${adapter ? "" : "  (NO ADAPTER YET)"}`);
      const size = bytes == null ? "NO BODY HANDED OVER" : `${bytes}B${truncated ? " (TRUNCATED at the cap)" : ""}`;
      console.log(`     ${status} ${mime} ${size}  ${url}`);
      /* SAY WHICH REFUSAL IT WAS. "No body" covers an empty response, an
         evicted one and a browser that would not surrender it, and those need
         different next moves. Printed on its own line because it is the thing
         a person reads the log for when a feed is found and cannot be read. */
      if (bodyError && !rescue) console.log(`     WHY NO BODY: ${bodyError}`);
      /* A body obtained the second way is a different provenance and says so. */
      if (rescue) console.log(`     RESCUED: ${rescue}`);
      if (bodyNote) console.log(`     NOTE: ${bodyNote}`);
      const facts = Object.entries(id).filter(([, v]) => v != null);
      if (facts.length) console.log(`     ${facts.map(([k, v]) => `${k}=${v}`).join("  ")}`);
      console.log(`     locations in payload: ${towns ?? "not countable from this shape"}`);
      if (names) for (const n of names) console.log(`       ${String(n.id).padStart(8)}  ${n.name}`);
      /* Nothing structural came out of it and it is small enough to read: show
         it. This is the line that turns a Bushel config from 899 bytes we threw
         away into the name of the request that carries the board. */
      if (shouldPeek({ towns, names, bytes })) {
        const p = peek(body);
        if (p) console.log(`     BODY: ${p}`);
      } else if (towns == null && !names && bytes != null && bytes > 0) {
        /* Too big to print and it told us nothing structural — describe it
           instead. This is what an adapter gets written from. */
        const sh = shape(body);
        if (sh) { console.log(`     SHAPE (${bytes}B):`); for (const l of sh.slice(0, 40)) console.log(`       ${l}`); }
      }
    }
    console.log("");
  }

  console.log("── tally");
  /* `asked`, NOT `urls.length`. The moment a run could stop on its own budget
     those stopped being the same number, and the first smoke test of it printed
     "pages asked: 4" for a run that asked one — which would have made every
     early-stopping sweep overstate its own coverage, and made "the queue"
     (asked minus feeds minus unreachable) a count of pages nobody had loaded. */
  console.log(`pages asked: ${asked}; with a recognised feed: ${withFeed}; ` +
              `unreachable (retry these): ${unreachable}; ` +
              `loaded but unrecognised (the queue): ${asked - withFeed - unreachable}`);
  /* NO SILENT CAPS. A slice that covered 20 of 56 must say so, or the tally
     reads as a complete survey of the list. */
  /* The resume point is where we ACTUALLY got to, not where the slice ended.
     Those were the same thing until a run could stop early, and printing the
     slice end after stopping short would skip every page in between. */
  const reached = start + asked;
  if (reached < all.length)
    console.log(`NOT ASKED: ${all.length - reached} of ${all.length} remain; resume with --start ${reached}` +
                (stoppedEarly ? "   (this run stopped on its own budget, not at the end of its slice)" : ""));
  for (const [p, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    const known = SIGNATURES.find((s) => s.platform === p)?.adapter;
    console.log(`  ${String(n).padStart(3)}  ${p}${known ? "" : "   <- no adapter; this is the queue"}`);
  }
}

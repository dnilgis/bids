#!/usr/bin/env node
/* WHAT A PAGE ACTUALLY SHOWS A VISITOR, SAVED WHERE IT CAN BE READ LATER.
 *
 * 2026-10-01. The assistant that writes this repository's code works from a
 * sandbox that reaches GitHub and nothing else, and GitHub keeps run logs on a
 * host that sandbox may not open. So every question of the form "what does
 * this board look like now?" has been a person copying a log by hand. This
 * asks the question on the runner and commits the answer to the `captures`
 * branch, where it can be read from git like any other file.
 *
 * It loads each page the way discover.mjs does (lib/cdp.mjs captureAll, the
 * same browser, the same identity, the same blocked images) and keeps:
 *
 *   dom.html         the rendered document, after the page's own scripts ran
 *   responses.json   every response the page received; the body of each one
 *                    that looks like data (the same looksLikeData discover
 *                    uses), redacted the same way
 *   meta.json        url, when, whether it loaded, why not
 *
 * IT WRITES NOTHING ON main. No manifest, no ledger, no data/. A capture is
 * evidence for a person or a parser to read, never a claim about anybody's
 * business. Keys in URLs are redacted by captureAll before they reach here,
 * and bodies go through the same redactBody discover applies.
 *
 *   node scripts/capture-pages.mjs --out captures/2026-10-01 https://a/ https://b/
 *   node scripts/capture-pages.mjs --out DIR --list probe-lists/some.txt
 *
 * FOLLOW MODE (2026-10-18, for the unread elevators' own sites):
 *
 *   node scripts/capture-pages.mjs --out DIR --list probe-lists/elevsites.txt --follow 3 --shard 2/8
 *
 * For each listed page, robots.txt is read once per site and obeyed for every
 * path; a disallowed page is recorded as skipped and never requested. Each page
 * is asked once, with a pause between two pages of one host. After a listed
 * page loads, up to N of its links that look like bids or markets
 * (lib/elevsites.mjs pickLinks) are captured the same way. Every page gets a
 * digest.json (title, readable text, links, script and frame sources, the hosts
 * it talked to); dom.html and responses.json are kept only for a page whose text
 * reads like a posted board, so a run over hundreds of sites stays small. No
 * bot check is answered or worked around: a page that shows one is saved as it
 * came. --shard i/n keeps the listed pages whose host falls in shard i.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureAll, findBrowser } from "../lib/cdp.mjs";
import { redactBody } from "./discover.mjs";
import { UA } from "../lib/cdp.mjs";
import { digestOf, pickLinks, pathAllowed, shardOf, hostOf } from "../lib/elevsites.mjs";

export function slugFor(url) {
  return String(url).toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 90) || "page";
}

export function parseArgs(argv) {
  const out = { urls: [], list: null, dir: null, maxBody: 3000000, timeoutMs: 45000, follow: 0, shard: null, pauseMs: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.dir = argv[++i];
    else if (a === "--list") out.list = argv[++i];
    else if (a === "--max-body") out.maxBody = Number(argv[++i]);
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === "--follow") out.follow = Math.max(0, Math.min(5, Number(argv[++i]) || 0));
    else if (a === "--pause") out.pauseMs = Number(argv[++i]) * 1000;
    else if (a === "--shard") {
      const m = String(argv[++i]).match(/^(\d+)\/(\d+)$/);
      if (!m || Number(m[1]) >= Number(m[2])) throw new Error("--shard wants i/n with i < n, e.g. 0/8");
      out.shard = [Number(m[1]), Number(m[2])];
    }
    else if (/^https?:\/\//i.test(a)) out.urls.push(a);
    else if (a.trim()) throw new Error(`not a page and not a flag: ${a}`);
  }
  return out;
}

export function urlsFromList(text) {
  return String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => /^https?:\/\//i.test(l));
}

/* robots.txt, once per origin. A robots file that cannot be fetched or is not
   served (404, 5xx, timeout) allows everything, as RFC 9309 says for 4xx; for
   5xx it says to assume disallowed, so 5xx is treated as "skip this site". */
export async function robotsFor(origin, cache, fetchImpl = fetch) {
  if (cache.has(origin)) return cache.get(origin);
  let r = { text: "", status: 0, unreachable: false };
  try {
    const res = await fetchImpl(origin + "/robots.txt", { headers: { "user-agent": UA }, redirect: "follow",
                                                           signal: AbortSignal.timeout(15000) });
    r = { text: res.ok ? (await res.text()).slice(0, 200000) : "", status: res.status, unreachable: res.status >= 500 };
  } catch (e) { r = { text: "", status: 0, unreachable: false, error: String(e?.message ?? e).slice(0, 200) }; }
  cache.set(origin, r);
  return r;
}

export function allowedBy(robots, url) {
  if (robots.unreachable) return false;
  const u = new URL(url);
  return pathAllowed(robots.text, u.pathname + u.search);
}

async function followMain(o, urls) {
  const browser = findBrowser();
  mkdirSync(o.dir, { recursive: true });
  const robotsCache = new Map(), lastAt = new Map(), done = new Set(), index = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const one = async (pageUrl, parent) => {
    if (done.has(pageUrl)) return null;
    done.add(pageUrl);
    const slug = slugFor(pageUrl);
    const origin = new URL(pageUrl).origin;
    const robots = await robotsFor(origin, robotsCache);
    const entry = { slug, pageUrl, parent, capturedAt: new Date().toISOString(), robots: robots.status };
    if (!allowedBy(robots, pageUrl)) {
      index.push({ ...entry, skipped: robots.unreachable ? "robots.txt answered 5xx" : "robots.txt disallows this path" });
      console.log(`robots  ${pageUrl}`);
      return null;
    }
    const h = hostOf(pageUrl), wait = (lastAt.get(h) ?? 0) + o.pauseMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(h, Date.now());
    const r = await captureAll({ pageUrl, browser, timeoutMs: o.timeoutMs, snapshotDom: true, maxBodyBytes: o.maxBody });
    lastAt.set(h, Date.now());
    const responses = (r.responses ?? []).map((x) => ({ url: x.url, status: x.status, mime: x.mime,
      bytes: x.body == null ? null : x.body.length, body: x.body == null ? null : redactBody(x.body) }));
    const dom = r.dom ? redactBody(r.dom) : "";
    const d = join(o.dir, slug);
    mkdirSync(d, { recursive: true });
    const digest = { ...digestOf({ pageUrl, html: dom, responses }), parent,
      navError: r.navError ?? null, error: r.error ?? null, domBytes: dom.length };
    writeFileSync(join(d, "digest.json"), JSON.stringify(digest, null, 1) + "\n");
    if (digest.looksLikeBoard) {
      writeFileSync(join(d, "dom.html"), dom.slice(0, 2_000_000));
      writeFileSync(join(d, "responses.json"), JSON.stringify(responses.filter((x) => x.body).slice(0, 40), null, 1) + "\n");
    }
    index.push({ ...entry, navError: digest.navError, error: digest.error, domBytes: dom.length,
                 looksLikeBoard: digest.looksLikeBoard, kept: digest.looksLikeBoard });
    console.log(`${digest.error || digest.navError ? "FAILED " : "ok     "} ${pageUrl}  dom ${dom.length}b${digest.looksLikeBoard ? "  BOARD" : ""}`);
    return dom;
  };
  for (const u of urls) {
    const dom = await one(u, null);
    if (dom && o.follow) for (const l of pickLinks(dom, u, o.follow)) await one(l.url, u);
    writeFileSync(join(o.dir, "index.json"), JSON.stringify(index, null, 1) + "\n");
  }
  writeFileSync(join(o.dir, "index.json"), JSON.stringify(index, null, 1) + "\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.dir) throw new Error("--out DIR is required");
  if (o.list) o.urls.push(...urlsFromList(readFileSync(o.list, "utf8")));
  let urls = [...new Set(o.urls)];
  if (o.shard) urls = urls.filter((u) => shardOf(u, o.shard[1]) === o.shard[0]);
  if (!urls.length && !o.shard) throw new Error("no pages to capture: give URLs or --list FILE");
  if (o.follow || o.shard) return followMain(o, urls);
  const browser = findBrowser();
  mkdirSync(o.dir, { recursive: true });
  const index = [];
  for (const pageUrl of urls) {
    const slug = slugFor(pageUrl);
    const d = join(o.dir, slug);
    mkdirSync(d, { recursive: true });
    const r = await captureAll({ pageUrl, browser, timeoutMs: o.timeoutMs, snapshotDom: true, maxBodyBytes: o.maxBody });
    const responses = (r.responses ?? []).map((x) => ({
      url: x.url, status: x.status, mime: x.mime,
      bytes: x.body == null ? null : x.body.length,
      ...(x.truncated ? { truncated: true } : {}),
      ...(x.rescue ? { rescue: x.rescue } : {}),
      body: x.body == null ? null : redactBody(x.body),
    }));
    if (r.dom) writeFileSync(join(d, "dom.html"), redactBody(r.dom));
    writeFileSync(join(d, "responses.json"), JSON.stringify(responses, null, 1) + "\n");
    const meta = { pageUrl, capturedAt: new Date().toISOString(), navError: r.navError ?? null,
                   error: r.error ?? null, domError: r.domError ?? null, quiet: r.quiet ?? null,
                   responses: responses.length, withBody: responses.filter((x) => x.body).length,
                   domBytes: r.dom ? r.dom.length : 0 };
    writeFileSync(join(d, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
    index.push({ slug, ...meta });
    console.log(`${meta.error || meta.navError ? "FAILED " : "ok     "} ${pageUrl}  dom ${meta.domBytes}b, ` +
                `${meta.responses} responses, ${meta.withBody} with a body${meta.error ? "  " + meta.error : ""}`);
  }
  writeFileSync(join(o.dir, "index.json"), JSON.stringify(index, null, 1) + "\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()))
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });

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
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureAll, findBrowser } from "../lib/cdp.mjs";
import { redactBody } from "./discover.mjs";

export function slugFor(url) {
  return String(url).toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 90) || "page";
}

export function parseArgs(argv) {
  const out = { urls: [], list: null, dir: null, maxBody: 3000000, timeoutMs: 45000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.dir = argv[++i];
    else if (a === "--list") out.list = argv[++i];
    else if (a === "--max-body") out.maxBody = Number(argv[++i]);
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else if (/^https?:\/\//i.test(a)) out.urls.push(a);
    else if (a.trim()) throw new Error(`not a page and not a flag: ${a}`);
  }
  return out;
}

export function urlsFromList(text) {
  return String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => /^https?:\/\//i.test(l));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.dir) throw new Error("--out DIR is required");
  if (o.list) o.urls.push(...urlsFromList(readFileSync(o.list, "utf8")));
  const urls = [...new Set(o.urls)];
  if (!urls.length) throw new Error("no pages to capture: give URLs or --list FILE");
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

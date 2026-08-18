#!/usr/bin/env node
/**
 * Read Big River's Boyceville board and write it to data/boyceville.json.
 *
 * Run by .github/workflows/poll.yml on a schedule. The workflow commits the
 * file only when it changes, so the git history of this repo IS the record of
 * every number their board has shown. That is the same doctrine the Emmert
 * sites use for their own prices, and it is why this lives in a repo rather
 * than a database: you can open the file, and you can read the history.
 *
 *   node scripts/fetch.mjs                    read the live page
 *   node scripts/fetch.mjs --fixture <file>   read a saved copy instead
 *   node scripts/fetch.mjs --dry-run          print, write nothing
 *
 * EXITS NON-ZERO ON A BAD READ, ON PURPOSE. A failed run is a red X and an
 * email, and data/boyceville.json is left exactly as it was. Nothing here ever
 * overwrites a good price with a bad one: the worst case is that the file goes
 * stale, and every consumer checks its `checkedAt` timestamp for exactly that.
 *
 * THIS FILE IS NOW ONLY THE I/O. Every decision — what counts as a valid
 * board, what counts as a change, which pricedAt to carry — lives in ../lib,
 * shared byte for byte with the Cloudflare Worker in ../worker. Before that
 * split there were two implementations that had already drifted apart in what
 * they emitted. See lib/board.mjs.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFile, Refused, serialise } from "../lib/board.mjs";
import { decide, commitMessage } from "../lib/decide.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "boyceville.json");
/* The workflow commits with `git commit -F` from this file, so a heartbeat and
   a price change read differently in `git log`. Gitignored. */
const MSG = join(ROOT, ".commit-message");

const CONFIG = {
  // Their page. The -2121 is Boyceville's id and the page still carries every
  // other location, which is what locationId is for.
  urls: [
    "https://bigriverbids.com/cashbidssingle-2121",
    "https://www.bigriverbids.com/cashbidssingle-2121",
  ],
  // Say who we are. Big River agreed to this being read, and a request that
  // identifies itself can be allowed deliberately rather than mistaken for
  // something hostile.
  userAgent: "agsist-bidreader/1.0 (+https://agsist.com; posted bid, by arrangement)",
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fixture = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : null;

const die = (msg) => { console.error(`FAILED: ${msg}`); process.exit(1); };

async function getPage() {
  if (fixture) return { html: readFileSync(fixture, "utf8"), url: `file://${fixture}` };
  const problems = [];
  for (const url of CONFIG.urls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": CONFIG.userAgent, Accept: "text/html" },
        redirect: "follow",
      });
      if (!res.ok) { problems.push(`${url} -> HTTP ${res.status}`); continue; }
      const html = await res.text();
      if (html.length < 500) { problems.push(`${url} -> ${html.length} bytes, too short`); continue; }
      return { html, url };
    } catch (e) {
      problems.push(`${url} -> ${e.message}`);
    }
  }
  die(`could not read their page.\n  ${problems.join("\n  ")}`);
}

const { html, url } = await getPage();

const now = new Date().toISOString();
let built;
try {
  built = buildFile(html, { now, sourceUrl: CONFIG.urls[0] });
} catch (e) {
  // Refused carries a message written for whoever reads the failed run. Any
  // other throw is a bug in the parser and should look like one.
  die(e instanceof Refused ? e.message : `the parser threw: ${e.message}`);
}
const { file: feed, dropped } = built;

if (dryRun) {
  console.log(serialise(feed));
  console.log(`(dry run: ${feed.count} rows, ${dropped} other-location rows dropped)`);
  process.exit(0);
}

let previous = null;
try { previous = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* first run */ }

const verdict = decide(previous, feed);

if (!verdict.write) {
  console.log(`${verdict.reason} (${feed.count} rows, priced ${verdict.file.pricedAt})`);
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, serialise(verdict.file));
writeFileSync(MSG, commitMessage(verdict) + "\n");
console.log(`${verdict.reason}: wrote ${feed.count} rows (priced ${verdict.file.pricedAt}), ` +
            `${dropped} other-location rows dropped`);
for (const b of verdict.file.bids) console.log(`  ${b.delivery.padEnd(10)} ${b.cash}  ${b.basisDollars}`);

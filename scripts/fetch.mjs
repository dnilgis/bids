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
 *   node scripts/fetch.mjs                    read the live page and write
 *   node scripts/fetch.mjs --dry-run          read the live page, print only
 *   node scripts/fetch.mjs --fixture <file>   read a saved copy, print only
 *
 * --fixture NEVER WRITES. It used to, and that was the worst bug in this repo.
 * It only swapped the HTML source, so the obvious thing to type while checking
 * the parser against a saved page -- `node scripts/fetch.mjs --fixture
 * fixtures/bigriver-2121.html` -- committed the fixture's prices to
 * data/boyceville.json stamped `checkedAt: <now>`. That is a fabricated price
 * carrying a fabricated freshness claim, in the exact field both Emmert sites
 * use to decide whether to keep publishing. The header here listed --fixture
 * next to --dry-run as though both were read-only, which is presumably why
 * nobody looked.
 *
 * EXITS NON-ZERO ON A BAD READ, ON PURPOSE. A failed run is a red X and an
 * email, and data/boyceville.json is left exactly as it was. Nothing here ever
 * overwrites a good price with a bad one: the worst case is that the file goes
 * stale, and every consumer checks its `checkedAt` timestamp for exactly that.
 *
 * THIS FILE IS ONLY THE I/O. Every decision — what counts as a valid board,
 * what counts as a change, which pricedAt to carry — lives in ../lib, pure and
 * testable without a network or a clock. That split exists because there were
 * once two readers with two implementations that had already drifted apart in
 * what they emitted. See lib/board.mjs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFile, checkMove, Refused, serialise, MAX_MOVE } from "../lib/board.mjs";
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

const die = (msg) => { console.error(`FAILED: ${msg}`); process.exit(1); };

let fixture = null;
if (args.includes("--fixture")) {
  fixture = args[args.indexOf("--fixture") + 1] ?? null;
  /* `--fixture` with no filename used to fall through to null and read their
     LIVE page -- the opposite of what was asked for, silently. */
  if (!fixture || fixture.startsWith("--"))
    die("--fixture needs a filename. Refusing to fall back to their live page.");
}

/* Reading a fixture can never write. See the header. */
const dryRun = args.includes("--dry-run") || fixture !== null;

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

const { html } = await getPage();
const now = new Date().toISOString();
let built;
try {
  built = buildFile(html, { now, sourceUrl: CONFIG.urls[0] });
} catch (e) {
  /* Refused carries a message written for whoever reads the failed run. Any
     other throw is a bug in the parser and should look like one.

     There was briefly a retry here, for boards caught mid-update. It was the
     right idea against the wrong cause: their front-month futures cell lags
     by a tick for far longer than a retry can wait, and lib/board.mjs now
     accepts that case and marks the row rather than refusing the board. What
     reaches this catch is a real refusal. */
  die(e instanceof Refused ? e.message : `the parser threw: ${e.message}`);
}

const { file: feed, dropped, verified } = built;

if (dryRun) {
  console.log(serialise(feed));
  console.log(`(dry run${fixture ? `, from ${fixture}` : ""}: ${feed.count} rows, ` +
              `${verified} identity-verified, ${dropped} other-location rows dropped. ` +
              `Nothing was written.)`);
  process.exit(0);
}

/* "The file is not there" and "the file is there and I cannot read it" are
   different facts. Collapsing them into `previous = null` makes a truncated or
   half-written file look like a first run, which resets pricedAt to now and
   republishes a three-day-old price as newly priced -- silently. */
let previous = null;
if (existsSync(OUT)) {
  try {
    previous = JSON.parse(readFileSync(OUT, "utf8"));
  } catch (e) {
    console.warn(`WARNING: ${OUT} exists but will not parse (${e.message}). ` +
                 `Treating it as absent, which means pricedAt restarts from this read.`);
  }
}

/* THE MAX-MOVE RAIL. Runs here rather than inside buildFile because it needs
   the last committed read, and buildFile is pure by design. A refusal writes
   nothing and exits non-zero, which is the same safe direction as every other
   guard: the committed price is held, not replaced. */
const moves = checkMove(previous, feed);
if (moves.length) {
  const w = moves[0];
  die(`${moves.length} row(s) moved more than $${MAX_MOVE.toFixed(2)} since the last read. ` +
      `e.g. ${w.delivery}: ${w.from} -> ${w.to} (${w.move > 0 ? "+" : ""}${w.move.toFixed(4)}). ` +
      `Their board may be quoting a bad futures price. Cash minus basis can still ` +
      `balance perfectly on a wrong number, so the identity check will not catch this. ` +
      `Look at their page before doing anything. If the move is real, commit the new ` +
      `data/boyceville.json by hand to re-baseline.`);
}

const verdict = decide(previous, feed);

if (!verdict.write) {
  console.log(`${verdict.reason} (${feed.count} rows, priced ${verdict.file.pricedAt})`);
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, serialise(verdict.file));
writeFileSync(MSG, commitMessage(verdict) + "\n");
console.log(`${verdict.reason}: wrote ${feed.count} rows ` +
            `(${verified} identity-verified, priced ${verdict.file.pricedAt}), ` +
            `${dropped} other-location rows dropped`);
for (const b of verdict.file.bids) console.log(`  ${b.delivery.padEnd(10)} ${b.cash}  ${b.basisDollars}`);

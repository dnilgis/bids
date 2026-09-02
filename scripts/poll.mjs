#!/usr/bin/env node
/**
 * THE MULTI-SOURCE READER.
 *
 * Supersedes scripts/fetch.mjs, which reads Boyceville and only Boyceville.
 * BOTH WRITE data/boyceville.json, so only ONE of them may ever be scheduled.
 * Switch the workflow to this and delete the other; do not run both.
 *
 * WHAT THIS ADDS OVER fetch.mjs, AND WHY EACH ONE MATTERS AT SCALE
 *
 * 1. SOURCES ARE DATA. sources/*.json, one row per location. Adding an
 *    elevator is a JSON file. Adding a PLATFORM is an adapter. Neither is a
 *    change to the guards, which is what keeps three hundred sources honest.
 *
 * 2. FAILURE IS ISOLATED. fetch.mjs dies on the first refusal. That was
 *    correct with one source and is catastrophic with two: on 2026-08-19 a
 *    parser bug on Boyceville would have taken every other elevator down with
 *    it. Each source gets its own try/catch and its own verdict. The run fails
 *    only if EVERY source refused -- which means the problem is ours, not
 *    theirs.
 *
 * 3. ONE FETCH PER PAGE. Flash Grain's Thorp and Granton are two sources on
 *    one page, and Big River publishes seven locations on one template. Reads
 *    are deduped by URL so a page is fetched once however many sources sit on
 *    it.
 *
 * 4. ONE COMMIT PER CYCLE. Three hundred sources committed individually is
 *    three hundred commits a cycle and a history that cannot be read as a
 *    price record.
 *
 * 5. data/index.json. Every source with its state and both clocks, so the
 *    Emmert Worker and the AGSIST merge can discover what exists instead of
 *    hardcoding a list.
 *
 * Usage:
 *   node scripts/poll.mjs                     read every enabled source
 *   node scripts/poll.mjs --only <id>         one source
 *   node scripts/poll.mjs --fixture <id>=<f>  read a source from a file
 *   node scripts/poll.mjs --dry-run           write nothing
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFile, Refused, serialise, isRefusal } from "../lib/board.mjs";
import { decide, movedSources } from "../lib/decide.mjs";
import { loadSources, toConfig, urlsFor, wireOf, transportOf } from "../lib/sources.mjs";
import { capture } from "../lib/cdp.mjs";
import { Breaker, Skipped, isSkip } from "../lib/breaker.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const MSG = join(ROOT, ".commit-message");
const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] ?? null; };
const only = flag("--only");
/* A FIXTURE CAN NEVER WRITE.
   fetch.mjs carried this guard with a comment on it and poll.mjs shipped
   without it. Running `poll.mjs --fixture <f>` wrote data/boyceville.json --
   the file both Emmert sites read -- from test prices. Test data must never be
   one forgotten flag away from the live file. */
let dryRun = args.includes("--dry-run");

const fixtures = new Map();
for (let i = 0; i < args.length; i++)
  if (args[i] === "--fixture") {
    const v = args[i + 1] ?? "";
    const eq = v.indexOf("=");
    if (eq < 1) { console.error("FAILED: --fixture wants <sourceId>=<path>"); process.exit(1); }
    fixtures.set(v.slice(0, eq), v.slice(eq + 1));
  }
if (fixtures.size) {
  dryRun = true;
  console.log(`reading ${fixtures.size} source(s) from fixtures -- writing nothing`);
}

/* ---------- manifest ---------- */
const rows = readdirSync(join(ROOT, "sources"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")));

const { sources: enabled, errors, warnings } = loadSources(rows);
for (const e of errors) console.error(`::error title=Bad source::${e}`);
/* Things worth saying that must not cost an elevator its reading -- a source
   with no coordinates is read and published and simply cannot be placed on the
   map. These used to be on the same list as the fatal ones, which meant a
   deliberate `lat: null` silently dropped the source at load. */
for (const w of warnings ?? []) console.error(`::warning title=Source note::${w}`);
/* A malformed source is dropped, not half-loaded -- but it must not pass
   quietly, or a typo silently removes an elevator from the site. */
if (errors.length && !enabled.length) { console.error("FAILED: no usable sources"); process.exit(1); }

/* WHICH SECRETS THIS RUN NEEDS, SAID ONCE AND UP FRONT.
 *
 * A source that needs a key and cannot find it refuses with a precise message,
 * which is right -- but thirteen sources on one site id produce thirteen copies
 * of it, and the first thing anybody does with thirteen identical refusals is
 * look at the elevator instead of at the repository settings. So the answer is
 * also given once, before any fetch, naming the variable and the remedy. */
const needed = [...new Set(enabled.map((s) => s.apiKeyEnv).filter(Boolean))];
for (const name of needed) {
  if (process.env[name]) continue;
  const who = enabled.filter((s) => s.apiKeyEnv === name).map((s) => s.id);
  console.error(`::error title=${name} is not set::${who.length} source(s) need it and will ` +
    `refuse: ${who.join(", ")}. Add ${name} as a repository secret AND pass it into the ` +
    `poll step's env: in .github/workflows/poll.yml. It must never be written into a ` +
    `manifest or a URL.`);
}

const todo = only ? enabled.filter((s) => s.id === only) : enabled;
if (!todo.length) { console.error(`FAILED: no enabled source matches ${only ?? "(any)"}`); process.exit(1); }

/* ══════════════════════════════════════════════════════════════════════════
 *  A DEAD PLATFORM MUST NOT EAT THE PASS, AND THE PASS MUST ALWAYS FINISH
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-02, run 33580292481. Every Bushel-hosted page began returning
 * "The page did make 0 request(s)" — the site loads nothing at all, so each one
 * burns its full 45-second browser timeout. There are 150 Bushel sources behind
 * 25 distinct pages:
 *
 *     25 pages x 45s = 18.8 MINUTES, inside a pass budgeted at `timeout 8m`
 *
 * The pass could not finish. The log shows it exactly: pass one started
 * 01:40:20Z and the retry started 01:48:20Z — killed at the eight-minute mark
 * having reached nine Bushel pages out of twenty-five. Then it retried, and was
 * killed again. Every source alphabetically after "chsfarmersalliance" went
 * unread for hours, including every board that was working perfectly.
 *
 * ONE PLATFORM'S OUTAGE TOOK DOWN THE WHOLE READER. That is the fault to fix,
 * not Bushel — Bushel will come back on its own and something else will break
 * on another Tuesday.
 *
 * TWO GUARDS, AND THEY DO DIFFERENT JOBS.
 *
 * The BREAKER is about not repeating a known answer. After three consecutive
 * page loads on one platform come back empty, the rest of that platform is
 * skipped for this pass. Three, not one: a single failure is a bad minute, and
 * a platform that is genuinely up deserves better than being written off by one
 * flaky load.
 *
 * The BUDGET is the backstop underneath it, and it is what makes the promise.
 * Whatever fails and however it fails, reading STOPS with time left to write and
 * commit — because a pass that gets killed publishes nothing at all, and a pass
 * that reads two hundred sources and commits them is worth more than a pass that
 * reads three hundred and fifty and dies.
 *
 * NOTHING IS INVENTED FOR A SKIPPED SOURCE. It keeps its previous file, its
 * checkedAt stops advancing, and every consumer's age threshold withdraws it on
 * schedule — the same behaviour a refusal already has. The skip is loud here,
 * in the annotations, and in the index. */
const PASS_BUDGET_MS = Number(process.env.PASS_BUDGET_MS ?? 6 * 60 * 1000);
const BREAKER_STRIKES = Number(process.env.BREAKER_STRIKES ?? 3);
const passStarted = Date.now();
const breaker = new Breaker({ strikes: BREAKER_STRIKES });

/* WHO READ CLEANLY LAST TIME, SO A TRIP DOES NOT STARVE THEM FOREVER.
   See Breaker.allows(). Read from the index we are about to overwrite; absent
   on a first run, in which case nobody is reprieved, which is the conservative
   answer. Its own parse failure must not stop a pass -- this is an optimisation
   over the skip list, not a dependency. */
const prevOk = new Set();
try {
  const pi = JSON.parse(readFileSync(join(DATA, "index.json"), "utf8"));
  for (const p of pi.sources ?? []) if (p.health === "live" || p.status === "ok") prevOk.add(p.id);
} catch { /* first run, or an unreadable index: nobody is reprieved */ }

const budgetLeftMs = () => PASS_BUDGET_MS - (Date.now() - passStarted);

/* ---------- one fetch per page ---------- */
const pages = new Map();
async function getPage(s) {
  if (fixtures.has(s.id))
    return { html: readFileSync(fixtures.get(s.id), "utf8"), url: `file://${fixtures.get(s.id)}` };
  /* Both urls in the key. Thirteen Ag Partners sources share one API url AND
     one page, so they share one browser load; a fourteenth on the same API url
     but a different page must not silently reuse it. */
  const key = `${s.browserPage ?? ""}|${s.url}`;
  if (pages.has(key)) return pages.get(key);
  const p = (async () => {
    const problems = [];
    const wire = wireOf(s.platform);

    /* A BROWSER SOURCE IS LOADED, NOT FETCHED. See lib/cdp.mjs for why. */
    if (transportOf(s.platform) === "browser") {
      if (!breaker.allows(s.platform, prevOk.has(s.id))) {
        const who = breaker.culprits(s.platform);
        throw new Skipped(`not attempted: ${BREAKER_STRIKES} page loads in a row returned nothing `
          + `on ${s.platform}${who.length ? ` (${who.join(", ")})` : ""}, so the rest of that `
          + `platform was left for the next pass. Its last good file is untouched and still `
          + `published while it is inside the withdrawal window. Nothing about this source is `
          + `known to be wrong.`);
      }
      let got;
      try {
        got = await capture({ pageUrl: s.browserPage, target: s.url });
      } catch (e) {
        if (breaker.fail(s.platform, e.message, s.operator || s.id.split("-")[0])) {
          /* NAME WHO FAILED, NOT WHERE THEY ARE HOSTED. The first version of
             this said "bushel is not answering" in a pass where 193 Bushel
             sources had just been read successfully and all 23 failures were
             CHS. Anyone acting on that message goes and looks at Bushel. */
          const who = breaker.culprits(s.platform);
          console.error(`::error title=${who.join(", ") || s.platform} is not answering`
            + `::${BREAKER_STRIKES} page loads in a row returned nothing, all of them `
            + `${who.join(", ")} on ${s.platform}. The rest of ${s.platform} is left for the next `
            + `pass, except sources that read cleanly last time — those are still attempted, so a `
            + `single operator's outage cannot starve the platform. Each empty load costs 45 `
            + `seconds and the pass has ${Math.round(budgetLeftMs() / 1000)}s left.`);
        }
        throw e;
      }
      breaker.ok(s.platform);   // a page that loaded resets the count
      if (!got.body.length) throw new Error(`${got.url} answered ${got.status} with an empty body`);
      /* got.url has already had any key in it redacted, which matters: it is
         what gets stamped into the committed file and printed on failure. */
      return { html: got.body, url: got.url };
    }
    const headers = {
      "User-Agent": UA,
      Accept: wire === "json" ? "application/json" : "text/html",
    };

    /* A KEY IS A HEADER, NEVER A QUERY PARAMETER, AND NEVER A FILE.
     *
     * DTN Content Services accepts `apikey` either way. A header is the one to
     * use: a query parameter ends up in the log line, in the error message
     * poll.mjs prints when a fetch fails, in any redirect, and in
     * `problems.join()` below -- and this is a public repository whose Actions
     * logs anybody can read.
     *
     * A missing secret REFUSES rather than fetching without it. Fetching
     * without it would come back 401, be reported as "their page is down", and
     * send somebody looking at the elevator's website instead of at the repo
     * settings. Saying which variable is unset ends that in one line. */
    if (s.apiKeyEnv) {
      const key = process.env[s.apiKeyEnv];
      if (!key)
        throw new Error(`needs ${s.apiKeyEnv} and it is not set. Add it as a repository ` +
                        `secret and pass it into this step's env. It must never be written ` +
                        `into a manifest or a URL.`);
      headers.apikey = key;
    }

    for (const url of urlsFor(s)) {
      try {
        const res = await fetch(url, { headers, redirect: "follow" });
        if (!res.ok) { problems.push(`${url} -> HTTP ${res.status}`); continue; }
        const html = await res.text();
        /* THE 500-BYTE FLOOR IS AN HTML ASSUMPTION. It exists to catch a shell
           page served in place of a board. A JSON feed for a one-location
           elevator can legitimately be three hundred bytes, and it would have
           been thrown away with a message about their page having changed. The
           JSON adapters each say something precise about an empty or malformed
           body, so on those the body goes straight to them. */
        if (wire !== "json" && html.length < 500) {
          problems.push(`${url} -> ${html.length} bytes, too short`); continue;
        }
        if (!html.length) { problems.push(`${url} -> empty response`); continue; }
        return { html, url };
      } catch (e) { problems.push(`${url} -> ${e.message}`); }
    }
    throw new Error(`could not read their page. ${problems.join("; ")}`);
  })();
  pages.set(key, p);
  return p;
}

/* ---------- read each source ---------- */
const now = new Date().toISOString();
const results = [];

let skippedForTime = 0;
for (const s of todo) {
  const out = join(DATA, `${s.id}.json`);
  /* THE BUDGET IS CHECKED BEFORE EACH SOURCE, NOT AFTER. Checking afterwards
     lets one 45-second load start with two seconds left and take the pass over
     the wall anyway. */
  if (budgetLeftMs() <= 0) {
    skippedForTime++;
    continue;
  }
  /* A FILE THAT WILL NOT PARSE MUST NOT KILL THE RUN.
     This JSON.parse sat OUTSIDE the per-source try, so one corrupt
     data/<id>.json threw before any catch and took every other source with it
     -- destroying the isolation this whole restructure exists for. A corrupt
     previous file is now that source's problem alone, and it is loud: treating
     it as absent silently would let decide() call it a first run and stamp
     pricedAt as now, overstating how fresh the price is. */
  let prev = null, prevUnreadable = null;
  if (existsSync(out)) {
    try { prev = JSON.parse(readFileSync(out, "utf8")); }
    catch (e) { prevUnreadable = e.message.slice(0, 160); }
  }
  /* `health` and NOT `state`. The manifest's `state` is the US state ("WI");
     reusing the key for read-health silently dropped it and left status.mjs
     reading a field that means one thing on a manifest row and another on a
     result row. Two meanings, one key, is how a wrong value gets rendered
     confidently. */
  const r = { id: s.id, operator: s.operator, location: s.location,
              usState: s.state ?? null,
              /* A DIRECT SOURCE WITHOUT COORDINATES IS INVISIBLE.
                 cash-bids.html sorts by distance from the user. A row with no
                 lat/lon cannot be placed, cannot be sorted, and never reaches
                 the page -- it would sit in the merged file looking published
                 while no farmer could ever see it. */
              zip: s.zip ?? null, lat: s.lat ?? null, lon: s.lon ?? null,
              phone: s.phone ?? null, email: s.email ?? null, website: s.website ?? null,
              /* Whether this source belongs on the AGSIST map. Boyceville is
                 read for the Emmert sites, which consume data/boyceville.json
                 directly, but Barchart already carries it more fully -- so it
                 is read and NOT merged. Two different jobs, one reader. */
              inMerge: s.inMerge !== false,
              platform: s.platform, url: s.url, provenance: s.provenance ?? "scraped",
              pricedAt: prev?.pricedAt ?? null, checkedAt: prev?.checkedAt ?? null,
              rows: prev?.count ?? 0, wrote: false };
  if (prevUnreadable) {
    r.note = `previous file unreadable (${prevUnreadable}); pricedAt will be restamped`;
    console.error(`::warning title=${s.id} unreadable previous file::${prevUnreadable}`);
  }
  try {
    const { html, url } = await getPage(s);
    const built = buildFile(html, { now, sourceUrl: url, source: toConfig(s), extract: adapterFor(s.platform) });
    /* A withheld commodity is something the elevator IS buying that we are not
       publishing. It must never be a silent omission -- it goes in the index,
       onto the status board, and into the Actions annotations. */
    if (built.withheld?.length) {
      r.withheld = built.withheld;
      for (const w of built.withheld)
        console.error(`::warning title=${s.id} withheld ${w.commodity}::${w.rows} row(s): ${w.why}`);
    }
    const verdict = decide(prev, built.file);
    r.health = "live";
    r.status = "ok";
    r.pricedAt = verdict.file.pricedAt;
    r.checkedAt = verdict.file.checkedAt;
    r.rows = verdict.file.count;
    /* WHAT THIS ELEVATOR IS ACTUALLY BUYING. The whole point of the reader, so
       it belongs on the board rather than only inside the file. */
    r.commodities = [...new Set(verdict.file.bids.map((b) => b.commodity))];
    r.verified = built.verified;
    /* A BOARD QUIETLY LOSING A ROW MUST NOT LOOK LIKE ONE THAT NEVER HAD IT.
       dtn-cs refuses an unreconcilable row rather than the whole co-operative
       as of 2026-08-20 — one bad Oats line used to cost ten towns of corn.
       That trade is only right while the refusal stays loud. */
    if (built.unreconciled?.length) {
      r.unreconciled = built.unreconciled;
      console.log(`  ${s.id}: ${built.unreconciled.length} row(s) REFUSED and published nowhere`);
      for (const u of built.unreconciled.slice(0, 5))
        console.log(`    ${u.location} ${u.commodity} ${u.delivery}: ${u.why}`);
    }
    r.reason = verdict.reason;
    /* A move, as opposed to a heartbeat. The Emmert sites are told about the
       first and not the second — see movedSources() in lib/decide.mjs. */
    r.changed = verdict.changed;
    if (verdict.write && !dryRun) {
      mkdirSync(DATA, { recursive: true });
      writeFileSync(out, serialise(verdict.file));
      r.wrote = true;
    }
    console.log(`  ok      ${s.id.padEnd(24)} ${String(verdict.file.count).padStart(2)} rows  ${verdict.reason}`);
  } catch (e) {
    /* HOLD, THEN WITHDRAW. A refused source keeps its last good file exactly
       as it is -- we do not overwrite a good price with silence -- and its
       checkedAt therefore stops advancing, which is what makes the consumer's
       age threshold withdraw it on schedule. The refusal is loud here and in
       the Actions annotation; it is not loud in the data. */
    /* An adapter's own refusal is a refusal, not a crash: it means we read a
       page and it was not the board we wanted, which is exactly what Refused
       means. Only an unexpected throw is "broken". */
    /* THREE OUTCOMES, NOT TWO. `skipped` means we never tried -- it is not a
       claim about the source and must never be counted as one. Conflating it
       with `broken` printed 153 failures on a board that had 23. */
    r.health = isSkip(e) ? "skipped" : isRefusal(e) ? "refused" : "broken";
    r.status = r.health;
    /* THE INDEX GETS A SUMMARY; THE LOG GETS THE WHOLE THING.
       index.json is read by the dashboard and wants a line, so it keeps the
       300-character cut. The console does not: on 2026-08-19 the 300th
       character landed in the middle of the diagnostic sample -- the refusal
       printed `body starts: "x,decimal_plac` and stopped, so the one piece of
       evidence the message existed to carry was the piece that got cut. Print
       the full message first, then the summary. */
    const full = e.message.replace(/\s+/g, " ").trim();
    r.error = full.slice(0, 300);
    console.error(`  ${r.health.padEnd(7)} ${s.id.padEnd(24)} ${full}`);
    console.error(`::warning title=${s.id} ${r.health}::${full.slice(0, 900)}`);
  }
  results.push(r);
}

/* WHAT THE PASS DID NOT REACH, SAID OUT LOUD.
   A pass that quietly reads two hundred of three hundred and fifty looks exactly
   like a pass that read them all, and the difference is somebody's price. */
for (const platform of breaker.down) {
  const who = breaker.culprits(platform);
  const n = results.filter((r) => r.health === "skipped" && r.platform === platform).length;
  console.error(`\n${platform} tripped after ${BREAKER_STRIKES} empty page loads in a row, all `
    + `of them ${who.join(", ") || "unattributed"}. ${n} source(s) on ${platform} were not `
    + `attempted this pass. They keep their last good file, are still published while inside `
    + `the withdrawal window, and are counted as "skipped" — NOT as broken, which is a claim `
    + `about a source we did not touch.`);
}
if (skippedForTime) {
  console.error(`::error title=pass budget spent::${skippedForTime} source(s) were not reached `
    + `within ${Math.round(PASS_BUDGET_MS / 1000)}s. Everything read before the wall IS written and `
    + `committed — which is the point: a pass killed by the outer timeout publishes nothing at all. `
    + `The next pass starts from the top, so a persistent overrun starves the end of the alphabet: `
    + `if this line keeps appearing, something is timing out that should not be.`);
}

/* ---------- index ---------- */
const ok = results.filter((r) => r.health === "live");
const index = {
  generated: now,
  counts: {
    total: results.length,
    live: ok.length,
    refused: results.filter((r) => r.health === "refused").length,
    broken: results.filter((r) => r.health === "broken").length,
    skipped: results.filter((r) => r.health === "skipped").length,
  },
  sources: results.map(({ wrote, ...keep }) => keep),
};
if (!dryRun) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, "index.json"), JSON.stringify(index, null, 1) + "\n");
}

/* WHO MOVED, FOR THE STEP THAT TELLS THE SITES.
   Written every run, empty when nothing moved, so the workflow step can read
   one file rather than parse a log. Not written on a dry run, for the same
   reason nothing else is. */
const moved = movedSources(results);
if (!dryRun) writeFileSync(join(ROOT, ".changed-sources"), moved.join("\n") + (moved.length ? "\n" : ""));

const wrote = results.filter((r) => r.wrote);
const summary = `${ok.length} ok, ${index.counts.refused} refused, ${index.counts.broken} broken`;
if (!dryRun)
  writeFileSync(MSG, wrote.length
    ? `bids: ${wrote.map((r) => r.id).join(", ")} (${summary})\n`
    : `bids: heartbeat (${summary})\n`);

console.log(`\n${summary}${wrote.length ? ` | wrote ${wrote.length}` : " | no change"}` +
            `${moved.length ? ` | moved: ${moved.join(", ")}` : ""}`);

/* Fail only when EVERY source refused. One elevator redesigning their page
   must never stop the other ninety-nine. */
if (ok.length === 0) { console.error("FAILED: every source refused"); process.exit(1); }

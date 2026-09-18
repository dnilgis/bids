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
import { createHash } from "node:crypto";
import { buildFile, Refused, serialise, isRefusal } from "../lib/board.mjs";
import { decide, movedSources } from "../lib/decide.mjs";
import { loadSources, toConfig, urlsFor, wireOf, transportOf } from "../lib/sources.mjs";
import { fetchWithin, deadlineFrom, shareOf, SOURCE_FETCH_MS_DEFAULT,
         BROWSER_FLOOR_MS } from "../lib/deadline.mjs";
import { capture } from "../lib/cdp.mjs";
import { Breaker, Skipped, isSkip, nextStreak } from "../lib/breaker.mjs";
import { adapterFor, SHARED_PAGES } from "../lib/adapters/index.mjs";

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

/* WHAT ONE SOURCE'S URL LIST MAY COST. The reasoning, the measurement and
   Node's own unbounded default are in lib/deadline.mjs; it lives there so it
   can be tested without running a pass, the same argument lib/breaker.mjs
   makes for itself. */
const SOURCE_FETCH_MS = Number(process.env.SOURCE_FETCH_MS ?? SOURCE_FETCH_MS_DEFAULT);
const passStarted = Date.now();
const breaker = new Breaker({ strikes: BREAKER_STRIKES });

/* READ ORDER IS A POLICY, AND IT IS THE ONLY THING THAT STOPS ONE OPERATOR
 * STARVING A PLATFORM.
 *
 * THE VERSION THIS REPLACES ASKED "DID IT READ CLEANLY LAST PASS", AND WAS
 * MEASURED INERT ON THE RUN IT WAS BUILT FOR. Run 91012844641: the breaker
 * tripped on CHS and `coopelev`, seven `michag` and eleven `riceland` sources
 * were skipped again, every one. The previous pass had been run by older code
 * that stamped a skipped source `broken`, so nothing was `live` and nothing
 * qualified -- and a skipped source is not `live` either, so nothing would ever
 * qualify again. The test poisoned its own input.
 *
 * The real reason one operator could starve a platform was never the reprieve.
 * It was that sources are read in id order, which is alphabetical, so `chs*`
 * spent the strikes and the trip fell on everything sorting after it. Fix the
 * order and the problem mostly stops existing.
 *
 * Three keys, in order:
 *
 *   1. the OPERATOR's failure streak, ascending
 *      Whoever has been failing longest is read LAST, where spending the budget
 *      on them costs nobody a read. An operator with nothing against it is read
 *      before the breaker can trip. Per operator and not per source, because a
 *      page is per operator: it is the operator that is up or down.
 *   2. how long since we last ATTEMPTED that operator, ascending
 *      So a tie is broken towards whoever has waited longest, and the pass
 *      rotates instead of favouring the same names.
 *   3. a hash of the id
 *      Not the id itself. Alphabetical order is exactly what correlates with
 *      the fault here -- seventeen of twenty-five Bushel operators are named
 *      `chs*` -- so an alphabetical tiebreak puts the outage at the front of
 *      every pass forever. A hash is stable, reproducible and uncorrelated.
 *
 * MEASURED against the real manifest and the real outage, at 45s per empty page
 * load and a 6-minute budget:
 *
 *      CHS down, five operators healthy   all eight healthy sources read by
 *                                         PASS 3, settling at 94s a pass
 *      the whole platform down            never recovers, correctly, and decays
 *                                         from 360s to ~90s a pass instead of
 *                                         throwing the budget at a dead host
 *      the platform healthy               25 loads, 50s, all 150 read -- no
 *                                         change from today
 *
 * Its own parse failure must not stop a pass: with no file every streak is zero
 * and the order is the hash, which is still uncorrelated with the fault. */
const prevFails = new Map(), prevSeen = new Map(), prevRow = new Map();
try {
  const pi = JSON.parse(readFileSync(join(DATA, "index.json"), "utf8"));
  for (const p of pi.sources ?? []) {
    if (Number.isFinite(p.fails)) prevFails.set(p.id, p.fails);
    const t = Date.parse(p.attemptedAt ?? "");
    if (Number.isFinite(t)) prevSeen.set(p.id, t);
    /* THE WHOLE ROW, NOT JUST THE TWO COUNTERS. A source the pass runs out of
       time for used to vanish from the manifest, and merge_bids drops any board
       file with no manifest row. See the carry-forward at the index write. */
    if (p.id) prevRow.set(p.id, p);
  }
} catch { /* first run, or an unreadable index: every streak is zero */ }

const operatorOf = (s) => s.operator || String(s.id).split("-")[0];

/* THE PENALTY IS PER PAGE, AND THE PAGE IS WHAT getPage() ALREADY CACHES ON.
 *
 * This was per OPERATOR and took the worst case, defended like this:
 *
 *     WORST CASE PER OPERATOR, not average: one source of theirs failing means
 *     their page is not answering, and every other source behind that page is
 *     about to cost 45 seconds proving it.
 *
 * Every word of that is about a PAGE. It was written when an operator was a
 * page, and on 2026-09-15 that stopped being true: 113 ADM sources came in as
 * one operator with 113 SEPARATE gradable market urls.
 *
 * MEASURED 2026-09-17 over all 1,094 enabled sources — 316 distinct page keys
 * across 185 operators:
 *
 *     Heartland 54 sources / 1 page      Riceland 11 / 1
 *     CoMark    48 / 1                   Central United 16 / 1
 *     ...every operator with 5+ sources has exactly ONE page, except
 *     ADM  113 sources / 113 pages       POET Grain  19 / 19
 *
 * So keying on the page changes NOTHING for the 183 operators the old comment
 * was protecting -- their page key and their operator are the same set -- and
 * fixes the two where one source's streak was condemning every sibling.
 *
 * WHAT IT COST, before this line: `adm-enolane` carried a streak of 37 and set
 * the penalty for all 87 ADM rows in the index, while 80 of those 87 had a
 * streak of ZERO. 172 of 185 operators sorted ahead. ADM was never attempted,
 * an unattempted source keeps its streak (lib/breaker.mjs), so it sorted last
 * forever: 87 of 88 carried, 62 aged past the 14-hour withdrawal at a median
 * of 31 hours, and merge dropped all 62 with "price is 30.6h old".
 *
 * Still the WORST CASE within a page, because that argument is untouched: the
 * sources behind one page stand or fall together. */
const pageKeyOf = (s) => `${s.browserPage ?? ""}|${s.url}`;
const opFails = new Map(), opSeen = new Map();
/* Real timestamps only. A page with no row has never been attempted, which is
   new, not starved -- and it already sorts near the front on key 3. */
const lastSeen = new Map();
for (const s of todo) {
  const k = pageKeyOf(s);
  opFails.set(k, Math.max(opFails.get(k) ?? 0, prevFails.get(s.id) ?? 0));
  opSeen.set(k, Math.max(opSeen.get(k) ?? 0, prevSeen.get(s.id) ?? 0));
  const t = prevSeen.get(s.id);
  if (t !== undefined) lastSeen.set(k, Math.max(lastSeen.get(k) ?? 0, t));
}

/* ---------- THE WAY BACK ----------
 *
 * THE THREE KEYS ABOVE HAVE NO EXIT. A page with ANY failure streak sorts
 * behind every clean page; the 360s wall arrives before it is reached; and an
 * unattempted source keeps its streak (lib/breaker.mjs). So it is never tried
 * again, and the streak that condemned it can never be cleared. One bad minute
 * is a life sentence.
 *
 * The page-key fix stopped one bad source condemning its SIBLINGS. It did not
 * give the condemned page itself a way back, and the comment above says so
 * without noticing: "an unattempted source keeps its streak, so it sorted last
 * forever".
 *
 * MEASURED on main, 2026-09-18, against data/index.json and the 1,094 enabled
 * sources:
 *
 *     143 sources had not been ATTEMPTED in ten hours
 *     of those, on a page with a streak of zero:  0
 *     on a page with a streak of one or two:     61   -- waiting 21 hours
 *     on a page with a streak of three or more:  82
 *
 * Not one starving source was on a clean page. This is not the budget being
 * short; it is the order having no way back. 107 enabled sources were past the
 * 14-hour withdrawal and publishing nothing, including three ADM boards whose
 * slug fix shipped the day before and has never been tried.
 *
 * So the longest-waiting pages are read FIRST, ahead of the streak, a few per
 * pass.
 *
 * TEN HOURS: the withdrawal is 14, and a page promoted at 10 has four hours of
 * passes to succeed in before its boards leave the feed. The poll commits
 * between two and seven times an hour, measured over the last three days, so
 * four hours is between eight and twenty-eight more chances.
 *
 * FOUR PAGES: a browser read is clamped at 45s, so four of them is 180s -- half
 * the budget, and the most the pass can spend on suspects without the healthy
 * majority losing more than half of its own time. The backlog at ten hours is
 * 50 pages (13 of them browser pages), so it drains in about thirteen passes.
 * In the ordinary case a recovered page answers in about 1.9s, the measured
 * serial browser read, and four of them cost eight seconds.
 *
 * SELF-CLEARING, and this is what makes it safe: a reprieved page is ATTEMPTED,
 * so its attemptedAt moves and it is no longer starving next pass -- whether it
 * succeeded or not. The reprieve cannot latch on to one dead host, because the
 * dead host stops being the longest-waiting as soon as it is tried. */
const STARVING_MS = 10 * 3600_000;
const REPRIEVE_PAGES = 4;
const reprieveAt = Date.now();
const reprieved = new Set(
  [...lastSeen.entries()]
    .filter(([, t]) => reprieveAt - t > STARVING_MS)
    .sort((a, b) => a[1] - b[1])
    .slice(0, REPRIEVE_PAGES)
    .map(([k]) => k));
if (reprieved.size)
  console.log(`  reprieve: ${reprieved.size} page(s) unattempted for over ${STARVING_MS / 3600_000}h are read first this pass`);

const spread = (id) => parseInt(createHash("sha1").update(id).digest("hex").slice(0, 8), 16);
todo.sort((a, b) => {
  const ka = pageKeyOf(a), kb = pageKeyOf(b);
  return ((reprieved.has(kb) ? 1 : 0) - (reprieved.has(ka) ? 1 : 0))
      || (opFails.get(ka) - opFails.get(kb))
      || (opSeen.get(ka) - opSeen.get(kb))
      || (spread(a.id) - spread(b.id));
});

const budgetLeftMs = () => PASS_BUDGET_MS - (Date.now() - passStarted);

/** What one source's whole url list is allowed to cost, never past the wall. */
const fetchDeadline = () => deadlineFrom(Date.now(), budgetLeftMs(), SOURCE_FETCH_MS);

/* ---------- one fetch per page ---------- */
const pages = new Map();
async function getPage(s) {
  if (fixtures.has(s.id))
    return { html: readFileSync(fixtures.get(s.id), "utf8"), url: `file://${fixtures.get(s.id)}` };
  /* Both urls in the key. Thirteen Ag Partners sources share one API url AND
     one page, so they share one browser load; a fourteenth on the same API url
     but a different page must not silently reuse it. */
  const key = pageKeyOf(s);   /* ONE definition, shared with the read order above */
  if (pages.has(key)) return pages.get(key);
  const p = (async () => {
    const problems = [];
    const wire = wireOf(s.platform);

    /* A BROWSER SOURCE IS LOADED, NOT FETCHED. See lib/cdp.mjs for why. */
    if (transportOf(s.platform) === "browser") {
      if (!breaker.allows(s.platform, operatorOf(s), opFails.get(operatorOf(s)) ?? 0)) {
        const who = breaker.culprits(s.platform);
        throw new Skipped(`not attempted: ${BREAKER_STRIKES} page loads in a row returned nothing `
          + `on ${s.platform}${who.length ? ` (${who.join(", ")})` : ""}, so the rest of that `
          + `platform was left for the next pass. Its last good file is untouched and still `
          + `published while it is inside the withdrawal window. Nothing about this source is `
          + `known to be wrong.`);
      }
      /* THE BROWSER BRANCH HAD NO BUDGET CLAMP AT ALL, AND IT IS THE BRANCH
         THAT CAN SPEND 45 SECONDS.
         *
         * capture() has taken a `timeoutMs` since it was written and this
         * call has never passed one, so every browser read got the full 45s
         * default however little of the pass was left. The fetch branch above
         * was fixed on 2026-09-16 and this one was not, which is the same
         * fault in the other half of the same function.
         *
         * MEASURED, run 2026-09-16T12:57:51Z. The 360s wall fell at
         * 13:03:51.665. `adm-enolane` was started at 13:03:24.47 with 27.2
         * seconds left and ran 45.4, and the budget error printed at
         * 13:04:09.848 -- 18.2 SECONDS PAST THE WALL, on one source, after
         * the reader had already decided to stop.
         *
         * AND A CLAMP ALONE WOULD LIE. A browser load handed three seconds
         * fails, and a failure is recorded `broken` and counted against the
         * operator's streak -- so clamping without a floor would invent
         * evidence against sources nobody actually tested. Below the floor
         * this SKIPS, which lib/breaker.mjs already defines as "we did not
         * try, so we learned nothing" and which leaves the streak alone. */
      const browserMs = Math.min(45_000, Math.max(0, budgetLeftMs()));
      if (browserMs < BROWSER_FLOOR_MS)
        throw new Skipped(`not attempted: ${Math.round(browserMs)}ms of the pass budget were `
          + `left, under the ${BROWSER_FLOOR_MS}ms floor a browser read is given — the `
          + `slowest successful one measured is 2.75s. Asking would have failed on the `
          + `clock rather than on the board, and been recorded against them. Its last `
          + `good file is untouched and still published while it is inside the withdrawal `
          + `window. Nothing about this source is known to be wrong.`);
      let got;
      try {
        got = await capture({ pageUrl: s.browserPage, target: s.url, timeoutMs: browserMs });
      } catch (e) {
        if (breaker.fail(s.platform, e.message, operatorOf(s))) {
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

    /* ONE DEADLINE FOR THE WHOLE LIST, SHARED EVENLY. See SOURCE_FETCH_MS
       above: the entries are the same site under two hostnames, so charging
       each a full timeout bills one dead site twice. But handing them one
       mark and letting the first take what it likes is not a bound either --
       measured 2026-09-16, Node's own connect timeout spent 10,487 of 12,000ms
       on the bare hostname and left the www twin 1,513. shareOf() divides what
       is left by the attempts still to make. */
    const deadline = fetchDeadline();
    const urls = urlsFor(s);
    for (const [i, url] of urls.entries()) {
      try {
        const res = await fetchWithin(url, { headers, redirect: "follow" },
                                      shareOf(deadline, urls.length - i));
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

/* ---------- a page that is the same for every source on a platform ----------
 *
 * AgriCharts' cash board carries no futures price; the quote is on a sibling
 * page, and it is CBOT's number rather than any one co-op's, so seven pages
 * answer for all 211 sites. Per source that would be 1,477 requests a pass to
 * say the same thing. Once per platform per pass it is seven.
 *
 * FETCHED LAZILY, so a pass that never reaches an AgriCharts source never asks
 * for them, and FETCHED ONCE even if it reaches two hundred.
 *
 * NOTHING IS DEFAULTED WHEN IT FAILS. Whatever came back is handed over as it
 * is; an adapter that needs a page it did not receive refuses that source, and
 * a withheld price is the right outcome of a failed fetch. The alternative --
 * publishing rows nothing checked -- is the one this whole file exists to
 * avoid. */
const sharedCtx = new Map();
async function sharedFor(platform) {
  const spec = SHARED_PAGES[platform];
  if (!spec) return undefined;
  /* KEYED BY THE PAGES, NOT BY THE PLATFORM.
     lib/adapters/index.mjs says of the cashgrid entry "the same seven pages,
     and they are fetched once for both". They were not: this cache was keyed
     by platform name, so agricharts and agricharts-cashgrid each fetched the
     same seven quote pages and the pass asked legacyfarmers.mobile.agricharts
     .com for fourteen. The comment was written the day the second platform was
     added and was never true. Two platforms naming the same URL list now share
     one fetch and one parse. */
  const key = spec.urls.join("|");
  if (sharedCtx.has(key)) return sharedCtx.get(key);

  const bodies = [], problems = [];
  /* A DEADLINE EACH, NOT ONE BETWEEN THEM. These are seven DIFFERENT pages
     and every one that answers is wanted -- unlike a source's url list, where
     the entries are one site written two ways and the first good answer ends
     it. Still clamped to the budget, so seven hung quote pages cannot spend
     more of the pass than there was left. */
  for (const u of spec.urls) {
    try {
      const res = await fetchWithin(u, { headers: { "User-Agent": UA, Accept: "text/html" },
                                       redirect: "follow" }, fetchDeadline());
      if (!res.ok) { problems.push(`${u} -> HTTP ${res.status}`); continue; }
      const body = await res.text();
      if (!body.length) { problems.push(`${u} -> empty response`); continue; }
      bodies.push(body);
    } catch (e) { problems.push(`${u} -> ${e.message}`); }
  }
  let ctx = null;
  if (bodies.length) {
    try { ctx = spec.build(bodies); }
    catch (e) { problems.push(`the ${bodies.length} page(s) that answered would not parse: ${e.message}`); }
  }
  if (problems.length)
    console.error(`::warning title=${platform} shared page(s)::${problems.length} of `
      + `${spec.urls.length} failed — ${spec.why}. ${problems.slice(0, 4).join("; ")}`
      + `${ctx ? " The rest were read and the platform continues on those."
              : " Nothing was read, so every " + platform + " source will refuse this pass rather "
                + "than publish unchecked."}`);
  else
    console.log(`   ${platform}: read ${spec.urls.length} shared page(s) once for the whole pass `
      + `(${spec.why})`);
  sharedCtx.set(key, ctx);
  return ctx;
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
              /* THE OPERATOR'S OWN NAME FOR THE FACILITY, WHICH THE MERGE
                 NEEDS AND THIS PROJECTION USED TO DROP. merge_bids keys a place
                 on operator|branch|location|state and had no branch to work
                 with, so two CHS elevators in one town collided and one lost
                 its rows with nothing counted. `labelInFeed` reads "Stateline",
                 "Holyoke Shuttle", "Kanco" -- it was on the source file all
                 along and stopped here. Carried now; the merge ignores it when
                 it only repeats the town. */
              labelInFeed: s.labelInFeed ?? null,
              zip: s.zip ?? null, lat: s.lat ?? null, lon: s.lon ?? null,
              phone: s.phone ?? null, email: s.email ?? null, website: s.website ?? null,
              /* Whether this source belongs on the AGSIST map. Boyceville is
                 read for the Emmert sites, which consume data/boyceville.json
                 directly, but Barchart already carries it more fully -- so it
                 is read and NOT merged. Two different jobs, one reader. */
              inMerge: s.inMerge !== false,
              /* Both carried forward untouched unless this pass actually
                 attempted the source. See the read-order block above. */
              fails: prevFails.get(s.id) ?? 0,
              attemptedAt: prevSeen.has(s.id) ? new Date(prevSeen.get(s.id)).toISOString() : null,
              platform: s.platform, url: s.url, provenance: s.provenance ?? "scraped",
              pricedAt: prev?.pricedAt ?? null, checkedAt: prev?.checkedAt ?? null,
              rows: prev?.count ?? 0, wrote: false };
  if (prevUnreadable) {
    r.note = `previous file unreadable (${prevUnreadable}); pricedAt will be restamped`;
    console.error(`::warning title=${s.id} unreadable previous file::${prevUnreadable}`);
  }
  try {
    const { html, url } = await getPage(s);
    const shared = await sharedFor(s.platform);
    const built = buildFile(html, { now, sourceUrl: url, source: toConfig(s),
                                    extract: adapterFor(s.platform, shared) });
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
    /* A READ THAT WORKED CLEARS THE STREAK -- it counts CONSECUTIVE failures,
       and a source that works once has no case against it any more. */
    r.fails = nextStreak(prevFails.get(s.id), "live");
    r.attemptedAt = now;
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
    /* A SKIP IS NOT EVIDENCE. We did not try, so neither field moves -- both are
       carried forward exactly as they were. That is the whole difference between
       this and the "was it ok last pass" test it replaced, which read not-trying
       as a black mark and then could never take it back. */
    r.fails = nextStreak(prevFails.get(s.id), r.health);
    if (!isSkip(e)) r.attemptedAt = now;
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
/* ── A SOURCE THE CLOCK RAN OUT ON IS NOT A SOURCE THAT STOPPED EXISTING ────
 *
 * The manifest was `results.map(...)` — only the sources this pass actually
 * reached. A pass that hits the six-minute wall skips the rest with
 * `skippedForTime++` and `continue`, so they never became results and never
 * appeared in the file. merge_bids then drops every board file with no manifest
 * row, under the reason "board file with no entry in index.json".
 *
 * Measured on the live tree, 2026-09-13: the manifest carried 666 rows against
 * 935 enabled sources. 266 of those had a FRESH board file on disk — fetched,
 * parsed, committed to git — holding 3,340 bid rows that the merge threw away.
 * The feed published 6,940. There was another 48% sitting in the repository,
 * already paid for in requests to other people's servers.
 *
 * Nothing was red. The poll reported its wall, the merge reported its drops,
 * and neither said the two numbers were the same 266 sources.
 *
 * So an unreached source keeps its LAST row, marked `carried` with the pass
 * that last read it. This does not publish a stale price: feedVerdict still
 * applies the 14-hour withdrawal to whatever `checkedAt` that row carries, so a
 * source that has genuinely gone quiet still leaves the feed — on age, which is
 * the policy, instead of on which sources a given six minutes happened to fit. */
function withCarried(rows) {
  const seen = new Set(rows.map((r) => r.id));
  const carried = [];
  for (const s of todo) {
    if (seen.has(s.id)) continue;
    const prev = prevRow.get(s.id);
    if (prev) { carried.push({ ...prev, carried: true, carriedAt: now }); continue; }
    /* NO PREVIOUS ROW, BUT THERE MAY STILL BE A BOARD. Once a source has
       fallen out of the manifest it can never climb back in on its own: the
       carry above has nothing to copy, and the merge keeps dropping its board.
       266 sources were in exactly that hole on 2026-09-13. The manifest row is
       a projection of the source file and the board file, and both are on disk,
       so it can be rebuilt rather than waited for. */
    let b = null;
    try { b = JSON.parse(readFileSync(join(DATA, `${s.id}.json`), "utf8")); }
    catch { continue; }
    if (!b || !b.checkedAt) continue;
    carried.push({
      id: s.id, operator: s.operator, location: s.location,
      usState: s.state ?? null, labelInFeed: s.labelInFeed ?? null,
      zip: s.zip ?? null, lat: s.lat ?? null, lon: s.lon ?? null,
      phone: s.phone ?? null, email: s.email ?? null, website: s.website ?? null,
      inMerge: s.inMerge !== false, platform: s.platform ?? null,
      url: s.url ?? null,
      status: b.status ?? "ok", health: b.status === "ok" ? "live" : (b.status ?? "unknown"),
      checkedAt: b.checkedAt ?? null, pricedAt: b.pricedAt ?? null,
      rows: b.count ?? (Array.isArray(b.bids) ? b.bids.length : null),
      fails: prevFails.get(s.id) ?? 0, attemptedAt: null,
      carried: true, carriedAt: now, carriedFrom: "board file",
    });
  }
  if (carried.length)
    console.log(`carried ${carried.length} source(s) the pass did not reach; `
      + `their last board still faces the age rule at merge`);
  return [...rows, ...carried];
}

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
  sources: withCarried(results.map(({ wrote, ...keep }) => keep)),
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

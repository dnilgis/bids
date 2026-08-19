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
import { buildFile, Refused, serialise } from "../lib/board.mjs";
import { decide } from "../lib/decide.mjs";
import { loadSources, toConfig, urlsFor } from "../lib/sources.mjs";
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

const { sources: enabled, errors } = loadSources(rows);
for (const e of errors) console.error(`::error title=Bad source::${e}`);
/* A malformed source is dropped, not half-loaded -- but it must not pass
   quietly, or a typo silently removes an elevator from the site. */
if (errors.length && !enabled.length) { console.error("FAILED: no usable sources"); process.exit(1); }

const todo = only ? enabled.filter((s) => s.id === only) : enabled;
if (!todo.length) { console.error(`FAILED: no enabled source matches ${only ?? "(any)"}`); process.exit(1); }

/* ---------- one fetch per page ---------- */
const pages = new Map();
async function getPage(s) {
  if (fixtures.has(s.id))
    return { html: readFileSync(fixtures.get(s.id), "utf8"), url: `file://${fixtures.get(s.id)}` };
  const key = s.url;
  if (pages.has(key)) return pages.get(key);
  const p = (async () => {
    const problems = [];
    for (const url of urlsFor(s)) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
        if (!res.ok) { problems.push(`${url} -> HTTP ${res.status}`); continue; }
        const html = await res.text();
        if (html.length < 500) { problems.push(`${url} -> ${html.length} bytes, too short`); continue; }
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

for (const s of todo) {
  const out = join(DATA, `${s.id}.json`);
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
    const verdict = decide(prev, built.file);
    r.health = "live";
    r.status = "ok";
    r.pricedAt = verdict.file.pricedAt;
    r.checkedAt = verdict.file.checkedAt;
    r.rows = verdict.file.count;
    r.verified = built.verified;
    r.reason = verdict.reason;
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
    r.health = (e instanceof Refused || e?.constructor?.name === "AghostRefused") ? "refused" : "broken";
    r.status = r.health;
    r.error = e.message.split("\n")[0].slice(0, 300);
    console.error(`  ${r.health.padEnd(7)} ${s.id.padEnd(24)} ${r.error}`);
    console.error(`::warning title=${s.id} ${r.health}::${r.error}`);
  }
  results.push(r);
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
  },
  sources: results.map(({ wrote, ...keep }) => keep),
};
if (!dryRun) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, "index.json"), JSON.stringify(index, null, 1) + "\n");
}

const wrote = results.filter((r) => r.wrote);
const summary = `${ok.length} ok, ${index.counts.refused} refused, ${index.counts.broken} broken`;
if (!dryRun)
  writeFileSync(MSG, wrote.length
    ? `bids: ${wrote.map((r) => r.id).join(", ")} (${summary})\n`
    : `bids: heartbeat (${summary})\n`);

console.log(`\n${summary}${wrote.length ? ` | wrote ${wrote.length}` : " | no change"}`);

/* Fail only when EVERY source refused. One elevator redesigning their page
   must never stop the other ninety-nine. */
if (ok.length === 0) { console.error("FAILED: every source refused"); process.exit(1); }

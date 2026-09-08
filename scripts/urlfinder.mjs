#!/usr/bin/env node
/* TURNING A NAME INTO A URL, AND REFUSING EVERY ONE THAT CANNOT BE PROVED.
 *
 * WHY. 4,270 of the 4,982 elevators this project knows about have no website on
 * file, so there is no board to ask for. That is the largest single wall between
 * here and every elevator in the country, and it is far larger than every other
 * one put together. Licence rolls cannot help: states publish LICENSEES, not
 * URLs, and the registries run of 2026-09-08 added 2,247 rows to the directory
 * and, necessarily, zero readable boards.
 *
 * 2,385 of those rows carry a phone number, and a ten-digit phone is the one
 * thing here that is IDENTITY rather than resemblance — build_directory.mjs
 * already decides on it. So: guess hostnames from the business's own name by
 * the fixed rule in lib/urlfinder.mjs, fetch them, and accept only the ones
 * whose page carries that phone.
 *
 * WHAT THIS IS NOT. It is not a search engine and it does not pretend to be
 * one. Businesses whose domain does not resemble their registered name will not
 * be found by it, and that is a stated limit rather than a bug: the run reports
 * how many it exhausted so the size of that limit is a measured number rather
 * than an impression.
 *
 * THE FAILURE MODE THIS IS BUILT AGAINST is not missing a site. It is FILING A
 * WRONG ONE. A guessed .com that answers 200 proves only that somebody owns it,
 * and a parked page will happily contain the word "grain". Every acceptance
 * here is a phone match; a town match is written to a worklist for a person and
 * is never a website. That line is not a preference, it is the rule
 * build_directory.mjs already states: "a town match alone is not identity: a
 * town can hold three elevators".
 *
 * MANNERS, because these are other people's servers and most of them are small.
 *   * robots.txt is fetched once per host and honoured. The repository does not
 *     fetch what a site tells crawlers not to -- that is why Illinois' licence
 *     lookup is snapshot-only -- and a domain guess is not the place to start.
 *   * One request per candidate, HEAD-free, 10s ceiling, small concurrency, and
 *     a run budget in seconds so a cron cannot run away.
 *   * A candidate that fails DNS costs nothing and stops there.
 *
 * RESUMABLE, and by itself. The ledger records what was asked and what came
 * back, and --resume skips anything decided by this PROBE_VERSION, so the work
 * can be walked down over many short runs the way scripts/discover.mjs does.
 * Bumping PROBE_VERSION re-opens everything the old rule wrote off.
 *
 *   node scripts/urlfinder.mjs --budget 1500 --limit 400 --resume
 *   node scripts/urlfinder.mjs --list one.csv --concurrency 4 --write
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  candidateHosts, evidenceIn, verdict, describeEvidence, digits10, MAX_CANDIDATES, PROVED,
  addressParts, usablePhone,
} from "../lib/urlfinder.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/* Bump this when the rule gets better, and every write-off the old rule made is
   asked again. It is the same contract scripts/discover.mjs holds. */
export const PROBE_VERSION = 1;

export const UA = "agsist-bids/1.0 (+https://github.com/dnilgis/bids; grain bid directory)";
export const LEDGER = "data/urlfinder.json";
export const FOUND_LIST = "probe-lists/urlfinder-found.txt";
export const WORKLIST = "data/gaps/website-candidates.csv";

/* ── hosts THIS PROBE does not crawl, whatever robots.txt says ─────────────
 *
 * READ THE NEXT PARAGRAPH BEFORE WIRING THIS INTO ANYTHING ELSE.
 *
 * This is urlfinder's list, and urlfinder guesses hostnames from a business
 * name and crawls strangers. It is NOT a repository-wide "never fetch". The
 * poller reads https://bigriverbids.com/cashbidssingle-2121 on every pass:
 * sources/boyceville.json is enabled, its note says "Read by arrangement", and
 * data/boyceville.json is what both Emmert sites consume. Wiring this list
 * into the reader would take those two sites down silently. One arranged URL
 * being read is not the same permission as a crawler guessing at the host.
 *
 * WHY THIS IS NOT LEFT TO robots.txt. It was, and on 2026-09-08 this probe
 * read 283 KB of bigriverbids.com and wrote it into the found list, which is
 * the input to scripts/discover.mjs. The host it ASKED was
 * bigriverunitedenergy.com — allowed, robots checked, all correct. getText
 * follows redirects and returns res.url, so the page that came back, and the
 * URL that got recorded, belonged to a different host whose robots.txt was
 * never asked. A decision already taken must not depend on a live fetch of a
 * file on the far end.
 *
 * A host goes in here when this probe must not go looking around it. robots is
 * still asked of every host, first, on top of this.
 */
export const NEVER_CRAWL = new Set([
  "bigriverbids.com",       // robots-disallowed to crawlers; rule 9. The ONE arranged
                            // board URL is read by the poller and is not affected.
  "apps.agr.illinois.gov",  // Illinois is snapshot-only; standing decision, rule 9
]);

/* Bare host, no www, no port, lowercase. Returns "" for anything unparseable,
   and "" is never in the denylist, so a URL we cannot read is not silently
   treated as permitted — every caller checks the parse separately. */
export function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return ""; }
}

/* True when this host, or any parent of it, is denied. bids.example.com is
   denied by an entry for example.com; examplebids.com is not — a suffix test
   without the dot matches the wrong hosts, which is how denylists leak. */
export function isDenied(host) {
  const h = String(host || "").replace(/^www\./i, "").toLowerCase();
  if (!h) return false;
  for (const d of NEVER_CRAWL) if (h === d || h.endsWith("." + d)) return true;
  return false;
}

/* ── the input ─────────────────────────────────────────────────────────────
   A CSV field may be quoted and may contain a comma; three of these business
   names do. Written with a split(",") first and it put "Auvergne Grain Company"
   in one column and " L.L.C." in the next, which then became a candidate
   hostname. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows.filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/* The ledger key. Name alone is not unique — "Farmers Cooperative" is a dozen
   different businesses in a dozen towns — and the phone alone would merge a
   co-op's head office with its elevators. */
export const keyOf = (b) =>
  [digits10(b.phone), (b.state || "").toUpperCase(),
   String(b.city || "").toLowerCase().replace(/[^a-z]/g, ""),
   String(b.name || "").toLowerCase().replace(/[^a-z0-9]/g, "")].join("|");

/* ── robots ────────────────────────────────────────────────────────────────
   Only the question this tool asks: may we fetch "/"? A full robots parser is
   not needed for that and would be a second thing to get wrong. Anything other
   than a served, parseable robots.txt with a matching blanket Disallow is
   treated as ALLOWED, which is what the standard says about a 404. */
export function rootDisallowed(robotsTxt) {
  let applies = false;
  for (const raw of String(robotsTxt ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, field, value] = m;
    if (/^user-agent$/i.test(field)) { applies = value.trim() === "*"; continue; }
    if (!applies) continue;
    if (/^allow$/i.test(field) && value.trim() === "/") return false;
    if (/^disallow$/i.test(field) && value.trim() === "/") return true;
  }
  return false;
}

/* ── the network, kept behind one function so the tests can drive it ──────── */
export async function getText(url, { timeoutMs = 10000, fetchImpl = fetch, maxBytes = 400_000 } = {}) {
  /* BEFORE THE REQUEST. Nothing below this line runs for a denied host. */
  if (isDenied(hostOf(url)))
    return { status: 0, body: "", url, code: "DENIED", denied: true,
             why: `${hostOf(url)} is on the never-fetch list` };
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    /* AND AFTER IT. redirect:"follow" means the host that answered is not
       necessarily the host that was asked. The body is already in hand at this
       point and is thrown away unread — a denied page must not reach evidenceIn
       and must not become res.url in the ledger. */
    if (isDenied(hostOf(res.url || url)))
      return { status: res.status, body: "", url: res.url || url, code: "DENIED", denied: true,
               why: `redirected to ${hostOf(res.url || url)}, which is on the never-fetch list` };
    const type = res.headers?.get?.("content-type") ?? "";
    if (!res.ok) return { status: res.status, body: "", url: res.url || url, why: `HTTP ${res.status}` };
    /* A PDF or an image proves nothing about a business and can be enormous. */
    if (type && !/text\/|html|xml|json/i.test(type))
      return { status: res.status, body: "", url: res.url || url, why: `content-type ${type}` };
    const body = (await res.text()).slice(0, maxBytes);
    return { status: res.status, body, url: res.url || url, why: "" };
  } catch (e) {
    /* THE CODE, NOT JUST THE MESSAGE. Node reports every transport failure as
       "fetch failed" and puts the useful part in `cause.code`, and the
       difference matters: ENOTFOUND means THE HOSTNAME DOES NOT EXIST, which is
       a finding about the guess, while a timeout or a refused connection means
       the question was never asked. */
    const code = e?.cause?.code ?? e?.code ?? "";
    return { status: 0, body: "", url, code,
             why: `${String(e?.message || e).slice(0, 120)}${code ? ` (${code})` : ""}` };
  }
}

/**
 * Ask one business. Returns the ledger record; makes at most one robots request
 * per host and one page request per candidate, and STOPS at the first phone
 * match — a proved answer ends the questioning.
 */
export async function askBusiness(b, opts = {}) {
  const { get = getText, robotsCache = new Map(), pageCache = new Map(),
          limit = MAX_CANDIDATES } = opts;
  const hosts = candidateHosts(b.name, { limit });
  const tried = [];

  /* One robots answer per host, whether the host was guessed or arrived at by
     redirect. Returns true when the host must not be read. */
  const disallowed = async (host) => {
    if (!robotsCache.has(host)) {
      const r = await get(`https://${host}/robots.txt`, opts);
      robotsCache.set(host, r.status === 200 ? rootDisallowed(r.body) : false);
    }
    return robotsCache.get(host) === true;
  };

  for (const host of hosts) {
    /* A DENIED HOST IS NOT ASKED AT ALL — not for robots.txt either. */
    if (isDenied(host)) {
      tried.push({ host, verdict: "denied", why: "this project does not fetch this host" });
      continue;
    }
    if (!robotsCache.has(host)) {
      const r = await get(`https://${host}/robots.txt`, opts);
      robotsCache.set(host, r.status === 200 ? rootDisallowed(r.body) : false);
    }
    if (robotsCache.get(host)) {
      tried.push({ host, verdict: "robots", why: "the site disallows / for every crawler" });
      continue;
    }

    /* ONE FETCH PER HOST PER RUN. data/known-elevators.json holds Riceland
       Co-op three times and ADM Grain dozens of times — different branches of
       one operator, all deriving the same candidate hostnames. Without this the
       run asks adm.com once per facility, which is both slower and ruder. */
    if (!pageCache.has(host)) pageCache.set(host, await get(`https://${host}/`, opts));
    const r = pageCache.get(host);

    /* THE PAGE THAT ANSWERED IS NOT ALWAYS THE PAGE THAT WAS ASKED. When a
       guess redirects somewhere else, that somewhere else has a robots.txt of
       its own and it has never been consulted. Ask it before the body counts
       as evidence. This is the second half of the bigriverbids finding: the
       denylist stops the hosts we have already decided about, and this stops
       the ones we have not. */
    if (r.body) {
      const landed = hostOf(r.url);
      if (landed && landed !== hostOf(`https://${host}/`)) {
        if (isDenied(landed)) {
          tried.push({ host, verdict: "denied", url: r.url,
                       why: `redirects to ${landed}, which this project does not fetch` });
          continue;
        }
        if (await disallowed(landed)) {
          tried.push({ host, verdict: "robots", url: r.url,
                       why: `redirects to ${landed}, which disallows / for every crawler` });
          continue;
        }
      }
    }

    if (!r.body) {
      if (r.denied) {
        tried.push({ host, verdict: "denied", why: r.why });
        continue;
      }
      /* A HOSTNAME THAT DOES NOT EXIST IS AN ANSWER. Anything else that
         produced no response at all is a fact about the network, and
         scripts/discover.mjs's rule applies: "AN UNREACHABLE PAGE IS NOT
         DECIDED. Writing those off is how a sweep quietly loses a working
         elevator." */
      const askable = r.status > 0 || r.code === "ENOTFOUND" || r.code === "ENOTFOUND_DNS";
      tried.push({ host, verdict: askable ? "no-answer" : "unreachable",
                   why: r.why || `HTTP ${r.status}` });
      continue;
    }

    const ev = evidenceIn(r.body, b);
    const v = verdict(ev);
    tried.push({ host, verdict: v, why: describeEvidence(ev, host), url: r.url, ev });
    if (PROVED.has(v))
      return { status: "found", provedBy: v, website: r.url, host,
               why: describeEvidence(ev, host),
               probeVersion: PROBE_VERSION, seenAt: new Date().toISOString(), tried };
  }

  const town = tried.find((t) => t.verdict === "town-only");
  const unreachable = !town && tried.some((t) => t.verdict === "unreachable");
  return {
    status: town ? "town-only"
          : unreachable ? "unreachable"
          : hosts.length ? "exhausted" : "no-candidates",
    provedBy: null,
    website: town ? town.url : null, host: town ? town.host : null,
    why: town ? town.why
       : unreachable ? `${tried.filter((t) => t.verdict === "unreachable").length} of `
                     + `${tried.length} candidate host(s) could not be reached at all, so this `
                     + `business has not been asked yet`
       : hosts.length ? `${hosts.length} candidate host(s) asked; none carried the phone or the `
                      + `street address we hold for this business`
       : "the name yields no candidate hostname",
    probeVersion: PROBE_VERSION, seenAt: new Date().toISOString(), tried,
  };
}

/* Decided, and the rule is scripts/discover.mjs's: a positive answer is
   permanent, a negative one only holds against the probe that made it. An
   error is never decided — it is a thing that has not been asked yet. */
/* `unreachable` is deliberately absent from this list, and that is the whole
   point of it: a business nothing could be asked about comes round again on the
   next run. */
export const decided = (rec) => {
  if (!rec) return false;
  /* A `found` row whose website is on the denylist was proved by reading a page
     this project should not have read. It is not a decision, it is a thing to
     ask again — and because `found` is otherwise permanent, without this line
     --resume would skip it forever and the bad row would never correct itself.
     The next run re-asks it, the redirect is refused, and the row becomes an
     honest not-proved. */
  if (rec.status === "found" && isDenied(hostOf(rec.website))) return false;
  return rec.status === "found"
    || (["town-only", "exhausted", "no-candidates"].includes(rec.status)
        && (rec.probeVersion ?? 0) >= PROBE_VERSION);
};

/* THE ONE PLACE A LEDGER ROW IS WRITTEN.
 *
 * MEASURED 2026-09-08. Central Farm Service (Dolliver IA and Truman MN) was
 * `found`, proved by phone, cfscoop.com. Both rows came back `unreachable`
 * after centralfarmservice.com answered ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR
 * once, and cfscoop.com dropped out of probe-lists/urlfinder-found.txt, where
 * it had been the day before.
 *
 * The rule "a positive answer is permanent" was written down, and it lived in
 * decided(), which only filters the QUEUE, and only when --resume is passed.
 * The write was `ledger.businesses[key] = rec`, unconditional. So the
 * invariant held in the predicate and not in the ledger, and the test that
 * guarded it asserted the predicate. Rule 28: a guard that cannot execute the
 * thing it guards is not a guard.
 *
 * A better proof still replaces an older one — found over found is a real
 * update, and a proof on a denied host is not a proof and never wins.
 */
export function keep(existing, next) {
  if (!existing) return next;
  if (existing.status !== "found") return next;
  if (isDenied(hostOf(existing.website))) return next;
  if (next && next.status === "found" && !isDenied(hostOf(next.website))) return next;
  return existing;
}

/* Write one answer into the ledger. Callers do not assign to
   ledger.businesses directly; there is exactly one writer and this is it. */
export function record(ledger, key, rec) {
  const kept = keep(ledger.businesses[key], rec);
  ledger.businesses[key] = kept;
  return kept;
}

const flag = (a, n, d) => { const i = a.indexOf(`--${n}`); return i < 0 ? d : a[i + 1]; };
const has = (a, n) => a.includes(`--${n}`);

export async function main(argv = process.argv.slice(2)) {
  const listPath = flag(argv, "list", "data/gaps/no-website-on-file.csv");
  const budgetMs = Number(flag(argv, "budget", "1500")) * 1000;
  const limitN = Number(flag(argv, "limit", "0")) || Infinity;
  const conc = Math.max(1, Math.min(8, Number(flag(argv, "concurrency", "4"))));
  const write = has(argv, "write");
  const started = Date.now();

  /* A ROW NEEDS A NAME TO GUESS FROM AND SOMETHING TO BE PROVED BY. Written
     first as "a ten-digit phone", which silently cut the input from 2,373 to
     575: Ohio and Wisconsin publish a street address and no phone, and 1,586 of
     the phone-carrying rows are Barchart facilities with no NAME at all, which
     is nothing to derive a hostname from. Measured 2026-09-08 on the committed
     gap list. */
  const usable = (b) => usablePhone(b.phone)
    || Boolean(addressParts(b.address).number && addressParts(b.address).words.length);
  const all = parseCsv(readFileSync(join(ROOT, listPath), "utf8"))
    .filter((b) => String(b.name ?? "").trim() && usable(b));

  const lpath = join(ROOT, LEDGER);
  const ledger = existsSync(lpath)
    ? JSON.parse(readFileSync(lpath, "utf8")) : { generated: null, note: "", businesses: {} };
  ledger.businesses ||= {};

  const owed = has(argv, "resume")
    ? all.filter((b) => !decided(ledger.businesses[keyOf(b)])) : all;
  const queue = owed.slice(0, limitN);

  const byPhone = all.filter((b) => usablePhone(b.phone)).length;
  console.log(`${all.length} business(es) with no website on file, a name to guess from, and `
    + `something to be proved by (${byPhone} a phone, ${all.length - byPhone} an address only)`);
  console.log(`${owed.length} not yet decided by probe v${PROBE_VERSION}; asking ${queue.length}`
    + `, ${conc} at a time, budget ${budgetMs / 1000}s\n`);

  const robotsCache = new Map(), pageCache = new Map();
  const tally = { found: 0, "town-only": 0, exhausted: 0, unreachable: 0, "no-candidates": 0 };
  let bodies = 0;
  let asked = 0, ranOut = false;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (Date.now() - started > budgetMs) { ranOut = true; return; }
      const i = cursor++;
      if (i >= queue.length) return;
      const b = queue[i];
      const rec = await askBusiness(b, { robotsCache, pageCache });
      bodies += rec.tried.filter((t) => t.verdict !== "no-answer" && t.verdict !== "unreachable"
                                     && t.verdict !== "robots").length;
      rec.name = b.name; rec.city = b.city; rec.state = b.state;
      rec.phone = b.phone; rec.address = b.address; rec.source = b.source;
      const kept = record(ledger, keyOf(b), rec);
      tally[rec.status] = (tally[rec.status] ?? 0) + 1;
      asked++;
      /* Say it out loud. A run that silently declines to write is worse than
         one that overwrites, because nobody can tell it happened. */
      if (kept !== rec)
        console.log(`  keep   ${b.name} (${b.city}, ${b.state})  ->  ${kept.website}`
                    + `  [proof kept; this run said ${rec.status}]`);
      if (rec.status === "found") console.log(`  FOUND  [${rec.provedBy}]  ${b.name} (${b.city}, ${b.state})  ->  ${rec.website}`);
      else if (rec.status === "town-only") console.log(`  maybe  ${b.name} (${b.city}, ${b.state})  ->  ${rec.host}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));

  console.log(`\nasked ${asked} in ${Math.round((Date.now() - started) / 1000)}s`
    + (ranOut ? " (budget spent — run again with --resume)" : ""));
  for (const [k, v] of Object.entries(tally)) console.log(`  ${String(v).padStart(5)}  ${k}`);

  /* A RUN THAT REACHED NOTHING HAS FOUND NOTHING, AND MUST NOT SAY OTHERWISE.
     Written after doing it: this was first run in a sandbox with no route to
     any of these hosts, and it cheerfully wrote forty businesses off as
     `exhausted` in six seconds. Every one of them would then have been skipped
     by --resume for good. If not one candidate anywhere in the run returned a
     page, the network is the finding, not the elevators. */
  if (write && asked && bodies === 0) {
    console.log("\n::error title=urlfinder reached nothing::"
      + `${asked} business(es) were asked and NOT ONE candidate host returned a page. `
      + "That is a broken route out of this machine, not a finding about these "
      + "businesses, and nothing has been written. Check egress and run again.");
    return 1;
  }

  const recs = Object.values(ledger.businesses);
  /* A ledger written before the denylist existed can still hold a website on a
     denied host. It is filtered here as well as at fetch time, so the file
     discover.mjs reads is clean on the very next run rather than after the row
     happens to be re-asked. */
  const found = recs.filter((r) => r.status === "found" && !isDenied(hostOf(r.website)));
  const maybe = recs.filter((r) => r.status === "town-only");
  const byProof = found.reduce((a, r) => ({ ...a, [r.provedBy]: (a[r.provedBy] ?? 0) + 1 }), {});
  console.log(`\nledger: ${found.length} proved (${Object.entries(byProof)
    .map(([k, v]) => `${v} by ${k}`).join(", ") || "none"}), `
    + `${maybe.length} town-only, ${recs.length} decided`);

  if (write) {
    ledger.generated = new Date().toISOString();
    ledger.note = "Websites found by guessing a hostname from the business name and PROVING it "
      + "with the ten-digit phone already on file. `found` is proved; `town-only` is not identity "
      + "and is a worklist, never a website. Written by scripts/urlfinder.mjs.";
    writeOut(LEDGER, JSON.stringify(ledger, null, 1) + "\n");
    writeOut(FOUND_LIST, foundList(found));
    writeOut(WORKLIST, worklist(maybe));
    console.log(`\nwrote ${LEDGER}, ${FOUND_LIST}, ${WORKLIST}`);
  }
  return 0;
}

function writeOut(rel, text) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export function foundList(found) {
  return `# WEBSITES FOUND BY scripts/urlfinder.mjs, AND PROVED BY PHONE.
#
# Every URL below was fetched and PROVED, by one of exactly two things this
# project already held for that business:
#
#   phone    the ten-digit phone appears on the page — the same rule
#            scripts/build_directory.mjs uses to decide a licence row and a
#            board are one elevator;
#   address  the house number stands beside its own street word, AND the town
#            is named, AND the state is named.
#
# Nothing here was accepted on a town match, or on a name that looked right.
# Each line says which proof carried it.
#
# This file is the input to scripts/discover.mjs --list: having a website is not
# having a board, and what each of these is running is the question discover
# exists to answer.
#
# Regenerated wholesale. Do not edit by hand.
${found.map((r) => `${r.website}  # ${r.name}; ${r.city}, ${r.state}; proved by ${r.provedBy}; ${r.source}`).sort().join("\n")}
${found.length ? "" : "# (nothing proved yet)"}`.trimEnd() + "\n";
}

export function worklist(maybe) {
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = ["name", "city", "state", "phone", "address", "host", "url", "why", "source"];
  return [cols.join(","), ...maybe.map((r) => cols.map((c) =>
    esc(c === "url" ? r.website : r[c])).join(","))].join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().then((code) => { process.exitCode = code; });

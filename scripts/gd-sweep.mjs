#!/usr/bin/env node
/* HOW MANY ELEVATORS ARE WAITING BEHIND THAT ENDPOINT?
 *
 *   GET https://marketplace.graindiscovery.com/api/public-sites/<token>/cash-bids
 *
 * There is no index. `/api/public-sites` is 404, and so is
 * `/api/public-sites/<token>` on its own — the only route that answers is the
 * board itself. A token that exists returns JSON; one that does not returns
 * 401 `{"error":"Unauthorized"}`. That is the whole discovery surface: ask, and
 * read the answer.
 *
 * So this takes candidate tokens, asks once each, and prints what came back.
 * A hit is worth a lot: a single token can carry SEVERAL destinations — the
 * default token in DTN's own bundle, stLawrenceGrain, carries Squirrel Creek
 * and SLG Stouffville — and every destination is an elevator we can publish.
 *
 * WHAT IT WILL NOT DO
 * It will not hammer them. One request at a time per worker, a small worker
 * pool, and a pause between rounds. A sweep that gets us blocked costs more
 * than the elevators it finds.
 *
 *   node scripts/gd-sweep.mjs --tokens a,b,c
 *   node scripts/gd-sweep.mjs --file candidates.txt --concurrency 4 --delay 150
 *   node scripts/gd-sweep.mjs --names "Allied Cooperative,River Country Co-Op"
 *
 * Output is the log, plus a JSON summary on the last line for machine use.
 * It writes nothing.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };

const BASE = flag("base", "https://marketplace.graindiscovery.com/api");
const CONC = Math.max(1, Math.min(8, Number(flag("concurrency", 4))));
const DELAY = Math.max(0, Number(flag("delay", 150)));
const UA = "agsist-bids/1.0 (+https://agsist.com)";

/* NAME -> THE SHAPES A TOKEN ACTUALLY TAKES.
   Observed: "albertleaelevator" (lower, squashed), "stLawrenceGrain" (camel),
   "lockiefarms" (lower). So a name is worth trying several ways, and the
   variants are cheap. Anything with fewer than four characters is dropped —
   those are not tokens, they are noise. */
export function slugVariants(name) {
  const words = String(name)
    .replace(/[.,]/g, " ")
    .replace(/&/g, " and ")
    /* "Co-Op" is one word. Splitting it on the hyphen leaves "co" and "op",
       and "co" is then dropped as a company suffix -- which turned
       "River Country Co-Op" into "rivercountryop". */
    .replace(/\bco[-\s]?op(erative)?\b/gi, (m) => (/erative/i.test(m) ? "cooperative" : "coop"))
    .split(/[\s\-_/]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (!words.length) return [];
  const lower = words.map((w) => w.toLowerCase());
  const noState = lower.filter((w) => !/^(inc|llc|ltd|co|company|the)$/.test(w));
  const use = noState.length ? noState : lower;
  const squashed = use.join("");
  const camel = use.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
  const hyphen = use.join("-");
  const dropCoop = use.filter((w) => !/^(coop|cooperative|co-op|elevator|grain|farms|farm)$/.test(w)).join("");

  /* "COOPERATIVE" AND "COOP" ARE THE SAME WORD AND THIS GENERATOR KNEW ONLY ONE
     OF THEM -- 2026-08-20.
     Held against the five tokens known to exist, it produced four of them and
     missed `sunriseagcoop`, from "Sunrise Ag Cooperative": it offered
     sunriseagcooperative, sunriseAgCooperative, sunrise-ag-cooperative and
     sunriseag, none of which is the token. That token was found by hand, by
     someone typing the abbreviation the company itself uses on its own domain.
     A generator that cannot produce the one hit a sweep has ever had is not
     generating candidates, it is generating confidence.
     So a name carrying either spelling is tried both ways. It costs one extra
     request per co-operative and it is the difference between finding one and
     not. test/gd-sweep.test.mjs holds all five. */
  const swap = (w) => (w === "cooperative" ? "coop" : w === "coop" ? "cooperative" : w);
  const swapped = use.map(swap);
  const bothWays = swapped.join("") === squashed ? [] : [
    swapped.join(""),
    swapped.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join(""),
    swapped.join("-"),
  ];

  return [...new Set([squashed, camel, hyphen, dropCoop, ...bothWays].filter((s) => s.length >= 4))];
}

/* THE CONTROL GROUP. Every token on this list is known to answer on the shared
 * marketplace host, so a sweep that does not find them has not proved anything
 * about the ones it also did not find.
 *
 * WHY THIS EXISTS. The 2026-08-20 sweep tried 1,252 tokens and reported five
 * hits. `sunriseagcoop` -- confirmed working the day before -- was not among
 * them, and the run looked exactly like a clean result. The cause was mundane:
 * probe-lists/gd-candidates.txt says "Sunrise Cooperative" and the company is
 * "Sunrise Ag Cooperative", so the token was never generated and never tried.
 * Nothing in the output could have told you that. A sweep whose negative
 * answer carries no information (a 401 is returned for private AND for
 * nonexistent) has to prove it can still find what it already knows, or
 * "no new hits" and "the sweep is broken" are the same log line.
 *
 * NOT lockiefarms: that customer is on its own API host -- see the Rf override
 * map quoted in lib/adapters/graindesk.mjs -- so it is expected to fail here
 * and would be a false alarm. */
export const CONTROL_TOKENS = [
  "albertleaelevator", "babgrain", "sunriseagcoop",
  "stLawrenceGrain", "pinebluffsfeedandgrain", "ramseygrain",
];

/* A 401 is returned for a private token AND for one that does not exist, so it
 * says nothing. Anything ELSE says something. On 2026-08-20 five candidates
 * came back 500 with `{"error":"Error fetching bids"}` or `Error fetching
 * configs` -- the server got as far as looking the company up and then failed,
 * which a nonexistent token does not do. Those are leads, not noise. */
export const isLead = (r) => r.status !== 401 && r.verdict !== "HIT";

/* Did the sweep find what it already knows? Pure, and exported, because it was
   written inside the script body first and nothing could reach it to test —
   which is how the check that guards against a silent sweep became a silent
   check. */
export function controlReport(results, control = CONTROL_TOKENS) {
  const found = new Set((results ?? []).filter((r) => r?.verdict === "HIT").map((r) => r.token));
  const lost = control.filter((t) => !found.has(t));
  return { ok: lost.length === 0, lost, checked: control.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ask(token, base = BASE) {
  const url = `${base.replace(/\/+$/, "")}/public-sites/${encodeURIComponent(token)}/cash-bids`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
    const body = await res.text();
    if (res.status === 401) return { token, status: 401, verdict: "no such token" };
    if (!res.ok) return { token, status: res.status, verdict: `HTTP ${res.status}`, body: body.slice(0, 160) };
    let data;
    try { data = JSON.parse(body); }
    catch { return { token, status: res.status, verdict: "200 but not JSON", body: body.slice(0, 160) }; }
    if (!Array.isArray(data)) return { token, status: res.status, verdict: "200 but not an array", body: body.slice(0, 160) };
    const offers = data.flatMap((g) => g?.offers ?? []);
    const destinations = [...new Set(offers.map((o) => o?.destination).filter(Boolean))];
    const commodities = [...new Set(data.map((g) => g?.commodity?.name).filter(Boolean))];
    return { token, status: 200, verdict: "HIT", destinations, commodities, offers: offers.length, bytes: body.length };
  } catch (e) {
    return { token, status: 0, verdict: `fetch failed: ${e.message}` };
  }
}

async function sweep(tokens) {
  const results = [];
  const queue = [...tokens];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const r = await ask(t);
      results.push(r);
      if (r.verdict === "HIT") {
        console.log(`  HIT  ${t.padEnd(28)} ${r.offers} offer(s) · ${r.destinations.length} destination(s): ${r.destinations.join(", ")}`);
        console.log(`       commodities: ${r.commodities.join(", ")}`);
      } else if (r.status !== 401) {
        console.log(`  ?    ${t.padEnd(28)} ${r.verdict}`);
      }
      if (DELAY) await sleep(DELAY);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let tokens = [];
  if (flag("tokens")) tokens.push(...flag("tokens").split(",").map((s) => s.trim()).filter(Boolean));
  if (flag("names")) tokens.push(...flag("names").split(",").flatMap((n) => slugVariants(n)));
  if (flag("file")) {
    const lines = readFileSync(flag("file"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const l of lines) tokens.push(...(flag("as-names") !== null && args.includes("--as-names") ? slugVariants(l) : [l]));
  }
  /* The control group rides along on every sweep. Six extra requests. */
  const before = new Set(tokens);
  tokens = [...new Set([...tokens, ...CONTROL_TOKENS])];
  const added = CONTROL_TOKENS.filter((t) => !before.has(t));
  if (added.length) console.log(`(adding ${added.length} control token(s): ${added.join(", ")})`);
  if (!tokens.length) {
    console.error("usage: node scripts/gd-sweep.mjs [--tokens a,b] [--names \"Some Co-op,Other\"] [--file list.txt [--as-names]] [--concurrency 4] [--delay 150]");
    process.exit(2);
  }
  console.log(`sweeping ${tokens.length} candidate token(s) at ${BASE}, ${CONC} at a time, ${DELAY}ms apart`);
  const results = await sweep(tokens);
  const hits = results.filter((r) => r.verdict === "HIT");
  const elevators = [...new Set(hits.flatMap((h) => h.destinations.map((d) => `${h.token}/${d}`)))];
  console.log(`\n${hits.length} token(s) answered, carrying ${elevators.length} destination(s):`);
  for (const h of hits) for (const d of h.destinations) console.log(`  ${d}  (token ${h.token})`);
  const odd = results.filter(isLead);
  if (odd.length) {
    console.log(`\n${odd.length} answer(s) that were neither a hit nor a plain 401. A 401 means ` +
      `"private OR nonexistent" and says nothing; anything else means the server got somewhere, ` +
      `so these are LEADS and worth trying again later:`);
    for (const o of odd) console.log(`  ${o.token}: ${o.verdict}${o.body ? ` — ${JSON.stringify(o.body)}` : ""}`);
  }

  /* THE CONTROL GROUP IS CHECKED LAST AND LOUDEST. */
  const { ok: controlOk, lost } = controlReport(results);
  if (!controlOk) {
    console.log(`\n::error title=the sweep could not find what it already knows::` +
      `${lost.length} control token(s) did not answer: ${lost.join(", ")}. Until that is ` +
      `explained, "no new hits" from this run means nothing — the endpoint, the network or ` +
      `this script may be the thing that changed.`);
    process.exitCode = 1;
  } else {
    console.log(`\ncontrol: all ${CONTROL_TOKENS.length} known token(s) answered, so a miss above is a real miss.`);
  }
  console.log(`\nSUMMARY_JSON ${JSON.stringify({ tried: results.length, hits: hits.map((h) => ({ token: h.token, destinations: h.destinations, commodities: h.commodities, offers: h.offers })) })}`);
}

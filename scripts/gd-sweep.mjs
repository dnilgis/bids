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
  return [...new Set([squashed, camel, hyphen, dropCoop].filter((s) => s.length >= 4))];
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
  tokens = [...new Set(tokens)];
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
  const odd = results.filter((r) => r.status !== 401 && r.verdict !== "HIT");
  if (odd.length) {
    console.log(`\n${odd.length} answer(s) that were neither a hit nor a plain 401 — worth a look:`);
    for (const o of odd) console.log(`  ${o.token}: ${o.verdict}${o.body ? ` — ${JSON.stringify(o.body)}` : ""}`);
  }
  console.log(`\nSUMMARY_JSON ${JSON.stringify({ tried: results.length, hits: hits.map((h) => ({ token: h.token, destinations: h.destinations, commodities: h.commodities, offers: h.offers })) })}`);
}

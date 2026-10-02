#!/usr/bin/env node
/* READ EVERY AGRICHARTS BOARD'S OWN LOCATION LIST, KEEP IT, AND USE IT.
 *
 *     node scripts/agricharts-published.mjs            fetch and report; writes nothing
 *     node scripts/agricharts-published.mjs --write    save geocodes/agricharts-published.json
 *                                                      and fill missing coordinates
 *
 * For every AgriCharts host this repository reads (sources/ with platform
 * agricharts or agricharts-cashgrid) and every one the sweep is pointed at
 * (data/platforms.json, probe-lists/agricharts-*.txt), asks
 * <host>/inc/cashbids/cashbids-js.php once and records each location the
 * operator published: name, street, city, state, ZIP, phone, coordinate. See
 * lib/agricharts-published.mjs.
 *
 * THE FILL never overwrites. A source is filled only when it has NO coordinate,
 * the published entry has the source's own locationId on the source's own
 * host, the published STATE equals the manifest's state, and the coordinate is
 * inside the continental box. latPrecision is "street" when the operator
 * published a street address with it, else "town". The note says where it came
 * from, in a sentence of its own.
 *
 * One request per host per run, one at a time, 400 ms apart. */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformHost, publishedUrl, parsePublished, plausible } from "../lib/agricharts-published.mjs";
import { UA } from "../lib/cdp.mjs";
import { cashgridCandidates } from "./agricharts-sweep.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "geocodes/agricharts-published.json");
const SOURCES = join(ROOT, "sources");

export function hostsToAsk(root = ROOT) {
  const hosts = new Set();
  for (const f of readdirSync(join(root, "sources")).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(join(root, "sources", f), "utf8"));
    if (!/^agricharts/.test(s.platform ?? "")) continue;
    const h = platformHost(s.url); if (h) hosts.add(h);
  }
  /* The hosts the sweep is pointed at by default: every AgriCharts site in the
     ledger, by the platform host its first cashgrid candidate names. */
  const plat = JSON.parse(readFileSync(join(root, "data/platforms.json"), "utf8")).sites ?? {};
  for (const [u, r] of Object.entries(plat)) {
    if (r?.platform !== "agricharts") continue;
    const h = platformHost(cashgridCandidates(u)[0] ?? ""); if (h) hosts.add(h);
  }
  for (const f of readdirSync(join(root, "probe-lists")).filter((x) => /^agricharts-.*\.txt$/.test(x)))
    for (const line of readFileSync(join(root, "probe-lists", f), "utf8").split(/\r?\n/)) {
      const u = line.replace(/#.*/, "").trim(); if (!/^https?:\/\//.test(u)) continue;
      const h = platformHost(u); if (h) hosts.add(h);
    }
  return [...hosts].sort();
}

/** Which sources a published file would fill, and why the rest are not. Pure. */
export function planFill(sources, published) {
  const fill = [], refused = [];
  for (const s of sources) {
    if (!/^agricharts/.test(s.platform ?? "") || s.lat != null || s.lon != null) continue;
    const host = platformHost(s.url);
    const p = host ? published?.hosts?.[host]?.locations?.[String(s.locationId)] : null;
    if (!p) { refused.push({ id: s.id, why: `no published entry for location ${s.locationId} on ${host ?? s.url}` }); continue; }
    if (!p.state || p.state !== s.state) { refused.push({ id: s.id, why: `published state ${p.state} is not the manifest's ${s.state}` }); continue; }
    if (!plausible(p)) { refused.push({ id: s.id, why: "published coordinate missing or outside the continental box" }); continue; }
    fill.push({ id: s.id, lat: p.lat, lon: p.lon, precision: p.street ? "street" : "town", host, p });
  }
  return { fill, refused };
}

async function get(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ac.signal });
    return { status: res.status, body: res.ok ? await res.text() : "" };
  } catch (e) { return { status: 0, error: e.message }; }
  finally { clearTimeout(t); }
}

async function main() {
  const write = process.argv.includes("--write");
  const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { hosts: {} };
  const out = { generated: new Date().toISOString(),
    note: "Each AgriCharts host's own published location list, from <host>/inc/cashbids/cashbids-js.php. Written by scripts/agricharts-published.mjs. A host that did not answer this run keeps its last good entry.",
    hosts: {} };
  const hosts = hostsToAsk();
  let ok = 0, locs = 0;
  for (const host of hosts) {
    const r = await get(publishedUrl(host));
    const parsed = r.body ? parsePublished(r.body) : null;
    if (parsed && Object.keys(parsed).length) {
      out.hosts[host] = { fetched: out.generated, locations: parsed };
      ok++; locs += Object.keys(parsed).length;
      console.log(`ok     ${host.padEnd(40)} ${Object.keys(parsed).length} location(s)`);
    } else {
      if (prior.hosts?.[host]) out.hosts[host] = prior.hosts[host];
      console.log(`none   ${host.padEnd(40)} ${r.error ?? `HTTP ${r.status}${r.body ? ", no bids array" : ""}`}${prior.hosts?.[host] ? " (kept last good)" : ""}`);
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  console.log(`\n${ok} of ${hosts.length} host(s) answered, ${locs} location(s) published`);

  const sources = readdirSync(SOURCES).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SOURCES, f), "utf8")));
  const { fill, refused } = planFill(sources, out);
  console.log(`fill: ${fill.length} source(s) would get the board's own coordinate; ${refused.length} not filled`);
  for (const r of refused) console.log(`  - ${r.id}: ${r.why}`);
  if (!write) return;
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  for (const f of fill) {
    const path = join(SOURCES, `${f.id}.json`);
    const s = JSON.parse(readFileSync(path, "utf8"));
    if (s.lat != null || s.lon != null) continue;
    s.lat = f.lat; s.lon = f.lon; s.latPrecision = f.precision;
    s.note = `${s.note ?? ""}\n\nCOORDINATE (${new Date().toISOString().slice(0, 10)}): the operator's own, as published for location ${s.locationId} in https://${f.host}/inc/cashbids/cashbids-js.php`
      + ` (${[f.p.street, f.p.city, f.p.state, f.p.zip].filter(Boolean).join(", ")}). Filled by scripts/agricharts-published.mjs only because the manifest had none and the published state agrees.`;
    writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });

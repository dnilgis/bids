#!/usr/bin/env node
/* COUNTY GOVERNMENT HOME PAGES IN TEN CORN-BELT STATES, TO LOOK FOR WHERE
 * EACH COUNTY'S ASSESSOR, AUDITOR OR RECORDER POSTS LAND SALES.
 *
 * 2026-10-18. For agsist's land sale source finder (scripts/landsrc_job.py
 * there). The repository holds no county websites, so this asks Wikidata
 * (CC0) once for every county with a FIPS code in IA, OH, NE, SD, MN, MI, KS,
 * MO, IN and ND, and its "official website" when one is recorded. It runs in
 * capture.yml's plan job (prep=county-sites): the sandbox cannot reach
 * Wikidata, Actions can.
 *
 * Writes probe-lists/county-sites.txt ("url  # <fips> <County>, <ST>") and
 * probe-lists/county-sites.json (every county, with or without a site, so the
 * ones with none are counted, not lost).
 *
 *   node scripts/county-sites-list.mjs [--out-dir DIR] [--from saved.json]
 *
 * capture.yml prep=county-sites list=probe-lists/county-sites.txt pick=land
 * follow=6 depth=2 save=countysites. A home page here is where to look.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
export const STATES = { IA: "19", OH: "39", NE: "31", SD: "46", MN: "27", MI: "26", KS: "20", MO: "29", IN: "18", ND: "38" };
const ST_OF = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));

export const QUERY = `SELECT ?item ?fips ?label ?site WHERE {
  ?item wdt:P882 ?fips .
  FILTER(STRLEN(?fips) = 5 && (${Object.values(STATES).map((s) => `STRSTARTS(?fips, "${s}")`).join(" || ")}))
  FILTER NOT EXISTS { ?item wdt:P576 ?gone }
  OPTIONAL { ?item wdt:P856 ?site }
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "en") }
}`;

export function countiesFrom(sparqlJson) {
  const by = new Map();
  for (const b of sparqlJson?.results?.bindings ?? []) {
    const fips = b.fips?.value;
    if (!/^\d{5}$/.test(fips ?? "") || !ST_OF[fips.slice(0, 2)] || fips.endsWith("000")) continue;
    if (!by.has(fips)) by.set(fips, { fips, state: ST_OF[fips.slice(0, 2)], name: "", sites: new Set(), wikidata: b.item?.value ?? "" });
    const c = by.get(fips);
    if (b.label?.value && !c.name) c.name = b.label.value.replace(/,\s*[A-Za-z ]+$/, "");
    const s = b.site?.value;
    if (s && /^https?:\/\//i.test(s)) { try { c.sites.add(new URL(s).href); } catch { /* not a URL */ } }
  }
  return [...by.values()].sort((a, b) => a.fips.localeCompare(b.fips))
    .map((c) => {
      const hosts = new Set();
      const sites = [...c.sites].sort((a, b) => (b.startsWith("https") - a.startsWith("https")) || a.length - b.length)
        .filter((u) => { const h = new URL(u).hostname.replace(/^www\./, ""); if (hosts.has(h)) return false; hosts.add(h); return true; });
      return { ...c, sites: sites.slice(0, 2) };
    });
}

export function listLines(counties) {
  const seen = new Set(), out = [];
  for (const c of counties) for (const s of c.sites) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(`${s}  # ${c.fips} ${c.name}, ${c.state}`);
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  const dir = a.includes("--out-dir") ? a[a.indexOf("--out-dir") + 1] : join(ROOT, "probe-lists");
  let j;
  if (a.includes("--from")) j = JSON.parse(readFileSync(a[a.indexOf("--from") + 1], "utf8"));
  else {
    const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(QUERY);
    for (let i = 0; i < 4 && !j; i++) {
      try {
        const r = await fetch(url, { headers: { accept: "application/sparql-results+json",
          "user-agent": "agsist-bids-county-sites/1.0 (https://agsist.com; one query per run)" }, signal: AbortSignal.timeout(90000) });
        if (r.ok) j = await r.json(); else console.error(`wikidata HTTP ${r.status}`);
      } catch (e) { console.error(`wikidata: ${e?.message ?? e}`); }
      if (!j) await new Promise((res) => setTimeout(res, 15000 * (i + 1)));
    }
    if (!j) throw new Error("Wikidata did not answer; no list written");
  }
  const counties = countiesFrom(j);
  if (counties.length < 700) throw new Error(`only ${counties.length} counties came back (expected about 880); no list written`);
  const lines = listLines(counties);
  mkdirSync(dir, { recursive: true });
  const per = Object.fromEntries(Object.keys(STATES).map((st) => [st, { counties: counties.filter((c) => c.state === st).length,
    withSite: counties.filter((c) => c.state === st && c.sites.length).length }]));
  writeFileSync(join(dir, "county-sites.txt"), ["# COUNTY HOME PAGES FOR THE LAND SALE SOURCE FINDER, FOR capture.yml (list=probe-lists/county-sites.txt,",
    "#   pick=land, follow=6, depth=2, save=countysites). Built by scripts/county-sites-list.mjs from Wikidata (CC0) official websites",
    `#   on ${new Date().toISOString().slice(0, 10)}: ${counties.length} counties, ${counties.filter((c) => c.sites.length).length} with a site.`,
    ...lines].join("\n") + "\n");
  writeFileSync(join(dir, "county-sites.json"), JSON.stringify({ built: new Date().toISOString(), source: "Wikidata P882 (FIPS) + P856 (official website)",
    perState: per, companies: counties.map((c) => ({ company: `${c.fips} ${c.name}, ${c.state}`, ...c })) }, null, 1) + "\n");
  console.log(JSON.stringify(per));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()))
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });

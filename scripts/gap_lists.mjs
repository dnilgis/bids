#!/usr/bin/env node
/* THE TWO LISTS OF WHAT WE DO NOT HAVE.
 *
 * Sig: "I want a list of elevators that don't publish bids online and also a
 * list of elevators with no associated website."
 *
 * These are the honest other half of the map. A green pin says we read a board;
 * a grey pin says we know the elevator exists. Neither says WHY a grey one is
 * grey, and there are two completely different reasons:
 *
 *   NO WEBSITE ON FILE    We have a name, a town and usually a phone, and no
 *                         URL at all. Every state registry entry is like this —
 *                         states publish licensees, not websites. Nothing can be
 *                         scraped until somebody finds the site, and for many of
 *                         these there may not be one. This is a phone-call list.
 *
 *   PUBLISHES NO BOARD    We have the website, a browser loaded it, followed the
 *                         operator's own Cash Bids link where there was one, and
 *                         no board came back. Some of these genuinely do not post
 *                         bids online; some put them behind a login, an image or
 *                         a PDF. Either way this is NOT a scraping backlog — it
 *                         is a finding, and it is the one that says how much of
 *                         the country is reachable at all.
 *
 * Writing them out as CSV because they are worklists, not dashboards: they get
 * sorted, filtered, split between people and phoned.
 *
 *   node scripts/gap_lists.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p, d) => (existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), "utf8")) : d);

const directory = read("data/directory.json", { elevators: [] }).elevators;
const registries = read("data/registries.json", { businesses: [] }).businesses;
const known = read("data/known-elevators.json", { elevators: [] }).elevators;
const platforms = read("data/platforms.json", { sites: {} }).sites;

const bare = (u) => String(u || "").trim().toLowerCase()
  .replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");

/* Barchart's directory is the only source that carries an operator URL, so a
   host is "known" only if it appears there or in a source file we read. */
const urlFor = new Map();
for (const e of known) {
  const h = bare(e.url);
  if (h) urlFor.set(`${(e.company || "").toLowerCase()}|${(e.city || "").toLowerCase()}`, h);
}

const csv = (rows, cols) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => {
    const v = r[c] ?? "";
    return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  }).join(","))].join("\n") + "\n";

/* ── 1. no website on file ─────────────────────────────────────────────── */
const noSite = [];
for (const b of registries) {
  const key = `${(b.name || "").toLowerCase()}|${(b.city || "").toLowerCase()}`;
  if (urlFor.has(key)) continue;                       // Barchart knows its site
  noSite.push({
    name: b.name, city: b.city, state: b.state || "", county: b.county || "",
    phone: b.phone || "", address: b.address || "",
    licences: (b.licences || []).join("+"),
    capacity: b.capacity || "",
    licensedBy: b.licensedBy || "",
    outOfState: b.outOfState ? "yes" : "",
    source: b.source || "",
  });
}
/* Barchart facilities that carry no url either — a smaller, different group:
   somebody sold their data and still has no site. */
for (const e of known) {
  if (bare(e.url)) continue;
  noSite.push({
    name: e.company || e.location, city: e.city, state: e.state || "",
    county: e.county || "", phone: e.phone || "", address: e.address || "",
    licences: "", capacity: "", licensedBy: "", outOfState: "",
    source: "barchart",
  });
}

/* ── 2. has a website, publishes no board ──────────────────────────────── */
const noBoard = [];
for (const [url, v] of Object.entries(platforms)) {
  if (v.status !== "no-platform") continue;            // unreachable is a retry
  const host = bare(url);
  const facilities = known.filter((e) => bare(e.url) === host);
  noBoard.push({
    website: url,
    operator: facilities[0]?.company || "",
    city: facilities[0]?.city || "",
    state: facilities[0]?.state || "",
    phone: facilities[0]?.phone || "",
    facilities: facilities.length,
    boardPageTried: (v.triedBoardPages || []).join(" | "),
    /* The hosts the page did serve. This is the evidence for whether it is a
       site with no bids or a platform we have no signature for yet. */
    servedHosts: (v.hosts || []).slice(0, 6).join(" "),
    lastAsked: v.seenAt || "",
  });
}

mkdirSync(join(ROOT, "data/gaps"), { recursive: true });
writeFileSync(join(ROOT, "data/gaps/no-website.csv"),
  csv(noSite.sort((a, b) => (a.state + a.name).localeCompare(b.state + b.name)),
      ["name", "city", "state", "county", "phone", "address", "licences", "capacity",
       "licensedBy", "outOfState", "source"]));
writeFileSync(join(ROOT, "data/gaps/no-board-published.csv"),
  csv(noBoard.sort((a, b) => a.website.localeCompare(b.website)),
      ["website", "operator", "city", "state", "phone", "facilities",
       "boardPageTried", "servedHosts", "lastAsked"]));

const withPhone = noSite.filter((r) => r.phone).length;
console.log(`no website on file       ${String(noSite.length).padStart(5)}  ` +
            `(${withPhone} carry a phone — that is the callable list)`);
console.log(`has a site, no board     ${String(noBoard.length).padStart(5)}  ` +
            `of ${Object.keys(platforms).length} asked so far`);
console.log(`\nwrote data/gaps/no-website.csv and data/gaps/no-board-published.csv`);

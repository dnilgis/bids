#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   FILL THE MISSING STATE — from this repository's own data, or not at all.
   ═══════════════════════════════════════════════════════════════════════════
   Sixteen source manifests carry `state: null`. On the agsist coverage map that
   shows as a place with a town and no state, which reads as a defect and is one.

   RULE 1 SAYS DO NOT INVENT A TOWN, A COORDINATE OR A COLOUR, AND A STATE IS
   THE SAME KIND OF THING. I know perfectly well that CHS Big Sky is in Montana.
   Typing that in is exactly the move this project has decided against, because
   the next person cannot tell what was measured from what was remembered.

   So two derivations, both from data already in this repository, and each with
   a refusal:

   1. NEAREST NEIGHBOURS. Every point in our own sources, in the state-registry
      geocode and in the directory geocode that carries BOTH a coordinate and a
      state — 3,920 of them — is a labelled point. The fifteen nearest to a
      stateless source must all name the same state, and the fifteenth must be
      inside sixty miles. Superior East fails this and stays null, correctly:
      Superior sits on the Kansas line and its neighbours split NE/KS.

   2. OPERATOR SIBLINGS. When every other location the same operator publishes
      names one state, take it. Aurora Cooperative fails this — it has ten in
      Nebraska and one in Kansas — and Premier Cooperative fails it too, five in
      Iowa and four in Wisconsin. Both stay null.

   WHAT CANNOT BE DERIVED STAYS NULL AND IS PRINTED. Nine of the sixteen carry
   no coordinate at all and no sibling agreement, so nothing here can reach them.
   Several are not towns in the first place — "Futures Markets", "CHS Primeland"
   — which is a known and accepted state, not a gap to paper over.

   Run:  node scripts/fill_states.mjs [--write]
   Without --write it says what it would do and changes nothing.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WRITE = process.argv.includes("--write");
const NEIGHBOURS = 15;      // how many labelled points must agree
const MAX_MILES = 60;       // and how far the furthest of them may be

const rd = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const miles = (a, b) => {
  const dy = (a.lat - b.lat) * 69;
  const dx = (a.lon - b.lon) * 69 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

const index = rd("data/index.json");
const places = rd("geocodes/places.json");

/* ---- the labelled reference set ---------------------------------------- */
const ref = [];
const push = (lat, lon, st) => {
  if (typeof lat === "number" && typeof lon === "number" && st) ref.push({ lat, lon, st });
};
for (const s of index.sources) push(s.lat, s.lon, s.usState);
for (const v of Object.values(places.registry ?? {})) push(v.lat, v.lon, v.state);
for (const v of Object.values(places.known ?? {})) push(v.lat, v.lon, v.state);

/* ---- operator siblings -------------------------------------------------- */
const sibStates = new Map();
for (const s of index.sources) {
  const op = s.id.split("-")[0];
  if (!sibStates.has(op)) sibStates.set(op, new Set());
  if (s.usState) sibStates.get(op).add(s.usState);
}

const rows = [];
for (const s of index.sources.filter((x) => !x.usState)) {
  let state = null, why = null;

  if (typeof s.lat === "number" && typeof s.lon === "number") {
    const near = ref.map((r) => ({ st: r.st, d: miles(s, r) }))
                    .sort((a, b) => a.d - b.d).slice(0, NEIGHBOURS);
    const agree = [...new Set(near.map((n) => n.st))];
    if (agree.length === 1 && near[near.length - 1].d < MAX_MILES) {
      state = agree[0];
      why = `its ${NEIGHBOURS} nearest labelled points are all ${state}, the furthest ${near[near.length - 1].d.toFixed(0)} miles away`;
    } else if (agree.length > 1) {
      why = `REFUSED — its nearest neighbours split ${agree.join("/")}, so it is on a state line`;
    } else {
      why = `REFUSED — nothing labelled within ${MAX_MILES} miles`;
    }
  }

  if (!state) {
    const sib = [...(sibStates.get(s.id.split("-")[0]) ?? [])];
    if (sib.length === 1) {
      state = sib[0];
      why = `every other location this operator publishes is in ${state}`;
    } else if (sib.length > 1 && !why) {
      why = `REFUSED — this operator spans ${sib.join("/")}`;
    } else if (!why) {
      why = "REFUSED — no coordinate and no sibling carries a state";
    }
  }
  rows.push({ id: s.id, location: s.location, state, why });
}

const filled = rows.filter((r) => r.state);
console.log(`${ref.length} labelled reference points\n`);
console.log(`${rows.length} sources carry no state. ${filled.length} can be derived, ${rows.length - filled.length} cannot.\n`);
for (const r of rows) {
  console.log(`  ${(r.state ?? "—").padEnd(4)} ${r.id.padEnd(44)} ${r.why}`);
}

if (!WRITE) { console.log("\n(dry run — pass --write to change the manifests)"); process.exit(0); }

let wrote = 0;
for (const r of filled) {
  const p = join(ROOT, "sources", r.id + ".json");
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (j.state) continue;
  j.state = r.state;
  /* SAY WHERE IT CAME FROM, IN THE FILE. A state that appears with no
     provenance is indistinguishable from one somebody typed in. */
  j.stateDerivedBy = r.why;
  writeFileSync(p, JSON.stringify(j, null, 1) + "\n");
  wrote++;
}
console.log(`\nwrote ${wrote} manifest(s)`);

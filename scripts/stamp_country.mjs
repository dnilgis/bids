#!/usr/bin/env node
/* WHICH COUNTRY EACH SOURCE IS IN, WRITTEN DOWN ONCE.
 *
 * Sig, 2026-09-06: "i say we add canadian elevators please".
 *
 * Adding them is not the work. The work is that until today this network had
 * no way to say which money a price was in, and one Ontario co-operative had
 * been publishing Canadian dollars into it since 2026-08-29 -- corn at 6.92
 * beside a US median of 4.99, a ratio of 1.387, which is the exchange rate and
 * not a market. Before more Canadian elevators are added, every source has to
 * declare where it is.
 *
 * THREE WAYS A SOURCE GETS ITS COUNTRY, AND THEY ARE NOT EQUAL:
 *
 *   state       Its own two-letter code places it. 949 of 973.
 *   operator    It has no state -- it is a delivery point at somebody else's
 *               plant, "ADM CC" or "Bunge PDC", and the manifest has no town
 *               for it. Its country is taken from THE OTHER LOCATIONS OF THE
 *               SAME OPERATOR in this repository, and only when they are
 *               unanimous. That is a measurement of our own data, not a
 *               lookup. 24 of 973.
 *   (none)      Nothing is written. A source this cannot place keeps a null
 *               country and merge_bids.mjs withholds its rows and counts them.
 *
 * `countryVia` records which of the three it was, so the next person can tell
 * a code that was read off a manifest from one that was inferred across an
 * operator's other yards.
 *
 * IT DOES NOT TOUCH A SOURCE THAT ALREADY DECLARES ONE. A stamp that overwrites
 * a human decision every time it runs is not a stamp, it is a race.
 *
 *   node scripts/stamp_country.mjs            report only
 *   node scripts/stamp_country.mjs --write    write the manifests
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { countryOfState, CURRENCY_OF_COUNTRY } from "../lib/currency.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "sources");
const WRITE = process.argv.includes("--write");

const files = readdirSync(SRC).filter((f) => f.endsWith(".json")).sort();
const all = files.map((f) => ({ f, s: JSON.parse(readFileSync(join(SRC, f), "utf8")) }));

/* THE OPERATOR'S OWN OTHER YARDS. Keyed on the manifest's `operator` string
   verbatim, because that is the field the rest of this repo joins on and a
   normalised key here would silently group two different companies. */
const byOperator = new Map();
for (const { s } of all) {
  const c = countryOfState(s.state);
  if (!c) continue;
  const k = String(s.operator ?? "").trim();
  if (!k) continue;
  if (!byOperator.has(k)) byOperator.set(k, new Set());
  byOperator.get(k).add(c);
}

const out = { state: 0, operator: 0, unplaced: [], already: 0, changed: [] };

for (const rec of all) {
  const { f, s } = rec;
  if (s.country) { out.already++; continue; }

  let country = countryOfState(s.state);
  let via = country ? "state" : null;

  if (!country) {
    const seen = byOperator.get(String(s.operator ?? "").trim());
    if (seen && seen.size === 1) { country = [...seen][0]; via = "operator"; }
  }

  if (!country) { out.unplaced.push(f); continue; }

  out[via]++;
  const currency = CURRENCY_OF_COUNTRY[country];
  out.changed.push({ f, country, currency, via, operator: s.operator });

  if (WRITE) {
    /* Inserted after `state` so the three geographic facts sit together, and
       the file is otherwise rewritten key-for-key in its own order. */
    const o = {};
    let placed = false;
    for (const [k, v] of Object.entries(s)) {
      o[k] = v;
      if (k === "state") {
        o.country = country; o.currency = currency; o.countryVia = via;
        placed = true;
      }
    }
    if (!placed) { o.country = country; o.currency = currency; o.countryVia = via; }
    writeFileSync(join(SRC, f), JSON.stringify(o, null, 2) + "\n");
  }
}

console.log(`${all.length} manifests`);
console.log(`  already declared   ${out.already}`);
console.log(`  placed by state    ${out.state}`);
console.log(`  placed by operator ${out.operator}`);
console.log(`  UNPLACED           ${out.unplaced.length}${out.unplaced.length ? " — " + out.unplaced.join(", ") : ""}`);

const byCountry = {};
for (const c of out.changed) byCountry[c.country] = (byCountry[c.country] || 0) + 1;
console.log("  by country        ", byCountry);

const inferred = out.changed.filter((c) => c.via === "operator");
if (inferred.length) {
  console.log(`\n  ${inferred.length} placed from the operator's other yards, which is the weaker of the two:`);
  for (const c of inferred) console.log(`    ${c.f.padEnd(48)} ${c.country}  (${c.operator})`);
}
if (!WRITE) console.log("\nreport only. Re-run with --write to change the manifests.");

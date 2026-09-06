#!/usr/bin/env node
/* THE CHECK THAT WOULD HAVE CAUGHT WANSTEAD, AND WHY IT IS A REPORT.
 *
 * lib/currency.mjs stops a board publishing in an unknown currency. It cannot
 * stop a board publishing in the WRONG one: if a manifest says USD and the
 * board is Canadian, every guard agrees and the number goes out.
 *
 * There is a measurement available for that, and it comes from our own feed.
 * Basis is the part of a cash bid that is local, and within one currency it
 * sits in a tight band. Measured 2026-09-06 across 9,808 rows, per-source
 * medians:
 *
 *     corn      743 sources   q1 -0.60   median -0.41   q3 -0.30   max +0.50
 *     soybeans  669 sources   q1 -0.78   median -0.68   q3 -0.50   max +0.35
 *     wheat     352 sources   q1 -0.78   median -0.65   q3 -0.55   max +0.35
 *     sorghum   145 sources   q1 -0.90   median -0.75   q3 -0.70   max +0.70
 *
 * Wanstead's corn median was +1.45 and its wheat +1.50. A US board does not
 * reach there, because the gap between the two is the currency conversion the
 * Ontario basis carries.
 *
 * WHY THIS IS NOT A GUARD. The separation is real but it is not a law. A
 * genuine US board at a processor can run a basis nobody else runs, and a
 * threshold tight enough to catch a 1.45 is close enough to a legitimate 0.70
 * that it will eventually withhold a real price. Withholding a real price on a
 * statistical smell is exactly the kind of thing this repository does not do.
 *
 * So it NAMES and it does not refuse. The number to act on is the source, not
 * the row: a board that sits outside its own currency's envelope on more than
 * one crop is a board somebody should look at.
 *
 * IT COMPARES LIKE WITH LIKE. Sources are grouped by their DECLARED currency
 * and each is judged against its own group. Once Canada is properly labelled,
 * the CAD group is its own envelope and a mislabelled US board would stand out
 * in it just as clearly.
 *
 *   node scripts/currency_audit.mjs
 *   node scripts/currency_audit.mjs --iqr 4     how far out is "out"
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const IQR_OUT = Number(flag("iqr", 4));

const MERGED = join(ROOT, "data", "merged");
if (!existsSync(MERGED)) {
  console.error("no data/merged — run scripts/merge_bids.mjs first. This reads what was published, not what could be.");
  process.exit(2);
}

const rows = [];
for (const f of readdirSync(MERGED).filter((f) => f.endsWith(".json"))) {
  const d = JSON.parse(readFileSync(join(MERGED, f), "utf8"));
  for (const b of d.bids || []) rows.push(b);
}

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (v, q) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/* One number per source per crop: its own median basis. A source with three
   deliveries of corn gets one corn figure, so a big board cannot outvote a
   small one. */
const per = new Map();
for (const b of rows) {
  if (b.basis == null || !b.crop || !b.currency) continue;
  const k = `${b.currency}␟${b.crop}␟${b.source}`;
  if (!per.has(k)) per.set(k, []);
  per.get(k).push(b.basis);
}

const groups = new Map();
for (const [k, v] of per) {
  const [cur, crop, source] = k.split("␟");
  const g = `${cur}␟${crop}`;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push({ source, m: median(v), n: v.length });
}

const flags = new Map();
const lines = [];
for (const [g, list] of [...groups].sort()) {
  const [cur, crop] = g.split("␟");
  /* A GROUP THIS SMALL HAS NO ENVELOPE. Three sources cannot describe a
     distribution, and a quartile of three is a number with no meaning. Said
     out loud rather than computed and quietly ignored. */
  if (list.length < 20) {
    lines.push(`${cur} ${crop.padEnd(9)} ${String(list.length).padStart(4)} sources — too few to describe an envelope, not judged`);
    continue;
  }
  const ms = list.map((x) => x.m);
  const q1 = quantile(ms, 0.25), q3 = quantile(ms, 0.75), med = median(ms);
  const iqr = q3 - q1;
  const lo = med - IQR_OUT * iqr, hi = med + IQR_OUT * iqr;
  const out = list.filter((x) => x.m < lo || x.m > hi);
  lines.push(`${cur} ${crop.padEnd(9)} ${String(list.length).padStart(4)} sources  ` +
    `q1 ${q1.toFixed(2)}  med ${med.toFixed(2)}  q3 ${q3.toFixed(2)}  ` +
    `envelope ${lo.toFixed(2)} to ${hi.toFixed(2)}  ${out.length} outside`);
  for (const o of out) {
    if (!flags.has(o.source)) flags.set(o.source, []);
    flags.get(o.source).push(`${crop} ${o.m > 0 ? "+" : ""}${o.m.toFixed(2)} (${cur} envelope ${lo.toFixed(2)}..${hi.toFixed(2)})`);
  }
}

console.log(`${rows.length} published rows, ${per.size} source-and-crop medians, ${IQR_OUT} x IQR\n`);
for (const l of lines) console.log("  " + l);

const many = [...flags].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
const one = [...flags].filter(([, v]) => v.length === 1);

console.log(`\nOUTSIDE ITS OWN CURRENCY'S ENVELOPE ON MORE THAN ONE CROP — ${many.length} source(s).`);
console.log("This is the shape a currency error makes: it moves every crop on the board at once.");
for (const [s, why] of many) console.log(`  ${s}\n      ${why.join("\n      ")}`);
if (!many.length) console.log("  none");

console.log(`\nOn one crop only — ${one.length} source(s). Usually a real basis, occasionally a parse.`);
for (const [s, why] of one.slice(0, 25)) console.log(`  ${s.padEnd(46)} ${why[0]}`);
if (one.length > 25) console.log(`  ... and ${one.length - 25} more`);

/* NOTHING EXITS NON-ZERO. This is a report. A board that trips it needs a
   person, not a red run that somebody learns to re-run until it passes. */

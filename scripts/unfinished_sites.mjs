#!/usr/bin/env node
/* WHAT THE LEDGER STILL OWES AN ASK.
 *
 * data/platforms.json holds 893 operator sites and knows perfectly well which
 * of them are undecided. discover.mjs --resume applies exactly this rule:
 *
 *     decided  =  status === "platform"
 *              OR (status === "no-platform" AND probeVersion >= PROBE_VERSION)
 *
 * Everything else comes round again — an `unreachable` because that is a fact
 * about the network and not about the operator, and a `no-platform` written by
 * an older, weaker probe because a negative is only as good as the test that
 * produced it.
 *
 * BUT --resume ONLY FILTERS A LIST IT IS GIVEN, and the list the national sweep
 * is given comes from barchart_sites.mjs, which has been producing nothing.
 * 169 sites have sat as "unreachable — a retry, NOT a finding about this
 * operator" since 2026-08-30, in a ledger that says they come round again, with
 * no list anywhere carrying their URLs. The promise was real and undeliverable.
 *
 * This is that list. It reads the ledger, applies discover's own rule, and
 * prints one URL per line. It writes nothing and decides nothing.
 *
 *   node scripts/unfinished_sites.mjs > probe-lists/unfinished.txt
 *   node scripts/unfinished_sites.mjs --why        # with the reason, for a person
 *
 * PROBE_VERSION is read out of discover.mjs rather than copied, the same way
 * sweep-plan.mjs does it, so the day it changes this does not quietly disagree.
 */
import { readFileSync } from "node:fs";

const LEDGER = process.argv.find((a) => a.endsWith(".json")) ?? "data/platforms.json";
const WHY = process.argv.includes("--why");

const src = readFileSync(new URL("./discover.mjs", import.meta.url), "utf8");
const pv = /export const PROBE_VERSION\s*=\s*(\d+)/.exec(src);
if (!pv) { console.error("could not read PROBE_VERSION out of scripts/discover.mjs"); process.exit(2); }
const PROBE_VERSION = Number(pv[1]);

/** The one rule, shared with discover.mjs --resume and scripts/sweep-plan.mjs. */
export function owedAnAsk(rec, probeVersion) {
  if (!rec) return "never recorded";
  if (rec.status === "platform") return null;
  if (rec.status === "no-platform")
    return (rec.probeVersion ?? 0) >= probeVersion
      ? null
      : `written off by probe v${rec.probeVersion ?? 0}, this one is v${probeVersion}`;
  if (rec.status === "unreachable") return `unreachable: ${String(rec.why ?? "").slice(0, 90)}`;
  return `status ${rec.status ?? "absent"}`;
}

export function unfinished(ledger, probeVersion) {
  const out = [];
  for (const [url, rec] of Object.entries(ledger?.sites ?? {})) {
    const why = owedAnAsk(rec, probeVersion);
    if (why) out.push({ url, why, status: rec?.status ?? null });
  }
  out.sort((a, b) => a.url.localeCompare(b.url));
  return out;
}

/* Only when run, so the functions above stay importable by the tests. */
if (process.argv[1] && process.argv[1].endsWith("unfinished_sites.mjs")) {
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  const rows = unfinished(ledger, PROBE_VERSION);
  for (const r of rows) console.log(WHY ? `${r.url}  # ${r.why}` : r.url);
  const tally = {};
  for (const r of rows) tally[r.status ?? "none"] = (tally[r.status ?? "none"] ?? 0) + 1;
  console.error(`${rows.length} of ${Object.keys(ledger.sites ?? {}).length} site(s) in ${LEDGER} ` +
    `are owed an ask against probe v${PROBE_VERSION}: ` +
    (Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ") || "none"));
}

#!/usr/bin/env node
/* WHAT EACH BOARD'S OWN COMMITTED ROWS SAY ABOUT HOW IT ROUNDS.
 *
 * THE FAILURE THIS EXISTS TO CATCH, MEASURED 2026-09-08.
 *
 * `cashRounding` is a claim about somebody else's spreadsheet, written into our
 * manifest on a day somebody looked. Boards change, and nothing ever went back
 * to check. Nine enabled sources were found publishing rows their own declared
 * mode cannot explain:
 *
 *   keystonecooperative  hamilton, holland, legacyfeed, whitecloud,
 *                        scirclevillegrain        declared floor-cent
 *   niewohnerfarms       albion, elgin, spalding  declared floor-cent
 *   cliffordfarmerscoopelevator-tharaldsonethanol declared round-cent
 *
 * `floor-cent` is the claim that cash = FLOOR(basis + futures), so a residual is
 * never negative. Every one of those eight boards carries -0.25c rows in the
 * capture committed under it. The claim is not tight, it is FALSE, and a false
 * one is not caught by anything: a minority of failing rows is classified
 * `lagging`, the file publishes, and those rows carry a futures quote whose
 * identity was never proven. Nobody sees it, because nothing is red.
 *
 * THE THIRD TIME THIS SHAPE HAS BITTEN. `futuresUnits` was set by zero sources
 * for eighteen days (2026-09-07). `cashRounding` disagreed between siblings on
 * one board for longer than that. Both are per-source knobs that are silent
 * when wrong, and are only discovered when a row happens to land badly. So this
 * one gets an executable check rather than a note.
 *
 * TWO QUESTIONS, AND ONLY ONE OF THEM IS A FAILURE.
 *
 *   REFUTED   The declared mode does not explain the source's own committed
 *             capture. That is a manifest that is wrong about a board we have
 *             the bytes for, and test/declared-rounding.test.mjs fails on it.
 *
 *   SIBLINGS  Two locations of one operator, reading ONE board on ONE platform,
 *             declare different modes. That is a question, not a verdict — a
 *             co-op can genuinely run two site configurations — so it is a
 *             worklist row and nothing more.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: a mode WIDER than the capture needs. 298 of
 * the 814 testable sources are in that state, nearly all of them declaring
 * `round-cent-either` where `round-cent` would do, and a board that rounds only
 * on the days its futures land badly looks exactly like one that never rounds.
 * Riceland's Weiner published four exact rows on 2026-09-04 and needed
 * round-cent by 2026-09-08. Narrowing on one capture would break it on the next.
 * The count is worth knowing and is printed; it is not a failure.
 *
 * The measurement is `explainedByRounding` from lib/board.mjs — the function the
 * reader itself applies — and not a second copy of the rule. A guard that
 * measures the same quantity differently from the thing it guards eventually
 * disagrees with it, and this repository has paid for that twice.
 *
 *   node scripts/rounding_audit.mjs           report, exit 0
 *   node scripts/rounding_audit.mjs --write   also write the siblings worklist
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { explainedByRounding } from "../lib/board.mjs";
import { checkIdentity } from "../lib/parse.mjs";
import { rowsFromCapture, roundingEvidence, describeEvidence } from "../lib/rounding.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const P = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/* A source declares its rounding in one of two ways and the reader honours
   both: a named mode, or a raw `cashRoundingCents` tolerance under the default
   `exact`. An audit that models only the first reported thirty sources as
   broken that were doing nothing of the kind — measured on the first pass. */
export const declaresRounding = (s) =>
  Boolean(s?.cashRounding) || Number(s?.cashRoundingCents ?? 0) > 0;

export const declarationOf = (s) =>
  s?.cashRounding ? s.cashRounding
    : Number(s?.cashRoundingCents ?? 0) > 0 ? `exact +/- ${s.cashRoundingCents}c`
    : "exact";

/** Every enabled source that has a committed capture with testable rows. */
export function auditSources(root = ROOT) {
  const out = [];
  for (const f of readdirSync(join(root, "sources")).sort()) {
    if (!f.endsWith(".json")) continue;
    const s = JSON.parse(readFileSync(join(root, "sources", f), "utf8"));
    if (!s.enabled) continue;
    const cap = join(root, "data", `${s.id}.json`);
    if (!existsSync(cap)) continue;
    const rows = rowsFromCapture(JSON.parse(readFileSync(cap, "utf8")));
    if (!rows.length) continue;

    const unexplained = explainedByRounding(
      s, checkIdentity(rows), Number(s.cashRoundingCents ?? 0));
    const ev = roundingEvidence(rows);
    out.push({
      id: s.id, operator: s.operator ?? null, platform: s.platform ?? null,
      declared: declarationOf(s), declares: declaresRounding(s),
      rows: rows.length, unexplained: unexplained.length, ev,
    });
  }
  return out;
}

/* REFUTED, and the word is chosen. A source that declares NOTHING and whose
   rows do not balance is not a manifest error — it is the strict guard doing
   its job, and the reader will say so at the next poll. This names only the
   sources that make a claim their own bytes contradict. */
export const refuted = (audit) => audit.filter((a) => a.declares && a.unexplained);

/* Siblings: one operator, one platform, more than one declaration. The id's
   prefix is the operator key everywhere else in this repository. */
export function siblingDisagreements(audit) {
  const by = new Map();
  for (const a of audit) {
    const key = `${a.id.split("-")[0]}|${a.platform}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(a);
  }
  const out = [];
  for (const [key, group] of by) {
    const modes = new Set(group.map((g) => g.declared));
    if (modes.size < 2) continue;
    const [operator, platform] = key.split("|");
    for (const g of group)
      out.push({
        operator: g.operator ?? operator, operator_key: operator, platform,
        id: g.id, declared: g.declared,
        siblings_declare: [...modes].filter((m) => m !== g.declared).sort().join(" / "),
        this_capture_supports: g.ev.confident ?? "",
        residuals: g.ev.residuals.join(" "),
        rows_unexplained: g.unexplained,
      });
  }
  return out.sort((a, b) =>
    a.operator_key.localeCompare(b.operator_key) || a.id.localeCompare(b.id));
}

const csv = (rows, cols) => [
  cols.join(","),
  ...rows.map((r) => cols.map((c) => {
    const v = String(r[c] ?? "");
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")),
].join("\n") + "\n";

export const SIBLINGS_CSV = "data/gaps/rounding-disagreement.csv";
export const SIBLING_COLS = ["operator", "platform", "id", "declared",
  "siblings_declare", "this_capture_supports", "residuals", "rows_unexplained"];

export function main(argv = process.argv.slice(2)) {
  const audit = auditSources();
  const bad = refuted(audit);
  const sib = siblingDisagreements(audit);

  /* Printed, never failed on — see the header. */
  const wider = audit.filter((a) =>
    a.declares && !a.unexplained && a.ev.confident && a.ev.confident !== a.declared);

  console.log(`${audit.length} enabled source(s) have a committed capture with testable rows\n`);
  console.log(`REFUTED BY THEIR OWN CAPTURE: ${bad.length}`);
  for (const a of bad)
    console.log(`  ${a.id}\n      declares ${a.declared}, and ${a.unexplained} of ${a.rows} `
      + `committed row(s) do not fit it\n      ${describeEvidence(a.ev)}`);
  console.log(`\nSIBLINGS DISAGREEING ON ONE BOARD: ${sib.length} source(s) in `
    + `${new Set(sib.map((s) => s.operator_key)).size} operator/platform group(s)`);
  console.log(`WIDER THAN THEIR CAPTURE NEEDS: ${wider.length} `
    + `(not a failure — a board rounds only on the days its futures land badly)`);

  if (argv.includes("--write")) {
    mkdirSync(join(ROOT, "data/gaps"), { recursive: true });
    writeFileSync(join(ROOT, SIBLINGS_CSV), csv(sib, SIBLING_COLS));
    console.log(`\nwrote ${SIBLINGS_CSV}`);
  }
  return bad.length;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

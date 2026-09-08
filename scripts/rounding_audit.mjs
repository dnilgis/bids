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
import { rowsFromCapture, roundingEvidence, describeEvidence, residualCents } from "../lib/rounding.mjs";

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

/* ONE CAPTURE IS NOT ENOUGH EVIDENCE TO SET A MODE — learned 2026-09-08, the
 * same day, twice.
 *
 * The first version of this judged each source against the ONE capture sitting
 * in data/<id>.json. Nine sources were corrected from it in the morning. By the
 * evening the poll had rewritten those captures and FOUR OF THE NINE were
 * refuted again — Keystone's Holland and Legacy Feed and Niewohner's Albion and
 * Elgin had each grown a +0.5c row, so the `round-cent` set that morning wanted
 * to be `round-cent-either`. Nothing was wrong with the boards and nothing was
 * wrong with the manifests; the evidence had simply been one afternoon deep.
 *
 * A cash board rounds only on the days its futures quote lands on a fraction of
 * a cent. Judging it on a single reading measures the day, not the board, and
 * chasing that produces a manifest edit every time the market moves.
 *
 * So the residuals ACCUMULATE. Every run unions what it sees into
 * data/rounding-residuals.json and the verdict is taken against everything this
 * project has ever observed from that board. A mode set from the union stops
 * flapping: today's +0.5c is already in tomorrow's evidence.
 *
 * It only ever grows. A residual seen once is a fact about that board forever,
 * and forgetting it is how the mode narrows back to something a later day
 * refutes.
 *
 * COUNTS, NOT A SET. Written first as a plain union of distinct values, and
 * that quietly broke the margin: lib/rounding.mjs will not NAME a mode unless
 * it beats its nearest rival by MIN_MARGIN rows, and ten rows collapsed to four
 * distinct residuals turned a margin of four into a margin of one — so a board
 * with plenty of evidence came out "TOO FEW TO STATE". How OFTEN a residual has
 * been seen is exactly the thing that margin is counting. */
export function mergeResiduals(store, id, residuals, now = new Date().toISOString()) {
  const prev = store[id] ?? { residuals: {}, firstSeen: now, reads: 0 };
  const counts = { ...prev.residuals };
  for (const r of residuals) {
    const k = String(Number(r.toFixed ? r.toFixed(4) : r));
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return { ...prev, residuals: counts, lastSeen: now, reads: (prev.reads ?? 0) + 1,
           grew: Object.keys(counts).length > Object.keys(prev.residuals).length };
}

/** The accumulated residuals as rows roundingEvidence can weigh, counts kept. */
export function storedRows(entry) {
  const out = [];
  for (const [value, n] of Object.entries(entry?.residuals ?? {}))
    for (let i = 0; i < n; i++) out.push(Number(value));
  return out;
}

/** Every enabled source that has a committed capture with testable rows. */
export function auditSources(root = ROOT, store = readResiduals(root)) {
  const out = [];
  for (const f of readdirSync(join(root, "sources")).sort()) {
    if (!f.endsWith(".json")) continue;
    const s = JSON.parse(readFileSync(join(root, "sources", f), "utf8"));
    if (!s.enabled) continue;
    const cap = join(root, "data", `${s.id}.json`);
    if (!existsSync(cap)) continue;
    const rows = rowsFromCapture(JSON.parse(readFileSync(cap, "utf8")));
    if (!rows.length) continue;

    /* Judged against the UNION of everything ever seen from this board, not
       against today's reading — see mergeResiduals above. The synthetic rows
       carry the accumulated residuals through the same explainedByRounding and
       roundingEvidence the reader uses, so there is still exactly one
       implementation of the rule. */
    const seen = storedRows(store[s.id]);
    /* residualCents, not the arithmetic written out again. The test below pins
       that this file computes no residual of its own, and the first draft of
       this line tripped it — correctly. lib/rounding.mjs's own header is about
       exactly this: two copies of one measurement eventually disagree. */
    const today = rows.map(residualCents);
    const all = [...seen, ...today];
    const asRows = all.map((res) => ({ cash: 1, basis: 0, futuresPrice: 100 + res }));

    const unexplained = explainedByRounding(
      s, checkIdentity(asRows), Number(s.cashRoundingCents ?? 0));
    const ev = roundingEvidence(asRows);
    out.push({
      id: s.id, operator: s.operator ?? null, platform: s.platform ?? null,
      declared: declarationOf(s), declares: declaresRounding(s),
      rows: rows.length, observations: all.length, seenBefore: seen.length,
      distinct: new Set(all).size,
      unexplained: unexplained.length, ev, todayResiduals: today,
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

export function readResiduals(root = ROOT) {
  const p = join(root, RESIDUALS);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).sources ?? {}) : {};
}

const csv = (rows, cols) => [
  cols.join(","),
  ...rows.map((r) => cols.map((c) => {
    const v = String(r[c] ?? "");
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")),
].join("\n") + "\n";

export const RESIDUALS = "data/rounding-residuals.json";
export const SIBLINGS_CSV = "data/gaps/rounding-disagreement.csv";
export const SIBLING_COLS = ["operator", "platform", "id", "declared",
  "siblings_declare", "this_capture_supports", "residuals", "rows_unexplained"];

export function main(argv = process.argv.slice(2)) {
  const store = readResiduals();
  const audit = auditSources(ROOT, store);
  const bad = refuted(audit);
  const sib = siblingDisagreements(audit);

  /* Printed, never failed on — see the header. */
  const wider = audit.filter((a) =>
    a.declares && !a.unexplained && a.ev.confident && a.ev.confident !== a.declared);

  console.log(`${audit.length} enabled source(s) have a committed capture with testable rows\n`);
  console.log(`REFUTED BY EVERYTHING EVER SEEN FROM THEIR BOARD: ${bad.length}`);
  for (const a of bad) {
    console.log(`  ${a.id}\n      declares ${a.declared}, and ${a.unexplained} of `
      + `${a.observations} observed residual(s) do not fit it`
      + ` (${a.seenBefore} carried in from earlier reads)\n      ${describeEvidence(a.ev)}`);
    /* A WARNING, NOT A FAILED SUITE. This used to be an assertion in
       test/declared-rounding.test.mjs over the live sources/ and data/ trees,
       and that was wrong: a cash board that rounds a little wider on a Tuesday
       would turn every push in the repository red for something no commit
       caused. The suite now tests the RULE; the live tree is reported here,
       where the poll's log and the daily read both pick it up. */
    console.log(`::warning title=rounding refuted::${a.id} declares ${a.declared}; `
      + `set "cashRounding": "${a.ev.confident ?? "(nothing — undeclare it)"}"`);
  }
  console.log(`\nSIBLINGS DISAGREEING ON ONE BOARD: ${sib.length} source(s) in `
    + `${new Set(sib.map((s) => s.operator_key)).size} operator/platform group(s)`);
  console.log(`WIDER THAN THEIR CAPTURE NEEDS: ${wider.length} `
    + `(not a failure — a board rounds only on the days its futures land badly)`);

  if (argv.includes("--write")) {
    mkdirSync(join(ROOT, "data/gaps"), { recursive: true });
    writeFileSync(join(ROOT, SIBLINGS_CSV), csv(sib, SIBLING_COLS));

    const now = new Date().toISOString();
    let grew = 0;
    for (const a of audit) {
      const merged = mergeResiduals(store, a.id, a.todayResiduals, now);
      if (merged.grew) grew++;
      store[a.id] = { residuals: merged.residuals, firstSeen: merged.firstSeen,
                      lastSeen: merged.lastSeen, reads: merged.reads };
    }
    writeFileSync(join(ROOT, RESIDUALS), JSON.stringify({
      generated: now,
      note: "Every residual (quoted futures minus cash-plus-basis, in cents) this project has "
          + "ever observed from each board. It only grows: a residual seen once is a fact about "
          + "that board forever. scripts/rounding_audit.mjs judges cashRounding against this "
          + "union rather than against one capture, because one capture measures the day.",
      sources: store,
    }, null, 1) + "\n");
    console.log(`\nwrote ${SIBLINGS_CSV} and ${RESIDUALS} (${grew} board(s) showed a residual `
      + `they had not shown before)`);
  }
  return bad.length;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

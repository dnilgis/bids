/* AURORA COOPERATIVE'S DTN BOARD CHANGED HOW IT ROUNDS CASH ON 2026-09-24.
 *
 * Until 18:47 UTC that day every Aurora board posted its cash rounded half up
 * to the cent. The committed captures show residuals of -0.5, -0.25, 0 and
 * +0.25 across some 12,000 rows and nothing else, which is why the manifests
 * said `round-cent`. From 21:07 UTC the cash is the arithmetic FLOORED to the
 * cent: residuals 0, +0.25, +0.5, +0.75 and never a negative one. On
 * 2026-09-25 fifteen boards refused on the same +0.75c row (S/O27 soybeans,
 * cash 12.06, basis -0.7, quote 1276.75; 12.0675 floors to 12.06 and would
 * round to 12.07) and the last good files started to age out.
 *
 * Rows go through the real adapter and the real guard (buildFile). What is
 * pinned is the manifests: this fails on the round-cent declarations and
 * passes on floor-cent. The fixture holds rows as the repository committed
 * them; test/fixtures/aurora-keene-rounding.json says which.
 *
 * superior is deliberately not in the list. Its cash has been posted to four
 * decimals since the change (12.0675, not 12.06), every residual is 0, and no
 * row can tell floor from round there, so nothing supports editing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused, CASH_ROUNDING, explainedByRounding } from "../lib/board.mjs";
import { extract } from "../lib/adapters/dtn-cs.mjs";
import { validateSource } from "../lib/sources.mjs";

const ROOT = new URL("..", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
const FX = json("test/fixtures/aurora-keene-rounding.json");
const FLOORED = [
  "aurorasouth", "byron", "centralcity", "chapman", "claycenter", "futuresmarkets",
  "geneva", "grandisland", "harvard", "hubbell", "keene", "marquette", "murphy",
  "republic", "sedan", "superioreast",
];
const manifest = (k) => json(`sources/auroracooperative-${k}.json`);
const NOW = "2026-09-25T17:09:00.000Z";

const ticks = (c) => { const i = Math.floor(c + 1e-9); return `${i}'${Math.round((c - i) * 8)}`; };
/* A DTN cash-bids payload in the shape api.dtn.com returns, for one location. */
const payload = (rows, m) => JSON.stringify(rows.map((b) => ({
  basisPrice: b.basisDollars, cashPrice: b.cash,
  commodityDisplayName: b.commodity, contractDeliveryLabel: b.delivery,
  conversionUsed: "0", convertedPrice: null, currency: "USD",
  futuresQuote: ticks(b.futuresPriceCents), futuresChange: "0'0",
  location: { id: Number(m.locationId), name: m.location },
  primaryPrice: { basisPrice: b.basisDollars, cashPrice: b.cash, currency: "USD", unitOfMeasure: "Bushels" },
  realTime: false, symbol: b.futuresMonth, unitOfMeasure: "Bushels",
})));
const build = (rows, m, mode = m.cashRounding) => {
  const source = { ...m };
  if (mode === undefined) delete source.cashRounding; else source.cashRounding = mode;
  return buildFile(payload(rows, m), { now: NOW, sourceUrl: m.url, source, extract });
};
const refusal = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof Refused, e.message); return e.message; } assert.fail("expected a refusal"); };
const withSoy = (o) => FX.floored.map((r) =>
  r.delivery === "S/O27" && r.commodity === "Soybeans" ? { ...r, ...o } : { ...r });

test("the sixteen boards that changed declare floor-cent, and the manifests are still valid", () => {
  for (const k of FLOORED) {
    const m = manifest(k);
    assert.equal(m.cashRounding, "floor-cent", k);
    assert.equal(m.cashRoundingCents, 0, `${k}: floor-cent is a rule, not a tolerance`);
    assert.deepEqual(validateSource(m, new Set()), [], k);
  }
});

test("every one of them accepts the board that was refused on 2026-09-25", () => {
  for (const k of FLOORED) {
    const r = build(FX.floored, manifest(k));
    assert.equal(r.file.count, 12, k);
    assert.equal(r.verified, 12, `${k}: every row balances under the declared rule`);
  }
});

test("round-cent, the old declaration, refuses that board on the +0.75c row", () => {
  const msg = refusal(() => build(FX.floored, manifest("keene"), "round-cent"));
  assert.match(msg, /S\/O27[^\n]*cash 12\.06[^\n]*basis -0\.7[^\n]*1276\.75c[^\n]*\(\+0\.75c\)/);
});

test("round-cent-either is not the fix: it still refuses the +0.75c row", () => {
  const msg = refusal(() => build(FX.floored, manifest("keene"), "round-cent-either"));
  assert.match(msg, /1 of 12 testable row\(s\) fail/);
  assert.match(msg, /\(\+0\.75c\)/);
});

test("the board as it was before the change publishes under round-cent and is refused under floor-cent", () => {
  /* If Aurora goes back to rounding, this is what the manifest sees. */
  assert.equal(build(FX.rounded, manifest("keene"), "round-cent").file.count, 12);
  const msg = refusal(() => build(FX.rounded, manifest("keene"), "floor-cent"));
  assert.match(msg, /7 of 12 testable row\(s\) fail/);
});

/* --- the guard is not looser for floor-cent ------------------------------ */

test("floor-cent still refuses a cash cell off by more than a cent, and decimal slips", () => {
  const m = manifest("keene");
  /* 1c low, 2c low, ten cents high, decimal slip up, decimal slip down. */
  for (const cash of [12.05, 12.04, 12.6, 120.6, 1.206])
    refusal(() => build(withSoy({ cash }), m));
  refusal(() => build(withSoy({ futuresPriceCents: 127675 }), m));   // quote read a hundredfold high
});

test("floor-cent admits [0, 1) cent and nothing outside it; round-cent's negative half is gone", () => {
  const rule = CASH_ROUNDING["floor-cent"];
  for (const s of [0, 0.25, 0.5, 0.75]) assert.ok(rule(s), String(s));
  for (const s of [-0.25, -0.5, 1, 1.25, 1.75, 2.75]) assert.ok(!rule(s), String(s));
  /* Not a superset of round-cent: it admits +0.5 and +0.75 and drops -0.5 and
     -0.25. Neither window reaches a cent, and a moved column is tens of cents. */
  const off = [-0.5, -0.25, 0.5, 0.75, 1].map((s) => ({ signedCents: s, offCents: Math.abs(s) }));
  assert.deepEqual(explainedByRounding({ cashRounding: "floor-cent" }, off, 0).map((r) => r.signedCents),
    [-0.5, -0.25, 1]);
  assert.deepEqual(explainedByRounding({ cashRounding: "round-cent" }, off, 0).map((r) => r.signedCents),
    [0.5, 0.75, 1]);
});

/* --- Berthold Farmers: canola is quoted per tonne against cash per cwt --- */

test("Berthold: as declared it publishes 15 rows and withholds the three canola rows", () => {
  const m = json("sources/bertholdfarmers-berthold.json");
  assert.deepEqual(m.foreignQuote, ["Canola"]);
  assert.deepEqual(validateSource(m, new Set()), []);
  const html = readFileSync(new URL("fixtures/board-sweep/cashbidssingle-bertholdfarmerscom.html", ROOT), "utf8");
  const r = buildFile(html, { now: "2026-09-07T21:25:00Z", sourceUrl: m.url, source: m });
  assert.equal(r.file.count, 15);
  assert.equal(r.verified, 12);
  assert.deepEqual(r.withheld.map((w) => [w.commodity, w.rows]), [["Canola", 1], ["Canola", 1], ["Canola", 1]]);
  assert.ok(!r.file.bids.some((b) => /canola/i.test(b.commodity)));
  /* Without the declaration the board is refused, on the canola rows only. */
  const bare = { ...m }; delete bare.foreignQuote;
  const msg = refusal(() => buildFile(html, { now: "2026-09-07T21:25:00Z", sourceUrl: m.url, source: bare }));
  assert.match(msg, /3 of 15 testable row\(s\) fail/);
  assert.match(msg, /Canola/);
});

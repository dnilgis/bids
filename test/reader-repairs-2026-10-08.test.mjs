/* THREE READERS REPAIRED FROM THE REPOSITORY'S OWN EVIDENCE -- 2026-10-08.
 *
 * 1. farmerseande-cedarrapids and farmerseande-wapello read the operator's
 *    MOBILE board, https://mobile.farmerseande.com/cash/prices.php, which has
 *    answered HTTP 500 on every read since the last good one at
 *    2026-10-01T15:05Z. The same operator's CASHGRID board is read live by
 *    their sibling farmerseande-kalona, and that board lists both locations
 *    under the same l= ids (84551 Cedar Rapids, 82049 Wapello). Moved there,
 *    with the sibling's identityAlternative and cashRounding -- the same move
 *    farmerscooperative made on 2026-10-02 (commit f0f45d79e9d).
 *
 * 2. sharedonfarms-owensound refused on every read since it was enabled, on
 *    one row of nine: cash 770.8997, basis -45.0003, quoted 815.9 against
 *    "November 2026". Those balance exactly in their own unit, which is CAD
 *    per TONNE -- ICE canola -- while the identity check reads cash and basis
 *    as dollars per bushel. Declared foreignQuote ["Canola"], the existing
 *    doctrine Berthold already uses: the row is withheld and named, never
 *    published, and the rows that balance prove the columns.
 *
 * Neither change touches lib/: no guard moves. What is pinned is the
 * manifests, and that the guard still refuses everything it refused before
 * that is not the canola row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildFile, Refused } from "../lib/board.mjs";
import { extract as graindesk } from "../lib/adapters/graindesk.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";

const ROOT = new URL("..", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
const refusal = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof Refused, e.message); return e.message; }
  assert.fail("expected a refusal");
};

/* --- 1. Farmers Elevator & Exchange: off the dead mobile board ------------ */

const DEAD = "https://mobile.farmerseande.com/cash/prices.php";
const MOVED = ["farmerseande-cedarrapids", "farmerseande-wapello"];

test("farmerseande: the two moved locations read the board their live sibling reads", () => {
  const sib = json("sources/farmerseande-kalona.json");
  assert.equal(sib.platform, "agricharts-cashgrid", "the sibling is no longer the reference this rests on");
  for (const id of MOVED) {
    const m = json(`sources/${id}.json`);
    assert.deepEqual(validateSource(m, new Set()), [], id);
    for (const k of ["platform", "url", "identityAlternative", "cashRounding"])
      assert.equal(m[k], sib[k], `${id}: ${k} differs from the sibling on the same board`);
    /* The l= id is what identifies the location on any AgriCharts board, and it
       did not change: the move is a url, not a re-identification. */
    assert.equal(m.locationId, { "farmerseande-cedarrapids": "84551", "farmerseande-wapello": "82049" }[id]);
    assert.match(m.note, /MOVED 2026-10-08/, `${id}: the move is not recorded in its own note`);
  }
});

test("farmerseande: no enabled source still points at the dead mobile board", () => {
  const still = readdirSync(new URL("sources/", ROOT))
    .map((f) => json(`sources/${f}`))
    .filter((s) => s.enabled !== false && s.url === DEAD)
    .map((s) => s.id);
  assert.deepEqual(still, []);
});

test("farmerseande: the rounding the move carries is the one the board's own history supports", () => {
  /* round-cent-either admits -0.5..+0.5c. Every residual farmerseande-kalona
     has ever shown off this board is inside that, so the declaration is a
     measurement of the board and not of one day. */
  const h = json("data/rounding-residuals.json").sources["farmerseande-kalona"];
  assert.ok(h && h.reads > 100, "the sibling's residual history is missing or thin");
  for (const r of Object.keys(h.residuals).map(Number))
    assert.ok(r >= -0.5 && r <= 0.5, `a residual of ${r}c is outside round-cent-either`);
});

/* --- 2. Sharedon Farms: the canola row is per tonne ---------------------- */

/* NOT A CAPTURE. The canola row is the one the live refusal printed, to the
   digit; the other rows are built to balance exactly the way Grain Desk's
   four-decimal cash does (fixtures/graindesk-albertlea-2026-08-20.json), with
   the commodity names the gd sweep read off this board. What is under test is
   the manifest against the guard, not the parser. */
const offer = (destination, deliveryPeriod, futuresMonth, cash, basis) => ({
  destination, deliveryPeriod, comments: "2026 Crop", futuresMonth,
  futuresPrice: (Math.round((cash - basis) * 1e6) / 1e4).toFixed(4),
  futuresChange: "0", basisPrice: basis.toFixed(4), standardCashPrice: cash.toFixed(4),
  convertedCashPrice: null,
});
const BOARD = (m) => JSON.stringify([
  { commodity: { name: "Corn Yellow" }, offers: [
    offer(m.locationId, "01 Oct 2026 to 31 Oct 2026", "December 2026", 4.6325, -0.35),
    offer(m.locationId, "01 Nov 2026 to 30 Nov 2026", "December 2026", 4.6825, -0.30) ] },
  { commodity: { name: "Soybeans Crush (RR)" }, offers: [
    offer(m.locationId, "01 Oct 2026 to 31 Oct 2026", "November 2026", 12.4775, -0.40),
    offer(m.locationId, "01 Nov 2026 to 30 Nov 2026", "November 2026", 12.5275, -0.35) ] },
  { commodity: { name: "Wheat SRW" }, offers: [
    offer(m.locationId, "01 Jul 2027 to 31 Jul 2027", "July 2027", 6.4175, -0.25) ] },
  { commodity: { name: "Canola -" }, offers: [{
    destination: m.locationId, deliveryPeriod: "01 Aug 2026 to 31 Aug 2026", comments: "2026 Crop",
    futuresMonth: "November 2026", futuresPrice: "815.9000", futuresChange: "0",
    basisPrice: "-45.0003", standardCashPrice: "770.8997", convertedCashPrice: null }] },
]);
const NOW = "2026-10-08T15:45:00.000Z";
const SHAREDON = () => json("sources/sharedonfarms-owensound.json");
const build = (m) => buildFile(BOARD(m), { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: graindesk });

test("sharedon: without the declaration the board refuses on the canola row and on nothing else", () => {
  /* The control. This is the refusal the live board gave 1,471 times. */
  const bare = SHAREDON(); delete bare.foreignQuote;
  const msg = refusal(() => build(bare));
  assert.match(msg, /1 of 6 testable row\(s\) fail/);
  assert.match(msg, /cash 770\.8997\s+basis -45\.0003\s+->\s+81590c but quoted 815\.9c/);
});

test("sharedon: declared, the canola row is withheld and named, and the rest publishes verified", () => {
  const m = SHAREDON();
  assert.deepEqual(m.foreignQuote, ["Canola"]);
  assert.deepEqual(validateSource(m, new Set()), []);
  const r = build(m);
  assert.equal(r.file.count, 5);
  assert.equal(r.verified, 5, "every published row must have balanced");
  assert.ok(!r.file.bids.some((b) => /canola/i.test(b.commodity)), "a per-tonne row published");
  const w = r.withheld.find((x) => /canola/i.test(x.commodity));
  assert.ok(w, "the canola row vanished instead of being named");
  assert.match(w.why, /foreign quote/);
  assert.equal(r.file.currency, "CAD");
});

test("sharedon: the declaration buys nothing for a row that is not canola", () => {
  /* A bean row off by a tenth of a dollar still refuses the board. foreignQuote
     names canola rows only; it does not widen anything for the rest. */
  const m = SHAREDON();
  const body = JSON.parse(BOARD(m));
  body[1].offers[0].standardCashPrice = "12.3775";
  const msg = refusal(() => buildFile(JSON.stringify(body),
    { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: graindesk }));
  assert.match(msg, /testable row\(s\) fail/);
  assert.match(msg, /cash 12\.3775/);
});

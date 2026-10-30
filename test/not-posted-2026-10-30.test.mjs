/* A BOARD THE OPERATOR LEFT OFF ITS OWN FEED -- 2026-10-30 (lib/not-posted.mjs).
 *
 * Real cases, from the operators' own feeds as the runner's browser read them
 * (capture.yml run 40981238561, fixtures in test/fixtures/bidslive-2026-10-30/):
 *   Country Partners, Midway: DTN site E0149201 answers 177 bids on 12 yards, none for 16684.
 *   CHS Farmers Elevator, Circle and Richey: Bushel answers 26 bids on Glasgow, Glendive, Macon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildFile, Refused } from "../lib/board.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { toConfig, validateSource } from "../lib/sources.mjs";
import { retireDue, retired, daysMissing, isDay, RETIRE_AFTER_DAYS } from "../lib/not-posted.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = (f) => readFileSync(join(ROOT, "test", "fixtures", "bidslive-2026-10-30", f), "utf8");
const manifest = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));
const NOW = new Date("2026-10-30T01:00:00Z");
const run = (m, body) => {
  try { buildFile(body, { now: NOW, sourceUrl: m.url, source: toConfig(m), extract: adapterFor(m.platform) }); }
  catch (e) { return e; }
  return null;
};
const CASES = [["countrypartnerscooperative-midway", "dtncs-countrypartners.json"],
  ["chsfarmerselevator-circle", "bushel-chsfarmers.json"], ["chsfarmerselevator-richey", "bushel-chsfarmers.json"]];

for (const [id, file] of CASES) {
  test(`${id}: missing from the operator's feed reads as not posted, with the flag`, () => {
    const m = manifest(id);
    assert.equal(m.notPostedSince, "2026-10-29");
    assert.deepEqual(validateSource(m, new Set()), []);
    const e = run(m, FX(file));
    assert.ok(e instanceof Refused, e?.message);
    assert.equal(e.empty, true, e.message);
    assert.match(e.message, /^not posted by the operator: location /);
  });
  test(`${id}: without the flag the same feed is an ordinary refusal (never inferred)`, () => {
    const { notPostedSince, ...m } = manifest(id);
    const e = run(m, FX(file));
    assert.ok(e instanceof Refused);
    assert.notEqual(e.empty, true);
    assert.match(e.message, /parsed \d+ bids but none for location/);
  });
}

test("a yard that is in the feed still publishes whatever the flag says", () => {
  /* Glasgow is a real CHS yard on the same capture. */
  const glasgow = { ...manifest("chsfarmerselevator-circle"), id: "chsfarmerselevator-glasgow", location: "Glasgow",
    locationId: "a6565504-49fa-447d-a038-4b856f95550e", labelInFeed: "Glasgow" };
  const e = run(glasgow, FX("bushel-chsfarmers.json"));
  assert.ok(!e || e.empty !== true, e?.message);
});

test("notPostedSince must be a day", () => {
  assert.ok(validateSource({ ...manifest("chsfarmerselevator-circle"), notPostedSince: "yesterday" }, new Set())
    .some((p) => /notPostedSince must be a day/.test(p)));
  assert.equal(isDay("2026-10-29"), true);
  assert.equal(isDay("2026-13-40"), false);
});

test("the 30-day rule: due on day 30, not on day 29, retired with the reason and date, id kept", () => {
  const s = manifest("chsfarmerselevator-richey");
  const d29 = new Date("2026-11-27T12:00:00Z"), d30 = new Date("2026-11-28T00:00:00Z");
  assert.equal(RETIRE_AFTER_DAYS, 30);
  assert.equal(daysMissing(s.notPostedSince, d29), 29);
  assert.deepEqual(retireDue([s], d29), []);
  assert.deepEqual(retireDue([s], d30).map((x) => x.id), ["chsfarmerselevator-richey"]);
  const r = retired(s, d30);
  assert.equal(r.id, s.id);
  assert.equal(r.enabled, false);
  assert.match(r.retired, /^2026-11-28: not posted by the operator\. Richey has been missing from CHS Farmers Elevator \(Montana\)'s own feed since 2026-10-29 \(30 days/);
  assert.deepEqual(retireDue([r], d30), [], "already retired: not due again");
  assert.deepEqual(retireDue([{ ...s, notPostedSince: undefined }], d30), [], "no flag, no retirement");
});

/* ── Wanstead (Ontario): listed, not read as CAD ──
 * The DTN rows state USD on every row; the manifest says CAD. The reader takes the feed's word over ours
 * (lib/currency.mjs) and refuses. The real soybean row: cash 15.89, "basis" 3.55, futures 1234'0 (USD 12.34).
 * That basis is the CAD cash minus a USD futures price, not a basis anybody posted, and the reader has no FX
 * rate, so reading the board as CAD would still publish a mixed-money basis. Held for the lead. */
test("Wanstead stays refused: the feed says USD, the manifest CAD, and the basis mixes the two", () => {
  const m = manifest("wansteadfarmerscooperative-anywansteadbranch");
  const body = FX("dtncs-wanstead.json");
  const e = run(m, body);
  assert.ok(e, "refused");
  assert.match(e.message, /the manifest declares CAD and the feed states USD on every row/);
  const soy = JSON.parse(body).find((r) => r.commodityDisplayName === "Soybeans");
  assert.equal(soy.currency, "USD");
  assert.equal(Math.round((soy.cashPrice - soy.basisPrice) * 100) / 100, 12.34, "cash - basis is the USD futures price");
});

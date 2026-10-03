/* QT Market Center boards (lib/adapters/qtmarket.mjs). Fixtures are real script
 * bodies from capture.yml run 37051659428 (Last Updated 10/02/2026 01:55pm).
 * The quotes are the futures DTN boards printed in the same run at 01:20 PM
 * (Burgess, Townsend, Peterson Farms, Agrex): Dec 26 Corn 4.9775, Mar 27 Corn
 * 5.1150, May 27 Corn 5.1850, Nov 26 Soybeans 12.7825, Jan 27 Soybeans 12.9450,
 * Mar 27 Soybeans 13.0475. No board in that run printed Chicago wheat for Dec
 * or Mar, so the wheat rows cannot be checked here and are refused, which is
 * the adapter working. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract, scriptUrl, contractOf, VERIFIED_BY, QtRefused, QtEmptyRefused } from "../lib/adapters/qtmarket.mjs";
import { build, SITES } from "../scripts/qtmarket-manifests.mjs";

const fx = (loc) => readFileSync(new URL(`../fixtures/qtmarket-${loc}-2026-10-02.js`, import.meta.url), "utf8");
const SAME_HOUR = [["ZCZ26", 497.75], ["ZCH27", 511.5], ["ZCK27", 518.5], ["ZSX26", 1278.25], ["ZSF27", 1294.5], ["ZSH27", 1304.75]]
  .map(([symbol, lastCents]) => ({ symbol, lastCents, priced: true }));

test("contract months", () => {
  assert.deepEqual(contractOf("Dec 26"), { code: "Z", yy: "26", label: "Dec 26" });
  assert.equal(contractOf("Fall 2026"), null);
});

test("Hudson Grain: corn and soybeans fit the contracts they name within half a cent, and are stamped", () => {
  const rows = extract(fx("438"), scriptUrl("438"), { contracts: SAME_HOUR });
  assert.deepEqual(rows.map((r) => [r.commodity, r.delivery, r.futures]),
    [["Soybeans", "Fall 2026", "ZSX26"], ["Soybeans", "January 2027", "ZSF27"], ["Corn", "Fall 2026", "ZCZ26"], ["Corn", "January 2027", "ZCH27"]]);
  for (const r of rows) {
    assert.equal(r.verifiedBy, VERIFIED_BY); assert.equal(r.futuresPrice, null); assert.equal(r.locationId, "438");
    const q = SAME_HOUR.find((c) => c.symbol === r.futures).lastCents;
    assert.ok(Math.abs(r.impliedFuturesCents - q) <= 0.5, r.raw);
  }
  assert.deepEqual(rows.unreconciled.map((u) => u.commodity), ["Wheat", "Wheat"]);
});

test("Christian County: a blank commodity cell carries the one above; an expired month is refused, not guessed", () => {
  const rows = extract(fx("441"), scriptUrl("441"), { contracts: SAME_HOUR });
  assert.equal(rows.length, 4);
  assert.ok(rows.unreconciled.some((u) => u.commodity === "White Corn" && /Sep 26/.test(u.why)));
});

test("no quotes, a page that is not the script, and a request with no loc are refused", () => {
  assert.throws(() => extract(fx("438"), scriptUrl("438")), QtRefused);
  assert.throws(() => extract("<html></html>", scriptUrl("438"), { contracts: SAME_HOUR }), QtRefused);
  assert.throws(() => extract(fx("438"), "https://fj.qtmarketcenter.com/js/cashbids.php", { contracts: SAME_HOUR }), QtRefused);
});

test("the manifests on disk are exactly what the generator writes", () => {
  /* 2 on 2026-10-02 afternoon; 13 after the next four QT sites the same evening. */
  assert.equal(SITES.length, 13);
  assert.ok(SITES.every((x) => x.knownId || x.registryId), "every yard names the row it is");
  for (const m of build())
    assert.deepEqual(JSON.parse(readFileSync(new URL(`../sources/${m.id}.json`, import.meta.url), "utf8")), m, m.id);
});

import { isRefusal } from "../lib/board.mjs";
test("Premier Grain Leesburg: 'Call in for Cash Bids.' is an empty board, refused and counted as posting nothing", () => {
  let err = null;
  try { extract(fx("444"), scriptUrl("444"), { contracts: SAME_HOUR }); } catch (e) { err = e; }
  assert.ok(err instanceof QtEmptyRefused && err instanceof QtRefused);
  assert.equal(err.empty, true);
  assert.equal(isRefusal(err), true);
  assert.match(err.message, /Call in for Cash Bids/);
  let other = null;
  try { extract("<html></html>", scriptUrl("444"), { contracts: SAME_HOUR }); } catch (e) { other = e; }
  assert.notEqual(other.empty, true, "a body that is not the script is not an empty board");
});

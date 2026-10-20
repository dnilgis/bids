/* NEW Cooperative's board as Sig's browser saw it on 2026-10-20: the same table
 * the adapter was written for, so it reads again the moment the site lets our
 * reader back in. Sig's page source (Oct 20): bids server-rendered in
 * <turbo-frame id="cashbids">, an <h1> per location, then COMMODITY | DELIVERY
 * | CASH PRICE | BASIS | FUTURE PRICE | FUTURE CHANGE. Example row, Afton corn
 * Oct 2026: $4.26, basis -35, futures 461-4, change -5-4. No vendor widget or
 * feed host: the board is their own server's page.
 *
 * The page is the Oct 2 capture (same markup) with Afton's first corn row set
 * to the Oct 20 numbers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract } from "../lib/adapters/newcoop.mjs";
import { buildFile } from "../lib/board.mjs";
import { loadSources, toConfig } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const OCT2 = readFileSync(new URL("../fixtures/newcoop-cashbids-2026-10-02.html", import.meta.url), "utf8");
/* Afton's first row, Corn Oct 2026, read from the Oct 2 page: $4.64 | -35 | 499-0 | -3-2. */
function oct20() {
  const at = OCT2.indexOf(">Afton</h1>");
  assert.ok(at > 0, "Afton is the first location on the page");
  const end = OCT2.indexOf("</tr>", OCT2.indexOf("<tbody", at));
  const row = OCT2.slice(at, end);
  for (const v of [">$4.64<", ">-35<", ">499-0<", ">-3-2<", ">10/1/2026 - 10/31/2026<"])
    assert.ok(row.includes(v), `the Oct 2 Afton corn row should carry ${v}`);
  const now = row.replace(">$4.64<", ">$4.26<").replace(">499-0<", ">461-4<").replace(">-3-2<", ">-5-4<");
  return OCT2.slice(0, at) + now + OCT2.slice(end);
}

test("the Oct 20 Afton corn row reads: $4.26, basis -35, futures 461-4 (461.50c), change -5-4", () => {
  const rows = extract(oct20(), "https://www.newcoop.com/cash-bids");
  const afton = rows.filter((r) => r.locationId === "Afton" && r.commodity === "Corn");
  const oct = afton.find((r) => r.delivery === "01 Oct 2026 to 31 Oct 2026");
  assert.ok(oct, "Afton Oct corn row missing");
  assert.equal(oct.cash, 4.26);
  assert.equal(oct.basisCents, -35);
  assert.equal(oct.futuresPrice, 461.5);
  assert.equal(oct.futuresChange, -5.5);
  assert.equal(new Set(rows.map((r) => r.locationId)).size, 69, "69 locations, Creston 1 and Creston 2 apart");
  assert.ok(rows.some((r) => r.locationId === "Creston 1") && rows.some((r) => r.locationId === "Creston 2"));
});

test("and the newcoop-afton source publishes it: 461.50 - 35 = 426.5c, inside round-cent-both", () => {
  const src = JSON.parse(readFileSync(new URL("../sources/newcoop-afton.json", import.meta.url), "utf8"));
  const { sources } = loadSources([src]);
  const built = buildFile(oct20(), { now: "2026-10-20T16:00:00.000Z", sourceUrl: src.url,
    source: toConfig(sources[0]), extract: adapterFor("newcoop", null) });
  const bid = built.file.bids.find((b) => b.commodity === "Corn" && /Oct 2026/.test(b.delivery));
  assert.ok(bid, "the Oct corn bid was not published");
  assert.equal(bid.cash, 4.26);
});

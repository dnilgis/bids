/* United Equity (Delphos, Spencerville, Neptune, OH) moved its DTN cash bids board off the home page to
 * /about/cashbidsonly/ on 2026-11-06. The site id is unchanged; only the page the browser lane opens moves. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateSource } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ids = ["unitedequityinc-delphosmain", "unitedequityinc-spencerville", "unitedequityinc-neptune"];

test("United Equity's three boards open the cash bids page, same DTN site", () => {
  for (const id of ids) {
    const m = JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));
    assert.equal(m.browserPage, "https://unitedequityinc.com/about/cashbidsonly/", id);
    assert.equal(m.url, "https://api.dtn.com/markets/sites/e0340101/cash-bids?units=us", id);
    assert.equal(m.website, "https://unitedequityinc.com/", id);
    assert.deepEqual(validateSource(m), [], id);
  }
});

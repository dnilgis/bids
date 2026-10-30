/*
 * Five more AgriCharts cashgrid boards on the browser lane (Oct 30, 2026). Our plain 6-second request got a
 * good read on 8 or 9 of about 99 polls (Farmers Coop Columbus x4, Oct 29 00:00Z to Oct 30 11:00Z) and 7 of
 * about 70 (Siouxland Energy, since its Oct 30 cashgrid move). Same page, same adapter, read the patient way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transportOf, validateSource } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const m = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));
const FIVE = ["farmerscoop-baxtersprings", "farmerscoop-columbus", "farmerscoop-columbuseast",
  "farmerscoop-faulkner", "siouxlandenergy-siouxlandenergy"];

test("the five chronic timeout boards read their own cashgrid page through the browser lane", () => {
  for (const id of FIVE) {
    const s = m(id);
    assert.equal(s.platform, "agricharts-cashgrid-browser", id);
    assert.equal(transportOf(s.platform), "browser", id);
    assert.equal(s.browserPage, s.url, id);
    assert.match(s.url, /\/markets\/cashgrid\.php$/, id);
    assert.deepEqual(validateSource(s, new Set()), [], id);
  }
});

test("Sioux Center stays on DTN (same operator, different feed)", () => {
  assert.notEqual(m("farmerscoop-siouxcenter").platform, "agricharts-cashgrid-browser");
});

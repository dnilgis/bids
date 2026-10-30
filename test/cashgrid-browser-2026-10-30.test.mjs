/* BOARDS READ THE PATIENT WAY -- 2026-10-30.
 *
 * Farmers Win (19 boards), KBQ, Valley Springs, GNP Co, Jewell, Cissna Park and
 * Faas Feed ran "could not read their page ... no answer within" on 35 to 37 of
 * 40 passes (2026-10-29 18:08Z to 2026-10-30 00:24Z). The request is a plain
 * 6-second fetch; a browser on the same runner loaded farmerswin.com (144 KB)
 * and kbqinc.net (48 KB) in capture.yml run 40981238561. They are the same
 * cashgrid page and adapter, asked through the browser lane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { adapterFor } from "../lib/adapters/index.mjs";
import { mergeQuotes } from "../lib/adapters/agricharts.mjs";
import { transportOf, validateSource, acceptOf, wireOf } from "../lib/sources.mjs";
import { planLanes } from "../lib/lanes.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ids = readdirSync(join(ROOT, "sources")).map((f) => f.replace(/\.json$/, ""));
const m = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));
const WANT = [...ids.filter((i) => i.startsWith("farmerswin-")), "kbqinc-kbqinc",
  "valleyspringsfarmerscoopsd-valleysprings", "gnpcograin-arcadia", "jewellgrain-thejewellgrainco",
  "cissnaparkcoop-cissnaparkwoodworthrankin", "faasfeed-websterkeswick"];

test("twenty-five boards are on the browser lane, each loading its own cashgrid page", () => {
  assert.equal(WANT.length, 25);
  for (const id of WANT) {
    const s = m(id);
    assert.equal(s.platform, "agricharts-cashgrid-browser", id);
    assert.equal(transportOf(s.platform), "browser", id);
    assert.equal(s.browserPage, s.url, id);
    assert.match(s.url, /\/markets\/cashgrid\.php$/, id);
    assert.deepEqual(validateSource(s, new Set()), [], id);
  }
});

test("they land in the browser lane, one job each; the plain lane keeps the rest of AgriCharts", () => {
  const all = WANT.map(m).concat([{ id: "plain", platform: "agricharts-cashgrid", url: "https://x.example/markets/cashgrid.php" }]);
  const { browser, fetch } = planLanes(all, { transportOf });
  assert.equal(browser.flat().length, 25);
  assert.deepEqual(fetch.flat().map((s) => s.id), ["plain"]);
  assert.equal(transportOf("agricharts-cashgrid"), "fetch", "the platform the other boards use is unchanged");
});

test("the browser takes the board itself and not a holding page at the same address", () => {
  const board = readFileSync(join(ROOT, "fixtures", "agricharts-cashgrid-farmerswin.html"), "utf8");
  const accept = acceptOf("agricharts-cashgrid-browser");
  assert.equal(accept(board), true);
  assert.equal(accept("<html><body>Just a moment...</body></html>"), false);
  assert.equal(wireOf("agricharts-cashgrid-browser"), "html");
});

test("the same adapter reads their real page (fixtures/agricharts-cashgrid-farmerswin.html)", () => {
  const board = readFileSync(join(ROOT, "fixtures", "agricharts-cashgrid-farmerswin.html"), "utf8");
  const dir = join(ROOT, "fixtures");
  const contracts = mergeQuotes(readdirSync(dir).filter((f) => /^agricharts-quotes-/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8")));
  const rows = adapterFor("agricharts-cashgrid-browser")(board, "https://farmerswin.com/markets/cashgrid.php", { contracts });
  const plain = adapterFor("agricharts-cashgrid")(board, "https://farmerswin.com/markets/cashgrid.php", { contracts });
  assert.ok(rows.length > 50, `rows ${rows.length}`);
  assert.deepEqual(rows, plain);
});

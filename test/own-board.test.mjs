/* NEW Cooperative and Nexus Cooperative: boards their own servers render.
 * Fixtures are real bytes, captured by capture.yml run 36956170275 on
 * 2026-10-02 UTC from www.newcoop.com/cash-bids and www.nexus.coop/cash-bids/. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract as newcoop, ticks, dateRange as ncRange, NewCoopRefused } from "../lib/adapters/newcoop.mjs";
import { extract as nexus, contractMonth, NexusRefused } from "../lib/adapters/nexus.mjs";
import { build, place, BUYER } from "../scripts/own-board-manifests.mjs";
import { buildFile } from "../lib/board.mjs";
import { validateSource, toConfig, PLATFORMS, wireOf, transportOf, methodOf } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NC = readFileSync(join(ROOT, "fixtures/newcoop-cashbids-2026-10-02.html"), "utf8");
const NX = readFileSync(join(ROOT, "fixtures/nexus-cashbids-2026-10-02.html"), "utf8");

test("NEW Cooperative: 69 locations, 822 rows, every one within a cent of cash - basis = futures", () => {
  const rows = newcoop(NC, "u");
  assert.equal(new Set(rows.map((r) => r.location)).size, 69);
  assert.equal(rows.length, 822);
  const a = rows[0];
  assert.deepEqual([a.location, a.commodity, a.delivery, a.cash, a.basis, a.futuresPrice],
    ["Afton", "Corn", "01 Oct 2026 to 31 Oct 2026", 4.64, -0.35, 499]);
  for (const r of rows) assert.ok(Math.abs(r.futuresPrice - (r.cash - r.basis) * 100) < 1, r.raw);
});

test("NEW Cooperative's ticks are cents and eighths", () => {
  assert.equal(ticks("499-0"), 499);
  assert.equal(ticks("513-4"), 513.5);
  assert.equal(ticks("1277-6"), 1277.75);
  assert.equal(ticks("-3-2"), -3.25);
  assert.equal(ticks(""), null);
  assert.equal(ticks("499.25"), undefined);
  assert.equal(ncRange("10/1/2026 - 10/31/2026"), "01 Oct 2026 to 31 Oct 2026");
  assert.throws(() => newcoop("<html>nothing</html>", "u"), NewCoopRefused);
});

test("Nexus: 35 locations with rows, StoneHedge ids from their own picker, contracts named", () => {
  const rows = nexus(NX, "u");
  assert.equal(new Set(rows.map((r) => r.location)).size, 35);
  assert.equal(rows.length, 486);
  const w = rows.find((r) => r.location === "Wells");
  assert.equal(w.locationId, "04SL43WKRTVZ8TW3N9HY");
  assert.equal(w.futures, "ZCZ26");
  /* "Oakland, MN" is the heading; the picker says "Oakland". Matched without the state. */
  assert.match(rows.find((r) => r.location === "Oakland, MN").locationId, /^[A-Z0-9]{20}$/);
  for (const r of rows) assert.ok(Math.abs(r.futuresPrice - (r.cash - r.basis) * 100) < 1, r.raw);
  assert.deepEqual(contractMonth("Dec 2026"), { code: "Z", year: 2026, label: "Dec 2026" });
  assert.throws(() => nexus("<html></html>", "u"), NexusRefused);
});

test("both platforms are registered, fetched with a plain GET, read as html", () => {
  for (const p of ["newcoop", "nexus"]) {
    assert.ok(PLATFORMS.includes(p));
    assert.equal(typeof adapterFor(p), "function");
    assert.equal(wireOf(p), "html");
    assert.equal(transportOf(p), "fetch");
    assert.equal(methodOf(p), "GET");
  }
});

test("a buyer's plant is a destination: its own town, never a coordinate", () => {
  const p = place("AGP Manning, IA", [{ src: "known", branch: "AGP MANNING, IA", city: "Charles City", state: "IA" }]);
  assert.equal(p.destination, true);
  assert.equal(p.city, "Manning");
  assert.ok(place("GOLDEN GRAIN, IA", []).skip, "a buyer with no town is not written");
  assert.ok(BUYER.test("Valero Charles City, IA"));
  assert.ok(!BUYER.test("Adams, MN"));
});

test("sources/ holds exactly what the generator produces, and every one publishes from its capture", () => {
  const { manifests, skipped } = build();
  const onDisk = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")))
    .filter((m) => m.platform === "newcoop" || m.platform === "nexus");
  assert.deepEqual(onDisk.map((m) => m.id).sort(), manifests.map((x) => x.manifest.id).sort(),
    "sources/ is out of step: run node scripts/own-board-manifests.mjs --write");
  const fixtureOf = { newcoop: NC, nexus: NX };
  for (const x of manifests) {
    const m = x.manifest;
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "sources", `${m.id}.json`), "utf8")), m, `${m.id} differs on disk`);
    assert.deepEqual(validateSource(m), [], m.id);
    if (m.lat == null) assert.equal(m.lon, null);
    const b = buildFile(fixtureOf[m.platform], { now: new Date("2026-10-02T02:00:00Z"), sourceUrl: m.url, source: toConfig(m), extract: adapterFor(m.platform) });
    assert.ok(b.file.count > 0, m.id);
    assert.equal((b.file.withheld ?? []).length, 0, `${m.id} withheld rows`);
  }
  assert.ok(manifests.length >= 100);
  /* The three left out are left out for a reason that is printed. */
  assert.deepEqual(skipped.map((s) => s.tag).sort(), ["newcoop: Cainsville", "newcoop: Morton Mills", "newcoop: Mt. Ayr", "nexus: GOLDEN GRAIN, IA"]);
});

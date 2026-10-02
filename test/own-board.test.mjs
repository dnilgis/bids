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
    assert.equal(methodOf(p), "GET");
  }
  /* newcoop.com answers a plain fetch with 403 and a browser with the board
     (first live poll, 2026-10-02). Nexus answered the plain fetch. */
  assert.equal(transportOf("newcoop"), "browser");
  assert.equal(transportOf("nexus"), "fetch");
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
    .filter((m) => m.platform === "newcoop" || m.platform === "nexus" || m.platform === "landus");
  assert.deepEqual(onDisk.map((m) => m.id).sort(), manifests.map((x) => x.manifest.id).sort(),
    "sources/ is out of step: run node scripts/own-board-manifests.mjs --write");
  const fixtureOf = { newcoop: NC, nexus: NX };
  for (const x of manifests) {
    const m = x.manifest;
    if (m.platform === "landus") {               // one captured location; see the Landus tests
      assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "sources", `${m.id}.json`), "utf8")), m, `${m.id} differs on disk`);
      assert.deepEqual(validateSource(m), [], m.id);
      continue;
    }
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "sources", `${m.id}.json`), "utf8")), m, `${m.id} differs on disk`);
    assert.deepEqual(validateSource(m), [], m.id);
    if (m.lat == null) assert.equal(m.lon, null);
    const b = buildFile(fixtureOf[m.platform], { now: new Date("2026-10-02T02:00:00Z"), sourceUrl: m.url, source: toConfig(m), extract: adapterFor(m.platform) });
    assert.ok(b.file.count > 0, m.id);
    assert.equal((b.file.withheld ?? []).length, 0, `${m.id} withheld rows`);
  }
  assert.ok(manifests.length >= 150);
  /* The three left out are left out for a reason that is printed. */
  assert.deepEqual(skipped.map((s) => s.tag).sort(), ["landus: Mcleansboro, IL", "newcoop: Cainsville", "newcoop: Morton Mills", "newcoop: Mt. Ayr", "nexus: GOLDEN GRAIN, IA"]);
});

/* ---------------- Landus ---------------- */
import { extract as landus, bidsUrl as landusUrl, VERIFIED_BY as LANDUS_VERIFIED, LandusRefused } from "../lib/adapters/landus.mjs";

/* TONIGHT'S QUOTES, NOT A GUESS. The committed agricharts-quotes-* pages are from
   September and would refuse every row, which is the guard working. These are
   the futures NEW Cooperative printed on its own board in the same hour
   (fixtures/newcoop-cashbids-2026-10-02.html: "499-0", "513-4", "524-4",
   "515-2", "1277-0", "1293-2", "1303-2", "1318-0", "1250-0"), in the shape the
   shared quote pages produce. */
const TONIGHT = [
  ["ZCZ26", 499], ["ZCH27", 513.5], ["ZCN27", 524.5], ["ZCZ27", 515.25],
  ["ZSX26", 1277], ["ZSF27", 1293.25], ["ZSH27", 1303.25], ["ZSN27", 1318], ["ZSX27", 1250],
].map(([symbol, lastCents]) => ({ symbol, lastCents, priced: true }));
const LANDUS_109 = readFileSync(join(ROOT, "fixtures/landus-cashbids-109-2026-10-02.json"), "utf8");

test("Landus at Adair: every row fits the contract it names within 5c, and is stamped", () => {
  const rows = landus(LANDUS_109, landusUrl(109), { contracts: TONIGHT });
  assert.equal(rows.length, 12);
  for (const r of rows) {
    assert.equal(r.verifiedBy, LANDUS_VERIFIED);
    assert.equal(r.locationId, "109");
    assert.equal(r.futuresPrice, null, "no futures price is printed, so none is published");
  }
  assert.deepEqual([rows[0].commodity, rows[0].delivery, rows[0].cash, rows[0].basis, rows[0].futures], ["Corn", "By 10/15/26", 4.54, -0.45, "ZCZ26"]);
});

test("Landus without quotes, or with stale ones, is refused rather than proved by its own subtraction", () => {
  assert.throws(() => landus(LANDUS_109, landusUrl(109), null), LandusRefused);
  const stale = TONIGHT.map((c) => ({ ...c, lastCents: c.lastCents + 40 }));
  assert.throws(() => landus(LANDUS_109, landusUrl(109), { contracts: stale }), /do not fit/);
  assert.throws(() => landus(LANDUS_109, "https://www.landus.ag/api/cash-bids", { contracts: TONIGHT }), /no location number/);
});

test("Landus's manifest for Adair publishes through the guards on tonight's quotes", () => {
  const m = build().manifests.find((x) => x.manifest.id === "landus-adair").manifest;
  assert.equal(m.identityAlternative, LANDUS_VERIFIED);
  /* Held: 429 from www.landus.ag on all 50 at the first live poll. */
  assert.equal(m.enabled, false);
  assert.match(m._pending, /429/);
  assert.deepEqual(validateSource(m), []);
  const b = buildFile(LANDUS_109, { now: new Date("2026-10-02T02:30:00Z"), sourceUrl: m.url, source: toConfig(m),
    extract: (h, u) => landus(h, u, { contracts: TONIGHT }) });
  assert.equal(b.file.count, 12);
});

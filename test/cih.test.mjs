/* CIH (cihedging.com) cash-bid widget. Fixtures are real bytes off the wire,
 * captured by .github/workflows/capture.yml (runs 36953837601 and 36954854588,
 * 2026-10-02 UTC) from each customer's own page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract, htmlOf, cards, contractMonth, widgetUrl, siteIdOf, num, CihRefused } from "../lib/adapters/cih.mjs";
import { ADAPTERS } from "../lib/adapters/index.mjs";
import { PLATFORMS, wireOf, transportOf } from "../lib/sources.mjs";

const fx = (n) => readFileSync(new URL(`../fixtures/cih-${n}-2026-10-02.json`, import.meta.url), "utf8");

test("Ladd's board: four locations by their own ids, corn and soybeans", () => {
  const rows = extract(fx("laddelevator"), widgetUrl(25584));
  const locs = [...new Map(rows.map((r) => [r.locationId, r.location])).entries()];
  assert.deepEqual(locs, [["46250", "Ladd"], ["243363", "Marquis"], ["243364", "River"], ["320132", "Sheffield Bartlett"]]);
  assert.equal(rows.length, 26);
  const first = rows[0];
  assert.equal(first.commodity, "Corn");
  assert.equal(first.delivery, "Oct 2026");
  assert.equal(first.cash, 4.69);
  assert.equal(first.basis, -0.3);
  assert.equal(first.futures, "ZCZ26");
  assert.equal(first.futuresPrice, 499);          // cents, as lib/board.mjs checks it
  assert.equal(first.futuresChange, -0.0325);
  assert.equal(first.futuresAt, "10/01/26 9:09 PM");
});

test("every row on all four boards balances cash - basis = futures within a cent", () => {
  let n = 0;
  for (const f of ["laddelevator", "alcorn", "huskerag", "tremont"]) {
    for (const r of extract(fx(f), "u")) {
      const residual = r.futuresPrice - (r.cash - r.basis) * 100;
      assert.ok(Math.abs(residual) < 1, `${f} ${r.location} ${r.commodity} ${r.delivery}: residual ${residual}c`);
      n++;
    }
  }
  assert.equal(n, 79);
});

test("soybeans get the soybean contract, Chicago wheat the Chicago one", () => {
  const rows = extract(fx("tremont"), "u");
  assert.ok(rows.some((r) => r.commodity === "Soybeans" && /^ZS[FHKNQUX]\d\d$/.test(r.futures)));
  assert.ok(rows.some((r) => r.commodity === "Chicago Wheat" && /^ZW[HKNUZ]\d\d$/.test(r.futures)));
});

test("the API's JSON string is unwrapped; a raw document is accepted as is", () => {
  const html = htmlOf(fx("huskerag"));
  assert.match(html, /cih-loc-card/);
  assert.equal(htmlOf(html), html);
  assert.equal(cards(html).length, 1);
});

test("a body with no location card is refused and says what it got", () => {
  assert.throws(() => extract('"<p>nothing here</p>"', "u"), CihRefused);
  assert.throws(() => extract('{"error":"bad site"}', "u"), /JSON object/);
});

test("helpers: contract months, numbers, the site number round-trips", () => {
  assert.deepEqual(contractMonth("Dec 26"), { code: "Z", month: 12, year: 2026, label: "Dec 26" });
  assert.equal(contractMonth("Oct 1-9th"), null);
  assert.equal(num("-0.30"), -0.3);
  assert.equal(num(""), null);
  assert.equal(num("abc"), undefined);
  assert.equal(siteIdOf(widgetUrl(239483)), "239483");
  assert.throws(() => widgetUrl("12a"), CihRefused);
});

test("the platform is registered everywhere a source is loaded", () => {
  assert.ok(PLATFORMS.includes("cih"));
  assert.equal(typeof ADAPTERS.cih, "function");
  assert.equal(wireOf("cih"), "json");
  assert.equal(transportOf("cih"), "fetch");
});

/* ---------------- the manifests ---------------- */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildManifests } from "../scripts/cih-manifests.mjs";
import { buildFile } from "../lib/board.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("sources/ holds exactly what the CIH generator produces from the captures", () => {
  const { manifests } = buildManifests();
  const onDisk = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8"))).filter((m) => m.platform === "cih");
  assert.deepEqual(onDisk.map((m) => m.id).sort(), manifests.map((x) => x.manifest.id).sort(),
    "sources/ is out of step with the generator: run node scripts/cih-manifests.mjs --write");
  for (const x of manifests) {
    const disk = JSON.parse(readFileSync(join(ROOT, "sources", `${x.manifest.id}.json`), "utf8"));
    assert.deepEqual(disk, x.manifest, `${x.manifest.id} on disk differs from the generator`);
  }
  assert.ok(manifests.length >= 19);
});

test("every CIH manifest validates and publishes rows from its own capture through the guards", () => {
  const { manifests } = buildManifests();
  for (const x of manifests) {
    const m = x.manifest;
    assert.deepEqual(validateSource(m), [], m.id);
    const b = buildFile(readFileSync(join(ROOT, `fixtures/cih-${x.site}-2026-10-02.json`), "utf8"),
      { now: new Date("2026-10-02T02:00:00Z"), sourceUrl: m.url, source: toConfig(m), extract: adapterFor("cih") });
    assert.ok(b.file.count > 0, m.id);
    assert.equal((b.file.withheld ?? []).length, 0, `${m.id} withheld rows`);
  }
});

test("a label with no identity is reported, never written: Ladd Elevator and Russell Grain", () => {
  const { manifests, skipped } = buildManifests();
  assert.ok(!manifests.some((x) => /^(laddelevator|russellgrain)-/.test(x.manifest.id)));
  assert.ok(skipped.some((s) => s.tag.startsWith("laddelevator:")));
  assert.ok(skipped.some((s) => s.tag.startsWith("russellgrain:")));
});

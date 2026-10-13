/* Bunge's own location pages on bungeag.com (lib/adapters/bungeag.mjs).
 *
 * Fixtures are real bytes read by probe.yml on 2026-10-13 UTC:
 *   bungeag-decatur-in-2026-10-13.html     the whole page (run 38446551000)
 *   bungeag-fairmontcity-il / sidney-mt /   the page's head and its Cash Bids
 *   hawcreek-in -2026-10-13.html            section as the probe's --grep printed
 *                                           them, whitespace collapsed (run 38447696952)
 *
 * Haw Creek is Bunge at Ladoga, IN: 11477 County Road 550 East, Ladoga 47954,
 * merchandiser Wyatt Anderson. Its page posts no bids, and that is pinned
 * here so nobody mistakes an empty read for a working source. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract, symbolOf, lastUpdate, slugOf, locationList, BungeRefused } from "../lib/adapters/bungeag.mjs";
import { build, SITES, LIST_FIXTURE } from "../scripts/bungeag-manifests.mjs";
import { buildFile } from "../lib/board.mjs";
import { validateSource, toConfig, PLATFORMS, wireOf, methodOf } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fx = (slug) => readFileSync(join(ROOT, `fixtures/bungeag-${slug}-2026-10-13.html`), "utf8");
const URL_OF = (slug) => `https://www.bungeag.com/locations/${slug}/`;
const exact = (r) => Math.abs(r.futuresPrice - (r.cash - r.basis) * 100) < 0.01;

test("Decatur, IN: 13 grain rows, futures in cents, every row exact; meal and hulls left out", () => {
  const rows = extract(fx("decatur-in"), URL_OF("decatur-in"));
  assert.equal(rows.length, 13);
  assert.deepEqual(rows.unreconciled, []);
  const a = rows[0];
  assert.deepEqual([a.location, a.locationId, a.commodity, a.delivery, a.futures, a.futuresPrice, a.basis, a.cash],
    ["Decatur, IN", "decatur-in", "Soybeans", "Oct/Nov", "ZSX26", 1283.75, -0.2, 12.6375]);
  assert.equal(a.futuresAt, "2026-10-13T18:25:14.000Z");
  assert.deepEqual([...new Set(rows.map((r) => r.commodity))], ["Soybeans", "High Oleic Soybeans", "Wheat"]);
  assert.ok(rows.every(exact));
  assert.ok(!rows.some((r) => /meal|hull/i.test(r.commodity)));
});

test("Fairmont City, IL: corn, soybeans and wheat on their own contracts, 29 rows, all exact", () => {
  const rows = extract(fx("fairmontcity-il"), URL_OF("fairmontcity-il"));
  assert.equal(rows.length, 29);
  assert.deepEqual([...new Set(rows.map((r) => r.futures.slice(0, 2)))], ["ZC", "ZS", "ZW"]);
  assert.ok(rows.every(exact));
});

test("Sidney, MT: spring and hard red winter wheat on Minneapolis and Kansas City", () => {
  const rows = extract(fx("sidney-mt"), URL_OF("sidney-mt"));
  assert.equal(rows.length, 10);
  assert.ok(rows.some((r) => r.commodity === "HRW 11.5%" && r.futures === "KEZ26"));
  assert.ok(rows.some((r) => r.commodity === "NS/DNS 14%" && r.futures === "MWZ26"));
  assert.ok(rows.every(exact));
});

test("Haw Creek (Bunge at Ladoga, IN) posts no bids on its page, and is refused rather than read empty", () => {
  const h = fx("hawcreek-in");
  assert.match(h, /"addressLocality": "Ladoga"/);
  assert.match(h, /<title>Haw Creek, IN - Bunge<\/title>/);
  assert.throws(() => extract(h, URL_OF("hawcreek-in")), (e) => e instanceof BungeRefused && /no "Cash Bids" section/.test(e.message));
  /* And the site's own list says why: a legacy-viterra page. */
  const me = locationList(fx("decatur-in")).find((l) => l.code === "HawCreek-IN");
  assert.deepEqual([me.source, me.address.city, me.address.postalCode], ["legacy-viterra", "Ladoga", "47954"]);
});

test("a page that is not the one asked for is refused: a redirect is not that location's board", () => {
  assert.throws(() => extract(fx("decatur-in"), URL_OF("roachdale-in")), BungeRefused);
  assert.throws(() => extract("<html></html>", URL_OF("decatur-in")), BungeRefused);
});

test("symbols, the as-of line and slugs", () => {
  assert.equal(symbolOf("@SX26"), "ZSX26");
  assert.equal(symbolOf("@CZ26"), "ZCZ26");
  assert.equal(symbolOf("@KWZ26"), "KEZ26");
  assert.equal(symbolOf("@MWH27"), "MWH27");
  assert.equal(symbolOf("@SMZ26"), null, "meal is not a grain contract");
  assert.equal(symbolOf("SX26"), null);
  assert.deepEqual(lastUpdate("USD per BU as of 10-13-2026 at 01:25:14 PM CDT"),
    { currency: "USD", unit: "BU", at: "2026-10-13T18:25:14.000Z" });
  assert.equal(lastUpdate("USD per TON as of 01-05-2027 at 09:00:00 AM CST").at, "2027-01-05T15:00:00.000Z");
  assert.equal(slugOf("https://www.bungeag.com/locations/morristown-in-beanplant/"), "morristown-in-beanplant");
  assert.equal(slugOf("https://www.bungeag.com/grain-facility-location/?lq=0034"), null);
});

test("registered: a plain GET of an html page", () => {
  assert.ok(PLATFORMS.includes("bungeag"));
  assert.equal(typeof adapterFor("bungeag"), "function");
  assert.equal(wireOf("bungeag"), "html");
  assert.equal(methodOf("bungeag"), "GET");
});

test("sources/ holds exactly what the generator writes; each names its yard; the captured ones publish", () => {
  const manifests = build();
  const onDisk = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")))
    .filter((m) => m.platform === "bungeag");
  assert.deepEqual(onDisk.map((m) => m.id).sort(), manifests.map((m) => m.id).sort(),
    "sources/ is out of step: run node scripts/bungeag-manifests.mjs --write");
  assert.equal(manifests.length, 17);
  assert.ok(!manifests.some((m) => m.id.includes("hawcreek")), "Haw Creek posts no bids and gets no source");
  for (const m of manifests) {
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "sources", `${m.id}.json`), "utf8")), m, `${m.id} differs on disk`);
    assert.deepEqual(validateSource(m), [], m.id);
    for (const r of [].concat(m.registryId ?? [])) assert.match(r, /^reg:[A-Z]{2}\|/);
  }
  const ind = manifests.filter((m) => m.state === "IN").map((m) => m.id).sort();
  assert.deepEqual(ind, ["bunge-decatur-in", "bunge-indianapolis-in", "bunge-morristown-in-beanplant"]);
  for (const slug of ["decatur-in", "fairmontcity-il", "sidney-mt"]) {
    const m = manifests.find((x) => x.locationId === slug);
    const b = buildFile(fx(slug), { now: new Date("2026-10-13T18:40:00Z"), sourceUrl: m.url, source: toConfig(m), extract: adapterFor("bungeag") });
    assert.equal(b.file.count, SITES.find((x) => x.slug === slug).rows, m.id);
    assert.equal((b.file.withheld ?? []).length, 0, `${m.id} withheld rows`);
  }
  assert.equal(LIST_FIXTURE, "fixtures/bungeag-decatur-in-2026-10-13.html");
});

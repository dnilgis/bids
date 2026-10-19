/*
 * FLASH GRAIN WITHDRAWS AT TWO HOURS, NOT FOURTEEN. Sig, 2026-10-19.
 *
 * Flash Grain's own page withholds cash once its harvester has been silent two
 * hours. When no flashgrain workflow runs at all, nothing rewrites
 * feed/<town>.json: it keeps status "ok" and an old `observed`, and until this
 * change the bids pipeline went on republishing that price to the fourteen
 * hours every other source gets. Twelve hours longer than the elevator itself
 * would show it.
 *
 * The fixture is the real feed/thorp.json as Flash Grain served it on
 * 2026-10-19 (dnilgis/flashgrain, unedited). The Badger Grain fixture is the
 * one test/emmert.test.mjs already reads. Manifests are the committed
 * sources/*.json. Every case is "this real feed, this many hours after its own
 * `observed` stamp".
 *
 *     node --test test/maxage.test.mjs
 *
 * No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extract, EmmertRefused } from "../lib/adapters/emmert.mjs";
import { adapterFor, optionsFor } from "../lib/adapters/index.mjs";
import { validateSource, toConfig } from "../lib/sources.mjs";
import { buildFile } from "../lib/board.mjs";
import {
  withdrawHFor, agingStamp, feedVerdict, stateOf, WITHDRAW_H, LATE_H,
} from "../lib/freshness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (n) => readFileSync(join(ROOT, "test/fixtures", n), "utf8");
const manifest = (id) => JSON.parse(readFileSync(join(ROOT, "sources", `${id}.json`), "utf8"));

const FLASH = fixture("emmert-flashgrain-thorp-2026-10-19.json");
const BADGER = fixture("emmert-badgergrain-2026-09-20.json");
const THORP = manifest("flashgrain-thorp");
const GRANTON = manifest("flashgrain-granton");
const WHEELER = manifest("badgergrain-wheeler");

/* N hours after the feed's own `observed`. */
const after = (body, h) => new Date(Date.parse(JSON.parse(body).observed) + h * 3.6e6);

test("the Flash Grain manifests say 2 hours, and Badger Grain says nothing", () => {
  assert.equal(THORP.maxAgeH, 2);
  assert.equal(GRANTON.maxAgeH, 2);
  assert.equal(withdrawHFor(THORP), 2);
  assert.equal(withdrawHFor(GRANTON), 2);
  assert.ok(!("maxAgeH" in WHEELER), "Badger Grain keeps the shared line");
  assert.equal(withdrawHFor(WHEELER), WITHDRAW_H);
  for (const m of [THORP, GRANTON]) {
    assert.deepEqual(validateSource(m, new Set()), [], `${m.id} still validates`);
    assert.match(m.note, /maxAgeH 2/, `${m.id} note says the 2 h line`);
    assert.doesNotMatch(m.note, /inside the 14-hour line/, `${m.id} note still claims 14 h`);
  }
});

test("maxAgeH can only SHORTEN the line: larger than 14 is ignored, garbage is ignored", () => {
  assert.equal(withdrawHFor({ maxAgeH: 20 }), WITHDRAW_H);
  assert.equal(withdrawHFor({ maxAgeH: WITHDRAW_H }), WITHDRAW_H);
  assert.equal(withdrawHFor({ maxAgeH: 1e9 }), WITHDRAW_H);
  for (const bad of [0, -2, NaN, Infinity, "2", null, undefined, true])
    assert.equal(withdrawHFor({ maxAgeH: bad }), WITHDRAW_H, `maxAgeH ${String(bad)}`);
  assert.equal(withdrawHFor(null), WITHDRAW_H);
  assert.equal(withdrawHFor({}), WITHDRAW_H);
  /* feedVerdict re-clamps, so a caller cannot hand it a longer line either. */
  const NOW = Date.parse("2026-10-19T12:00:00Z");
  const old = new Date(NOW - 15 * 3.6e6).toISOString();
  assert.equal(feedVerdict("ok", old, NOW, 20).publish, false, "a 20 h line is still 14 h");
  /* Validation refuses a typo outright rather than letting it read as a policy. */
  assert.ok(validateSource({ ...THORP, maxAgeH: "2" }, new Set()).some((e) => /maxAgeH/.test(e)));
  assert.ok(validateSource({ ...THORP, maxAgeH: 0 }, new Set()).some((e) => /maxAgeH/.test(e)));
});

test("THE REAL CASE, AT THE ADAPTER: Flash Grain status ok, observed 2.5 h old, is refused", () => {
  const j = JSON.parse(FLASH);
  assert.equal(j.status, "ok", "the fixture is the frozen-file case: status still ok");
  const ex = (body, h, m) => extract(body, m.url, { now: after(body, h), ...optionsFor(m) });

  assert.equal(ex(FLASH, 1.5, THORP).length, 6, "inside 2 h, all six of their bids publish");
  assert.throws(() => ex(FLASH, 2.5, THORP),
    (e) => e instanceof EmmertRefused && /past the 2h withdrawal line/.test(e.message));

  /* Badger Grain at the same 2.5 h publishes: the shorter line is Flash
     Grain's, not everybody's. */
  assert.equal(ex(BADGER, 2.5, WHEELER).length, 11);
  /* And a maxAgeH past 14 changes nothing: still published at 13.5, still
     withdrawn at 14.5. */
  const LOOSE = { ...WHEELER, maxAgeH: 20 };
  assert.equal(ex(BADGER, 13.5, LOOSE).length, 11);
  assert.throws(() => ex(BADGER, 14.5, LOOSE), /past the 14h withdrawal line/);
});

test("the line reaches the adapter through the same path poll.mjs uses", () => {
  /* scripts/poll.mjs: shared = optionsFor(s) ?? sharedFor(...), then
     buildFile(..., extract: adapterFor(s.platform, shared)). Without optionsFor
     the adapter would never see maxAgeH and would silently use 14 h. */
  assert.deepEqual(optionsFor(THORP), { maxAgeH: 2 });
  const build = (h) => buildFile(FLASH, {
    now: new Date().toISOString(), sourceUrl: THORP.url, source: toConfig(THORP),
    extract: adapterFor(THORP.platform, { ...optionsFor(THORP), now: after(FLASH, h) }),
  });
  const ok = build(1);
  assert.equal(ok.file.count, 6);
  assert.equal(ok.observedAt, JSON.parse(FLASH).observed, "their stamp comes back for the index row");
  assert.ok(!("observedAt" in ok.file), "and stays OUT of the board file, whose key set is pinned");
  assert.throws(() => build(2.5), /past the 2h withdrawal line/);
});

test("WHICH CLOCK AGES: the feed's own observed, when it is older than our checkedAt", () => {
  const NOW = Date.parse("2026-10-19T21:45:00Z");
  const fresh = new Date(NOW - 0.1 * 3.6e6).toISOString();   // we read it 6 min ago
  const stale = new Date(NOW - 2.5 * 3.6e6).toISOString();   // they last looked 2.5 h ago
  assert.equal(agingStamp(fresh, stale), stale);
  assert.equal(agingStamp(stale, fresh), stale);
  assert.equal(agingStamp(fresh, undefined), fresh, "no observedAt: checkedAt alone, as before");
  assert.equal(agingStamp(fresh, "whenever"), fresh, "an unreadable observedAt is ignored");
  assert.equal(agingStamp(null, stale), null, "an unreadable checkedAt still reads as Infinity");

  /* feedVerdict, as merge_bids.mjs calls it. */
  const fg = feedVerdict("ok", agingStamp(fresh, stale), NOW, withdrawHFor(THORP));
  assert.equal(fg.publish, false, "Flash Grain, frozen 2.5 h, polls fresh: withdrawn");
  assert.match(fg.why, /past the 2h withdrawal/);
  const bg = feedVerdict("ok", agingStamp(fresh, stale), NOW, withdrawHFor(WHEELER));
  assert.equal(bg.publish, true, "Badger Grain at 2.5 h: still published");
  assert.equal(feedVerdict("ok", agingStamp(fresh, stale), NOW, withdrawHFor({ maxAgeH: 20 })).publish, true);

  /* stateOf, as status.mjs and build_directory.mjs call it on the index row. */
  const row = { health: "live", checkedAt: fresh, observedAt: stale };
  assert.equal(stateOf({ ...row, maxAgeH: 2 }, NOW), "down");
  assert.equal(stateOf(row, NOW), "live", "without the line, 2.5 h is under LATE_H");
  assert.ok(2.5 < LATE_H);
  assert.equal(stateOf({ health: "refused", checkedAt: stale, maxAgeH: 2 }, NOW), "down",
    "a held Flash Grain price past 2 h is down, not late");
  assert.equal(stateOf({ health: "refused", checkedAt: stale }, NOW), "late");
});

test("THE REAL CASE, END TO END: merge_bids withdraws Flash Grain at 2.5 h and keeps Badger Grain", () => {
  /* The frozen-feed case as the merge sees it: every poll read them cleanly
     (status ok, checkedAt six minutes old) and their own `observed`, carried on
     the index row as observedAt, is 2.5 hours old. */
  const NOW = Date.parse("2026-10-19T21:45:00Z");
  const at = (h) => new Date(NOW - h * 3.6e6).toISOString();
  const dir = mkdtempSync(join(tmpdir(), "maxage-"));
  try {
    for (const d of ["data", "geocodes", "sources"]) mkdirSync(join(dir, d), { recursive: true });
    const real = JSON.parse(readFileSync(join(ROOT, "data", "flashgrain-thorp.json"), "utf8"));
    const board = { ...real, checkedAt: at(0.1), pricedAt: at(0.1) };
    const cases = [
      // id, manifest, observedAt age, should publish
      ["flashgrain-thorp",    THORP,                       2.5,  false],
      ["flashgrain-granton",  GRANTON,                     1.5,  true],
      ["badgergrain-wheeler", WHEELER,                     2.5,  true],
      ["loose-line",          { ...WHEELER, id: "loose-line", location: "Loose Line", maxAgeH: 20 }, 13.5, true],
      ["loose-gone",          { ...WHEELER, id: "loose-gone", location: "Loose Gone", maxAgeH: 20 }, 14.5, false],
    ];
    const index = [];
    for (const [id, m, h] of cases) {
      writeFileSync(join(dir, "sources", `${id}.json`), JSON.stringify({ ...m, id }));
      writeFileSync(join(dir, "data", `${id}.json`), JSON.stringify(board));
      index.push({
        id, operator: m.operator, location: m.location, usState: "WI", status: "ok", health: "live",
        inMerge: true, platform: m.platform, lat: m.lat, lon: m.lon, url: m.url,
        pricedAt: at(0.1), checkedAt: at(0.1), observedAt: at(h), rows: board.count,
        ...(withdrawHFor(m) < WITHDRAW_H ? { maxAgeH: withdrawHFor(m) } : {}),
      });
    }
    writeFileSync(join(dir, "data", "index.json"), JSON.stringify({ generated: at(0), counts: {}, sources: index }));
    writeFileSync(join(dir, "geocodes", "places.json"), JSON.stringify({ places: {}, known: {} }));

    execFileSync(process.execPath, [join(ROOT, "scripts", "merge_bids.mjs"),
      "--no-barchart", "--root", dir, "--now", new Date(NOW).toISOString()],
      { stdio: "pipe", encoding: "utf8" });

    const published = new Set();
    for (const f of readdirSync(join(dir, "data", "merged")))
      for (const b of JSON.parse(readFileSync(join(dir, "data", "merged", f), "utf8")).bids ?? [])
        published.add(b.source);
    for (const [id, , h, want] of cases)
      assert.equal(published.has(id), want, `${id} at ${h} h: ${want ? "published" : "withdrawn"}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

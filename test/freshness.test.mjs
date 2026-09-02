/* THE TEST THAT WOULD HAVE CAUGHT IT.
 *
 * On 2026-09-02 the merged feed lost 1,706 bids from 151 sources because
 * merge_bids.mjs withdrew on `status !== "ok"` instead of on age. The full
 * suite — 1,141 assertions — passed before that change and passed after it,
 * unaltered. Nothing anywhere asserted what the feed does with a source whose
 * read failed and whose last good price is forty minutes old. That is the
 * whole defect: not a wrong line, an unwatched one.
 *
 * So these are written against the DECISION, not against the wording of any
 * message: does this price reach a consumer, and does the consumer know how
 * old it is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  feedVerdict, stateOf, ageHours, LATE_H, WITHDRAW_H, MAX_SKEW_H, HELD,
} from "../lib/freshness.mjs";
import * as status from "../scripts/status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-02T02:20:00.000Z");
const at = (h) => new Date(NOW - h * 3.6e6).toISOString();

test("the withdrawal window is one number, and lib/ owns it", () => {
  assert.equal(WITHDRAW_H, 14, "FEED_MAX_AGE_H in worker/src/index.js is 14; they are the same policy");
  assert.ok(LATE_H < WITHDRAW_H, "late must come before withdrawn or the board has two names for one state");
  /* status.mjs used to define these itself. If it ever does again there are two
     numbers, and this asserts they are one object, not two that happen to agree. */
  assert.equal(status.WITHDRAW_H, WITHDRAW_H);
  assert.equal(status.LATE_H, LATE_H);
  assert.equal(status.stateOf, stateOf, "status.mjs must re-export lib/freshness's function, not a copy");
});

test("a failed read does NOT withdraw a fresh price — the bug, stated as a rule", () => {
  /* 151 sources sat at 6.2–6.7h with good files and were dropped. Every one of
     these three statuses is a way of saying "no new price arrived", and none of
     them is a way of saying "the price we have is wrong". */
  for (const status of ["broken", "refused", "skipped"]) {
    const v = feedVerdict(status, at(6.5), NOW);
    assert.equal(v.publish, true, `${status} at 6.5h must still publish`);
    assert.equal(v.stale, true, `${status} at 6.5h must be flagged stale`);
    assert.equal(Math.round(v.ageH * 10) / 10, 6.5);
  }
});

test("past the window it is withdrawn, whatever the status says", () => {
  for (const status of ["broken", "refused", "skipped", "ok"]) {
    assert.equal(feedVerdict(status, at(WITHDRAW_H + 0.1), NOW).publish, false, status);
  }
  for (const status of ["broken", "refused", "skipped", "ok"]) {
    assert.equal(feedVerdict(status, at(WITHDRAW_H - 0.1), NOW).publish, true, status);
  }
});

test('"ok" is not a synonym for fresh — a dead poller leaves every source ok', () => {
  /* If the poll workflow stops, nothing ever flips to broken: every source keeps
     status "ok" and its checkedAt simply stops moving. A gate written as
     `status === "ok" ? publish : withdraw` publishes yesterday's corn as today's
     for as long as the reader is down, silently. Caught while writing
     feedVerdict, which is the only reason it is not shipped. */
  const dead = feedVerdict("ok", at(20), NOW);
  assert.equal(dead.publish, false);
  assert.equal(dead.stale, true);
  assert.match(dead.why, /past the 14h withdrawal/);
});

test("a live row is flagged live and still carries its age", () => {
  const v = feedVerdict("ok", at(0.5), NOW);
  assert.deepEqual({ publish: v.publish, stale: v.stale, why: v.why },
                   { publish: true, stale: false, why: null });
  assert.ok(v.ageH > 0.4 && v.ageH < 0.6, "a healthy row reports its real age, not null");
});

test("a clock ahead of ours is not fresh, it is wrong", () => {
  assert.equal(feedVerdict("ok", at(-1), NOW).publish, false);
  /* Inside the skew allowance a runner clock is just a runner clock. */
  assert.equal(feedVerdict("ok", at(-MAX_SKEW_H / 2), NOW).publish, true);
});

test("an unreadable or absent timestamp publishes nothing", () => {
  for (const bad of [null, undefined, "", "not a date"]) {
    assert.equal(feedVerdict("ok", bad, NOW).publish, false, JSON.stringify(bad));
  }
});

test("an unknown status is refused, not guessed at", () => {
  const v = feedVerdict("weird", at(1), NOW);
  assert.equal(v.publish, false);
  assert.match(v.why, /unknown source status/);
});

test('stateOf treats "skipped" as held, not as healthy', () => {
  /* A skipped source must colour like a refused one on the board — the read did
     not happen either way. Before this it fell through to the healthy branch and
     a never-attempted source could render live. */
  assert.ok(HELD.has("skipped"));
  assert.equal(stateOf({ health: "skipped", checkedAt: at(1) }, NOW), "late");
  assert.equal(stateOf({ health: "skipped", checkedAt: at(WITHDRAW_H + 1) }, NOW), "down");
  assert.equal(stateOf({ health: "live", checkedAt: at(1) }, NOW), "live");
});

test("ageHours is Infinity, never NaN, for anything it cannot read", () => {
  for (const bad of [null, undefined, "", "x"]) assert.equal(ageHours(bad, NOW), Infinity);
});

/* ── AND THE SAME DECISION, THROUGH THE DOOR THE FEED ACTUALLY USES ─────────
   The unit tests above pin feedVerdict. They cannot tell you whether
   merge_bids.mjs calls it. This runs the real script over a built tree. */
test("merge_bids publishes a held board and withdraws a stale one", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-"));
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "geocodes"), { recursive: true });
    const board = (h) => ({
      schema: "board/1", count: 1, pricedAt: at(h), checkedAt: at(h),
      bids: [{ commodity: "Corn", delivery: "SEP 2026", cash: 4.25, basisDollars: -0.35,
               futuresMonth: "ZCZ26", futuresPriceCents: 460 }],
    });
    const src = (id, status, h) => ({
      id, operator: `Op ${id}`, location: "Town", usState: "WI", status, health: status,
      inMerge: true, platform: "bushel", lat: 44.9, lon: -91.5,
      pricedAt: at(h), checkedAt: at(h), rows: 1,
    });
    const cases = [
      ["live-now",   "ok",      0.2],
      ["held-broken","broken",  6.5],
      ["held-skip",  "skipped", 6.5],
      ["held-refuse","refused", 13.9],
      ["gone-broken","broken",  15],
      ["gone-ok",    "ok",      20],
    ];
    for (const [id, , h] of cases) writeFileSync(join(dir, "data", `${id}.json`), JSON.stringify(board(h)));
    writeFileSync(join(dir, "data", "index.json"), JSON.stringify({
      generated: at(0), counts: {}, sources: cases.map(([id, st, h]) => src(id, st, h)),
    }));
    writeFileSync(join(dir, "geocodes", "places.json"), JSON.stringify({ places: {}, known: {} }));

    execFileSync(process.execPath, [join(ROOT, "scripts", "merge_bids.mjs"),
      "--no-barchart", "--root", dir, "--now", new Date(NOW).toISOString()],
      { stdio: "pipe", encoding: "utf8" });

    const shards = readdirSync(join(dir, "data", "merged"))
      .map((f) => JSON.parse(readFileSync(join(dir, "data", "merged", f), "utf8")));
    const bySource = new Map();
    for (const sh of shards) for (const b of sh.bids) bySource.set(b.source, b);

    assert.ok(bySource.has("live-now"),    "a live board publishes");
    assert.ok(bySource.has("held-broken"), "a broken board with a 6.5h price still publishes");
    assert.ok(bySource.has("held-skip"),   "a skipped board still publishes");
    assert.ok(bySource.has("held-refuse"), "a refused board at 13.9h still publishes");
    assert.ok(!bySource.has("gone-broken"), "past 14h it is withdrawn");
    assert.ok(!bySource.has("gone-ok"),     'past 14h it is withdrawn even if status is "ok"');

    assert.equal(bySource.get("live-now").stale, false);
    assert.equal(bySource.get("held-broken").stale, true);
    assert.equal(bySource.get("held-broken").sourceStatus, "broken");
    assert.equal(bySource.get("held-broken").ageHours, 6.5);
    /* THE PRICE ITSELF MUST BE UNTOUCHED. A held row is the last good board,
       not a reconstruction of one. */
    assert.equal(bySource.get("held-broken").cash, 4.25);
    assert.equal(bySource.get("held-broken").basis, -0.35);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* THE PASS READS THREE AT A TIME, AND TWO THINGS HAD TO BE TRUE FIRST.
 *
 * 2026-09-18. The pass was browser-bound: 447 of 1,094 sources need a browser
 * read, they sit on 180 distinct pages, and those pages were read one after
 * another at 1.9s each — 316 seconds of a 360-second budget. So a pass reached
 * 595 to 805 sources and never all of them.
 *
 * Reading three at a time is measured at 2.22x (see the block above the pool in
 * poll.mjs). But concurrency is not a free switch, and this file is the two
 * things it broke or could break:
 *
 *   1. a cache that stores a VALUE is not a cache under concurrency
 *   2. a worker pool must cover every item exactly once and never exceed N
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");

/* ── 1. THE CACHE ──────────────────────────────────────────────────────────
   sharedFor() fetches seven AgriCharts quote pages and caches the parsed
   result. It cached the RESULT, set after the await. One reader at a time,
   that is the same thing. Three readers at a time, all three miss a cache
   nobody has filled yet, and the pass asks somebody else's server for
   twenty-one pages instead of seven. */
function valueCached(load) {                  // what it was
  const c = new Map();
  return async (k) => {
    if (c.has(k)) return c.get(k);
    const v = await load(k);
    c.set(k, v);
    return v;
  };
}
function promiseCached(load) {                // what it is
  const c = new Map();
  return (k) => {
    if (c.has(k)) return c.get(k);
    const p = load(k);
    c.set(k, p);
    return p;
  };
}
const counting = () => {
  let calls = 0;
  const load = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return "pages"; };
  return { load, calls: () => calls };
};

test("a VALUE cache fetches the shared pages once per concurrent reader", async () => {
  const c = counting();
  const get = valueCached(c.load);
  await Promise.all([get("k"), get("k"), get("k")]);
  assert.equal(c.calls(), 3, "this is the bug: three readers, three fetches of the same seven pages");
});

test("a PROMISE cache fetches them once, however many readers arrive together", async () => {
  const c = counting();
  const get = promiseCached(c.load);
  const all = await Promise.all([get("k"), get("k"), get("k")]);
  assert.equal(c.calls(), 1, "one fetch, which is what the log line 'read 7 shared page(s) once' claims");
  assert.deepEqual(all, ["pages", "pages", "pages"], "and every reader still gets the answer");
});

test("poll.mjs caches the shared pages as a promise, not as a value", () => {
  /* The shipped copy, not the specification above. */
  assert.match(src, /const p = \(async \(\) => \{/, "sharedFor must build the promise first");
  assert.match(src, /sharedCtx\.set\(key, p\);/, "and cache the promise");
  assert.doesNotMatch(src, /sharedCtx\.set\(key, ctx\)/, "caching the resolved value is the bug");
});

/* ── 2. THE POOL ───────────────────────────────────────────────────────────
   A queue drained by N workers. The read ORDER still matters — the reprieve
   puts the longest-starved pages at the front — so the pool must take from
   the front, not shuffle. */
async function pool(items, n, work) {
  let cursor = 0, live = 0, peak = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) {
      const it = items[cursor++];
      live++; peak = Math.max(peak, live);
      await work(it);
      live--;
    }
  }));
  return peak;
}

test("every source is read exactly once, and none is read twice", async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const seen = [];
  await pool(items, 3, async (i) => { await new Promise((r) => setTimeout(r, 1)); seen.push(i); });
  assert.equal(seen.length, 50);
  assert.deepEqual([...seen].sort((a, b) => a - b), items, "exactly once each");
});

test("never more than N in flight, whatever N is", async () => {
  for (const n of [1, 2, 3, 8]) {
    const peak = await pool(Array.from({ length: 30 }, (_, i) => i), n,
      () => new Promise((r) => setTimeout(r, 2)));
    assert.equal(peak, Math.min(n, 30), `concurrency ${n} must never exceed itself — saw ${peak}`);
  }
});

test("the queue is taken from the front, so the reprieve still means something", async () => {
  /* With one worker the order is exactly the read order. That is the case the
     reprieve tests in read-order.test.mjs assert, and it must still hold. */
  const seen = [];
  await pool(["reprieved", "clean-a", "clean-b"], 1, async (x) => { seen.push(x); });
  assert.deepEqual(seen, ["reprieved", "clean-a", "clean-b"]);
  /* And with three, the first three START in order even though they finish in
     whatever order the network decides. */
  const started = [];
  await pool(["a", "b", "c", "d"], 3, async (x) => { started.push(x); await new Promise((r) => setTimeout(r, 5)); });
  assert.deepEqual(started.slice(0, 3), ["a", "b", "c"]);
});

test("poll.mjs drives the read with a bounded pool, not a serial for-loop", () => {
  assert.match(src, /const READ_CONCURRENCY = Math\.max\(1, Number\(process\.env\.READ_CONCURRENCY \?\? 3\)\)/,
    "three by default, measured; overridable without a code change");
  assert.match(src, /while \(cursor < todo\.length\) await readOne\(todo\[cursor\+\+\]\)/,
    "one shared cursor is what makes it a queue and not N copies of the work");
  assert.doesNotMatch(src, /\nfor \(const s of todo\) \{\n  const out = join\(DATA/,
    "the serial read loop is what this replaces");
  /* The budget check must still run per source, inside the worker. */
  assert.match(src, /async function readOne\(s\) \{[\s\S]{0,400}budgetLeftMs\(\) <= 0/,
    "the wall is still checked before each source, not once for the pass");
});

/* A HUNG HOST MUST NOT BE ABLE TO SPEND THE PASS.
 *
 * scripts/poll.mjs called fetch() with no signal until 2026-09-16. Node's fetch
 * has no request timeout: a host that ACCEPTS the connection and then never
 * answers is bounded only by the headers timeout, which is 300 seconds — most
 * of a 360-second pass budget, spent on one source.
 *
 * The first two tests here are the measurement, not an assertion about the
 * documentation: a real socket that accepts and writes nothing, fetched
 * without a deadline and then with one. The unguarded call is left running
 * past the point that proves it, because waiting the full five minutes to
 * watch it finish is the fault, not the evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import {
  fetchWithin, deadlineFrom, shareOf, SOURCE_FETCH_MS_DEFAULT,
  NODE_HEADERS_TIMEOUT_MS, BROWSER_FLOOR_MS,
} from "../lib/deadline.mjs";

/** A socket that completes the TCP handshake and then says nothing at all.
 *  This is the shape the deadline exists for; a refused connection fails on
 *  its own and never needed guarding. */
function blackhole() {
  const held = [];
  const srv = net.createServer((s) => { held.push(s); s.on("error", () => {}); });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({
    url: `http://127.0.0.1:${srv.address().port}/markets/cashgrid.php`,
    close: () => { for (const s of held) s.destroy(); srv.close(); },
  })));
}

test("A HOST THAT ACCEPTS AND NEVER ANSWERS IS BOUNDED BY THE DEADLINE", async () => {
  const bh = await blackhole();
  try {
    const began = Date.now();
    await assert.rejects(
      () => fetchWithin(bh.url, {}, Date.now() + 700),
      /no answer within \d+ms/,
      "it must fail with how long it waited and on whose behalf, not with \"aborted\"");
    const took = Date.now() - began;
    assert.ok(took < 3000, `bounded at 700ms, took ${took}ms`);
  } finally { bh.close(); }
});

test("and the same host, fetched WITHOUT a deadline, is still waiting", async () => {
  const bh = await blackhole();
  const ac = new AbortController();
  try {
    /* THE CONTROL. Plain fetch() — what poll.mjs did — against the same socket.
       It is cut off here at two seconds to keep the suite quick; the point is
       that it has not settled, and Node's own ceiling for it is 300s. */
    const race = await Promise.race([
      fetch(bh.url, { signal: ac.signal }).then(() => "settled", () => "settled"),
      new Promise((r) => setTimeout(() => r("still waiting"), 2000)),
    ]);
    assert.equal(race, "still waiting",
      "if this ever settles on its own the premise has changed and the numbers below are stale");
    assert.equal(NODE_HEADERS_TIMEOUT_MS, 300_000);
  } finally { ac.abort(); bh.close(); }
});

test("A GOOD HOST INSIDE THE DEADLINE IS UNTOUCHED", async () => {
  const { createServer } = await import("node:http");
  const http = createServer((_q, res) => { res.writeHead(200); res.end("board"); });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  try {
    const res = await fetchWithin(`http://127.0.0.1:${http.address().port}/`, {},
      deadlineFrom(Date.now(), 6 * 60 * 1000));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "board");
  } finally { http.close(); }
});

test("THE DEADLINE IS CLAMPED TO WHAT IS LEFT OF THE PASS BUDGET", () => {
  const now = 1_000_000;
  /* Early in a pass the source cap is the binding one. */
  assert.equal(deadlineFrom(now, 300_000, 12_000), now + 12_000);
  /* Near the wall the BUDGET is, because the budget is only checked BEFORE
     each source: a fetch starting with four seconds left would otherwise carry
     the pass past it, and a pass that is killed commits nothing at all. */
  assert.equal(deadlineFrom(now, 4_000, 12_000), now + 4_000);
  /* Spent is spent, and never negative. */
  assert.equal(deadlineFrom(now, -9_000, 12_000), now);
  assert.equal(deadlineFrom(now, 0, 12_000), now);
});

test("A DEADLINE ALREADY PAST REFUSES INSTEAD OF CALLING OUT", async () => {
  let asked = 0;
  await assert.rejects(
    () => fetchWithin("http://127.0.0.1:1/", {}, Date.now() - 1,
      { impl: () => { asked++; return Promise.resolve(new Response("")); } }),
    /deadline had already passed/);
  assert.equal(asked, 0, "the budget was gone; nothing should have gone out on the wire");
});

test("THE DEADLINE IS ABSOLUTE, SO ONE SOURCE'S URL LIST SHARES IT", async () => {
  /* urlsFor() yields a host and its www twin — the SAME site written two ways.
     A per-attempt timeout bills a dead site twice for one answer, so poll.mjs
     hands both attempts the same mark. Two 400ms attempts against a mark 400ms
     out must cost 400ms in total, not 800. */
  const bh = await blackhole();
  try {
    const mark = Date.now() + 400;
    const began = Date.now();
    /* Two genuinely different hostnames for one socket, which is what the
       host/www pair is: localhost and 127.0.0.1 resolve to the same place. */
    for (const u of [bh.url, bh.url.replace("127.0.0.1", "localhost")]) {
      await fetchWithin(u, {}, mark).catch(() => {});
    }
    const took = Date.now() - began;
    assert.ok(took < 1200, `two attempts on one 400ms mark took ${took}ms`);
  } finally { bh.close(); }
});

test("the default is stated in one place and poll.mjs reads it from there", () => {
  assert.equal(SOURCE_FETCH_MS_DEFAULT, 12_000);
});

/* ── AND THE READER MUST ACTUALLY USE IT ────────────────────────────────────
 *
 * Everything above tests lib/deadline.mjs. On 2026-09-16 the whole guard was
 * deleted out of scripts/poll.mjs by hand and the suite stayed green: the
 * library was covered and the only caller that matters was not. That is the
 * same shape as the three coordinate boxes and the futuresUnits knob with no
 * source turning it — a rule that is true in one file and untrue where it
 * ships.
 *
 * So this reads the script. It is a crude test and it is the one that fails
 * when somebody puts a bare fetch back. */
test("scripts/poll.mjs HAS NO UNGUARDED fetch()", () => {
  const src = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  /* Strip comments first: this file explains at length what Node's bare fetch
     does, and a test that greps prose finds its own documentation. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bare = [...code.matchAll(/(?<![.\w])fetch\s*\(/g)];
  assert.equal(bare.length, 0,
    `every fetch in the live reader goes through fetchWithin, so a hung host `
    + `cannot spend the pass. Found ${bare.length} bare call(s).`);
  assert.match(code, /fetchWithin\(/, "and it must still be reaching the network at all");
});


/* ── THE SPLIT, AND THE RUN THAT FOUND IT NEEDED ────────────────────────── */

test("A SHARED DEADLINE IS DIVIDED, NOT QUEUED", () => {
  const now = 1_000_000;
  /* Two urls on a 12s mark: 6s each, and the second gets the rest. */
  assert.equal(shareOf(now + 12_000, 2, now), now + 6_000);
  assert.equal(shareOf(now + 6_000, 1, now), now + 6_000);
  /* Three shared pages, a third each. */
  assert.equal(shareOf(now + 9_000, 3, now), now + 3_000);
  /* Spent is spent. */
  assert.equal(shareOf(now - 1, 2, now), now);
  assert.equal(shareOf(now + 12_000, 0, now), now);
});

test("an attempt that returns early hands its time to the next one", () => {
  const now = 1_000_000, mark = now + 12_000;
  assert.equal(shareOf(mark, 2, now), now + 6_000);
  /* First url answered in 500ms instead of spending its 6s: 11.5s remain and
     one attempt is left, so the twin gets all of it — not the 6s it was
     provisionally allotted. */
  assert.equal(shareOf(mark, 1, now + 500), now + 12_000);
});

test("THE PRODUCTION FAILURE THIS FIXES: 10,487ms of 12,000 on one hostname", () => {
  /* Run 2026-09-16T12:57:51Z, verbatim from the log:
       https://farmerswin.com/...     -> fetch failed
       https://www.farmerswin.com/... -> no answer within 1513ms
     Node's connect timeout (~10.5s) fired before the abort could, so the twin
     that exists BECAUSE only one of the pair is sometimes served got 1.5s. */
  const now = 0, CONNECT = 10_487;
  const unshared = 12_000 - CONNECT;
  assert.equal(unshared, 1_513, "this is the number the log printed");
  const shared = shareOf(now + 12_000, 2, now) - now;
  assert.equal(shared, 6_000);
  assert.ok(shared > unshared * 3, "the twin gets a real attempt, not a formality");
  /* And the site still costs the same in total. */
  assert.equal(shareOf(now + 12_000, 2, now) + 6_000, now + 12_000);
});

/* ── THE BROWSER FLOOR ───────────────────────────────────────────────────── */

test("THE BROWSER FLOOR IS ABOVE EVERY BROWSER READ EVER MEASURED", () => {
  /* The fourteen consecutive ADM gradable reads of run 2026-09-16T12:57:51Z,
     as seconds past 13:03:00, read off the log's own timestamps. Every one a
     successful read. */
  const at = [0.623, 2.194, 4.048, 5.732, 8.377, 10.319, 12.004,
              13.742, 15.361, 16.952, 19.705, 21.307, 22.926, 24.468];
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  const slowest = Math.max(...gaps);
  assert.equal(gaps.length, 13);
  assert.ok(Math.abs(slowest - 2.753) < 0.001, `slowest measured read ${slowest}s`);
  assert.ok(BROWSER_FLOOR_MS > slowest * 1000,
    "a floor at or under the slowest real read would skip reads that would have answered");
  assert.ok(BROWSER_FLOOR_MS < 45_000, "and it is a floor, not a second timeout");
});

test("scripts/poll.mjs CLAMPS THE BROWSER READ TO THE BUDGET", () => {
  /* capture() has accepted timeoutMs since it was written and poll.mjs never
     passed one, so `adm-enolane` started with 27.2s of budget left, spent
     45.4, and carried the pass 18.2 seconds past its own wall. A library
     constant nobody hands to the call is not a guard. */
  const src = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const calls = [...code.matchAll(/capture\(\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(calls.length, "poll.mjs must still be reading browser sources at all");
  for (const c of calls)
    assert.match(c, /timeoutMs/,
      "every capture() in the live reader carries a budget-clamped timeout");
  assert.match(code, /BROWSER_FLOOR_MS/,
    "and it must skip rather than record a browser read it never gave time to");
});

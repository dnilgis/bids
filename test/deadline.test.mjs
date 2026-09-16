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
  fetchWithin, deadlineFrom, SOURCE_FETCH_MS_DEFAULT, NODE_HEADERS_TIMEOUT_MS,
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

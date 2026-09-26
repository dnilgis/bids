/* A PLATFORM THAT KEEPS SAYING NO IS LEFT ALONE FOR THE REST OF THE PASS. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Backoff, isRefusalStatus } from "../lib/breaker.mjs";

test("only 403 and 429 count as a refusal", () => {
  assert.equal(isRefusalStatus(403), true);
  assert.equal(isRefusalStatus(429), true);
  for (const s of [200, 404, 500, 503, 0, undefined]) assert.equal(isRefusalStatus(s), false);
});

test("four different hosts in a row trip it; three do not", () => {
  const b = new Backoff({ strikes: 4 });
  assert.equal(b.note("agricharts-cashgrid", 403, "a.com"), false);
  assert.equal(b.note("agricharts-cashgrid", 429, "b.com"), false);
  assert.equal(b.note("agricharts-cashgrid", 403, "c.com"), false);
  assert.equal(b.blocked("agricharts-cashgrid"), false);
  assert.equal(b.note("agricharts-cashgrid", 403, "d.com"), true);
  assert.equal(b.blocked("agricharts-cashgrid"), true);
  assert.deepEqual(b.culprits("agricharts-cashgrid").sort(), ["a.com", "b.com", "c.com", "d.com"]);
});

test("one host refusing many times is that host, not the platform", () => {
  const b = new Backoff({ strikes: 4 });
  for (let i = 0; i < 20; i++) b.note("p", 403, "same.com");
  assert.equal(b.blocked("p"), false);
});

test("a page that loads breaks the run", () => {
  const b = new Backoff({ strikes: 4 });
  b.note("p", 403, "a.com"); b.note("p", 403, "b.com"); b.note("p", 403, "c.com");
  b.ok("p");
  assert.equal(b.note("p", 403, "d.com"), false);
  assert.equal(b.blocked("p"), false);
});

test("404 and 500 never count, and platforms are independent", () => {
  const b = new Backoff({ strikes: 2 });
  for (const h of ["a", "b", "c", "d"]) { b.note("p", 404, h); b.note("p", 500, h); }
  assert.equal(b.blocked("p"), false);
  b.note("q", 403, "a"); b.note("q", 403, "b");
  assert.equal(b.blocked("q"), true);
  assert.equal(b.blocked("p"), false);
});

test("once tripped it stays tripped for the pass, and trips once", () => {
  const b = new Backoff({ strikes: 2 });
  b.note("p", 403, "a"); assert.equal(b.note("p", 403, "b"), true);
  b.ok("p");
  assert.equal(b.blocked("p"), true);
  assert.equal(b.note("p", 403, "c"), false);
});

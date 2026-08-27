/* The Cloudflare Worker's entry point and its GitHub commit path.
 *
 * Runs under `node --test` with an injected fetch, so the whole reader is
 * covered without a Cloudflare account, a GitHub token, or a network. The
 * Worker's own runtime globals it needs (btoa/atob/TextEncoder/Response) all
 * exist in Node 22, which is what CI runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run, getPage } from "../worker/src/index.js";
import { makeRepo, GitHubError, b64encode, b64decode } from "../worker/src/github.js";
import { Refused } from "../lib/board.mjs";
import { serialise } from "../lib/board.mjs";
import { HEARTBEAT_H } from "../lib/decide.mjs";

/* A GAP THAT IS INSIDE THE HEARTBEAT, WHATEVER THE HEARTBEAT IS.
   Two tests below poll again "an hour later" to prove a quiet poll writes
   nothing. One hour was inside the heartbeat while it was six; it is outside
   it at half an hour, and both tests began failing for a reason that had
   nothing to do with the worker. Half the heartbeat is inside it by
   construction. */
const INSIDE_HEARTBEAT_MS = (HEARTBEAT_H / 2) * 36e5;

const html = readFileSync(new URL("../fixtures/bigriver-2121.html", import.meta.url), "utf8");
const NOW = "2026-08-17T16:32:26.765Z";

const ENV = {
  GITHUB_OWNER: "dnilgis", GITHUB_REPO: "bigriver-bids", GITHUB_BRANCH: "main",
  DATA_PATH: "data/boyceville.json", GITHUB_TOKEN: "t0ken",
};

const ok = (body, init = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, ...init });

/* A stand-in GitHub + their site. Records every call so the tests can assert
   on what was actually sent rather than on what we hoped was sent. */
function harness({ page = html, existing = null, putStatus = 200 } = {}) {
  const calls = [];
  let sha = existing ? "sha-1" : null;
  let stored = existing;
  let puts = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", opts });
    if (u.includes("bigriverbids.com")) {
      if (page === null) return new Response("nope", { status: 503 });
      return ok(page);
    }
    if (u.includes("api.github.com")) {
      if ((opts.method || "GET") === "GET") {
        if (stored === null) return new Response("{}", { status: 404 });
        return ok({ sha, content: b64encode(JSON.stringify(stored)) });
      }
      puts++;
      const st = typeof putStatus === "function" ? putStatus(puts) : putStatus;
      if (st !== 200) return new Response("conflict", { status: st });
      const body = JSON.parse(opts.body);
      stored = JSON.parse(b64decode(body.content));
      sha = `sha-${puts + 1}`;
      return ok({ commit: { sha: "abc" }, content: { sha } });
    }
    throw new Error(`unexpected fetch to ${u}`);
  };
  return { fetchImpl, calls, get stored() { return stored; }, get puts() { return puts; } };
}

test("a first run reads their page and commits the file", async () => {
  const h = harness();
  const s = await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  assert.equal(s.ok, true);
  assert.equal(s.rows, 7);
  assert.equal(s.wrote, true);
  assert.equal(s.changed, true);
  assert.equal(h.stored.count, 7);
  assert.equal(h.stored.bids[0].delivery, "August");
});

test("the request to their site identifies itself", async () => {
  const h = harness();
  await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  const theirs = h.calls.find((c) => c.url.includes("bigriverbids.com"));
  assert.match(theirs.opts.headers["User-Agent"], /agsist-bidreader/);
  assert.match(theirs.opts.headers["User-Agent"], /agsist\.com/);
});

test("an unchanged price inside the heartbeat commits nothing at all", async () => {
  const h0 = harness();
  await run(ENV, { now: NOW, fetchImpl: h0.fetchImpl });
  const first = h0.stored;

  const h = harness({ existing: first });
  const later = new Date(Date.parse(NOW) + INSIDE_HEARTBEAT_MS).toISOString();
  const s = await run(ENV, { now: later, fetchImpl: h.fetchImpl });
  assert.equal(s.wrote, false);
  assert.equal(h.puts, 0, "a quiet poll must not touch the repo");
  assert.equal(s.pricedAt, NOW, "and must carry the old pricedAt");
});

test("a moved price commits with the price in the subject line", async () => {
  const h0 = harness();
  await run(ENV, { now: NOW, fetchImpl: h0.fetchImpl });

  const moved = html.replace(">4.0750<", ">4.1250<").replace(">-0.5200<", ">-0.4700<");
  assert.notEqual(moved, html, "fixture shape changed; this test needs updating");
  const h = harness({ page: moved, existing: h0.stored });
  const s = await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  assert.equal(s.wrote, true);
  const put = h.calls.find((c) => c.method === "PUT");
  const msg = JSON.parse(put.opts.body).message;
  assert.match(msg, /^boyceville: August 4\.125 basis -0\.47$/);
});

test("a heartbeat commit says heartbeat, so git log stays a price record", async () => {
  const h0 = harness();
  await run(ENV, { now: NOW, fetchImpl: h0.fetchImpl });
  const h = harness({ existing: h0.stored });
  const muchLater = new Date(Date.parse(NOW) + 7 * 36e5).toISOString();
  const s = await run(ENV, { now: muchLater, fetchImpl: h.fetchImpl });
  assert.equal(s.wrote, true);
  assert.equal(s.changed, false);
  const msg = JSON.parse(h.calls.find((c) => c.method === "PUT").opts.body).message;
  assert.match(msg, /heartbeat/);
});

test("A REFUSED READ WRITES NOTHING AND HOLDS THE LAST GOOD PRICE", async () => {
  const h0 = harness();
  await run(ENV, { now: NOW, fetchImpl: h0.fetchImpl });
  const good = h0.stored;

  const h = harness({ page: "<html><body>maintenance</body></html>", existing: good });
  await assert.rejects(() => run(ENV, { now: NOW, fetchImpl: h.fetchImpl }),
    (e) => e instanceof Refused);
  assert.equal(h.puts, 0);
  assert.deepEqual(h.stored, good, "the committed price must be untouched by a bad read");
});

test("their site being down is refused, not published as an empty board", async () => {
  const h = harness({ page: null });
  await assert.rejects(() => run(ENV, { now: NOW, fetchImpl: h.fetchImpl }),
    (e) => e instanceof Refused && /HTTP 503/.test(e.message));
  assert.equal(h.puts, 0);
});

test("getPage falls through to the second spelling of their host", async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(String(url));
    if (tried.length === 1) return new Response("x", { status: 500 });
    return ok(html);
  };
  const r = await getPage(["https://a.example/x", "https://b.example/x"], { fetchImpl });
  assert.equal(tried.length, 2);
  assert.match(r.url, /b\.example/);
});

test("a short body is refused rather than parsed as a layout change", async () => {
  const fetchImpl = async () => ok("<html>redirecting</html>");
  await assert.rejects(() => getPage(["https://a.example/x"], { fetchImpl }),
    (e) => e instanceof Refused && /too short/.test(e.message));
});

test("a stale sha is retried once, then succeeds", async () => {
  /* Two cron firings overlapping. The PUT is rejected with 409 rather than
     clobbering, and the retry re-reads and wins. */
  const h = harness({ putStatus: (n) => (n === 1 ? 409 : 200) });
  const s = await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  assert.equal(s.wrote, true);
  assert.equal(h.puts, 2);
  const gets = h.calls.filter((c) => c.method === "GET" && c.url.includes("api.github")).length;
  assert.equal(gets, 2, "one read to decide, one re-read for the retry -- and no more");
});

test("a persistent conflict gives up rather than looping", async () => {
  const h = harness({ putStatus: 409 });
  await assert.rejects(() => run(ENV, { now: NOW, fetchImpl: h.fetchImpl }),
    (e) => e instanceof GitHubError && e.status === 409);
  assert.equal(h.puts, 2, "one retry, not an unbounded loop");
});

test("the GitHub read is not served from a cache", async () => {
  const h = harness();
  await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  const get = h.calls.find((c) => c.url.includes("api.github") && c.method === "GET");
  assert.equal(get.opts.cache, "no-store", "a cached blob means a stale sha means a 409 loop");
  assert.match(get.url, /ref=main/);
});

test("GitHub requests carry a User-Agent, which the API requires", async () => {
  const h = harness();
  await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  for (const c of h.calls.filter((x) => x.url.includes("api.github")))
    assert.ok(c.opts.headers["User-Agent"], "GitHub rejects requests with no User-Agent");
});

test("a quiet poll costs exactly one API read and no write", async () => {
  /* At ten-minute polling this runs about 3,300 times a month. A redundant
     GET here is 3,300 wasted calls against the rate limit to learn a sha the
     reader was already handed. */
  const h0 = harness();
  await run(ENV, { now: NOW, fetchImpl: h0.fetchImpl });
  const h = harness({ existing: h0.stored });
  await run(ENV, { now: new Date(Date.parse(NOW) + INSIDE_HEARTBEAT_MS).toISOString(), fetchImpl: h.fetchImpl });
  const gh = h.calls.filter((c) => c.url.includes("api.github"));
  assert.equal(gh.length, 1);
  assert.equal(gh[0].method, "GET");
});

test("a writing poll costs one read and one write, not two reads", async () => {
  const h = harness();
  await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  const gh = h.calls.filter((c) => c.url.includes("api.github"));
  assert.deepEqual(gh.map((c) => c.method), ["GET", "PUT"]);
});

test("dryRun builds and decides but never writes", async () => {
  const h = harness();
  const s = await run(ENV, { now: NOW, fetchImpl: h.fetchImpl, dryRun: true });
  assert.equal(s.rows, 7);
  assert.equal(s.wrote, false);
  assert.equal(h.puts, 0);
});

test("base64 survives non-ASCII, which btoa alone does not", () => {
  const s = 'basis note — "smart" quotes and é';
  assert.equal(b64decode(b64encode(s)), s);
  assert.throws(() => btoa(s), "if this stops throwing, the guard is still harmless");
});

test("committed bytes round-trip exactly", async () => {
  const h = harness();
  await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  const put = h.calls.find((c) => c.method === "PUT");
  const sent = b64decode(JSON.parse(put.opts.body).content);
  assert.equal(sent, serialise(h.stored));
  assert.ok(sent.endsWith("\n"));
});

test("the committer is the bot, not whoever owns the token", async () => {
  const h = harness();
  await run(ENV, { now: NOW, fetchImpl: h.fetchImpl });
  const body = JSON.parse(h.calls.find((c) => c.method === "PUT").opts.body);
  assert.deepEqual(body.committer, { name: "agsist-bot", email: "bot@agsist.com" });
  assert.equal(body.branch, "main");
});

test("a missing token is refused before anything is fetched", () => {
  assert.throws(() => makeRepo({ owner: "a", repo: "b", path: "c", branch: "main" }),
    (e) => e instanceof GitHubError && /no token/.test(e.message));
});

test("an unparseable committed file is treated as absent, not fatal", async () => {
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("bigriverbids.com")) return ok(html);
    if ((opts.method || "GET") === "GET") return ok({ sha: "s1", content: b64encode("{ not json") });
    return ok({ content: { sha: "s2" } });
  };
  const s = await run(ENV, { now: NOW, fetchImpl });
  assert.equal(s.wrote, true, "the next write should replace it rather than wedge shut");
});

test("A LOST WRITE RACE RE-DECIDES, IT DOES NOT RE-PUT A STALE BODY", async () => {
  /* The bug this replaces: the retry re-read only the sha and re-PUT the body
     it had computed against the pre-conflict file. Two overlapping cron
     firings, and the loser reverted the winner's price while its own commit
     said "heartbeat, no change" and its invocation went green.

     Realistic scenario: both firings read the same board, which has moved to
     4.125. A commits first. B's PUT 409s. B must re-read, see that 4.125 is
     already committed, and decide there is nothing left to do -- not re-post
     its own body, and not commit the same price a second time. */
  const h0 = harness();
  await run(ENV, { now: "2026-08-17T06:30:00.000Z", fetchImpl: h0.fetchImpl });
  const base = h0.stored;                            // 4.075, checked 06:30

  const moved = html.replace(">4.0750<", ">4.1250<").replace(">-0.5200<", ">-0.4700<");
  assert.notEqual(moved, html, "fixture shape changed; this test needs updating");

  // Exactly what firing A would have committed.
  const hA = harness({ page: moved });
  await run(ENV, { now: "2026-08-17T07:00:00.000Z", fetchImpl: hA.fetchImpl });
  const aFile = hA.stored;
  assert.equal(aFile.bids[0].cash, 4.125);

  let stored = JSON.parse(JSON.stringify(base));
  let sha = "sha-a";
  let puts = 0;
  const bodies = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("bigriverbids.com")) return ok(moved);
    if ((opts.method || "GET") === "GET")
      return ok({ sha, content: b64encode(JSON.stringify(stored)) });
    puts++;
    bodies.push(JSON.parse(b64decode(JSON.parse(opts.body).content)));
    if (puts === 1) {
      /* Firing A lands between our read and our write -- with the file the
         reader would genuinely have built, not a hand-patched approximation.
         Patching only bids[0].cash by hand leaves basisCents disagreeing and
         the retry correctly sees a real difference, which would make this
         test pass for the wrong reason. */
      stored = { ...aFile, pricedAt: "2026-08-17T07:00:00.000Z",
                 checkedAt: "2026-08-17T07:00:00.000Z" };
      sha = "sha-b";
      return new Response("conflict", { status: 409 });
    }
    stored = bodies[bodies.length - 1];
    return ok({ content: { sha: "sha-c" } });
  };

  const s = await run(ENV, { now: "2026-08-17T07:00:05.000Z", fetchImpl });

  assert.equal(s.retried, true, "the conflict must be retried, not swallowed");
  assert.equal(puts, 1, "re-deciding against the new file leaves nothing to write");
  assert.equal(s.wrote, false);
  assert.equal(stored.bids[0].cash, 4.125, "the winner's price must survive");
  assert.equal(stored.pricedAt, "2026-08-17T07:00:00.000Z",
    "and pricedAt must not be walked back to claim the board has not moved");
});

test("but a conflict that leaves genuine news still writes it", async () => {
  /* The mirror case, so the retry is not just 'give up quietly'. Another
     firing commits something, we lose the race, and on re-reading we still
     have a price the repo does not have. It must go in. */
  const h0 = harness();
  await run(ENV, { now: "2026-08-17T06:30:00.000Z", fetchImpl: h0.fetchImpl });
  let stored = JSON.parse(JSON.stringify(h0.stored));
  const moved = html.replace(">4.0750<", ">4.1250<").replace(">-0.5200<", ">-0.4700<");
  let sha = "sha-a", puts = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("bigriverbids.com")) return ok(moved);
    if ((opts.method || "GET") === "GET")
      return ok({ sha, content: b64encode(JSON.stringify(stored)) });
    puts++;
    if (puts === 1) {   // someone commits an unrelated heartbeat, price unchanged
      stored = { ...stored, checkedAt: "2026-08-17T07:00:00.000Z" };
      sha = "sha-b";
      return new Response("conflict", { status: 409 });
    }
    stored = JSON.parse(b64decode(JSON.parse(opts.body).content));
    return ok({ content: { sha: "sha-c" } });
  };
  const s = await run(ENV, { now: "2026-08-17T07:00:05.000Z", fetchImpl });
  assert.equal(s.retried, true);
  assert.equal(s.wrote, true);
  assert.equal(stored.bids[0].cash, 4.125, "the moved price must not be lost to a conflict");
});

test("the repo config is validated BEFORE their site is touched", async () => {
  /* Big River agreed to this being read. A misconfigured Worker that hits
     their page every ten minutes and only then dies on its own missing token
     is a bad way to spend that. */
  const hit = [];
  const fetchImpl = async (url) => { hit.push(String(url)); return ok(html); };
  await assert.rejects(() => run({ ...ENV, GITHUB_TOKEN: undefined }, { now: NOW, fetchImpl }),
    (e) => e instanceof GitHubError && /no token/.test(e.message));
  assert.deepEqual(hit, [], "nothing should have been fetched at all");
});

test("source.url names the URL actually read, not the one we hoped for", async () => {
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("bigriverbids.com")) {
      n++;
      return n === 1 ? new Response("x", { status: 500 }) : ok(html);
    }
    if ((opts.method || "GET") === "GET") return new Response("{}", { status: 404 });
    return ok({ content: { sha: "s" } });
  };
  const s = await run(ENV, { now: NOW, fetchImpl, dryRun: true });
  assert.match(s.readFrom, /^https:\/\/www\./,
    "the apex failed, so the www spelling served it");
});

test("absent and unreadable are different facts, and the second is flagged", async () => {
  const mk = (ghGet) => async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("bigriverbids.com")) return ok(html);
    if ((opts.method || "GET") === "GET") return ghGet();
    return ok({ content: { sha: "s" } });
  };
  const absent = await run(ENV, { now: NOW, fetchImpl: mk(() => new Response("{}", { status: 404 })) });
  assert.equal(absent.firstRun, true);
  assert.equal(absent.previousUnreadable, false);

  const broken = await run(ENV, {
    now: NOW,
    fetchImpl: mk(() => ok({ sha: "s1", content: b64encode("{ truncated") })),
  });
  assert.equal(broken.firstRun, false, "the file exists; this is not a first run");
  assert.equal(broken.previousUnreadable, true, "and that has to be visible in the log line");
});

test("a 200 that is not a file is a GitHubError, not a stray TypeError", async () => {
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("bigriverbids.com")) return ok(html);
    return ok({ message: "this is a directory listing, not a file" });
  };
  await assert.rejects(() => run(ENV, { now: NOW, fetchImpl }),
    (e) => e instanceof GitHubError && /no file content/.test(e.message));
});

test("a 200 with a non-JSON body is a GitHubError, not a SyntaxError", async () => {
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("bigriverbids.com")) return ok(html);
    return new Response("<html>maintenance</html>", { status: 200 });
  };
  await assert.rejects(() => run(ENV, { now: NOW, fetchImpl }),
    (e) => e instanceof GitHubError && /non-JSON body/.test(e.message));
});

/* A BOARD THAT ANSWERS 403 OR 429 IS ASKED AGAIN IN HOURS, NOT EVERY PASS -- 2026-10-27.
 *
 * The real case: Insight FS (2 sources on api.dtn.com) has answered 403 "The
 * site identifier pro..." on every pass, 1,437 consecutive fails by
 * data/index.json 2026-10-27T01:10Z, which is a request every ten minutes to a
 * site that has said no. Nothing here gets past a block; the tests pin that a
 * refusal STOPS the asking, that a shared host is not held for one site's 403,
 * and that a page that answers clears the hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { retryAfterMs, holdUntilFor, refusalHolds, refusalWaiting, HostHold, REFUSAL_HOLD_H, MAX_RETRY_AFTER_H, isSkip, Skipped } from "../lib/breaker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const poll = readFileSync(join(ROOT, "scripts/poll.mjs"), "utf8");

test("Retry-After is read as seconds or a date, and the hold is clamped to 10 minutes .. MAX_RETRY_AFTER_H", () => {
  const now = Date.parse("2026-10-27T01:00:00Z");
  assert.equal(retryAfterMs("120", now), 120_000);
  assert.equal(retryAfterMs("Tue, 27 Oct 2026 02:00:00 GMT", now), 3600_000);
  assert.equal(retryAfterMs("", now), null);
  assert.equal(retryAfterMs("soon", now), null);
  assert.equal(holdUntilFor(429, "120", now), "2026-10-27T01:10:00.000Z", "never sooner than 10 minutes");
  assert.equal(holdUntilFor(429, "7200", now), "2026-10-27T03:00:00.000Z");
  assert.equal(holdUntilFor(429, String(99 * 3600), now), new Date(now + MAX_RETRY_AFTER_H * 3600_000).toISOString());
  assert.equal(holdUntilFor(403, "60", now), new Date(now + REFUSAL_HOLD_H * 3600_000).toISOString(), "a 403's Retry-After is not a promise");
  assert.equal(holdUntilFor(429, null, now), new Date(now + REFUSAL_HOLD_H * 3600_000).toISOString());
});

test("holds are per page from last pass's rows, and end at their stamp", () => {
  const key = (s) => `|${s.url}`;
  const srcs = [{ id: "insightfs-a", url: "https://api.dtn.com/x" }, { id: "insightfs-b", url: "https://api.dtn.com/x" }, { id: "other", url: "https://api.dtn.com/y" }];
  const rows = new Map([["insightfs-a", { holdUntil: "2026-10-27T04:00:00Z" }], ["insightfs-b", { holdUntil: "2026-10-27T03:00:00Z" }], ["other", {}]]);
  const h = refusalHolds(srcs, rows, key);
  assert.equal(h.size, 1, "the page that did not refuse is not held, though it is on the same host");
  assert.equal(refusalWaiting(h, "|https://api.dtn.com/x", Date.parse("2026-10-27T03:30:00Z")), true, "the latest stamp of the page wins");
  assert.equal(refusalWaiting(h, "|https://api.dtn.com/x", Date.parse("2026-10-27T04:00:00Z")), false);
  assert.equal(refusalWaiting(h, "|https://api.dtn.com/y", Date.parse("2026-10-27T03:30:00Z")), false);
  const hh = new HostHold();
  hh.hold("api.dtn.com", 403);
  assert.equal(hh.held("api.dtn.com"), false, "a 403 does not hold a shared host");
  hh.hold("www.landus.ag", 429);
  assert.equal(hh.held("www.landus.ag"), true, "a 429 is the host's rate limit and holds it for the pass");
});

test("the poller checks the hold before the page cache, skips (streak untouched), stamps on refusal and clears on a read", () => {
  const gp = poll.indexOf("async function getPage(s)");
  const held = poll.indexOf("if (refusalWaiting(key))", gp);
  assert.ok(held > gp && held < poll.indexOf("if (pages.has(key)) return pages.get(key);", gp));
  assert.match(poll, /\{ refusalHeld: true \}\);/);
  assert.match(poll, /if \(e\?\.refusalHold\) r\.holdUntil = e\.refusalHold;/);
  assert.match(poll, /if \(!pasted\) delete r\.holdUntil;/);
  assert.match(poll, /\.\.\.\(prevRow\.get\(s\.id\)\?\.holdUntil \? \{ holdUntil: prevRow\.get\(s\.id\)\.holdUntil \} : \{\}\)/);
  assert.match(poll, /!botCheckWaiting\(k, reprieveAt\) && !refusalWaiting\(k, reprieveAt\)/, "the reprieve does not ask a held page");
  assert.equal(isSkip(Object.assign(new Skipped("not asked this pass"), { refusalHeld: true })), true);
  /* nothing changes who we say we are or retries faster on a refusal */
  const i = poll.indexOf("let refusals = 0, refusal = null");
  const block = poll.slice(i, poll.indexOf("pages.set(key, p);", i));
  assert.doesNotMatch(block, /User-Agent|setTimeout|retry\(/i);
});

/* ---- end to end: two passes against a board that answers 403, then 200 ---- */
function runPoll(T) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["scripts/poll.mjs"], { cwd: T, env: { ...process.env, BOT_CHECK_BACKOFF_H: "3" } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => c.kill("SIGKILL"), 100000);
    c.on("close", (code) => { clearTimeout(t); res({ code, out }); });
  });
}

test("poll.mjs end to end: a 403 board is held after one ask, not asked on the next pass, and a held row carries the stamp",
  { timeout: 240000 }, async () => {
  let status = 403;
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(status, { "content-type": "text/html" });
    res.end(status === 403 ? "<html><body>Forbidden</body></html>" : "<html><body>no board here</body></html>".padEnd(800, " "));
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const T = mkdtempSync(join(tmpdir(), "refusal-hold-"));
  try {
    for (const d of ["scripts", "sources", "data"]) mkdirSync(join(T, d));
    copyFileSync(join(ROOT, "scripts/poll.mjs"), join(T, "scripts/poll.mjs"));
    symlinkSync(join(ROOT, "lib"), join(T, "lib"));
    if (existsSync(join(ROOT, "package.json"))) copyFileSync(join(ROOT, "package.json"), join(T, "package.json"));
    const m = JSON.parse(readFileSync(join(ROOT, "sources/adellcoop-adell.json"), "utf8"));
    m.url = `http://127.0.0.1:${port}/cashbidssingle-1`;
    delete m.altUrls;
    writeFileSync(join(T, "sources", `${m.id}.json`), JSON.stringify(m, null, 2));

    const p1 = await runPoll(T);
    const row1 = JSON.parse(readFileSync(join(T, "data/index.json"), "utf8")).sources.find((x) => x.id === m.id);
    assert.ok(row1, p1.out.slice(-1500));
    assert.equal(seen.length, 1, `asked once: ${seen.join(", ")}`);
    assert.match(row1.error, /HTTP 403/);
    const until = Date.parse(row1.holdUntil);
    assert.ok(Number.isFinite(until) && until - Date.now() > 2.5 * 3600_000, `held about ${REFUSAL_HOLD_H} hours: ${row1.holdUntil}`);

    const p2 = await runPoll(T);
    const row2 = JSON.parse(readFileSync(join(T, "data/index.json"), "utf8")).sources.find((x) => x.id === m.id);
    assert.equal(seen.length, 1, "the held page was not asked again on the next pass");
    assert.equal(row2.status, "skipped", p2.out.slice(-1500));
    assert.match(row2.error, /not asked this pass: .* answered 403 or 429/);
    assert.equal(row2.holdUntil, row1.holdUntil, "the stamp rides on the skipped row");
    assert.equal(row2.fails, row1.fails, "a held skip is not counted against the board");

    /* the hold ends: the page answers something else, and the stamp is gone */
    const idx = JSON.parse(readFileSync(join(T, "data/index.json"), "utf8"));
    idx.sources.find((x) => x.id === m.id).holdUntil = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(T, "data/index.json"), JSON.stringify(idx));
    status = 200;
    await runPoll(T);
    const row3 = JSON.parse(readFileSync(join(T, "data/index.json"), "utf8")).sources.find((x) => x.id === m.id);
    assert.equal(seen.length, 2, "asked again once the hold ran out");
    assert.equal(row3.holdUntil, undefined, "a page that answered other than 403/429 carries no hold");
  } finally { srv.close(); }
});

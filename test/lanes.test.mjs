/* TWO LANES: every board gets a turn, a browser board never waits behind a
 * fetch, and the extra fetch workers never put two requests on one host at
 * once. See lib/lanes.mjs for the count that started it (Oct 17-20: a median
 * 620 of 2,281 sources not reached per pass; 2,432 browser skips as "not
 * attempted: N ms of the pass budget were left" over 288 passes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { planLanes, drain, hostKey } from "../lib/lanes.mjs";
import { transportOf, loadSources } from "../lib/sources.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (id, platform, url) => ({ id, platform, url });

test("browser sources go to the browser lane one per job; fetch sources are grouped by host, in order", () => {
  const sorted = [
    S("a", "agricharts-cashgrid", "https://x.agricharts.com/markets/cashgrid.php"),
    S("b", "dtn-cs", "https://api.dtn.com/markets/sites/e1/cash-bids"),
    S("c", "heartland", "https://www.heartlandcoop.com/bids"),
    S("d", "agricharts-cashgrid", "https://www.x.agricharts.com/markets/cashgrid.php"),
    S("e", "newcoop", "https://www.newcoop.com/cash-bids"),
  ];
  const { browser, fetch } = planLanes(sorted, { transportOf });
  assert.deepEqual(browser.map((j) => j.map((s) => s.id)), [["b"], ["e"]]);
  assert.deepEqual(fetch.map((j) => j.map((s) => s.id)), [["a", "d"], ["c"]], "www and bare host are one host");
  assert.equal(hostKey("https://WWW.Example.com/x"), "example.com");
});

test("the real manifest: every enabled source lands in exactly one lane", () => {
  const dir = new URL("../sources/", import.meta.url);
  const rows = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  const { sources } = loadSources(rows);
  const { browser, fetch } = planLanes(sources, { transportOf });
  const ids = [...browser.flat(), ...fetch.flat()].map((s) => s.id);
  assert.equal(ids.length, sources.length);
  assert.equal(new Set(ids).size, sources.length);
  assert.ok(browser.flat().every((s) => transportOf(s.platform) === "browser"));
  assert.ok(fetch.flat().every((s) => transportOf(s.platform) !== "browser"));
  /* one job per host */
  const hosts = fetch.map((j) => hostKey(j[0].url));
  assert.equal(new Set(hosts).size, hosts.length);
  assert.ok(fetch.every((j) => j.every((s) => hostKey(s.url) === hostKey(j[0].url))));
});

test("drain reads every source exactly once, never more than N jobs at a time, front first", async () => {
  const jobs = Array.from({ length: 20 }, (_, i) => [i * 2, i * 2 + 1]);
  let live = 0, peak = 0;
  const seen = [], started = [];
  const r = await drain(jobs, 3, async (x) => {
    started.push(x); live++; peak = Math.max(peak, live);
    await sleep(2); seen.push(x); live--;
  });
  assert.equal(r.sources, 40);
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
  assert.equal(peak, 3);
  assert.deepEqual(started.slice(0, 3), [0, 2, 4], "the first three jobs start in read order");
});

test("one host's sources are never read at the same time", async () => {
  const sorted = Array.from({ length: 12 }, (_, i) => S(`s${i}`, "graindesk", `https://h${i % 2}.example/b${i}`));
  const { fetch } = planLanes(sorted, { transportOf });
  const busy = new Set(); let clash = 0;
  await drain(fetch, 6, async (s) => {
    const h = hostKey(s.url);
    if (busy.has(h)) clash++;
    busy.add(h); await sleep(3); busy.delete(h);
  });
  assert.equal(clash, 0);
});

test("a slow browser lane does not hold up the fetch lane, and the reverse", async () => {
  /* The old single queue: the fetch boards sorted behind ten slow browser loads
     waited for them. Two lanes run side by side. */
  const t0 = Date.now(); const doneAt = {};
  const browserJobs = Array.from({ length: 6 }, (_, i) => [`b${i}`]);
  const fetchJobs = Array.from({ length: 6 }, (_, i) => [`f${i}`]);
  await Promise.all([
    drain(browserJobs, 3, async (x) => { await sleep(60); doneAt[x] = Date.now() - t0; }),
    drain(fetchJobs, 3, async (x) => { await sleep(5); doneAt[x] = Date.now() - t0; }),
  ]);
  const lastFetch = Math.max(...fetchJobs.flat().map((x) => doneAt[x]));
  const firstBrowser = Math.min(...browserJobs.flat().map((x) => doneAt[x]));
  assert.ok(lastFetch < firstBrowser, `every fetch finished (${lastFetch}ms) before the first browser load (${firstBrowser}ms)`);
});

test("poll.mjs runs both lanes at once against the one wall, and records what each did", () => {
  const src = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(src, /const lanes = planLanes\(todo, \{ transportOf \}\);/);
  assert.match(src, /await Promise\.all\(\[\n  drain\(lanes\.browser, READ_CONCURRENCY, readOne\),\n  drain\(lanes\.fetch, FETCH_CONCURRENCY, readOne\),\n\]\)/);
  assert.match(src, /const FETCH_CONCURRENCY = Math\.max\(1, Number\(process\.env\.FETCH_CONCURRENCY \?\? 3\)\)/);
  assert.match(src, /lanes: laneStats,/, "index.json carries each lane's numbers");
  assert.match(src, /async function readOne\(s\) \{[\s\S]{0,400}budgetLeftMs\(\) <= 0/, "the wall is still checked per source");
});

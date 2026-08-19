/* The five defects found by asking "you sure" on 2026-08-19, each pinned.
 * Every one of them rendered as success, which is why none may come back. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { urlsFor, loadSources, validateSource } from "../lib/sources.mjs";
import { render, stateOf, density } from "../scripts/status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snap = () => existsSync(join(ROOT, "data"))
  ? readdirSync(join(ROOT, "data")).sort()
      .map((f) => `${f}:${statSync(join(ROOT, "data", f)).mtimeMs}:${readFileSync(join(ROOT, "data", f), "utf8").length}`)
      .join("|")
  : "";

test("1. a fixture run writes NOTHING", () => {
  // It once wrote data/boyceville.json -- the file both Emmert sites read --
  // from test prices, because --fixture did not imply --dry-run.
  const before = snap();
  const out = execFileSync("node", ["scripts/poll.mjs", "--only", "boyceville",
    "--fixture", "boyceville=fixtures/bigriver-2121-settled.html"],
    { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /writing nothing/, "it must say so out loud");
  assert.equal(snap(), before, "a fixture run changed data/ -- test prices reached the live file");
});

test("2. a source is tried on both the apex and the www host", () => {
  const u = urlsFor({ url: "https://bigriverbids.com/cashbidssingle-2121" });
  assert.ok(u.includes("https://bigriverbids.com/cashbidssingle-2121"));
  assert.ok(u.some((x) => x.includes("www.bigriverbids.com")), "www twin missing");
  const w = urlsFor({ url: "https://www.example.com/x" });
  assert.ok(w.some((x) => x.startsWith("https://example.com/")), "apex twin missing");
  assert.deepEqual(urlsFor({ url: "https://a.com/x", altUrls: ["https://a.com/x"] })
    .filter((x) => x === "https://a.com/x").length, 1, "no duplicates");
});

test("3. the workflow commits every source's file, not one hardcoded path", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/poll.yml"), "utf8");
  const add = [...yml.matchAll(/^\s*git add (\S+)/gm)].map((m) => m[1]);
  assert.ok(add.includes("data/"),
    `workflow adds ${JSON.stringify(add)} -- a hardcoded data file silently drops every other source`);
  assert.ok(!add.includes("data/boyceville.json"), "the hardcoded path is back");
  assert.match(yml, /node scripts\/poll\.mjs/, "workflow must run the multi-source reader");
  assert.ok(!/run: node scripts\/fetch\.mjs/.test(yml),
    "fetch.mjs and poll.mjs both write data/boyceville.json -- only one may be scheduled");
});

test("4. read-health comes from `health` and from nothing else", () => {
  const now = Date.parse("2026-08-19T21:20:00Z");
  const fresh = "2026-08-19T21:15:00Z";
  assert.equal(stateOf({ health: "refused", checkedAt: fresh }, now), "late");
  assert.equal(stateOf({ health: "refused", checkedAt: "2026-08-18T05:00:00Z" }, now), "down");
  assert.equal(stateOf({ health: "live", checkedAt: fresh }, now), "live");
  // THE DISCRIMINATING CASE. `state` is the US state on a manifest row. If
  // stateOf ever falls back to it, a row carrying state:"refused" is read as a
  // refusal -- and this assertion goes red. The first version of this test
  // used state:"WI", which no fallback could misread, so it could not fail.
  assert.equal(stateOf({ state: "refused", checkedAt: fresh }, now), "live",
    "stateOf fell back to `state` -- one key, two meanings");
  assert.equal(stateOf({ state: "WI", checkedAt: fresh }, now), "live");
});

test("5. a board that read nothing is not an all-clear", () => {
  const html = render({ generated: "2026-08-19T21:00:00Z", sources: [] }, Date.now());
  assert.ok(!/ALL SOURCES LIVE/.test(html), "zero sources rendered as healthy");
  assert.match(html, /NO SOURCES READ/);
  assert.match(html, /verdict down/);
  assert.match(html, /Nothing was read/);
});

test("the manifest refuses a source that could not publish", () => {
  assert.ok(validateSource({ id: "x", operator: "o", location: "l", platform: "aghost",
    url: "https://a.com" }).some((e) => /no bands/.test(e)), "a source with no band is a silent outage");
  assert.ok(validateSource({ id: "x", operator: "o", location: "l", platform: "nope",
    url: "https://a.com", bands: { corn: [2, 12] } }).some((e) => /unknown platform/.test(e)));
  assert.ok(validateSource({ id: "x", operator: "o", location: "l", platform: "aghost",
    url: "https://a.com", bands: { corn: [12, 2] } }).some((e) => /inverted/.test(e)));
  assert.ok(validateSource({ id: "x", operator: "o", location: "l", platform: "aghost",
    url: "https://a.com", bands: { corn: [2, 12] }, cashRoundingCents: 40 })
    .some((e) => /cashRoundingCents/.test(e)), "a huge tolerance is not rounding");
});

test("every shipped source row is valid", () => {
  const rows = readdirSync(join(ROOT, "sources")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ROOT, "sources", f), "utf8")));
  const { errors } = loadSources(rows);
  assert.deepEqual(errors, []);
  const boyceville = rows.find((r) => r.id === "boyceville");
  assert.ok(boyceville, "the id must stay `boyceville`: data/<id>.json is what the Emmert Worker reads");
  assert.equal(boyceville.cashRoundingCents ?? 0, 0, "Boyceville posts full precision; it needs no tolerance");
});

test("the board stays on one screen as sources multiply", () => {
  assert.equal(density(3).label, "full");
  assert.equal(density(300).label, "micro");
  assert.ok(density(300).min < density(3).min, "tiles must shrink, not the page grow");
});

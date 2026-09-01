/* A GUARD NOBODY RUNS IS A DRAFT.
 *
 * WHY THIS EXISTS. On 2026-09-01 two test files were added to this repo —
 * test/registry-run-together.test.py and test/unplaced-reason.test.py — covering
 * the registry joiner that had been eating 63 records and the rejection messages
 * that had been shipping with a hole in them. Both passed. Neither ran.
 *
 * `npm test` is `node --test test/*.test.mjs`. A python guard sits beside those
 * files, passing only on the days somebody remembers it by hand, and there is
 * nothing to notice: no red tick, no missing output, just a rule that quietly
 * stopped being enforced. It was found because Sig asked "are you sure" — which
 * is not a process.
 *
 * So this is the process. Every test file in test/ must be reachable by
 * something that runs on its own: the npm glob, or a step in a workflow. Adding
 * a guard in a language the glob does not cover now fails HERE until it is
 * wired to something that will actually run it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WORKFLOWS = join(ROOT, ".github", "workflows");

const testFiles = readdirSync(join(ROOT, "test"))
  .filter((f) => /\.test\.(mjs|py|js|ts)$/.test(f));

/* What `npm test` covers, read from package.json rather than assumed — the glob
   is the thing that changes, and assuming it is how this gap opened. */
const npmTest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.test;
const globbed = (f) => {
  const m = npmTest.match(/test\/\*\.test\.(\w+)/);
  return !!m && f.endsWith(`.test.${m[1]}`);
};

/* COMMENTS ARE NOT COVERAGE.
 * The first cut of the check below matched the phrase "npm test" wherever it
 * appeared — and registries.yml contains a COMMENT explaining that npm test
 * globs test/*.test.mjs. So the guard passed by reading my own prose about the
 * bug it was written to catch, and went green with the CI workflow deleted.
 * Caught by deleting that workflow and watching nothing happen, which is the
 * only reason to ever delete it. Every line beginning with # is dropped first. */
const stripComments = (t) => t.split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

const workflowText = existsSync(WORKFLOWS)
  ? readdirSync(WORKFLOWS).map((w) => stripComments(readFileSync(join(WORKFLOWS, w), "utf8"))).join("\n")
  : "";

test("there are test files to check", () => {
  assert.ok(testFiles.length > 10, `only ${testFiles.length} test files found — is the path right?`);
});

/* ── AND THE GLOB ONLY COUNTS IF SOMETHING RUNS IT ──────────────────────────
 *
 * The first version of this file was written on 2026-09-01 to catch two python
 * guards that no workflow ran. It treated the npm glob as coverage — and the
 * next time Sig asked "are you sure", the answer was that NOTHING RAN NPM TEST
 * EITHER. Thirteen workflows, each with its own hand-picked list, and 24 of 42
 * test files run by nothing at all: board, parse, guards, registries — the
 * readers this repository is.
 *
 * That is this exact bug one level up, inside the guard written to catch it. So
 * the glob is not taken on trust: some workflow must actually invoke it.
 */
test("something actually runs the npm suite", () => {
  assert.ok(/(^|\s)(npm (run )?test|node --test test\/\*)/m.test(workflowText),
    `no workflow runs "${npmTest}". Every test file that relies on the glob — and `
    + "that is most of them — passes only when somebody types it on a laptop. "
    + "The glob is not coverage until a workflow invokes it.");
});

/* Same question for the python guards, which the glob cannot see at all. */
test("something actually runs the python guards", () => {
  const py = testFiles.filter((f) => f.endsWith(".test.py"));
  if (!py.length) return;
  const globbedPy = /test\/\*\.test\.py/.test(workflowText);
  const namedAll = py.every((f) => workflowText.includes(f));
  assert.ok(globbedPy || namedAll,
    "python guards exist that no workflow globs or names: " + py.join(", "));
});

test("EVERY test file is run by something that runs on its own", () => {
  const orphans = testFiles.filter((f) => !globbed(f) && !workflowText.includes(f));
  assert.deepEqual(orphans, [],
    `these guards are never run — not by "${npmTest}", not by any workflow:\n`
    + orphans.map((o) => `    test/${o}`).join("\n")
    + "\n  Add them to a workflow step, or they only pass on the days somebody remembers.");
});

/* The npm glob covering nothing would make the check above vacuously true. */
test("the npm glob actually matches most of the suite", () => {
  const n = testFiles.filter(globbed).length;
  assert.ok(n >= testFiles.length - 5,
    `only ${n} of ${testFiles.length} test files match "${npmTest}" — the glob may have changed`);
});

/* AND THE WORKFLOWS THEMSELVES MUST BE REACHABLE.
   A workflow with no trigger is the same failure one level up: it exists, it
   looks like coverage, and it never fires. */
test("every workflow has a trigger that can fire without a person", { skip: !workflowText }, () => {
  const dead = [];
  for (const w of readdirSync(WORKFLOWS)) {
    const t = readFileSync(join(WORKFLOWS, w), "utf8");
    const hasAuto = /^\s*(schedule|push|pull_request|repository_dispatch|workflow_call|workflow_run):/m.test(t);
    const hasManual = /^\s*workflow_dispatch:/m.test(t);
    if (!hasAuto && !hasManual) dead.push(w);
  }
  assert.deepEqual(dead, [], `these workflows can never fire: ${dead.join(", ")}`);
});

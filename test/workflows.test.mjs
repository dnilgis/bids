/* The workflow files still parse, and this guard still catches the reason
 * they once did not.
 *
 * On 2026-08-20 both Emmert sites stopped building for seventeen hours. The tests
 * passed, the scripts ran, the token worked and the dispatch was accepted
 * with a 204 -- and every run went red with no steps in it, because GitHub
 * could not parse prices.yml. A job that cannot start cannot run the tests
 * that would have caught it, so the test suite was never the thing that
 * could have found this. THE FILE HAS TO BE CHECKED AS A FILE.
 *
 * This runs against the workflow files actually in the repository, not
 * against a fixture, for the same reason: a fixture cannot go stale into
 * a form that stops GitHub from starting the job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { lintWorkflow } from "../lib/check-workflows.mjs";

const DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => readFileSync(join(DIR, f), "utf8");

test("there are workflow files to check at all", () => {
  // Without this, a rename to a path GitHub ignores would empty the loop
  // below and every test under it would pass by having nothing to do.
  assert.ok(FILES.length >= 4, `expected the workflows, found ${FILES.join(", ") || "none"}`);
  assert.ok(FILES.includes("poll.yml"), "poll.yml is the one that publishes");
});

for (const f of FILES) {
  test(`${f} has no line that stops YAML parsing`, () => {
    const faults = lintWorkflow(read(f));
    assert.deepEqual(
      faults, [],
      faults.map((x) => `${f}:${x.line}  ${x.text}\n    ${x.why}`).join("\n"),
    );
  });
}

/* The guard, guarded. Each case below is a line that has to be caught; if
 * one stops being caught, the guard has quietly stopped working and the
 * clean bill of health above means nothing.
 */
const CAUGHT = {
  "the line that actually shipped":
    'run: echo "dispatched by $FROM: $SOURCE moved, pricedAt $PRICED_AT"',
  "a colon and a space in a plain value": "run: echo rendering: the panel",
  "a plain value ending in a colon": "run: echo hours:",
  "a comment marker inside a quoted string": 'run: echo "rendered # done"',
};

for (const [name, line] of Object.entries(CAUGHT)) {
  test(`caught: ${name}`, () => {
    const doc = ["jobs:", "  j:", "    steps:", "      - name: x", `        ${line}`].join("\n");
    assert.equal(lintWorkflow(doc).length, 1, `not caught: ${line}`);
  });
}

const ALLOWED = {
  "a real comment on a real value": "contents: read          # it writes nothing",
  "a quoted value that contains a colon": 'run: "echo a: b"',
  "a flow mapping": 'with: { node-version: "20" }',
  "a flow sequence": "branches: [main]",
  "a cron, which is quoted": '- cron: "5,35 22,23,0-11 * * 1-5"',
  "an action reference": "uses: actions/checkout@v4",
  "an expression": "if: github.event_name == 'repository_dispatch'",
};

for (const [name, line] of Object.entries(ALLOWED)) {
  test(`allowed: ${name}`, () => {
    const doc = ["jobs:", "  j:", "    steps:", "      - name: x", `        ${line}`].join("\n");
    assert.deepEqual(lintWorkflow(doc), [], `false positive on: ${line}`);
  });
}

test("a block scalar is the shell's, and is not read as YAML", () => {
  // The commit step contains `git commit -m "prices: 20 August"`, which has
  // a colon and a space in it and is completely fine, because it is inside
  // `run: |`. A guard that flagged it would be unusable.
  const doc = [
    "jobs:", "  j:", "    steps:", "      - name: x",
    "        run: |",
    '          git commit -m "prices: 20 August"',
    '          echo "done # here"',
    "      - name: y",
    "        run: node x.mjs",
  ].join("\n");
  assert.deepEqual(lintWorkflow(doc), []);
});

test("a nested mapping is NOT a block, and is still checked", () => {
  // The first draft treated a bare `key:` as opening a block scalar, so it
  // skipped every line after `jobs:` and passed the very file it was
  // written to catch.
  const doc = ["jobs:", "  j:", "    steps:", "      - name: x", "        env:", "          A: b", "        run: echo a: b"].join("\n");
  assert.equal(lintWorkflow(doc).length, 1, "the mapping swallowed the lines under it");
});

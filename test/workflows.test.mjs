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

/* ══════════════════════════════════════════════════════════════════════════
   THE HOURLY LOOP — asked for by Sig on 2026-08-26 after the schedule was
   measured delivering one to two runs an hour against six.
   ══════════════════════════════════════════════════════════════════════════
   His words: "i want the one hour fire, but important that if it fails i want
   it to alert me or retry the run immediately instead of failing and then
   waiting for the next scheduled run."
   Three separate promises, and each gets its own assertion below.
   ══════════════════════════════════════════════════════════════════════════ */
test("the trading-window cron asks ONCE an hour, not six times", () => {
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  const crons = [...y.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
  const window_ = crons.find((c) => /12-21/.test(c));
  assert.ok(window_, "the trading-window cron is gone");
  const minutes = window_.split(" ")[0];
  assert.doesNotMatch(minutes, /,/,
    `the window cron still asks ${minutes.split(",").length} times an hour — GitHub was ` +
    "measured delivering one to two of those, which is what the loop replaces");
});

test("one pass of the reader is ONE THING, so it can be called in a loop", () => {
  const sh = readFileSync(new URL("../scripts/one-pass.sh", import.meta.url), "utf8");
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  for (const [what, re] of [["read", /node scripts\/poll\.mjs/],
                            ["commit", /git commit -F \.commit-message/],
                            ["push", /git push/],
                            ["tell the sites", /repository_dispatch|dispatches/]])
    assert.match(sh, re, `one-pass.sh does not ${what} — the pass is not whole`);
  assert.match(y, /bash scripts\/one-pass\.sh/, "the workflow no longer calls the pass");
  /* And the pass must NOT still be duplicated as steps, or two writers exist. */
  assert.doesNotMatch(y, /^\s+run: node scripts\/poll\.mjs\s*$/m,
    "poll.mjs is still invoked directly by a step as well as by the script — two writers");
});

test("A FAILED PASS RETRIES AT ONCE, and the first retry does not sleep", () => {
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  assert.match(y, /for attempt in 1 2 3/, "there is no retry at all");
  assert.match(y, /back=\$\(\(\s*\(attempt - 1\) \* 20\s*\)\)/,
    "the backoff is not zero on the first retry — that is the word 'immediately'");
});

test("a pass that cannot be recovered does not cost the rest of the hour", () => {
  /* A blip at 14:05 must not also lose 14:15, 14:25 and 14:35. The loop
     records the failure and carries on; the JOB still ends red. */
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  const loop = y.slice(y.indexOf("while : ;"), y.indexOf("echo \"passes:"));
  assert.doesNotMatch(loop, /\bexit 1\b/,
    "the loop exits on a failed pass, abandoning the rest of the hour");
  assert.match(y, /\[ \$failed -eq 0 \]/,
    "the step does not end red when a pass failed — the failure would be invisible");
});

test("the loop stops BEFORE the next fire, so runs cannot queue and be cancelled", () => {
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  const m = y.match(/event\.schedule == '[^']+' && '(\d+)'/);
  assert.ok(m, "the scheduled loop length is not stated");
  assert.ok(Number(m[1]) < 60,
    `the loop runs ${m[1]} minutes against an hourly cron — the next run would queue behind it`);
});

test("a hand-fired run does NOT loop, because it holds the concurrency lock", () => {
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  assert.match(y, /event\.schedule == '[^']+' && '\d+' \|\| '0'/,
    "a manually fired run would loop too, locking out the next one for the whole hour");
  /* And the loop is tied to ONE named cron, not to "any schedule" — which is
     what stops the overnight and weekend fires looping as well. */
  const named = y.match(/event\.schedule == '([^']+)'/)[1];
  assert.match(named, /12-21/, `the loop is tied to "${named}", which is not the trading-window cron`);
});

test("AND IT ALERTS: a failure opens an issue, and reuses the same one", () => {
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  assert.match(y, /issues: write/, "the job cannot open an issue");
  assert.match(y, /if: failure\(\)/, "the alert step is not gated on failure");
  assert.match(y, /gh issue create/, "nothing opens an issue");
  assert.match(y, /gh issue list[\s\S]{0,200}--state all/,
    "it does not look for an existing issue — an afternoon of failures would file one per hour");
});

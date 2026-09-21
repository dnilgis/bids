/* THE RETRY AROUND ONE PASS: WHEN IT RETRIES, WHEN IT STOPS, AND WHETHER IT FITS.
 *
 * 2026-09-20. Every red `read boyceville` run in the two days to that evening
 * had the same shape, read off the run pages:
 *
 *   read job    15m18s - 19m21s   "rebase failed" x3, "pass 1 failed three times"
 *   backup job  12m14s - 12m17s   "The job has exceeded the maximum execution time of 12m0s"
 *
 * Two faults, and both were in the loop, not the pass. It re-read 1,094 boards
 * to retry a PUSH that a rebase conflict had refused, which cannot help. And it
 * asked for three eight-minute attempts inside ceilings of twenty and twelve
 * minutes, which cannot fit -- so the job was killed, and a killed job skips its
 * remaining steps, which in the backup job were the email and the issue.
 *
 * Everything below runs the real script against a stand-in one-pass.sh whose
 * exit codes are scripted, because what matters is what the loop DOES with each
 * code, and a regex over the file cannot tell you that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const HELPER = join(ROOT, "scripts/pass-with-retries.sh");

/* A sandbox with the real helper and a fake pass. `codes` is what each attempt
   exits with, in order; `sleeps` how long each takes. Returns what happened. */
function run(codes, { available = 60, timeout = 2, slack = 1, sleeps = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pwr-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(HELPER, join(dir, "scripts/pass-with-retries.sh"));
    writeFileSync(join(dir, "codes"), codes.join("\n") + "\n");
    writeFileSync(join(dir, "sleeps"), sleeps.join("\n") + "\n");
    writeFileSync(join(dir, "scripts/one-pass.sh"),
      `n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"\n` +
      `s=$(sed -n "\${n}p" "${dir}/sleeps"); [ -n "$s" ] && sleep "$s"\n` +
      `c=$(sed -n "\${n}p" "${dir}/codes"); exit "\${c:-0}"\n`);
    const t0 = Date.now();
    const r = spawnSync("bash", ["scripts/pass-with-retries.sh", "t", String(available)], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, PASS_TIMEOUT: String(timeout), PASS_SLACK: String(slack) },
    });
    let attempts = 0;
    try { attempts = Number(readFileSync(join(dir, "n"), "utf8").trim()); } catch { /* none */ }
    return { code: r.status, attempts, out: (r.stdout || "") + (r.stderr || ""), ms: Date.now() - t0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a pass that publishes is not run again", () => {
  const r = run([0]);
  assert.equal(r.code, 0);
  assert.equal(r.attempts, 1);
});

test("a failed READ is retried at once, and a good second attempt is the answer", () => {
  const r = run([1, 0]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.attempts, 2);
  assert.ok(r.ms < 3000, `the first retry slept: ${r.ms}ms`);
});

test("a pass killed by its own timeout counts as a failed read and is retried", () => {
  /* timeout exits 124. The fake sleeps past a one-second pass limit. */
  const r = run([0, 0], { timeout: 1, slack: 1, sleeps: [3, 0], available: 30 });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.attempts, 2);
  assert.match(r.out, /attempt 1 timed out/);
});

test("A REFUSED PUSH IS NOT RETRIED — reading every board again cannot fix it", () => {
  const r = run([3, 0, 0]);
  assert.equal(r.code, 3, r.out);
  assert.equal(r.attempts, 1, "the boards were read again after the push was refused");
  assert.match(r.out, /::error title=t published nothing::/);
});

test("a pass that published but could not tell the sites is not retried either", () => {
  const r = run([4, 0]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.attempts, 1);
});

test("three failed reads end as a failed read, not a hang", () => {
  const r = run([1, 1, 1], { available: 300 });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.attempts, 3);
});

test("AN ATTEMPT THAT CANNOT FINISH INSIDE THE BUDGET IS NOT STARTED", () => {
  /* The fault behind every 33-minute run: the third attempt could never fit,
     so the job ceiling killed it and took the alert steps with it. Here the
     pass is allowed 2s + 1s slack and the caller has 4s: one attempt fits,
     the second does not, and the loop must stop rather than start it. */
  const r = run([1, 1, 1], { available: 4, timeout: 2, slack: 1, sleeps: [2.5] });
  assert.equal(r.attempts, 1, r.out);
  assert.equal(r.code, 1);
  assert.match(r.out, /attempt 2 not started/);
  assert.ok(r.ms < 4000, `the helper overran its own budget: ${r.ms}ms`);
});

test("a caller with no room at all is told so, loudly, and nothing is read", () => {
  const r = run([0], { available: 1, timeout: 2, slack: 1 });
  assert.equal(r.attempts, 0);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error title=t not started::/);
});

/* ── the callers ────────────────────────────────────────────────────────── */

const WF = (f) => readFileSync(join(ROOT, ".github/workflows", f), "utf8");

/* Every run: block that calls the helper, with the budget it hands over and the
   ceiling of the job it sits in. The parse is deliberately plain -- jobs at two
   spaces, their timeout at four -- because that is how every workflow in this
   repository is written, and a layout it cannot read makes the test fail, not
   pass. */
function callers() {
  const out = [];
  for (const f of readdirSync(join(ROOT, ".github/workflows")).filter((x) => /\.ya?ml$/.test(x))) {
    const y = WF(f);
    const jobsAt = y.search(/^jobs:\s*$/m);
    if (jobsAt < 0) continue;
    const body = y.slice(jobsAt);
    const heads = [...body.matchAll(/^  ([\w-]+):\s*$/gm)];
    heads.forEach((h, i) => {
      const block = body.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined);
      const ceiling = Number((block.match(/^    timeout-minutes:\s*(\d+)/m) || [])[1]);
      /* The budget runs to the `))` that ends the line: the read job's is
         `$(( STEP_END - $(date +%s) ))`, which has a `)` of its own inside. */
      for (const m of block.matchAll(/bash scripts\/pass-with-retries\.sh\s+"[^"]*"\s+\$\(\(\s*(.*?)\s*\)\)(?:\s*&&.*)?\s*$/gm))
        out.push({ file: f, job: h[1], ceiling, expr: m[1] });
    });
  }
  return out;
}

test("the reader, its backup and the watchdog all go through the one retry", () => {
  const seen = callers().map((c) => `${c.file}:${c.job}`).sort();
  assert.deepEqual(seen, ["poll.yml:backup", "poll.yml:read", "watchdog.yml:watch"],
    `callers of pass-with-retries.sh: ${JSON.stringify(seen)}`);
  /* And nobody has grown a private copy of the loop back. */
  for (const f of readdirSync(join(ROOT, ".github/workflows"))) {
    assert.doesNotMatch(WF(f), /timeout\s+\S+\s+bash scripts\/one-pass\.sh/,
      `${f} runs one-pass.sh under its own timeout — a second copy of the retry`);
  }
});

test("EVERY CALLER'S BUDGET FITS INSIDE ITS JOB, with room for the steps after it", () => {
  const helper = readFileSync(HELPER, "utf8");
  const passS = Number(helper.match(/PASS_TIMEOUT="\$\{PASS_TIMEOUT:-(\d+)\}"/)[1]);
  const slackS = Number(helper.match(/SLACK="\$\{PASS_SLACK:-(\d+)\}"/)[1]);
  for (const c of callers()) {
    assert.ok(c.ceiling > 0, `${c.file}:${c.job} has no timeout-minutes`);
    /* "17 * 60" or "STEP_END - $(date +%s)"; the second is the read job, whose
       STEP_END is set from the same file. */
    let budget;
    const plain = c.expr.match(/^(\d+)\s*\*\s*60$/);
    if (plain) budget = Number(plain[1]) * 60;
    else {
      const m = WF(c.file).match(/STEP_END=\$\(\( \$\(date \+%s\) \+ (\d+) \* 60 \)\)/);
      assert.ok(m, `${c.file}:${c.job} hands over "${c.expr}" and no STEP_END was found to size it`);
      budget = Number(m[1]) * 60;
    }
    /* A minute for checkout and setup-node, at least a minute for whatever
       runs after the pass. The job ceiling kills the whole job, alert steps
       included -- that is the fault this test exists for. */
    assert.ok(budget + 120 <= c.ceiling * 60,
      `${c.file}:${c.job} hands the pass ${budget}s inside a ${c.ceiling}-minute job; ` +
      `the ceiling would kill the steps after it`);
    assert.ok(budget >= passS + slackS,
      `${c.file}:${c.job} hands the pass ${budget}s, less than one ${passS}s attempt`);
  }
});

test("the backup reads again only when reading was what failed", () => {
  const y = WF("poll.yml");
  const backup = y.slice(y.indexOf("\n  backup:"));
  const rec = backup.slice(backup.indexOf("- name: One recovery pass"));
  assert.match(rec.split("run:")[0], /if: needs\.read\.outputs\.why == 'read'/,
    "the backup's recovery pass is not gated on why the read job failed");
  assert.match(y, /outputs:\s*\n\s*why: \$\{\{ steps\.pass\.outputs\.why \}\}/,
    "the read job no longer says why it failed");
  /* A refused push must still reach a person, even though no recovery ran and
     so nothing in the backup job itself failed. */
  for (const step of ["- name: Email, immediately", "- name: Say so, out loud"]) {
    const s = backup.slice(backup.indexOf(step)).split("run:")[0];
    assert.match(s, /needs\.read\.outputs\.why == 'publish'/,
      `"${step}" does not fire on a refused push`);
  }
});

test("one-pass.sh says which stage failed", () => {
  const sh = readFileSync(join(ROOT, "scripts/one-pass.sh"), "utf8");
  assert.match(sh, /^bash "\$\(dirname "\$0"\)\/commit-and-push\.sh" \.commit-message \|\| exit 3$/m,
    "a refused push no longer exits 3, so it would be retried as a failed read");
  assert.doesNotMatch(sh.slice(sh.indexOf("commit-and-push.sh\" .commit-message")), /\bexit 1\b/,
    "something after the push still exits 1, which the retry reads as a failed read");
  assert.match(sh, /curl -sS --max-time \d+/,
    "the dispatch to the sites has no deadline, so a hung API spends the pass");
  assert.match(sh, /\\"reason\\":\\"\$REASON\\"/,
    "the dispatch no longer says why, so the sites log every pass as a price move");
});

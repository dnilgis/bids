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
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
test("the trading-window cron asks a FEW times an hour, and each fire is short", () => {
  /* REVERSED 2026-08-27, and this is the assertion that was most wrong.
     It required exactly one fire an hour so the job could loop for fifty
     minutes inside it. Counted over every commit in the repository -- a commit
     happens on every pass, so this is an exact record of whether the reader
     ran -- that change cost two thirds of the coverage it was meant to buy:

         BEFORE the 50-minute loop   94 of 116 weekday hours   81.0%
         AFTER  the 50-minute loop    8 of  26 weekday hours   30.8%

     and on 2026-08-27 the repository went six hours with eighteen fires due
     and none arriving, with nothing queued, nothing cancelled and nothing red,
     while push-triggered workflows in the same repository ran normally.
     A job holding a runner for fifty of every sixty minutes is a persistent
     server as far as the scheduler is concerned.

     So: several short fires, not one long one. Two is too few to survive a
     drop, six was measured getting one or two through, and three at twenty
     minutes leaves no in-window wait longer than the old loop's own gap. */
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  const crons = [...y.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
  const window_ = crons.find((c) => /12-21/.test(c));
  assert.ok(window_, "the trading-window cron is gone");
  const mins = window_.split(" ")[0].split(",").map(Number);
  assert.ok(mins.length >= 6,
    `the window cron asks ${mins.length} times an hour; Sig asked for a read every ten minutes`);
  const gaps = mins.slice(1).map((m, i) => m - mins[i]);
  assert.ok(Math.max(...gaps) <= 10,
    `fires are ${Math.max(...gaps)} minutes apart; the ask is every ten`);
  /* AND THE ASK IS NOT THE CADENCE. Measured 2026-08-18 to 08-26 with GitHub's
     own incidents excluded, this exact cron delivered 66 of 380 fires — 17.4%,
     a mean of 1.7 reads an hour. The workflow must say so where the next
     person reads it, or they will believe the schedule. */
  assert.match(y, /17\.4%|66 delivered/,
    "the cron does not record what GitHub actually delivers, so it reads as a promise");
});

test("one pass of the reader is ONE THING, so it can be called in a loop", () => {
  const sh = readFileSync(new URL("../scripts/one-pass.sh", import.meta.url), "utf8");
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  /* Commit and push are DELEGATED to scripts/commit-and-push.sh — the pass is
     still whole, it just no longer carries its own copy of the rebase-and-retry
     that registries.yml and sync_known.yml were missing when they lost 581
     businesses to a rejected push. Passing .commit-message keeps the price
     message's exact bytes. */
  for (const [what, re] of [["read", /node scripts\/poll\.mjs/],
                            ["commit and push", /commit-and-push\.sh" \.commit-message/],
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

test("NOTHING the scheduler starts may hold a runner for more than one pass", () => {
  /* The two tests this replaces policed how LONG the scheduled loop ran and
     WHICH cron it was tied to. Both are moot: no schedule loops at all now.
     What has to be guarded instead is the property that matters -- a run
     GitHub starts must be a single short pass -- and it is guarded twice, in
     the loop length and in the job's own ceiling, because either one alone
     could be relaxed by accident. */
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  assert.match(y, /LOOP_MINUTES: \$\{\{ inputs\.loop_minutes \|\| '0' \}\}/,
    "a scheduled run can still be given a loop length; it must default to a single pass");
  assert.doesNotMatch(y, /event\.schedule == '[^']+' && '\d+'/,
    "a cron is still wired to a loop length — that is the change that cost 50 points of coverage");
  const ceiling = Number((y.match(/^    timeout-minutes: (\d+)/m) || [])[1]);
  assert.ok(ceiling > 0 && ceiling <= 20,
    `the reader's ceiling is ${ceiling} minutes; a single 2-minute pass needs nothing like an hour`);
});

test("the loop machinery survives, so the cadence can be raised without more fires", () => {
  /* Keeping it is deliberate. If the scheduler ever starts dropping short
     fires again, reading repeatedly inside one fire is still the only lever
     that does not ask GitHub for more of them -- it just cannot be the
     DEFAULT, which is what this repository learned the hard way. */
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  assert.match(y, /while : ;/, "the loop was deleted rather than defaulted off");
  assert.match(y, /loop_minutes/, "a hand-fired run can no longer ask for a loop");
});

test("THE TEN-MINUTE CADENCE HAS A SCHEDULER THAT CAN KEEP IT", () => {
  /* Sig, 2026-08-27: "i want this runnng at least every ten minutes during
     trading hours, then every hour off hours."

     poll.yml asks for exactly that. What GitHub delivered the last time it
     asked, 2026-08-18 to 08-26 with GitHub's own incidents excluded, was 66 of
     380 fires — 17.4%, a mean of 1.7 reads an hour. So the ask alone is a wish,
     and something outside GitHub cron has to do the asking.

     This test exists so that nobody deletes worker-scheduler/ believing the
     cron in poll.yml is what delivers the cadence. */
  const wt = readFileSync(new URL("../worker-scheduler/wrangler.toml", import.meta.url), "utf8");
  const crons = [...wt.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const win = crons.find((c) => /12-21/.test(c));
  assert.ok(win, "the external scheduler has no trading-window cron");
  assert.match(win, /^\*\/10 |^(\d+,){5,}/, `the external trading cron is "${win}", not every ten minutes`);
  assert.ok(crons.some((c) => /0-11,22-23/.test(c)), "no off-hours cron on the external scheduler");
  /* Accepts either spelling. 6,0 was the original and is what GitHub wants;
     Cloudflare rejected it outright (its weekday field is 1-7, no 0), so the
     toml now says SAT,SUN. A test pinned to one spelling would have gone red
     for the fix rather than for the fault. */
  assert.ok(crons.some((c) => /\* \*\s+(?:6,0|6,7|SAT,SUN)$/i.test(c)),
    "no weekend cron on the external scheduler");

  const js = readFileSync(new URL("../worker-scheduler/src/index.js", import.meta.url), "utf8");
  /* The path is built from constants, so assert the constant AND the shape —
     matching only the assembled string would fail on a correct refactor, and
     matching only the template would pass while pointing at another
     workflow. */
  /* CORRECTED 2026-08-29, and the old assertion is kept above the new one
     because the reason it broke is the point.

     This required `const WORKFLOW = "poll.yml"` — right for as long as the
     Worker drove exactly one workflow. On 2026-08-28 `discover-sweep.yml` was
     put on the same scheduler, because GitHub cron was delivering one fire in
     six and that workflow is the one that turns a grey pin green. The single
     constant became a ROUTES map keyed on the cron string Cloudflare hands
     back, and this test has been red ever since.

     The code was right every day it was red. Rule 16: read the failure before
     touching the code. What the test should have been asserting all along is
     not "there is one workflow and it is poll.yml" but "every workflow this
     thing can fire is one we meant it to fire" — which is what it asserts now,
     and which would have survived the refactor that broke it. */
  /* CORRECTED AGAIN 2026-09-05, and again the code was right while this was
     red. A cron now routes to a LIST of workflows, because Cloudflare's free
     plan allows five Cron Triggers PER ACCOUNT -- not three per Worker, as
     worker/wrangler.toml had assumed -- so a slot is scarce and a fire may
     usefully ask for more than one thing. The old regex wanted `"cron":
     "x.yml"` and found nothing, which read as "the scheduler routes no
     workflow at all" about a scheduler routing six. */
  const routed = [...js.matchAll(/"([a-z0-9-]+\.yml)"/g)].map((m) => m[1])
    .filter((w) => !/^\s*\*/.test(w));
  assert.ok(routed.length, "the scheduler routes no workflow at all");
  assert.ok(routed.includes("poll.yml"), "the scheduler no longer fires the reader");
  for (const w of new Set(routed))
    assert.ok(existsSync(new URL(`../.github/workflows/${w}`, import.meta.url)),
      `the scheduler routes a cron to ${w}, which is not in .github/workflows`);
  assert.match(js, /const DEFAULT_WORKFLOW = "poll\.yml"/,
    "an unrecognised cron must fall back to the reader, not throw");
  assert.match(js, /const REPO = "bids"/, "the scheduler targets some other repository");
  assert.match(js, /actions\/workflows\/\$\{workflow\}\/dispatches|actions\/workflows\/\$\{WORKFLOW\}\/dispatches/i,
    "the scheduler does not hit the workflow-dispatch endpoint");
  assert.doesNotMatch(js, /ghp_|github_pat_/, "a token is hard-coded in the Worker");
  assert.match(js, /env\.GH_PAT/, "the token does not come from the Worker's secrets");
  /* It must dispatch WITHOUT inputs, so a dispatched run is a single short
     pass. Passing loop_minutes here would rebuild the fifty-minute job that
     cost 50 points of coverage, from the outside. */
  /* Strip comments before this one: the file EXPLAINS in prose why it sends no
     inputs, and a test that reads prose as code is a test that fails on good
     documentation. */
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /loop_minutes|inputs:/,
    "the external scheduler passes workflow inputs; a dispatched run must be one short pass");
  assert.match(code, /JSON\.stringify\(\{ ref: REF \}\)/,
    "the dispatch body is not just the ref");

  /* ── FIVE CRON TRIGGERS, FOR THE WHOLE ACCOUNT ──────────────────────────
   *
   * https://developers.cloudflare.com/workers/platform/limits — "Number of
   * Cron Triggers per account": Free 5, Paid 250. PER ACCOUNT. worker/ called
   * three "the free-plan ceiling, not a style choice", which is the wrong
   * shape of limit, and on 2026-09-05 this repository was defining SEVEN
   * across two Workers: bigriver-worker 3 and agsist-bid-scheduler 4.
   *
   * Every wrangler.toml in the repository counts, because they all deploy to
   * the same account. A sixth added anywhere is a deploy that fails or a cron
   * that silently never fires, and either way something stops running. */
  const tomls = ["worker-scheduler/wrangler.toml", "worker/wrangler.toml"]
    .map((f) => new URL(`../${f}`, import.meta.url))
    .filter((u) => existsSync(u));
  let account = 0;
  const per = [];
  for (const u of tomls) {
    const t = readFileSync(u, "utf8");
    const block = t.slice(t.indexOf("[triggers]"));
    const n = [...block.matchAll(/^\s*"([^"]+)",/gm)].length;
    account += n;
    per.push(`${u.pathname.split("/").slice(-2).join("/")}=${n}`);
  }
  assert.ok(account <= 5,
    `${account} cron triggers across this repository's Workers (${per.join(", ")}) ` +
    "and the free plan allows 5 PER ACCOUNT");

  /* ── AND THE TOML AND THE ROUTE TABLE MUST AGREE ────────────────────────
   *
   * routeFor() falls back to poll.yml on an unrecognised cron, deliberately —
   * a typo then costs one wasted poll instead of dropping every fire in that
   * slot. But that same fallback means a cron added to the toml and NOT to
   * ROUTES fires the reader silently, forever, while somebody waits for the
   * workflow they thought they had scheduled. Nothing was checking it. */
  /* ── EVERY WORKFLOW THE WORKER FIRES MUST QUEUE A DUPLICATE ────────────
   *
   * The Worker is NOT a fallback that fires when GitHub Actions fails. It
   * cannot be: it holds no state, checks nothing, and makes one POST. It is a
   * second scheduler running in parallel, and BOTH are armed on purpose —
   * GitHub cron is the fallback now, not the Worker, so if Cloudflare stops
   * the system degrades to GitHub's 17.4% rather than to nothing.
   *
   * Which means every workflow on this Worker is fired twice on any slot the
   * two schedulers share, and the only thing that makes that safe is a
   * top-level `concurrency` group with `cancel-in-progress: false`: the
   * duplicate queues behind the running one instead of two runs writing the
   * same files at once.
   *
   * src/index.js has ASSERTED this in prose since August — "Both workflows
   * hold a concurrency group with cancel-in-progress: false". It was true of
   * the two workflows it was written about. registries.yml and sync_known.yml
   * were added on 2026-09-05 and nothing checked whether it was still true;
   * they do share `group: map-data`, and that was luck, not a guarantee.
   * Comments are not coverage. */
  for (const w of new Set(routed)) {
    const y = readFileSync(new URL(`../.github/workflows/${w}`, import.meta.url), "utf8");
    const block = /^concurrency:\n((?:[ \t]+.*\n?)+)/m.exec(y);
    assert.ok(block,
      `${w} is fired by the Worker and has no top-level concurrency group — ` +
      "two schedulers are armed, so it can run twice over its own output");
    assert.match(block[1], /cancel-in-progress:\s*false/,
      `${w} cancels in progress, so the Worker's fire would kill a run that ` +
      "is mid-write rather than queueing behind it");
  }

  const wtb = wt.slice(wt.indexOf("[triggers]"));
  const tomlCrons = [...wtb.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
  const routeKeys = [...js.matchAll(/^\s*"([^"]+)":\s*\[/gm)].map((m) => m[1]);
  assert.deepEqual([...tomlCrons].sort(), [...routeKeys].sort(),
    "wrangler.toml and ROUTES disagree about which crons exist — a cron in " +
    "the toml with no route silently fires poll.yml instead");
});

test("AND IT EMAILS: every path that gives up sends mail before it files an issue", () => {
  /* Sig, 2026-08-27, after six silent hours: "if that doesnt run i want an
     email sent to me immediately to address the issue."

     An issue is the record. The mail is the alert. Both failure paths — the
     backup job in poll.yml and the watchdog's own covering read — must send
     it, both must send it BEFORE filing the issue so the mail is out at the
     earliest moment, and both must go through the one implementation, or the
     day it matters one of them will turn out to have drifted. */
  const dir = new URL("../.github/workflows/", import.meta.url);
  for (const f of ["poll.yml", "watchdog.yml"]) {
    const y = readFileSync(new URL(f, dir), "utf8");
    assert.match(y, /node scripts\/alert-email\.mjs/,
      `${f} never sends mail; a failure there would reach nobody`);
    const mail = y.indexOf("node scripts/alert-email.mjs");
    const issue = y.indexOf("gh issue create");
    assert.ok(mail > 0 && issue > 0 && mail < issue,
      `${f} files the issue before sending the mail; the alert must go first`);
    for (const k of ["SMTP_USER", "SMTP_PASS", "ALERT_TO"])
      assert.match(y, new RegExp(k + ":\\s*\\$\\{\\{ secrets\\." + k),
        `${f} does not pass ${k} — the mail step would silently no-op`);
    assert.doesNotMatch(y, /SMTP_PASS:\s*["'][^$]/, `${f} has a literal password in it`);
  }
});

test("the alerter fails OPEN, so a mail problem never hides a feed problem", () => {
  /* If a missing secret or a sulking mail server made this exit non-zero, the
     job would go red for the wrong reason and — worse — the issue-filing step
     after it would never run. The alarm must never be able to silence the
     record. */
  const js = readFileSync(new URL("../scripts/alert-email.mjs", import.meta.url), "utf8");
  assert.match(js, /process\.exit\(0\)/, "the alerter can exit non-zero on a mail failure");
  assert.doesNotMatch(js, /process\.exit\([1-9]/, "the alerter exits non-zero somewhere");
  assert.match(js, /::warning title=no alert email sent/,
    "a missing credential is silent — it must annotate the run");
  assert.match(js, /replace\(\/\^\\\.\/gm, "\.\."\)/,
    "the body is not dot-stuffed; a line starting with '.' would truncate the message");
  assert.doesNotMatch(js, /smtp\.gmail\.com['"]\s*\)?[,;]?\s*\n?\s*const (USER|PASS) = ['"][^'"]/,
    "credentials must come from the environment, never the file");
});

test("AND IT ALERTS: a failure opens an issue, and reuses the same one", () => {
  const y = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8");
  assert.match(y, /issues: write/, "the job cannot open an issue");
  assert.match(y, /if: failure\(\)/, "the alert step is not gated on failure");
  assert.match(y, /gh issue create/, "nothing opens an issue");
  assert.match(y, /gh issue list[\s\S]{0,200}--state all/,
    "it does not look for an existing issue — an afternoon of failures would file one per hour");
});

/* EVERY PUSH GOES THROUGH ONE PLACE, BECAUSE THE SIX LINES DID NOT SPREAD.
 *
 * one-pass.sh has carried a rebase-and-retry since the reader started looping.
 * registries.yml and sync_known.yml never got it, and on 2026-08-28 the
 * registries run read all 251 Iowa dealers, all 102 warehouses, geocoded 481
 * addresses over 171 seconds, committed 581 businesses — and then:
 *
 *     ! [rejected]  main -> main (fetch first)
 *
 * The bid poller pushes to main every ten minutes through the trading day, and
 * that job runs for seven. Everything it learned died on the runner, under a
 * summary that said the run had succeeded.
 *
 * A bare `git push` in anything that commits is now a test failure.
 */
test("nothing pushes without the rebase-and-retry", () => {
  const offenders = [];
  for (const f of FILES) {
    const body = readFileSync(join(DIR, f), "utf8");
    if (!/git\s+push/.test(body)) continue;
    if (!/commit-and-push\.sh/.test(body)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `these push directly and will lose their work to the poller: ${offenders.join(", ")}`);
});

test("the shared push script retries, rebases, and fails loudly", () => {
  const sh = readFileSync(new URL("../scripts/commit-and-push.sh", import.meta.url), "utf8");
  assert.match(sh, /pull --rebase --autostash/, "a rejected push must rebase, not force");
  assert.ok(!/push\s+(--force|-f)\b/.test(sh), "never force-push over somebody else's commit");
  assert.match(sh, /::error/, "exhausting the retries must be loud, not a silent zero");
  assert.match(sh, /rebase --abort/, "a failed rebase must not leave the runner mid-rebase");
});

test("the reader still commits through it, message file intact", () => {
  const pass = readFileSync(new URL("../scripts/one-pass.sh", import.meta.url), "utf8");
  assert.match(pass, /commit-and-push\.sh" \.commit-message/,
    "the price message is multi-line and must go through as a FILE, not an argument");
  assert.ok(!/^git push/m.test(pass), "one-pass.sh still has a bare push");
});

/* THE SWEEP THAT HAS TO WALK ITSELF.
 *
 * 674 operator websites at up to 45 seconds each is about eight hours of wall
 * clock. No single run does that, so the only way it finishes is if each run
 * starts where the last one stopped WITHOUT a person carrying --start forward.
 * That is what the ledger is for, and these guard the three ways it could
 * quietly stop working:
 *
 *   - the run stops resuming, and asks the same first 45 hosts forever;
 *   - the list stops being rebuilt, and keeps asking hosts we now read;
 *   - a page that could not be loaded gets written off as "runs nothing we
 *     know", which loses a working elevator to a network blip.
 */
test("the discover sweep resumes, rebuilds its list, and keeps a ledger", () => {
  const y = readFileSync(new URL("../.github/workflows/discover-sweep.yml", import.meta.url), "utf8");
  assert.match(y, /--resume/, "without this every run asks the same first hosts forever");
  assert.match(y, /--ledger data\/platforms\.json/, "nothing is remembered between runs");
  assert.match(y, /node scripts\/barchart_sites\.mjs > probe-lists\/barchart-sites\.txt/,
    "the list must be rebuilt, or it keeps asking hosts we have started reading");
  assert.match(y, /--budget/, "a run with no budget dies at the job timeout with nothing written");
  assert.match(y, /commit-and-push\.sh/, "a bare push loses the sweep to the poller");
  assert.match(y, /git add data\/platforms\.json/, "the ledger is not committed");
});

test("an unreachable page is a retry, not a verdict about the operator", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  /* The filter got STRICTER since this was written — a no-platform now counts
     as decided only if a board page was actually tried — so it is checked by
     intent rather than by matching its exact text: whatever else it does, an
     unreachable page must never land in the decided set. */
  const filt = d.slice(d.indexOf("const done = new Set("), d.indexOf(".map(([k]) => k))"));
  assert.ok(!/unreachable/.test(filt),
    "the resume filter mentions unreachable — it must never be treated as decided");
  assert.match(filt, /v\.status === "platform"/, "a decided platform is not being skipped");
  assert.ok(!/status !== "unreachable"[\s\S]{0,80}done\.add/.test(d),
    "an unreachable host is being written off as answered");
  assert.match(d, /remember\(pageUrl, \{ probeVersion: PROBE_VERSION, status: "unreachable"/,
    "an unreachable page is not recorded at all, so it cannot be retried deliberately");
});

test("a flag's value is never mistaken for a URL", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  /* `discover.mjs <url> --patience 60` refused itself with "2 of 3 entries are
     not a page", because only --dump's value was excluded from the URL check —
     and --patience is documented in that same file. */
  assert.match(d, /VALUE_FLAGS/, "the exclusion list is back to one flag name");
  for (const f of ["--patience", "--start", "--limit", "--budget", "--list", "--ledger"])
    assert.ok(d.includes(`"${f}"`), `${f} takes a value and is not in VALUE_FLAGS`);
});

/* THE HOME PAGE IS NOT THE BOARD.
 *
 * The first live sweep asked 45 operators and 28 "loaded but recognised
 * nothing" — including adm.com, whose front page was never going to call a
 * cash-bids API. Barchart's directory gives the operator's WEBSITE and nothing
 * deeper, so probing that URL alone asks the wrong page of most of the list.
 *
 * The fix is to use the site's own navigation rather than guess at /cash-bids
 * and a dozen spellings: a guessed path 404s silently, a link the operator
 * wrote is the page they mean. Two things that must not rot:
 *
 *   - captureAll's default keeps bodies that LOOK LIKE A BOARD and drops HTML
 *     documents. Right for finding a feed, and it means the operator's own
 *     "Cash Bids" link is invisible. The sweep has to ask for the page itself.
 *   - a "Cash Bids" link pointing at another domain is a finding about somebody
 *     else's board, not this operator's.
 */
test("the sweep keeps the page's own HTML, or it can never see the link", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  /* The override got BROADER since this was written — any same-site HTML, not
     the one exact URL — because an exact match lost the body to a redirect. The
     intent is unchanged: captureAll drops HTML by default and the link scan
     needs it. */
  assert.match(d, /keep: \(u, mime\) => looksLikeData\(u, mime\)/,
    "captureAll drops HTML by default; without this override the link scan reads nothing");
  assert.match(d, /\/html\/i\.test\(mime \|\| ""\) && sameSite\(u, pageUrl\)/,
    "the override no longer keeps the document at all");
  assert.match(d, /import \{ captureAll, looksLikeData \}/);
});

test("a board link on another domain is not followed", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  assert.match(d, /u\.hostname\.replace\(\/\^www\\\.\/, ""\) !== home\.hostname/,
    "a third party's Cash Bids link would be recorded as this operator's board");
  assert.match(d, /FALLBACK_PATHS/, "there is no fallback when a site publishes no link");
  assert.match(d, /boardPage: followed \|\| pageUrl/,
    "the ledger must record WHICH page answered, or a source file points at the home page");
});

/* A VERDICT REACHED BY A WEAKER TEST IS NOT A VERDICT.
 *
 * The first live batch asked 45 home pages and wrote off 28 as "no-platform" —
 * before the sweep learned to follow the operator's own Cash Bids link, which
 * is the whole reason most of them looked empty. Resuming past those would skip
 * exactly the pages the fix was written for, and the ledger would carry that
 * mistake for good.
 *
 * The tell is whether a board page was ever tried. Which means the ATTEMPT has
 * to be recorded, not just a successful follow — otherwise a failed follow is
 * indistinguishable from a record written before follows existed, and the 28
 * stay written off.
 */
test("a no-platform decided before the follow existed is asked again", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  assert.match(d, /v\.status === "no-platform" && \(v\.probeVersion \?\? 0\) >= PROBE_VERSION/,
    "the resume filter treats every no-platform as final, whatever probe produced it");
  assert.match(d, /triedBoardPages: triedPages/,
    "only a SUCCESSFUL follow is recorded, so a failed one looks pre-fix forever");
  assert.match(d, /triedPages\.push\(next\)/,
    "the attempt is not recorded before it is made");
});

test("the resume line counts this list, not the whole ledger", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  /* It printed "resume: 11 of 4 already decided" — the ledger's count against
     this list's length, a number true of nothing. */
  assert.match(d, /const doneHere = all\.length - pool\.length/);
  assert.ok(!/resume: \$\{done\.size\} of/.test(d), "still printing the ledger size as a share of the list");
});

/* THE TWO LISTS OF WHAT WE DO NOT HAVE.
 *
 * A green pin says we read a board; a grey pin says we know the elevator is
 * there. Neither says WHY a grey one is grey, and the two reasons need
 * completely different work:
 *
 *   no website on file    a name, a town, usually a phone, and no URL at all.
 *                         Every state registry entry is like this — states
 *                         publish licensees, not websites. A phone-call list.
 *   publishes no board    we have the site, a browser loaded it, followed the
 *                         operator's own Cash Bids link, and nothing came back.
 *                         A finding, not a backlog.
 *
 * Conflating them would put 1,930 businesses that have no website into a queue
 * of "sites we failed to scrape", which is a queue nobody can work.
 */
/* A FILE NAME IS A CLAIM.
 *
 * no-website.csv said "no website" and 288 of its 1,930 rows are ADM, Bunge,
 * Cargill, CHS, MFA and Landus — companies that obviously have websites. The
 * state registry does not publish one; that is a fact about our data.
 *
 * no-board-published.csv said the operator publishes no bids. A hand audit of
 * twelve rows found ONE genuine negative and NINE with a correctly named cash
 * bids page — commodity, basis and cash-price headers, live timestamps, Barchart
 * disclaimers — everything but the numbers, which arrive by JavaScript.
 *
 * Both are worklists about our own coverage. Naming them after somebody else's
 * business was the error, and it is the kind that survives because a file name
 * is never reviewed. */
test("neither list is named as a claim about somebody else's business", () => {
  const g = readFileSync(new URL("../scripts/gap_lists.mjs", import.meta.url), "utf8");
  assert.match(g, /no-website-on-file\.csv/, "the file still claims the company has no website");
  assert.match(g, /board-not-read\.csv/, "the file still claims the operator publishes no bids");
  assert.ok(!/"data\/gaps\/no-website\.csv"|no-board-published\.csv"/.test(g),
    "an old, overclaiming filename is still being written");
  assert.match(g, /UNRESOLVED/, "the unread list must not read as a set of negatives");
});

test("both gap lists are rebuilt and committed wherever their inputs move", () => {
  for (const f of ["registries.yml", "discover-sweep.yml"]) {
    const y = readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.match(y, /node scripts\/gap_lists\.mjs/, `${f} does not rebuild the gap lists`);
    assert.match(y, /git add[^\n]*data\/gaps/, `${f} rebuilds them and does not commit them`);
  }
});

test("an unreachable page is not filed as an elevator that publishes no bids", () => {
  const g = readFileSync(new URL("../scripts/gap_lists.mjs", import.meta.url), "utf8");
  assert.match(g, /if \(v\.status !== "no-platform"\) continue;/,
    "a network failure would be reported to Sig as a finding about the operator");
  assert.match(g, /triedBoardPages/,
    "the list must say which board page was tried, or it cannot be checked by hand");
});

/* SIG AUDITED THE FIRST ROW OF THE LIST AND IT WAS WRONG.
 *
 * acoop2.com — Assumption Coop — publishes a full Barchart board at /cashbids,
 * and I gave it to him as an elevator that posts no bids online. Two bugs, and
 * one of them is the more serious kind:
 *
 *   - the fallback path list had /cash-bids and /cash-bids/ and NOT /cashbids,
 *     the commonest spelling there is;
 *   - the document body was kept only when the response URL matched the URL we
 *     asked for exactly, so one redirect left the page unretained, the link scan
 *     saw no anchors, and the site's own "CASH BIDS" link — right there in the
 *     served HTML — was never followed.
 *
 * A "no board published" row is a claim about somebody's business. Getting it
 * from a bug is worse than having no list, because a wrong list gets worked.
 *
 * The general fix is the version number: a negative is only as good as the test
 * that produced it, so improving the test invalidates the negatives. A POSITIVE
 * stays — finding a board is not made wrong by looking harder.
 */
test("improving the probe re-asks every negative it recorded", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  assert.match(d, /export const PROBE_VERSION = \d+/, "the probe has no version to compare");
  assert.equal((d.match(/probeVersion: PROBE_VERSION/g) || []).length, 3,
    "every verdict — platform, no-platform and unreachable — must be stamped");
  /* A positive must NOT be re-asked: that would re-walk the whole list forever. */
  const filt = d.slice(d.indexOf("const done = new Set("), d.indexOf(".map(([k]) => k))"));
  assert.match(filt, /v\.status === "platform"\s*$/m,
    "an identified platform is being re-asked, so the sweep can never finish");
});

test("the fallback paths include the spelling that was actually missed", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  const list = /const FALLBACK_PATHS = \[([\s\S]*?)\]/.exec(d)[1];
  for (const p of ["/cashbids", "/cash-bids", "/grain-bids", "/bids"])
    assert.ok(list.includes(`"${p}"`), `fallback paths do not include ${p}`);
  assert.ok(list.indexOf('"/cashbids"') < list.indexOf('"/cash-bids/"'),
    "the unhyphenated spelling should be tried first; it is the commonest");
});

test("a redirect does not cost us the page body", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  assert.ok(!/keep: \(u, mime\) => looksLikeData\(u, mime\) \|\| \(u === pageUrl/.test(d),
    "the body is kept only on an exact URL match — one redirect and the links vanish");
  assert.match(d, /sameSite\(u, pageUrl\)/, "same-site HTML is not being kept");
  assert.match(d, /const sameSite = /, "there is no host comparison to keep by");
});

/* THE BROWSER WAS TELLING EVERY SITE IT WAS A BOT.
 *
 * Chromium's default user-agent carries the literal token "HeadlessChrome",
 * which is the commonest thing a bot filter keys on. Assumption Coop publishes
 * a full board at acoop2.com/cashbids and this browser got TWO responses from
 * it — not one third-party host, no analytics, nothing a real page load makes.
 * It was served a stripped page, and the sweep filed the co-operative as an
 * elevator that posts no bids online.
 *
 * lib/cdp.mjs is also what poll.mjs reads every browser source with, so this is
 * not only a sweep fix.
 *
 * The identifier stays on the end. This is a real Chrome engine rendering what
 * a farmer's browser renders, and anyone reading their access log can see who
 * called and how to reach us — the same stance as every other read here.
 */
test("the browser does not announce itself as headless", () => {
  const c = readFileSync(new URL("../lib/cdp.mjs", import.meta.url), "utf8");
  assert.match(c, /--user-agent=\$\{UA\}/, "the default UA is being used, and it says HeadlessChrome");
  /* The declaration is a multi-line concatenation and the FIRST semicolon after
     it sits inside "(X11; Linux x86_64)" — slicing there cut the string in half
     and failed on a UA that was correct. Take every quoted piece instead. */
  const decl = /export const UA =([\s\S]*?);\n/.exec(c);
  assert.ok(decl, "no UA declaration found in lib/cdp.mjs");
  const full = [...decl[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  assert.ok(!/Headless/i.test(full), `the replacement UA still says Headless: ${full}`);
  assert.match(full, /Chrome\/\d/, `it must present as a real Chrome build: ${full}`);
  assert.match(full, /agsist/, "we do not read anyone's board anonymously");
});

test("a better browser identity re-asks every negative taken with the old one", () => {
  const d = readFileSync(new URL("../scripts/discover.mjs", import.meta.url), "utf8");
  const v = Number(/export const PROBE_VERSION = (\d+)/.exec(d)[1]);
  assert.ok(v >= 4, `PROBE_VERSION is ${v} — the user-agent change did not bump it, so ` +
    "every page asked as HeadlessChrome stays written off");
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  THE EMMERT CHAIN: EVERY PRICE CADENCE REACHES THE READER
 * ═══════════════════════════════════════════════════════════════════════════
 *  Sig, 2026-09-05: the two Emmert sites must have "flawless continuous site
 *  freshness" through whatever else changes in this repository.
 *
 *  The chain is: Big River's board -> scripts/one-pass.sh -> data/boyceville.json
 *  here -> repository_dispatch into midwestagsupply/badgergrain and
 *  midwestagsupply/midwestcommodity -> both sites rebuild. Everything upstream
 *  of the dispatch is poll.yml, and poll.yml now gets its real cadence from
 *  worker-scheduler rather than from GitHub cron.
 *
 *  THE FAILURE THIS EXISTS TO STOP. The test above asserts the scheduler fires
 *  poll.yml *somewhere*. That is not enough. There are three price cadences --
 *  trading day, overnight, weekend -- and if a future edit hands one of those
 *  slots to a sweep instead, poll.yml silently falls back to GitHub cron for
 *  that window. GitHub delivered 17.4% of asked fires when measured over
 *  2026-08-18 to 08-26 with its own incidents excluded, and TWO consecutive
 *  dropped weekend runs have already been measured at 15.95 hours of staleness
 *  -- against the 14 hours at which the Emmert sites withdraw the price and
 *  show "Call for today's price". So losing the weekend slot specifically
 *  darkens two customer sites on a Sunday, with nothing red anywhere.
 *
 *  Each of the three is therefore named and checked on its own.
 */
test("EMMERT: all three price cadences route to the reader, not just one", () => {
  const src = readFileSync(new URL("../worker-scheduler/src/index.js", import.meta.url), "utf8");
  /* Comments are not coverage. This file explains the cadences in prose and a
     regex over the prose would pass on a scheduler that routes none of them. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const block = code.match(/const ROUTES\s*=\s*(\{[\s\S]*?\n\});/);
  assert.ok(block, "ROUTES is not a literal object any more — this guard cannot read it");
  const routes = JSON.parse(block[1].replace(/,(\s*\})/g, "$1"));

  /* The three price windows, by what each one protects. */
  const PRICE_CADENCES = [
    ["*/10 12-21 * * MON-FRI",    "the trading day"],
    ["20 0-11,22-23 * * MON-FRI", "overnight, where a pre-dawn move is picked up"],
    ["20 */3 * * SAT,SUN",        "the weekend, where 14h withdrawal is closest"],
  ];
  for (const [cron, what] of PRICE_CADENCES) {
    assert.ok(routes[cron],
      `no cron covers ${what} — poll.yml falls back to GitHub cron in that window`);
    assert.ok(routes[cron].includes("poll.yml"),
      `${what} is routed to ${routes[cron].join(", ")} and not to poll.yml — ` +
      `the Emmert sites lose their reader for that whole window`);
  }

  /* The toml has to declare the same three, or the Worker is never woken for
     them however good its route table is. */
  const toml = readFileSync(new URL("../worker-scheduler/wrangler.toml", import.meta.url), "utf8");
  const tomlCode = toml.replace(/^\s*#.*$/gm, "");
  for (const [cron, what] of PRICE_CADENCES)
    assert.ok(tomlCode.includes(`"${cron}"`),
      `wrangler.toml does not declare the cron for ${what}, so it never fires`);
});

test("EMMERT: the weekend cadence stays at three hours, never four", () => {
  /* Four-hourly puts the natural weekend commit interval at exactly 8.00h,
     which is the dashboard's own gap threshold, AND two dropped runs reach
     15.95h against the 14h the Emmert sites withdraw at. Three-hourly is the
     margin. Checked in both places that can set it. */
  const toml = readFileSync(new URL("../worker-scheduler/wrangler.toml", import.meta.url), "utf8")
    .replace(/^\s*#.*$/gm, "");
  const poll = readFileSync(new URL("../.github/workflows/poll.yml", import.meta.url), "utf8")
    .replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(toml, /"\d+ \*\/[4-9] \* \* (?:6,0|6,7|SAT,SUN)"/i,
    "the scheduler's weekend cadence is 4-hourly or slower — two dropped runs " +
    "reach 15.95h and the Emmert sites withdraw at 14h");
  assert.doesNotMatch(poll, /cron:\s*"\d+ \*\/[4-9] \* \* 6,0"/,
    "poll.yml's own weekend fallback is 4-hourly or slower — same 14h exposure " +
    "when the scheduler is the thing that is down");
});


/* ═══════════════════════════════════════════════════════════════════════════
 *  CLOUDFLARE AND GITHUB NUMBER THE WEEK DIFFERENTLY
 * ═══════════════════════════════════════════════════════════════════════════
 *  2026-09-05. The first Git-triggered build uploaded the Worker successfully
 *  and then failed setting its triggers:
 *
 *      invalid cron string: 20 *\/3 * * 6,0 [code: 10100]   (slash escaped:
 *      the literal sequence would end this comment)
 *      Trigger configuration was only partially updated.
 *
 *  GitHub Actions numbers the weekday field 0-6 with 0 = Sunday. Cloudflare's
 *  runs 1-7 and has no 0 at all. This repository drives BOTH schedulers from
 *  crons that look identical, so a string that is correct in poll.yml is
 *  rejected outright by Cloudflare — and, worse than rejected, a string like
 *  `1-5` is accepted by both and is not guaranteed to mean the same five days.
 *
 *  Cloudflare's own documentation recommends the three-letter abbreviations to
 *  avoid this. MON-FRI and SAT,SUN mean one thing everywhere.
 *
 *  So: no numeric weekday may appear in wrangler.toml. poll.yml keeps its
 *  numbers, because they are right for GitHub — this checks the Cloudflare
 *  side only, deliberately.
 *
 *  What made this expensive is that the code deployed and the triggers did
 *  not. `/health` reported the new route table while the Worker was still
 *  firing on the old schedule, so the one page built to answer "what is
 *  running?" answered it wrongly. A guard, not a look at the dashboard, is
 *  what has to catch this.
 */
test("CLOUDFLARE: no numeric day-of-week in wrangler.toml — 0 is invalid there", () => {
  const toml = readFileSync(new URL("../worker-scheduler/wrangler.toml", import.meta.url), "utf8")
    .replace(/^\s*#.*$/gm, "");
  const crons = [...toml.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    .filter((c) => c.trim().split(/\s+/).length === 5);
  assert.ok(crons.length, "no cron expressions found in wrangler.toml");
  for (const c of crons) {
    const dow = c.trim().split(/\s+/)[4];
    if (dow === "*") continue;
    assert.ok(!/\d/.test(dow),
      `wrangler.toml cron "${c}" uses a numeric day-of-week ("${dow}"). ` +
      "Cloudflare's weekday field is 1-7 with no 0, GitHub's is 0-6 with 0 = Sunday, " +
      "and this repo drives both. Use MON-FRI / SAT,SUN.");
  }
});

test("CLOUDFLARE: the ROUTES keys are the exact strings wrangler.toml declares", () => {
  /* event.cron is handed back verbatim, so a route keyed on a string the toml
     does not declare is a cron that silently falls through to the default
     workflow. Spelling the days out is only safe if BOTH files were changed. */
  const toml = readFileSync(new URL("../worker-scheduler/wrangler.toml", import.meta.url), "utf8")
    .replace(/^\s*#.*$/gm, "");
  const declared = [...toml.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    .filter((c) => c.trim().split(/\s+/).length === 5);
  const src = readFileSync(new URL("../worker-scheduler/src/index.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const block = src.match(/const ROUTES\s*=\s*(\{[\s\S]*?\n\});/);
  assert.ok(block, "ROUTES is not a literal object any more");
  const routed = Object.keys(JSON.parse(block[1].replace(/,(\s*\})/g, "$1")));
  for (const c of declared)
    assert.ok(routed.includes(c),
      `wrangler.toml fires "${c}" and ROUTES has no key for it — that fire ` +
      "falls through to the default workflow instead of what it was meant to do");
  for (const c of routed)
    assert.ok(declared.includes(c),
      `ROUTES has a key "${c}" that wrangler.toml never fires — dead route`);
});

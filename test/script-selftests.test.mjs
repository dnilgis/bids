/* A SELFTEST NOBODY RUNS IS A DRAFT, AND ONE OF THEM WAS.
 *
 * test/every-guard-runs.test.mjs says it plainly for test/: "Every test file in
 * test/ must be reachable by something that runs on its own." It counts files
 * in test/ and nowhere else.
 *
 * scripts/barchart_gap.mjs carries eight checks behind `--selftest`, including
 * the bucket-boundary cases in its own nearest-neighbour index — the part most
 * likely to be wrong and least likely to be noticed, because a wrong answer
 * there reads as coverage rather than as an error. Measured 2026-09-14: nothing
 * in this repository ran them. Not npm test, not a workflow, not a hook. They
 * had never executed outside the session that wrote them.
 *
 * So this file runs every one it finds, and test/every-guard-runs.test.mjs now
 * asserts that this file is the thing that finds them. Adding `--selftest` to a
 * script is enough; there is nothing else to remember.
 *
 *     node --test test/script-selftests.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every script that offers `--selftest`, found rather than listed. */
export function scriptsWithSelftest(root = ROOT) {
  const dir = join(root, "scripts");
  return readdirSync(dir)
    .filter((f) => /\.mjs$/.test(f))
    .filter((f) => /process\.argv\.includes\(\s*["']--selftest["']\s*\)/
      .test(readFileSync(join(dir, f), "utf8")))
    .sort();
}

test("every --selftest in scripts/ is found, and there is at least one", () => {
  const found = scriptsWithSelftest();
  assert.ok(found.length >= 1, "no script exposes --selftest — has the convention changed?");
  assert.ok(found.includes("barchart_gap.mjs"), found.join(", "));
});

for (const script of scriptsWithSelftest()) {
  test(`scripts/${script} --selftest passes`, () => {
    let out = "";
    try {
      out = execFileSync(process.execPath, [join(ROOT, "scripts", script), "--selftest"],
                         { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      assert.fail(`scripts/${script} --selftest exited ${e.status}:\n`
        + `${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    /* A selftest that reports nothing is a selftest that checked nothing. The
       exit code alone would pass for a script whose checks were all deleted. */
    const m = /(\d+)\s+passed,\s+(\d+)\s+failed/.exec(out);
    assert.ok(m, `${script} --selftest printed no "N passed, M failed" line:\n${out}`);
    assert.equal(Number(m[2]), 0, out);
    assert.ok(Number(m[1]) > 0, `${script} --selftest ran zero checks:\n${out}`);
  });
}

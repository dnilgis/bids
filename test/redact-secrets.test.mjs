/* scripts/redact_secrets.py (a copy of agsist's): capture.yml's save step runs
 * it on the captures before pushing them to the elevsites branch, because
 * GitHub push protection refuses a push carrying the co-op sites' own keys. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("the redactor passes its selftest and the save step runs it before the push", () => {
  const r = spawnSync("python3", ["scripts/redact_secrets.py", "selftest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /redact selftest ok/);
  const y = readFileSync(".github/workflows/capture.yml", "utf8");
  assert.ok(y.indexOf("redact_secrets.py") > 0 && y.indexOf("redact_secrets.py") < y.indexOf('git -C "$W" add -A'));
});

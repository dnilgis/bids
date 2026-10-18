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

/* ids1, 2026-10-18. The StoneHedge widget key in a saved capture reads
 * "key=<redacted>": capture-pages' redactBody (scripts/discover.mjs, lib/cdp.mjs)
 * takes it out first, by this repo's written rule (scripts/stonehedge-probe.mjs,
 * THE KEY: public in the operator's page, never in this repository or log),
 * and redact_secrets.py would too. Nothing downstream needs it: the poller
 * loads the operator's page (browserPage) and reads the widget it embeds. What
 * a manifest does need is the location ids, and those must survive both. */
test("both redactors take the StoneHedge key and keep the location ids a manifest needs", async () => {
  const { redactBody } = await import("../scripts/discover.mjs");
  const page = '<iframe src="https://stonehedge.stonex.com/component/bids?key=ABCDEFGHIJ0123456789XYZ9&amp;cols=name&amp;locs=8TG9IQ1J6TGRFBUP1XH0%2CC3KE3V6FRIM9U1E9N3V5">'
    + ' https://api.stonehedge.stonex.com/settings/v2/delivery-periods?locationIds=8TG9IQ1J6TGRFBUP1XH0,MY33N2HTBP5KB5I5NXBT'
    + ' {"locationId":"ALP74TQG6DRPXDLCUCHS"}';
  const a = redactBody(page);
  const py = spawnSync("python3", ["-c", "import sys;sys.path.insert(0,'scripts');import redact_secrets as r;print(r.redact(sys.stdin.read())[0])"],
    { input: page, encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  for (const out of [a, py.stdout]) {
    assert.ok(!out.includes("ABCDEFGHIJ0123456789XYZ9"), "the key is gone");
    for (const id of ["8TG9IQ1J6TGRFBUP1XH0", "C3KE3V6FRIM9U1E9N3V5", "MY33N2HTBP5KB5I5NXBT", "ALP74TQG6DRPXDLCUCHS"])
      assert.ok(out.includes(id), `${id} survives`);
  }
});

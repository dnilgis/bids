/* THE SWEEP THAT WAS ASKING NOTHING.
 *
 * discover-sweep.yml runs every three hours because Sig said "I want every
 * elevator in the country". Its list came from barchart_sites.mjs, which reads
 * `e.url` off data/known-elevators.json — a file that stopped carrying a url
 * field. So the list was empty, --resume printed "nothing left to ask — the
 * sweep is complete", and the run went green and idle.
 *
 * Two things are tested here: the list the ledger owes, and the refusal that
 * makes an empty directory look like the input regression it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { unfinished, owedAnAsk } from "../scripts/unfinished_sites.mjs";
import { PROBE_VERSION } from "../scripts/discover.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* --- the rule, which three files must agree on ---------------------------- */

test("the rule is discover's own: platform decided, everything else comes round", () => {
  assert.equal(owedAnAsk({ status: "platform", platform: "dtn-cs" }, 5), null);
  assert.equal(owedAnAsk({ status: "no-platform", probeVersion: 5 }, 5), null);
  assert.ok(owedAnAsk({ status: "no-platform", probeVersion: 4 }, 5),
    "a negative reached by an older, weaker probe is not a verdict");
  assert.ok(owedAnAsk({ status: "no-platform" }, 5), "no version at all is older than any version");
  assert.ok(owedAnAsk({ status: "unreachable", why: "timed out" }, 5),
    "we could not reach it is a fact about the network, not about the operator");
  assert.ok(owedAnAsk(undefined, 5), "a site with no record has certainly not been decided");
});

test("finding a board is not made wrong by looking harder", () => {
  /* A site already identified stays identified whatever the probe version. */
  for (const v of [1, 4, 5, 99])
    assert.equal(owedAnAsk({ status: "platform", platform: "bushel", probeVersion: 1 }, v), null);
});

test("the reason travels with the url, because a bare list cannot be audited", () => {
  const rows = unfinished({ sites: {
    "https://a.com/": { status: "unreachable", why: "Page.navigate did not answer in 45000ms" },
    "https://b.com/": { status: "no-platform", probeVersion: 4 },
    "https://c.com/": { status: "platform", platform: "dtn-cs" },
  } }, 5);
  assert.deepEqual(rows.map((r) => r.url), ["https://a.com/", "https://b.com/"]);
  assert.match(rows[0].why, /unreachable/);
  assert.match(rows[1].why, /probe v4.*v5/);
});

/* --- against the real ledger --------------------------------------------- */

test("the real ledger owes an ask, and the sweep's list is not empty", () => {
  /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. On 2026-09-07 this was 437 of
     893 — 169 unreachable since 2026-08-30 and 268 written off by a probe
     older than this one — while the list the sweep actually walked held zero.
     Not pinned to 437: it falls as the sweep works and rises as discovery
     finds more, and both are the system working. */
  const ledger = JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8"));
  const rows = unfinished(ledger, PROBE_VERSION);
  const total = Object.keys(ledger.sites ?? {}).length;
  assert.ok(total > 0, "the ledger holds no sites at all");
  assert.ok(rows.length > 0,
    `every one of ${total} sites is decided — if that is real, say so deliberately rather than ` +
    `letting a cron report completeness`);
  for (const r of rows) assert.match(r.url, /^https?:\/\//, `${r.url} is not a URL`);
});

/* --- the refusal --------------------------------------------------------- */

test("a directory with no websites in it refuses instead of printing an empty list", () => {
  /* data/known-elevators.json holds 1804 records and its own counts.with_url
     reads 0. Before this, that produced an empty list, exit 0, and a sweep that
     reported itself complete every three hours. */
  const known = JSON.parse(readFileSync(join(ROOT, "data/known-elevators.json"), "utf8"));
  const withUrl = (known.elevators || []).filter((e) => e && e.url).length;
  if (withUrl) {
    /* The directory has been fixed upstream. Then the script must NOT refuse. */
    execFileSync("node", ["scripts/barchart_sites.mjs"], { cwd: ROOT, stdio: "pipe" });
    return;
  }
  let code = 0, err = "";
  try {
    execFileSync("node", ["scripts/barchart_sites.mjs"], { cwd: ROOT, stdio: "pipe" });
  } catch (e) { code = e.status; err = String(e.stderr); }
  assert.equal(code, 3, "an empty list from an urlless directory must not exit 0");
  assert.match(err, /::error/, "the run has to carry the annotation, not just a stderr line");
  assert.match(err, /no websites|url field/i);
});

test("--allow-empty is there for the day the sweep really is finished", () => {
  const out = execFileSync("node", ["scripts/barchart_sites.mjs", "--allow-empty"],
    { cwd: ROOT, stdio: "pipe" });
  assert.equal(typeof out.toString(), "string", "it must exit 0 when a person says the empty list is the answer");
});

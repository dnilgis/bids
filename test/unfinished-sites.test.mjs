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

/* --- the order ------------------------------------------------------------ */

test("THE LIST IS OLDEST FIRST, because alphabetical asked the same twenty twice", () => {
  /* 2026-09-07. The discover run at 20:35 asked 45 sites and the run at 20:47
     asked 20, and the first twenty of each were IDENTICAL, in order:
     21stcoop, agheadquarters, altonterminal, aspinwallcoop, babgrain,
     badgergrainsupply, bessie-cordellcoop, bids.themaschhoffs, bpsonsgrain,
     brownmilling, and ten more. Fifty minutes of runner, 65 page loads, zero
     sites decided.

     A failed ask still stamps seenAt, so those twenty carried a stamp from
     minutes earlier — and an alphabetical sort does not care how fresh a
     record is. Sorting by seenAt is what makes "it comes round again" true. */
  const ledger = {
    sites: {
      "https://aaa-asked-just-now.com/":   { status: "unreachable", seenAt: "2026-09-07T20:36:34.823Z" },
      "https://zzz-asked-ten-days-ago.com/": { status: "unreachable", seenAt: "2026-08-28T23:17:12.161Z" },
    },
  };
  const rows = unfinished(ledger, PROBE_VERSION);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, "https://zzz-asked-ten-days-ago.com/",
    "the ten-day-old site is asked before the one asked minutes ago");
});

test("a site never asked at all outranks one asked once", () => {
  const rows = unfinished({
    sites: {
      "https://asked-once.com/": { status: "unreachable", seenAt: "2026-08-01T00:00:00.000Z" },
      "https://never-asked.com/": { status: "unreachable" },
    },
  }, PROBE_VERSION);
  assert.equal(rows[0].url, "https://never-asked.com/",
    "no stamp at all sorts first — never-asked beats asked-and-failed");
});

test("the order is deterministic when two records carry the same stamp", () => {
  const same = "2026-09-01T00:00:00.000Z";
  const rows = unfinished({
    sites: {
      "https://b.com/": { status: "unreachable", seenAt: same },
      "https://a.com/": { status: "unreachable", seenAt: same },
    },
  }, PROBE_VERSION);
  assert.deepEqual(rows.map((r) => r.url), ["https://a.com/", "https://b.com/"],
    "the url is the tiebreak, so two runs of the same ledger ask the same order");
});

test("EVERY ROW CARRIES ITS STAMP, or the sort has nothing to sort on", () => {
  const rows = unfinished(JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8")),
    PROBE_VERSION);
  assert.ok(rows.length > 0, "the shipped ledger owes some asks");
  assert.ok(Object.hasOwn(rows[0], "seenAt"), "the row exposes seenAt");
});

test("and against the SHIPPED ledger the head is genuinely the oldest", () => {
  /* Not a synthetic two-record case: the real 893-site ledger. On the day this
     was written 233 of the 350 owed had not been asked since 2026-08-28 while
     45 had been asked that day, and the alphabetical head was the 45. */
  const rows = unfinished(JSON.parse(readFileSync(join(ROOT, "data/platforms.json"), "utf8")),
    PROBE_VERSION);
  const stamps = rows.map((r) => String(r.seenAt ?? ""));
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i - 1] <= stamps[i],
      `row ${i} (${rows[i].seenAt}) is older than row ${i - 1} (${rows[i - 1].seenAt})`);
  }
  const alphabetical = [...rows].sort((a, b) => a.url.localeCompare(b.url));
  assert.notEqual(rows[0].url, alphabetical[0].url,
    "if these agree the fix is doing nothing on the real ledger");
});

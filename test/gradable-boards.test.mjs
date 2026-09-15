/* THE REPORT THAT UNBLOCKS 152 MANIFESTS, AND THE THREE WAYS IT COULD LIE.
 *
 * scripts/gradable_boards.mjs reads a partner's boards and writes one file that
 * later becomes `bands` and `cashRounding` on real source manifests. Three
 * things would each be worse than having no report at all:
 *
 *   1. RECORDING A NETWORK POLICY AS A FACT ABOUT AN OPERATOR. The first run of
 *      this script got 403 three times from the sandbox's egress gateway and
 *      was about to refuse with "the board endpoint needs the browser" — a
 *      sentence about ADM, drawn from a connection that never reached ADM.
 *   2. WRITING A ROUNDING MODE NOBODY COUNTED. That is the bug
 *      lib/rounding.mjs exists to kill, and the bug scripts/gradable-markets.mjs
 *      had until 2026-09-15.
 *   3. PUTTING A PRICE IN A FILE THE MERGE DOES NOT GUARD.
 *
 * Every test below is one of those three or a refusal that prevents one.
 *
 *     node --test test/gradable-boards.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PARTNERS, fixturePathFor, reportPathFor, boardsToRead, readingFor,
  refusalFor, reportFrom, summarise, probeFetch, fetchBoard, isEnvironmentBlock,
} from "../scripts/gradable_boards.mjs";
import { marketsFrom } from "../lib/adapters/gradable.mjs";

const BOARD = readFileSync(new URL("../fixtures/gradable-poet-bigstonecity.json", import.meta.url), "utf8");
const ADM = readFileSync(new URL("../fixtures/gradable-adm-bootstrap.json", import.meta.url), "utf8");
const POET = readFileSync(new URL("../fixtures/gradable-poet-bootstrap.json", import.meta.url), "utf8");

const MARKET = {
  marketId: 331845223, displayName: "Big Stone City, SD", city: "Big Stone City",
  state: "SD", company: "POET Grain", declaredRounding: "always_down",
};

/* A fetch that answers with whatever it is handed, in order. `null` throws. */
const stub = (bodies, { status = 200, headers = {} } = {}) => {
  let i = 0;
  return async () => {
    const b = bodies[i++];
    if (b === null) throw new Error("connection refused by the stub");
    if (status !== 200)
      return { ok: false, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => b };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => b };
  };
};

/* ---- 1. whose refusal is it ---------------------------------------------- */

test("A GATEWAY'S 403 IS NOT THE OPERATOR'S ANSWER", async () => {
  /* The exact body the sandbox returned on 2026-09-15, verbatim. */
  const gateway = "Host not in allowlist: adm.gradable.com. Add this host to your network " +
                  "egress settings to allow access.";
  const f = stub([gateway, gateway, gateway], { status: 403, headers: { "content-type": "text/plain" } });
  const p = await probeFetch([{ marketId: 1 }, { marketId: 2 }, { marketId: 3 }], "adm", f, 3);
  assert.equal(p.usable, false, "a blocked request must never look like a working transport");
  assert.equal(p.unreachable, true,
    "three requests that never reached ADM were counted as ADM refusing them");
  assert.equal(p.reached, 0);
});

test("and a 403 FROM THEM is their answer, which is a different thing entirely", async () => {
  /* A real site refusing a robot returns 403 too. Treating every 403 as an
     environment problem is the same mistake pointed the other way, and it would
     make the script walk 136 boards that are all going to refuse it. */
  const theirs = "<html><head><title>Access denied</title></head><body>…</body></html>";
  const f = stub([theirs, theirs, theirs], { status: 403, headers: { "content-type": "text/html" } });
  const p = await probeFetch([{ marketId: 1 }, { marketId: 2 }, { marketId: 3 }], "adm", f, 3);
  assert.equal(p.usable, false);
  assert.equal(p.unreachable, false, "their own refusal was written off as a local network policy");
  assert.equal(p.reached, 3);
});

test("the gateway test keys on the body's shape, never on the status code", () => {
  const plain = (t) => ({ headers: { get: () => "text/plain" } });
  assert.equal(isEnvironmentBlock(plain(), "Host not in allowlist: adm.gradable.com."), true);
  assert.equal(isEnvironmentBlock(plain(), "denied by policy"), true);
  /* An origin's own page, however it is phrased, is an answer. */
  assert.equal(isEnvironmentBlock({ headers: { get: () => "text/html" } },
    "blocked by the gateway"), false, "content-type html is an origin, not a gateway");
  assert.equal(isEnvironmentBlock({ headers: { get: () => "application/json" } },
    '{"error":"not in allowlist"}'), false, "a JSON error is theirs");
  /* THE LENGTH CHECK NEEDS A BODY THAT WOULD OTHERWISE MATCH. The first
     version of this line was 700 x's, which contains no blocker phrase and so
     returned false whether the length check existed or not — it proved nothing
     and a mutation deleting the check survived it. This is a verbose origin
     error page, served text/plain, that happens to use the words. */
  const wordy = ("We could not complete your request. " +
    "Our upstream provider reported that the destination was not in allowlist for this account. " +
    "This is an application-level error from our own service and not a network gateway. " +
    "Please retry, and if the problem persists contact support quoting reference 8814-22. ").repeat(3);
  assert.ok(wordy.length > 600, `the fixture is only ${wordy.length} bytes`);
  assert.equal(isEnvironmentBlock(plain(), wordy), false,
    "a long page that merely uses the words was taken for a gateway line");
  assert.equal(isEnvironmentBlock(plain(), "x".repeat(700)), false,
    "no blocker phrase at all is never a gateway line");
  assert.equal(isEnvironmentBlock(plain(), "Forbidden"), false,
    "a bare Forbidden names no blocker and must not be assumed to be local");
});

test("a request that never got an HTTP response is unreachable, not a refusal", async () => {
  const p = await probeFetch([{ marketId: 1 }, { marketId: 2 }], "adm", stub([null, null]), 2);
  assert.equal(p.unreachable, true);
  assert.equal(p.tried.every((t) => t.reached === false), true);
});

test("ONE GOOD BOARD OUT OF THREE IS NOT A TRANSPORT", async () => {
  /* A transport that fails two thirds of the time reads downstream as those
     elevators posting nothing today, which is the failure this whole repository
     is arranged to prevent. */
  const p = await probeFetch([{ marketId: 1 }, { marketId: 2 }, { marketId: 3 }], "poet",
    stub([BOARD, null, null]), 3);
  assert.equal(p.ok, 1);
  assert.equal(p.usable, false);
  assert.equal(p.unreachable, false, "one board did answer, so this is not unreachable");
});

test("a 200 that is not a board is not a good board", async () => {
  const p = await probeFetch([{ marketId: 1 }], "poet", stub(["<html>maintenance</html>"]), 1);
  assert.equal(p.usable, false, "an HTML error page served with a 200 passed as a board");
});

test("fetchBoard marks a thrown connection as not reached", async () => {
  await assert.rejects(() => fetchBoard("https://x/y", stub([null])), (e) => e.reached === false);
});

/* ---- 2. the measurement --------------------------------------------------- */

test("THE COMMITTED POET BOARD READS TO ITS MEASURED MODE", () => {
  /* Big Stone City's five rows carry +0.75c and +0.25c and nothing else, which
     is floor and only floor — and its bootstrap independently declares
     always_down. Both numbers are in the report; neither is derived from the
     other. */
  const r = readingFor(MARKET, BOARD, "https://poet.gradable.com/x");
  assert.equal(r.rows, 5);
  assert.equal(r.rounding.confident, "floor-cent");
  assert.equal(r.declaredInBootstrap, "always_down");
  assert.deepEqual(r.rounding.residuals, [0.25, 0.75]);
  assert.equal(r.rounding.testable, 5);
});

test("the crop comes out as a band key a manifest can actually declare", () => {
  const r = readingFor(MARKET, BOARD, "u");
  assert.deepEqual(r.crops.map((c) => c.commodity), ["Corn"]);
  assert.equal(r.crops[0].band, "corn", "the bands key would not match lib/board.mjs");
  assert.deepEqual(r.crops[0].range, [2, 12],
    "the band is not the one 35 committed POET manifests already carry");
  assert.doesNotMatch(r.crops[0].band, /default/,
    "bandFor's provenance string reached the report as a manifest key");
  assert.equal(r.crops[0].rows, 5);
});

test("NO PRICE REACHES THE REPORT", () => {
  /* data/gradable/ is not read by the merge and has none of the guards a
     capture gets. A price here is an unguarded price. */
  const s = JSON.stringify(readingFor(MARKET, BOARD, "u"));
  for (const k of ["cash", "basis", "futuresPrice", "cash_bid", "basis_bid", "futures_bid"])
    assert.doesNotMatch(s, new RegExp(`"${k}"`), `${k} is in the report`);
  /* And the thing it DOES carry is the count, which is what a manifest needs. */
  assert.match(s, /"residuals"/);
});

test("a board that states its own mode is recorded saying so", () => {
  const r = readingFor(MARKET, BOARD, "u");
  assert.equal(r.declaredOnBoard, "always_down",
    "the per-row declaration was dropped — it is the cheapest answer to ADM's missing mode");
});

test("the declared mode and the counted mode are separate fields", () => {
  /* Collapsing them is how a declaration becomes a measurement. A market whose
     bootstrap says nothing must still be able to come out with a counted mode,
     and one that disagrees must be visible. */
  const r = readingFor({ ...MARKET, declaredRounding: null }, BOARD, "u");
  assert.equal(r.declaredInBootstrap, null);
  assert.equal(r.rounding.confident, "floor-cent",
    "the counted mode was taken from the bootstrap instead of from the rows");
});

/* ---- 3. what is asked, and what is refused -------------------------------- */

test("ADM'S 136 ARE THE MARKETS THIS WALKS", () => {
  /* The number the whole job is sized on. If the filter changes, the workflow's
     timeout and the 45-second browser arithmetic in its header both change. */
  const all = marketsFrom(ADM);
  assert.equal(all.length, 152);
  assert.equal(boardsToRead(all).length, 136);
  const poet = marketsFrom(POET);
  assert.equal(boardsToRead(poet).length, 35, "POET's demo market is being asked for a board");
  assert.equal(boardsToRead(poet).some((m) => m.demo), false);
});

test("the walk is in market-id order, so two runs diff as measurements", () => {
  const ids = boardsToRead(marketsFrom(ADM)).map((m) => Number(m.marketId));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test("ZERO READ OUT OF MANY IS AN OUTAGE AND IS NEVER WRITTEN", () => {
  const why = refusalFor({ partner: "adm", read: 0, attempted: 136 });
  assert.match(why ?? "", /outage/);
  /* Because a report saying no market posts a crop is a finding, and it would
     be read as one. */
  assert.match(why ?? "", /measurement/);
});

test("a shrinking report needs a person", () => {
  assert.ok(refusalFor({ partner: "adm", read: 120, attempted: 136, existingCount: 136 }));
  assert.equal(refusalFor({ partner: "adm", read: 120, attempted: 136, existingCount: 136, allowShrink: true }), null);
  assert.equal(refusalFor({ partner: "adm", read: 140, attempted: 140, existingCount: 136 }), null);
});

test("the partner is a menu because it reaches two filenames", () => {
  assert.ok(refusalFor({ partner: "../../etc/passwd", read: 1, attempted: 1 }));
  for (const p of PARTNERS) {
    assert.match(p, /^[a-z]+$/);
    assert.equal(fixturePathFor(p), `fixtures/gradable-${p}-bootstrap.json`);
  }
});

test("THE REPORT NEVER LANDS WHERE merge_bids WOULD READ IT", () => {
  /* scripts/merge_bids.mjs does readdirSync("data").filter(f => f.endsWith(".json"))
     and treats each hit as a poller capture. A report at data/adm-boards.json
     would be parsed as a board file inside the step that builds the public
     feed. A subdirectory is invisible to that scan. */
  const src = readFileSync(new URL("../scripts/merge_bids.mjs", import.meta.url), "utf8");
  assert.match(src, /readdirSync\(join\(ROOT, "data"\)\)\.filter\(\(x\) => x\.endsWith\("\.json"\)\)/,
    "merge_bids no longer scans data/*.json the way this test assumes — re-check the report path");
  for (const p of PARTNERS) {
    const rel = reportPathFor(p);
    assert.match(rel, /^data\/[^/]+\/[^/]+\.json$/, `${rel} would be scanned by the merge`);
    assert.equal(rel.split("/").length, 3);
  }
});

/* ---- the report and the summary ------------------------------------------ */

test("the report sorts by market id and counts what it actually read", () => {
  const rs = [3, 1, 2].map((id) => readingFor({ ...MARKET, marketId: id }, BOARD, "u"));
  const rep = reportFrom({
    partner: "adm", transport: "fetch", fixture: "f",
    marketsInFixture: 152, attempted: 136, readings: rs,
    failures: [{ marketId: 9, displayName: "x", why: "y" }],
  });
  assert.deepEqual(rep.markets.map((m) => m.marketId), [1, 2, 3]);
  assert.equal(rep.marketsRead, 3);
  assert.equal(rep.marketsAttempted, 136);
  assert.equal(rep.failures.length, 1);
});

test("the summary names a crop with no band rather than passing it over", () => {
  /* A crop lib/board.mjs has no band for is withheld from the feed. Silently
     absent from the summary, it looks like a market that posts less than it
     does, and nobody goes looking. */
  const r = readingFor(MARKET, BOARD, "u");
  r.crops.push({ commodity: "Distillers Grain", rows: 2, deliveries: 1, band: null, range: null });
  const text = summarise(reportFrom({
    partner: "adm", transport: "fetch", fixture: "f",
    marketsInFixture: 152, attempted: 1, readings: [r], failures: [],
  }));
  assert.match(text, /NO BAND/);
  assert.match(text, /Distillers Grain/);
  assert.match(text, /withheld/);
});

test("and says so plainly when every crop is banded", () => {
  const text = summarise(reportFrom({
    partner: "poet", transport: "fetch", fixture: "f",
    marketsInFixture: 36, attempted: 1,
    readings: [readingFor(MARKET, BOARD, "u")], failures: [],
  }));
  assert.match(text, /every crop posted has a band/);
  assert.match(text, /floor-cent/);
});

/* ---- the wiring ----------------------------------------------------------- */

test("THE WORKFLOW REHEARSES BEFORE IT ASKS ANYBODY'S SITE", () => {
  const y = readFileSync(new URL("../.github/workflows/gradable-boards.yml", import.meta.url), "utf8");
  assert.match(y, /--rehearse fixtures\/gradable-poet-bigstonecity\.json/,
    "the offline rehearsal was dropped, so a broken walk is found by 136 live requests");
  assert.match(y, /node scripts\/gradable_boards\.mjs --selftest/);
  assert.match(y, /permissions:\s*\n\s*contents: write/);
  assert.match(y, /concurrency:\s*\n\s*group: gradable-boards/,
    "two runs could write the same path");
  assert.match(y, /default: false/, "commit is not defaulted off");
});

test("the commit message's count is the script's own, not a second one", () => {
  const y = readFileSync(new URL("../.github/workflows/gradable-boards.yml", import.meta.url), "utf8");
  assert.match(y, /\$BOARDS_READ/, "the commit count no longer comes from the script");
  assert.doesNotMatch(y, /grep -c/, "a second counter appeared in the workflow");
  const src = readFileSync(new URL("../scripts/gradable_boards.mjs", import.meta.url), "utf8");
  assert.match(src, /BOARDS_READ=\$\{report\.marketsRead\}/,
    "the script stopped handing the count to the shell");
});

test("A REHEARSAL CAN NEVER BE COMMITTED", () => {
  const src = readFileSync(new URL("../scripts/gradable_boards.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(has\("write"\)\) throw new GradableRefused\(/,
    "--rehearse --write no longer refuses, so one board copied 136 times could be committed");
  const y = readFileSync(new URL("../.github/workflows/gradable-boards.yml", import.meta.url), "utf8");
  assert.match(y, /transport === "rehearsal"/,
    "the commit gate no longer checks that a rehearsal did not reach it");
});

test("a limited run can never be committed either", () => {
  const src = readFileSync(new URL("../scripts/gradable_boards.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(limit\) throw new GradableRefused\(/,
    "--limit --write would write a partial report over a whole one");
  assert.match(src, /existingCount: limit \? null : existing/,
    "a partial run is being measured against the committed whole and would 'shrink'");
});

test("THE REPORT PRINTS THE CODE BESIDE THE NAME", () => {
  /* On 2026-09-15 every ADM row came back as a bare code and the report was the
     place that had to make it visible. It grouped on the resolved NAME, so an
     unresolved code showed only as a strange-looking crop. */
  const r = readingFor(MARKET, BOARD, "https://poet.gradable.com/x");
  assert.equal(r.crops[0].code, "CN");
  assert.equal(r.crops[0].commodity, "Corn");
  assert.equal(r.crops[0].unresolved, false);
});

test("AN UNNAMED CODE SETS THE FLAG ITSELF, and is called out loudly", () => {
  /* The first version of this test pushed `unresolved: true` onto the crop list
     by hand. That proved the summary can print a flag and proved nothing about
     readingFor ever setting one — hardcoding it to false left this green. So
     the code below is one their dictionary genuinely does not carry. */
  const proto = JSON.parse(BOARD).instruments[0];
  const body = JSON.stringify({ instruments: [
    { ...proto, ext_commodity_id: "02", market_id: 1 },
    { ...proto, ext_commodity_id: "ZZ9", market_id: 1 },
  ] });
  const r = readingFor({ ...MARKET, marketId: 1 }, body, "https://adm.gradable.com/x");
  const named = r.crops.find((c) => c.code === "02");
  const unnamed = r.crops.find((c) => c.code === "ZZ9");
  assert.equal(named.unresolved, false, "a code their dictionary names was flagged unresolved");
  assert.equal(unnamed.unresolved, true, "a code nobody names was not flagged");
  assert.equal(unnamed.commodity, "ZZ9", "an unknown code was given a name it does not have");
  assert.equal(unnamed.band, null, "an unknown code was given a band");
  const text = summarise(reportFrom({
    partner: "adm", transport: "fetch", fixture: "f",
    marketsInFixture: 152, attempted: 1, readings: [r], failures: [],
  }));
  assert.match(text, /DOES NOT NAME: ZZ/);
  assert.match(text, /codes, not\s+crops/);
});

test("crops are grouped by THEIR CODE, not by the word it resolves to", () => {
  /* Two codes carrying one word would merge into a single line and hide that
     one of them is unbanded. ADM has three canolas under three codes. */
  const proto = JSON.parse(BOARD).instruments[0];
  const body = JSON.stringify({ instruments: [
    { ...proto, ext_commodity_id: "31", market_id: 1 },
    { ...proto, ext_commodity_id: "59", market_id: 1 },
    { ...proto, ext_commodity_id: "PB", market_id: 1 },
  ] });
  const r = readingFor({ ...MARKET, marketId: 1 }, body, "https://adm.gradable.com/x");
  assert.equal(r.crops.length, 3, "three distinct codes collapsed into fewer lines");
  assert.deepEqual(r.crops.map((c) => c.code).sort(), ["31", "59", "PB"]);
  for (const c of r.crops) assert.equal(c.band, "canola");
});

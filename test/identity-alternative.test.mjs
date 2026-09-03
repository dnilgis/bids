/* A board with no futures column, and the one way it is allowed to publish.
 *
 * lib/board.mjs refuses a source where not one row carries a quoted future:
 *
 *     "A structural check whose absence looks identical to its success is not
 *      a check. Count what was verified and refuse if the answer is none."
 *
 * That rule is right and these tests exist to keep it exactly as strong. What
 * changed on 2026-09-03 is that AgriCharts — 211 sites, roughly 945 locations —
 * publishes cash, basis and a futures CHANGE and no futures price, ever. For
 * that platform the absence is not a regression; it is the platform, and it is
 * knowable when the manifest is written.
 *
 * So a source may declare what it publishes on instead. Three things must hold
 * together and each of them is tested here:
 *
 *   the MANIFEST names the alternative     — a decision on record
 *   the ROWS carry that same name          — the adapter asserts it, not the
 *                                            manifest about itself
 *   EVERY row carries it                   — one unchecked row still refuses
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildFile, Refused } from "../lib/board.mjs";
import { adapterFor, ADAPTERS, SHARED_PAGES } from "../lib/adapters/index.mjs";
import { toConfig, PLATFORMS } from "../lib/sources.mjs";
import { VERIFIED_BY, mergeQuotes, quoteUrls } from "../lib/adapters/agricharts.mjs";

const DIR = join(fileURLToPath(new URL("..", import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(DIR, f), "utf8");
const CONTRACTS = mergeQuotes(readdirSync(DIR).filter((f) => /^agricharts-quotes-/.test(f)).map(read));

/* Two rows in the shape every adapter returns, with no quoted future — which
   is the only situation this whole path is about. */
const rows = (stamp) => [
  { seq: 0, location: "Testville", locationId: "99", commodity: "Corn", delivery: "09/01/2026",
    cash: 5.28, basis: -0.15, basisCents: -15, futures: null, futuresPrice: null,
    futuresAt: null, futuresFlag: null, source: "u", raw: "Testville Corn",
    ...(stamp ? { verifiedBy: stamp } : {}) },
  { seq: 1, location: "Testville", locationId: "99", commodity: "Corn", delivery: "10/01/2026",
    cash: 5.31, basis: -0.12, basisCents: -12, futures: null, futuresPrice: null,
    futuresAt: null, futuresFlag: null, source: "u", raw: "Testville Corn",
    ...(stamp ? { verifiedBy: stamp } : {}) },
];

const SRC = {
  id: "test-testville", operator: "Test Co", location: "Testville", state: "WI",
  platform: "agricharts", locationId: "99", cashRoundingCents: 1,
  url: "https://test.mobile.agricharts.com/cash/prices.php",
  bands: { corn: [2.0, 12.0] },
};

/* assert.throws does not hand back the error, and several of these tests are
   about what the refusal SAYS. */
function refusalFrom(fn) {
  try { fn(); } catch (e) { assert.ok(e instanceof Refused, `not a Refused: ${e.stack}`); return e; }
  assert.fail("expected a refusal and got none");
}

const build = (src, rs) => buildFile("<ignored>", {
  now: new Date("2026-09-03T05:00:00Z"), sourceUrl: SRC.url, source: src, extract: () => rs,
});

/* ── the original rule, unchanged ────────────────────────────────────────── */

test("a source that declares nothing still refuses, in the same words", () => {
  assert.throws(() => build(SRC, rows(null)),
    (e) => e instanceof Refused
        && /could not run the\s+cash - basis = futures check on any of them/.test(e.message)
        && /one structural guard off/.test(e.message));
});

/* THE REGRESSION THIS RULE WAS WRITTEN FOR. A board that used to carry a quote
   and stops looks exactly like a board that never had one. It must still
   refuse, and declaring an alternative must not be reachable by accident — a
   source that has never been told to expect one has no way to acquire it. */
test("rows that are stamped but not declared still refuse — and the message says how", () => {
  const e = refusalFrom(() => build(SRC, rows(VERIFIED_BY)));
  assert.match(e.message, /one structural guard off/);
  assert.match(e.message, new RegExp(VERIFIED_BY.replace(/[+]/g, "\\+")),
    "the refusal should name the stamp the rows carry, or nobody can act on it");
  assert.match(e.message, /deliberately/);
});

/* ── and the three things the declaration has to survive ─────────────────── */

const DECLARED = { ...SRC, identityAlternative: VERIFIED_BY };

test("a declaration with nothing to back it refuses", () => {
  const e = refusalFrom(() => build(DECLARED, rows(null)));
  assert.match(e.message, /not one of its 2 row\(s\) carries any verification stamp/);
});

test("a declaration that does not match the stamp refuses", () => {
  const e = refusalFrom(() => build({ ...SRC, identityAlternative: "something-else" },
                                    rows(VERIFIED_BY)));
  assert.match(e.message, /only 0 of 2 row\(s\) carry it/);
  assert.match(e.message, new RegExp(VERIFIED_BY.replace(/[+]/g, "\\+")));
});

/* ONE ROW IS ENOUGH TO REFUSE THE BOARD, and this is the case worth having.
 * A partial stamp is precisely the silent hole the original rule closes: the
 * checked rows look identical to the unchecked ones once they are in the file. */
test("one unstamped row among two refuses the whole board", () => {
  const mixed = rows(VERIFIED_BY);
  delete mixed[1].verifiedBy;
  const e = refusalFrom(() => build(DECLARED, mixed));
  assert.match(e.message, /only 1 of 2 row\(s\) carry it/);
  assert.match(e.message, /must not travel beside rows that were/);
});

test("declared, stamped on every row: it publishes, and says nothing was verified", () => {
  const built = build(DECLARED, rows(VERIFIED_BY));
  assert.equal(built.file.count, 2);
  assert.equal(built.verified, 0, "no row carried a quoted future and the count must say so");
  for (const b of built.file.bids) assert.equal(b.futuresPriceCents, null);
});

/* ── the knob has to reach board.mjs ─────────────────────────────────────── */

/* toConfig is the ONLY path from a manifest to buildFile and it drops what it
 * does not name. Two knobs were live in board.mjs for a day in August and
 * neither reached it for exactly this reason. A declaration that does not
 * travel is a source that refuses for a reason nobody can find. */
test("toConfig carries identityAlternative through to the guard", () => {
  assert.equal(toConfig({ ...DECLARED }).identityAlternative, VERIFIED_BY);
  assert.equal(toConfig({ ...SRC }).identityAlternative, null);
  const built = build(toConfig({ ...DECLARED, bands: SRC.bands }), rows(VERIFIED_BY));
  assert.equal(built.file.count, 2);
});

/* ── the adapter, end to end, on a real capture ──────────────────────────── */

test("a real AgriCharts board publishes through buildFile once it is declared", () => {
  const html = read("agricharts-thefarmerselevator.html");
  const src = {
    id: "thefarmerselevator-farmerselevator", operator: "The Farmers Elevator Grain & Supply Assn.",
    location: "Farmers Elevator", state: "KS", platform: "agricharts",
    locationId: "30119", cashRoundingCents: 1,
    identityAlternative: VERIFIED_BY,
    url: "https://mobile.thefarmerselevator.com/cash/prices.php",
    bands: { corn: [2.0, 12.0], soybeans: [6.0, 32.0], wheat: [3.0, 20.0] },
  };
  const built = buildFile(html, {
    now: new Date("2026-09-03T05:00:00Z"), sourceUrl: src.url, source: toConfig(src),
    extract: adapterFor("agricharts", { contracts: CONTRACTS }),
  });
  assert.equal(built.file.count, 6);
  assert.equal(built.verified, 0);
  assert.ok(built.file.bids.every((b) => b.futuresPriceCents === null));
});

/* AND THE SAME BOARD REFUSES WITH NO QUOTES TO CHECK AGAINST. A failed fetch of
   the shared page withholds a price; it never publishes an unchecked one. */
test("the same board refuses when the quote pages did not come back", () => {
  const html = read("agricharts-thefarmerselevator.html");
  const src = toConfig({
    id: "x", operator: "x", location: "Farmers Elevator", platform: "agricharts",
    locationId: "30119", identityAlternative: VERIFIED_BY,
    bands: { corn: [2.0, 12.0], soybeans: [6.0, 32.0], wheat: [3.0, 20.0] },
  });
  assert.throws(() => buildFile(html, {
    now: new Date("2026-09-03T05:00:00Z"), sourceUrl: "u", source: src,
    extract: adapterFor("agricharts", null),
  }), (e) => /no futures quotes were supplied/.test(e.message));
});

/* ── the wiring ──────────────────────────────────────────────────────────── */

test("agricharts is registered, and the older adapters are untouched by the third argument", () => {
  assert.equal(typeof ADAPTERS.agricharts, "function");
  // adapterFor with no context returns the adapter itself, exactly as before.
  assert.equal(adapterFor("bushel"), ADAPTERS.bushel);
  assert.notEqual(adapterFor("agricharts", { contracts: [] }), ADAPTERS.agricharts);
});

/* A PLATFORM WITH AN ADAPTER AND NO ENTRY IN PLATFORMS IS A SOURCE THAT LOADS
 * AND NEVER RUNS. validateSource drops a manifest naming an unknown platform,
 * so the adapter can be perfect, the manifest can be perfect, and 23 sources
 * simply are not there. This is what caught agricharts missing from that list. */
test("every adapter is a declared platform, and every declared platform has an adapter", () => {
  for (const p of PLATFORMS)
    assert.ok(p in ADAPTERS, `platform "${p}" is declared and has no adapter`);
  for (const p of Object.keys(ADAPTERS))
    assert.ok(PLATFORMS.includes(p),
      `adapter "${p}" exists and is not in PLATFORMS — every manifest naming it is dropped at load`);
});

test("the shared pages are seven absolute URLs on one host", () => {
  const spec = SHARED_PAGES.agricharts;
  assert.ok(spec, "agricharts must declare the page it cannot fetch for itself");
  assert.deepEqual(spec.urls, quoteUrls());
  assert.equal(spec.urls.length, 7);
  assert.equal(new Set(spec.urls.map((u) => new URL(u).host)).size, 1,
    "one host answers for all 211 sites; more than one is a fetch per co-op waiting to happen");
  for (const u of spec.urls) assert.match(u, /^https:\/\/[^/]+\/markets\/futures\.php\?/);
  assert.ok(spec.why && spec.build, "the poller prints why, and calls build");
});

test("build turns the captured bodies into contracts", () => {
  const ctx = SHARED_PAGES.agricharts.build(
    readdirSync(DIR).filter((f) => /^agricharts-quotes-/.test(f)).map(read));
  assert.equal(ctx.contracts.filter((c) => c.priced).length, 87);
});


/* ── and the poller has to actually hand it over ─────────────────────────── */

/* scripts/poll.mjs runs on import — it is a script, not a module — so it
 * cannot be exercised here without doing a whole pass. What CAN be checked is
 * the wiring, and the wiring is the part that silently does nothing when it is
 * wrong: buildFile is handed `adapterFor(s.platform)` with no context and the
 * adapter refuses every AgriCharts source for a reason that points at the
 * quote pages rather than at this line. Two knobs already died that way. */
const POLL = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "scripts", "poll.mjs"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

test("the poller fetches the shared pages and passes them to the adapter", () => {
  assert.match(POLL, /SHARED_PAGES/, "poll.mjs must know which platforms need a shared page");
  assert.match(POLL, /adapterFor\(s\.platform,\s*shared\)/,
    "buildFile must be handed the per-pass context, or the declaration does nothing");
  assert.match(POLL, /await sharedFor\(s\.platform\)/);
  assert.doesNotMatch(POLL, /adapterFor\(s\.platform\)/,
    "a call with no context left behind would refuse every AgriCharts source");
});

test("the shared pages are fetched once per pass, not once per source", () => {
  // 211 sites x 7 pages is 1,477 requests to say the same thing.
  assert.match(POLL, /sharedCtx\.has\(platform\)/,
    "without the cache this is a fetch per source");
  assert.match(POLL, /sharedCtx\.set\(platform,/);
});

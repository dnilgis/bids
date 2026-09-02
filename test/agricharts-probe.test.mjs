/* The AgriCharts probe, on the shapes it will actually meet.
 *
 * The whole value of that script is one sentence it prints at the end, and
 * that sentence decides whether the next day of work is "change a header" or
 * "move the egress". Those are not close together, so the function that picks
 * between them is pure and is tested here without a network.
 *
 * A PROBE'S SUMMARY IS A GUARD LIKE ANY OTHER. status.mjs said "26 broken, 0
 * refused" off a log that read 26/9/127, and it said it convincingly. The
 * fix for that class of thing is not care, it is a test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, urlsFrom, slugOf, looksLikeBoard, verdict, PROFILES, PROFILE_ORDER, CHROME }
  from "../scripts/agricharts-probe.mjs";

/* ── the target list ─────────────────────────────────────────────────────── */

/* probe-lists/agricharts-mobile.txt is mostly prose, and one of its comment
   lines contains a URL. A reader that took "any line containing a scheme"
   would probe the example inside a paragraph. */
const LIST = `# AGRICHARTS MOBILE
#     https://<sub>.mobile.agricharts.com/cash/prices.php
# Both forms work; try both.
https://legacyfarmers.mobile.agricharts.com/cash/prices.php
#    VERIFIED 10 locations -- Legacy Farmers, Ohio
https://mobile.prideag.com/cash/prices.php
#    VERIFIED 27 locations
https://legacyfarmers.mobile.agricharts.com/cash/prices.php
`;

test("reads only the lines that are a URL and nothing else", () => {
  assert.deepEqual(urlsFrom(LIST), [
    "https://legacyfarmers.mobile.agricharts.com/cash/prices.php",
    "https://mobile.prideag.com/cash/prices.php",
  ]);
});

test("a commented-out URL is not a target", () => {
  assert.deepEqual(urlsFrom("#https://example.test/cash/prices.php"), []);
  assert.deepEqual(urlsFrom("  # https://example.test/cash/prices.php"), []);
});

/* ── naming a fixture ────────────────────────────────────────────────────── */

/* THE SAME BOARD IS SERVED UNDER TWO HOSTNAME FORMS. Filing it twice would
   give a later reader two fixtures for one operator and no way to tell which
   the adapter was built against. */
test("both hostname forms of one operator name one fixture", () => {
  assert.equal(slugOf("prideag.mobile.agricharts.com"), "prideag");
  assert.equal(slugOf("mobile.prideag.com"), "prideag");
});

test("slugs, on the hosts actually measured", () => {
  assert.equal(slugOf("legacyfarmers.mobile.agricharts.com"), "legacyfarmers");
  assert.equal(slugOf("mobile.thefarmerselevator.com"), "thefarmerselevator");
  assert.equal(slugOf("kokomograin.mobile.agricharts.com"), "kokomograin");
  assert.equal(slugOf("wheatfieldgrain.mobile.agricharts.com"), "wheatfieldgrain");
  assert.equal(slugOf("www.leroycoop.coop"), "leroycoop");
});

test("a slug is a filename and never anything else", () => {
  assert.match(slugOf("a_b.MOBILE.agricharts.com"), /^[a-z0-9-]+$/);
  assert.equal(slugOf(""), "unnamed");
  assert.equal(slugOf("../../etc/passwd"), "etc-passwd");
});

/* ── a 200 is not a board ────────────────────────────────────────────────── */

const BOARD = `<html><body><h1>Cash Prices</h1><table>
<tr><th>Commodity</th><th>Delivery</th><th>Basis</th><th>Cash Price</th><th>Futures Chg</th></tr>
<tr><td>Corn</td><td>09/01/2026</td><td>-15</td><td>$5.29</td><td>-2-4</td></tr>
</table>${"<!-- padding -->".repeat(30)}</body></html>`;

test("a real board is recognised", () => {
  assert.equal(looksLikeBoard(BOARD), true);
});

test("a parked page, a splash and a redirect target are not fixtures", () => {
  assert.equal(looksLikeBoard(`<html><body>This domain is for sale.${"x".repeat(600)}</body></html>`), false);
  // Says "cash price" in its marketing copy but has no table at all.
  assert.equal(looksLikeBoard(`<html><body><p>See our cash price page.</p>${"x".repeat(600)}</body></html>`), false);
  // A table with no board in it.
  assert.equal(looksLikeBoard(`<html><table><tr><td>hours</td></tr></table>${"x".repeat(600)}</html>`), false);
  assert.equal(looksLikeBoard(""), false);
});

test("the 520-byte refusal is never mistaken for a board", () => {
  assert.equal(looksLikeBoard("<html><head><title>403 Forbidden</title></head><body>"
    + "<h1>Forbidden</h1></body></html>"), false);
});

/* ── the profiles differ only where they are meant to ────────────────────── */

/* cdp vs chrome is the experiment. If anything else drifts between them, the
   run can no longer isolate our own token and the grid means nothing. */
test("cdp and chrome differ in the user-agent and in nothing else", () => {
  const a = { ...PROFILES.cdp }, b = { ...PROFILES.chrome };
  assert.notEqual(a["user-agent"], b["user-agent"]);
  delete a["user-agent"]; delete b["user-agent"];
  assert.deepEqual(a, b);
});

test("cdp carries our token and chrome does not", () => {
  assert.match(PROFILES.cdp["user-agent"], /agsist-bidreader/);
  assert.doesNotMatch(PROFILES.chrome["user-agent"], /agsist/);
  assert.equal(PROFILES.chrome["user-agent"], CHROME);
});

test("bidreader is what the reader would really send", () => {
  // scripts/poll.mjs line: const UA = "agsist-bidreader/1.0 (+https://agsist.com; posted bid)"
  assert.equal(PROFILES.bidreader["user-agent"],
    "agsist-bidreader/1.0 (+https://agsist.com; posted bid)");
});

test("bare sends no user-agent, which is the other end of the range", () => {
  assert.equal(PROFILES.bare["user-agent"], undefined);
});

test("every profile in the order exists", () => {
  for (const p of PROFILE_ORDER) assert.ok(PROFILES[p], `no headers for profile ${p}`);
  assert.equal(PROFILE_ORDER.length, Object.keys(PROFILES).length);
});

/* ── the verdict ─────────────────────────────────────────────────────────── */

const NET_OK = { ok: true, status: 200, bytes: 100 };
const NET_DOWN = { ok: false, error: "TypeError: fetch failed (ENOTFOUND)" };
const PLAT_500 = { ok: true, status: 500 };
const row = (profile, status, url = "https://a.mobile.agricharts.com/cash/prices.php") =>
  ({ url, profile, ok: true, status });

test("no egress means no finding, whatever the grid says", () => {
  const v = verdict({
    rows: [row("chrome", 403), row("cdp", 403)],
    networkControl: NET_DOWN, platformControl: PLAT_500,
  });
  assert.equal(v.call, "inconclusive");
  assert.match(v.lines.join(" "), /nothing below is about AgriCharts/);
});

test("a network control that answers 403 is also no finding", () => {
  const v = verdict({
    rows: [row("chrome", 403)],
    networkControl: { ok: true, status: 403 }, platformControl: PLAT_500,
  });
  assert.equal(v.call, "inconclusive");
});

test("every profile refused, control healthy: it is the network, and it says so", () => {
  const v = verdict({
    rows: PROFILE_ORDER.map((p) => row(p, 403)),
    networkControl: NET_OK, platformControl: PLAT_500,
  });
  assert.equal(v.call, "network");
  const t = v.lines.join(" ");
  assert.match(t, /client is not the variable/i);
  assert.match(t, /EGRESS/i);
  // and it must NOT send anybody off to try a sixth user-agent
  assert.match(t, /no further user-agent is worth/i);
});

test("a 403 on a hostname with nothing behind it is called out", () => {
  const v = verdict({
    rows: PROFILE_ORDER.map((p) => row(p, 403)),
    networkControl: NET_OK, platformControl: { ok: true, status: 403 },
  });
  assert.equal(v.call, "network");
  assert.match(v.lines.join(" "), /DOES NOT EXIST/);
});

test("our own token being the rule is named, not left to be inferred", () => {
  const v = verdict({
    rows: [row("bidreader", 403), row("cdp", 403), row("chrome", 200),
           row("browser", 200), row("bare", 403)],
    networkControl: NET_OK, platformControl: PLAT_500,
  });
  assert.equal(v.call, "client");
  const t = v.lines.join(" ");
  assert.match(t, /A DOOR IS OPEN/);
  assert.match(t, /agsist-bidreader/);
});

test("a header set rather than a UA string is named too", () => {
  const v = verdict({
    rows: [row("bidreader", 403), row("cdp", 403), row("chrome", 403),
           row("browser", 200), row("bare", 403)],
    networkControl: NET_OK, platformControl: PLAT_500,
  });
  assert.equal(v.call, "client");
  assert.match(v.lines.join(" "), /header set a browser sends/);
});

test("a mixed grid refuses to draw one conclusion", () => {
  const v = verdict({
    rows: [row("chrome", 403), row("chrome", 500, "https://b.mobile.agricharts.com/cash/prices.php"),
           row("cdp", 404)],
    networkControl: NET_OK, platformControl: PLAT_500,
  });
  assert.equal(v.call, "mixed");
  assert.match(v.lines.join(" "), /row by row/);
});

test("nothing asked is not a finding either", () => {
  const v = verdict({ rows: [], networkControl: NET_OK, platformControl: PLAT_500 });
  assert.equal(v.call, "inconclusive");
});

/* ── flags ───────────────────────────────────────────────────────────────── */

test("a flag's value is not a target", () => {
  const cfg = parseArgs(["--control", "https://example.test/ok", "--profiles", "chrome,bare"]);
  assert.deepEqual(cfg.urls, []);
  assert.equal(cfg.control, "https://example.test/ok");
  assert.deepEqual(cfg.profiles, ["chrome", "bare"]);
});

test("URLs given bare and with --url both land as targets", () => {
  const cfg = parseArgs(["https://a.test/x", "--url", "https://b.test/y"]);
  assert.deepEqual(cfg.urls, ["https://a.test/x", "https://b.test/y"]);
});

test("--timeout is seconds on the outside and milliseconds inside", () => {
  assert.equal(parseArgs(["--timeout", "30"]).timeoutMs, 30000);
});

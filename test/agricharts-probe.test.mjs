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

const dead = (profile, error = "TypeError: fetch failed (ECONNRESET)",
              url = "https://a.mobile.agricharts.com/cash/prices.php") =>
  ({ url, profile, ok: false, status: null, error });

test("a runner that reached nothing at all has found nothing", () => {
  const v = verdict({
    rows: [dead("chrome"), dead("cdp")],
    networkControl: NET_DOWN, platformControl: { ok: false, error: "ECONNRESET" },
  });
  assert.equal(v.call, "inconclusive");
  assert.match(v.lines.join(" "), /reached nothing at all/);
});

test("a control that answers 403 with nothing else answering is no finding either", () => {
  const v = verdict({
    rows: [dead("chrome")],
    networkControl: { ok: true, status: 403 }, platformControl: { ok: false, error: "ECONNRESET" },
  });
  assert.equal(v.call, "inconclusive");
});

/* RUN 91323682912, AND THE REASON THIS TEST EXISTS.
 *
 * raw.githubusercontent.com dropped one connection. The run then printed
 * "INCONCLUSIVE ... nothing below is about AgriCharts" over a grid of
 * thirty-five 200s, a platform control answering 500 from nginx, and seven
 * boards captured and committed in the same job — and exited 1. The control is
 * evidence about egress, and it is the WEAKEST evidence about egress in the
 * room the moment a target answers. */
test("a control that flakes does not throw away a run where the targets answered", () => {
  const v = verdict({
    rows: PROFILE_ORDER.map((p) => row(p, 200)),
    networkControl: NET_DOWN, platformControl: PLAT_500,
  });
  assert.equal(v.call, "client");
  const t = v.lines.join(" ");
  assert.match(t, /A DOOR IS OPEN/);
  assert.match(t, /control flaked; the run did not/);
  assert.doesNotMatch(t, /INCONCLUSIVE/);
});

/* AND THE TARGETS HAVE TO COUNT ON THEIR OWN. Both controls are extra requests
   to hosts we do not care about; either can drop a connection. Thirty-five 200s
   from the boards themselves is the strongest evidence of egress in the run and
   it must not need a control to corroborate it. */
test("targets answering is enough on its own, with both controls down", () => {
  const v = verdict({
    rows: PROFILE_ORDER.map((p) => row(p, 200)),
    networkControl: NET_DOWN, platformControl: { ok: false, error: "ECONNRESET" },
  });
  assert.equal(v.call, "client");
  assert.doesNotMatch(v.lines.join(" "), /INCONCLUSIVE/);
});

test("a flaked control does not turn a real refusal into a shrug either", () => {
  // Every profile refused, control down, but the platform control answered —
  // so we did reach AgriCharts and the refusal is still the finding.
  const v = verdict({
    rows: PROFILE_ORDER.map((p) => row(p, 403)),
    networkControl: NET_DOWN, platformControl: PLAT_500,
  });
  assert.equal(v.call, "network");
  assert.match(v.lines.join(" "), /client is not the variable/i);
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

/* ── the quote pages ─────────────────────────────────────────────────────── */

/* THE CASH BOARD IS MISSING THE ONE NUMBER lib/board.mjs INSISTS ON.
 * It carries cash, basis and a futures CHANGE, and no futures price -- and
 * board.mjs refuses any source where not one row carries a quoted future,
 * because a structural check whose absence looks identical to its success is
 * not a check. So the quote pages are not a nicety; without them AgriCharts
 * cannot publish at all, and a fixture filed from the wrong page would be
 * built against for a week before anybody noticed. */
import { looksLikeQuotes, QUOTE_PAGES, fixtureVerdict } from "../scripts/agricharts-probe.mjs";

const QUOTES = `<html><body><table>
<tr><td>Symbol</td><td>Last</td><td>Change</td><td>Time</td></tr>
<tr><td>Corn (E) Dec 26</td><td>543-4s</td><td>-2-4</td><td>09/02/26</td></tr>
<tr><td>Soybeans (E) Nov 26</td><td>1310-2s</td><td>-7-4</td><td>09/02/26</td></tr>
</table>${"<!-- pad -->".repeat(40)}</body></html>`;

/* MG Wheat and Rice quote in decimals, not eighths, on the same page family. */
const DECIMAL_QUOTES = QUOTES.replace("543-4s", "7.5975s").replace("1310-2s", "7.8200s")
  .replace("-2-4", "+0.0425").replace("-7-4", "+0.0525");

test("a real quote table is recognised, in eighths and in decimals", () => {
  assert.equal(looksLikeQuotes(QUOTES), true);
  assert.equal(looksLikeQuotes(DECIMAL_QUOTES), true);
});

test("the category menu that answers 200 with no prices is not a fixture", () => {
  // futures.php with no root and no overview really does answer 200 with a
  // menu of Currencies / Energies / Grains / Livestock and nothing else.
  const menu = `<html><body><table><tr><td><a href="?category=Grains">Grains</a></td></tr>
    <tr><td><a href="?category=Livestock">Livestock</a></td></tr></table>
    Last Update: 23:15:27 CST ${"<!-- pad -->".repeat(40)}</body></html>`;
  assert.equal(looksLikeQuotes(menu), false);
});

test("a cash board is not a quote page either", () => {
  assert.equal(looksLikeQuotes(BOARD), false);
});

/* A REAL CASH BOARD CARRIES EIGHTHS TOO. The Futures Chg column reads "-24-2"
   on Keller Grain's wheat row, which is the same shape as a quote. So the
   headings are what separate the two pages, and the test has to use a board
   that actually contains one -- the tidy one above is rejected by the price
   rule and proves nothing about the heading rule. */
test("a cash board that quotes eighths is still not a quote page", () => {
  const realish = `<html><body><h1>Cash Prices</h1><table class="cashprices">
    <tr><td>Commodity</td><td>Delivery</td><td>Basis</td><td>Cash Price</td><td>Futures Chg</td></tr>
    <tr><td>Wheat</td><td>08/01/2026</td><td>-45</td><td>$5.94</td><td>-24-2</td></tr>
    </table>Last Update: 23:09:45 CST ${"<!-- pad -->".repeat(40)}</body></html>`;
  assert.match(realish, /\d{2,4}-\d\d?/, "the fixture must contain an eighths-shaped number");
  // and every AgriCharts page carries "Last Update", so "Last" alone cannot be
  // what separates a board from a strip -- the Change heading is load-bearing.
  assert.match(realish, /\bLast\b/);
  assert.equal(looksLikeQuotes(realish), false);
});

/* AND A STRIP WITH THE RIGHT HEADINGS AND NO PRICES IS THE ONE THAT WOULD GET
   FILED. A root with no contracts trading answers 200 with the full table
   furniture and empty cells; filed as a fixture, it would be built against as
   though that commodity simply had no quotes. */
test("the right headings with no prices under them is not a fixture", () => {
  const empty = `<html><body><table>
    <tr><td>Symbol</td><td>Last</td><td>Change</td><td>Time</td></tr>
    <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
    </table>Last Update: 23:15:27 CST ${"<!-- pad -->".repeat(40)}</body></html>`;
  assert.equal(looksLikeQuotes(empty), false);
});

test("every grain this system publishes has a strip to capture", () => {
  const names = QUOTE_PAGES.map(([n]) => n);
  for (const want of ["corn", "soybeans", "wheat-chicago", "wheat-kc"])
    assert.ok(names.includes(want), `no quote page for ${want}`);
  // the overview carries only two contracts per commodity, so it can never be
  // the only page captured -- Legacy Farmers priced a 01/01/2027 corn delivery
  // off a 558 board, which is Mar 27 and is not on the overview.
  assert.ok(names.length > 1, "the overview alone cannot cover a cash board's far deliveries");
  for (const [, path] of QUOTE_PAGES) assert.match(path, /^\/markets\/futures\.php\?/);
});

test("--quotes takes no target list and has a default host", () => {
  const cfg = parseArgs(["--quotes"]);
  assert.equal(cfg.quotes, true);
  assert.match(cfg.quotesHost, /^https:\/\/[a-z.]+agricharts\.com$/);
  assert.deepEqual(cfg.urls, []);
});

test("--quotes-host is a value, not a target", () => {
  const cfg = parseArgs(["--quotes", "--quotes-host", "https://kokomograin.mobile.agricharts.com"]);
  assert.deepEqual(cfg.urls, []);
  assert.equal(cfg.quotesHost, "https://kokomograin.mobile.agricharts.com");
});


/* ── a fixture is frozen evidence ────────────────────────────────────────── */

/* THREE RUNS REWROTE ALL SEVEN BOARDS -- 721 lines changed and 721 deleted,
 * every time -- because a board captured at 23:11 differs from the same board
 * at 00:37. The churn is the smaller half. The larger half is that an adapter's
 * tests are written against these bytes, and a specimen that moves under the
 * test means the day it fails nobody can say whether the parser broke or the
 * page did. */
test("a captured board is kept, not rewritten", () => {
  assert.equal(fixtureVerdict({ exists: true, refresh: false }).write, false);
});

test("a board we do not have is always captured", () => {
  assert.equal(fixtureVerdict({ exists: false, refresh: false }).write, true);
  assert.equal(fixtureVerdict({ exists: false, refresh: true }).write, true);
});

test("--refresh replaces it, deliberately and visibly", () => {
  const v = fixtureVerdict({ exists: true, refresh: true });
  assert.equal(v.write, true);
  assert.match(v.why, /--refresh/);
});

test("the kept case says how to replace it, or nobody will find out how", () => {
  assert.match(fixtureVerdict({ exists: true, refresh: false }).why, /--refresh/);
});

test("--refresh is a flag, not a target", () => {
  const cfg = parseArgs(["--refresh", "https://a.test/x"]);
  assert.equal(cfg.refresh, true);
  assert.deepEqual(cfg.urls, ["https://a.test/x"]);
  assert.equal(parseArgs([]).refresh, false);
});

/* ── the shape a workflow_dispatch box actually delivers ─────────────────── */

/* RUN 91355280009. Sixteen URLs were pasted into the workflow's `urls` box,
 * one per line, and the job received them as ONE line with spaces between —
 * a workflow_dispatch string input is single-line, and a pasted newline is a
 * space before the job starts. The parser required a whole line to be a URL,
 * so sixteen live targets matched nothing and the run died with three words. */
test("sixteen URLs on one line, the way GitHub delivers them", () => {
  const asDelivered = "https://a.mobile.agricharts.com/cash/prices.php "
    + "https://mobile.b.com/cash/prices.php https://c.mobile.agricharts.com/cash/prices.php";
  assert.deepEqual(urlsFrom(asDelivered), [
    "https://a.mobile.agricharts.com/cash/prices.php",
    "https://mobile.b.com/cash/prices.php",
    "https://c.mobile.agricharts.com/cash/prices.php",
  ]);
});

test("and the comment rule still holds, which is why the file form works", () => {
  assert.deepEqual(urlsFrom(LIST), [
    "https://legacyfarmers.mobile.agricharts.com/cash/prices.php",
    "https://mobile.prideag.com/cash/prices.php",
  ]);
  assert.deepEqual(urlsFrom("# https://example.test/x https://example.test/y"), []);
  assert.deepEqual(urlsFrom("   #    https://example.test/x"), []);
});

test("tabs, blank lines and a trailing space are all just separators", () => {
  assert.deepEqual(urlsFrom("\n\thttps://a.test/x \n\n  https://b.test/y\t\n "),
    ["https://a.test/x", "https://b.test/y"]);
});

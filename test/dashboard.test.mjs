/* The dashboard baker.
 *
 * These exist because the first cut of scripts/dashboard.mjs shipped a chart
 * built from x coordinates around -518,000,000,000 and NOTHING COMPLAINED.
 * SVG drew the path far off-canvas, the panel rendered as a small dash, and a
 * dash on a basis chart reads as "the market has not moved" rather than as
 * "this chart is broken". It was caught by screenshotting the page, which is
 * not a repeatable check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeries, sparkline, gaps, render } from "../scripts/dashboard.mjs";

const bid = (delivery, seq, basis) => ({
  seq, commodity: "Corn", delivery, futuresMonth: "Sep 26",
  cash: Math.round((4.595 + basis) * 10000) / 10000,
  basisDollars: basis, basisCents: Math.round(basis * 100), futuresPriceCents: 459.5,
});

/* A commit as history() hands it on: git metadata plus the file at that sha. */
const commit = (when, pricedAt, basis) => ({
  sha: when, when, subject: "x",
  doc: { checkedAt: when, pricedAt, count: 1, bids: [bid("August", 0, basis)] },
});

const H = (n) => new Date(Date.parse("2026-08-01T00:00:00.000Z") + n * 36e5).toISOString();

test("THE HEARTBEAT BUG: a stale pricedAt must not walk the series backwards", () => {
  /* pricedAt only moves when the price moves, so a heartbeat commit carries an
     OLD pricedAt on purpose. Appending one point per commit in commit order
     therefore goes backwards in x every time a heartbeat lands. */
  const commits = [
    commit(H(0), H(0), -0.52),     // price set
    commit(H(1), H(0), -0.52),     // heartbeat, pricedAt still H(0)
    commit(H(2), H(2), -0.50),     // price moves
    commit(H(3), H(2), -0.50),     // heartbeat, pricedAt back at H(2)
    commit(H(9), H(2), -0.50),     // heartbeat
  ];
  const { byMonth } = buildSeries(commits);
  const s = byMonth.get("August");

  assert.equal(s.length, 2, "five commits carrying two distinct prices is two points");
  for (let i = 1; i < s.length; i++)
    assert.ok(s[i].t > s[i - 1].t, `series went backwards at ${i}`);
  assert.deepEqual(s.map((p) => p.v), [-0.52, -0.50]);
});

test("commits arriving out of order still produce an ascending series", () => {
  const { byMonth } = buildSeries([
    commit(H(5), H(5), -0.44),
    commit(H(1), H(1), -0.52),
    commit(H(3), H(3), -0.48),
  ]);
  const s = byMonth.get("August");
  assert.deepEqual(s.map((p) => p.v), [-0.52, -0.48, -0.44]);
});

test("EVERY POINT LANDS INSIDE THE PANEL", () => {
  const commits = Array.from({ length: 40 }, (_, i) =>
    commit(H(i), H(i), -0.6 + (i % 7) * 0.02));
  const s = buildSeries(commits).byMonth.get("August");
  const svg = sparkline(s, { lo: -0.7, hi: -0.4 });
  const pts = [...svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  assert.equal(pts.length, s.length);
  for (const [x, y] of pts) {
    assert.ok(x >= -1 && x <= 233, `x ${x} outside the 232-wide panel`);
    assert.ok(y >= -1 && y <= 75, `y ${y} outside the 74-tall panel`);
  }
  assert.ok(Math.max(...pts.map((p) => p[0])) > 200, "the line should span the panel, not bunch at the left");
});

test("the baker REFUSES rather than drawing a path off-canvas", () => {
  /* The guard that would have turned the original bug into a red build
     instead of a plausible-looking flat line. */
  const bad = [{ t: 0, v: -0.5 }, { t: 1e15, v: -0.5 }, { t: 5, v: -0.5 }];
  assert.throws(() => sparkline(bad, { lo: -1, hi: 0 }),
    (e) => /not in time order|outside the/.test(e.message));
});

test("panels share one y-scale, so they can be compared by eye", () => {
  /* Small multiples that each scale to their own data are a lie: a flat month
     and a violent month look identical. */
  const a = [{ t: 1, v: -0.60 }, { t: 2, v: -0.58 }];
  const b = [{ t: 1, v: -0.45 }, { t: 2, v: -0.43 }];
  const yOf = (svg) => [...svg.matchAll(/[ML](?:-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[1]);
  const ya = yOf(sparkline(a, { lo: -0.7, hi: -0.4 }));
  const yb = yOf(sparkline(b, { lo: -0.7, hi: -0.4 }));
  assert.ok(Math.min(...yb) < Math.min(...ya),
    "the higher-basis month must sit higher in its panel under a shared scale");
});

test("an empty series renders an empty panel rather than throwing", () => {
  const svg = sparkline([], { lo: -1, hi: 0 });
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /class="line"/);
});

test("a heartbeat gap is detected, because a refusal leaves no commit", () => {
  /* A failed read writes nothing at all. There is no positive record of it
     anywhere in the repo. A missing heartbeat is the only trace. */
  const quiet = [commit(H(0), H(0), -0.52), commit(H(30), H(0), -0.52)];
  const g = gaps(quiet);
  assert.equal(g.length, 1);
  assert.ok(g[0].hours > 29);

  const healthy = [commit(H(0), H(0), -0.52), commit(H(5), H(0), -0.52), commit(H(10), H(0), -0.52)];
  assert.equal(gaps(healthy).length, 0);
});

test("THE PAGE PRINTS NO RELATIVE TIMES", () => {
  /* A static file that says "checked 2 hours ago" says it forever, and it
     stays reassuring long after it stops being true -- on the one page you
     would open to find out whether the reader had died. */
  const doc = {
    checkedAt: H(0), pricedAt: H(0), count: 1, bids: [bid("August", 0, -0.52)],
    source: { location: "Boyceville" },
  };
  const html = render(doc, { byMonth: new Map([["August", [{ t: Date.parse(H(0)), v: -0.52 }]]]), commits: [] });
  assert.doesNotMatch(html, /\bago\b/i);
  assert.doesNotMatch(html, /just now|moments|minutes old|hours old/i);
  assert.match(html, /drop this price after/, "the freshness claim must be a deadline");
});

test("the page carries no script and makes no outside request", () => {
  const doc = {
    checkedAt: H(0), pricedAt: H(0), count: 1, bids: [bid("August", 0, -0.52)],
    source: { location: "Boyceville" },
  };
  const html = render(doc, { byMonth: new Map(), commits: [] });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//, "no CDN, no web font, no remote image");
  assert.doesNotMatch(html, /onclick|onload/i);
});

test("the identity check is re-run on the published file and reported", () => {
  const ok = {
    checkedAt: H(0), pricedAt: H(0), count: 1, bids: [bid("August", 0, -0.52)],
    source: { location: "Boyceville" },
  };
  assert.match(render(ok, { byMonth: new Map(), commits: [] }),
    /All 1 verifiable rows satisfy cash minus basis equals futures/);

  const broken = JSON.parse(JSON.stringify(ok));
  broken.bids[0].cash = 9.99;                       // cash - basis no longer equals futures
  assert.match(render(broken, { byMonth: new Map(), commits: [] }),
    /fail cash minus basis equals futures/);
});

test("A BLANK UPSTREAM CELL IS UNVERIFIABLE, NOT A FAILURE", () => {
  /* lib/board.mjs publishes a row missing one of the three values, because
     checkIdentity skips it and the build only refuses when NO row is testable.
     This page used to count that as a failure and render "Do not trust these
     numbers" -- an alarm whose every clause was false -- on an ordinary N/A in
     their Futures column. It is the panel that would have to carry a real
     column-shift alarm, so it must not cry wolf on an upstream blank. */
  const doc = {
    checkedAt: H(0), pricedAt: H(0), count: 2, source: { location: "Boyceville" },
    bids: [bid("August", 0, -0.52), { ...bid("September", 1, -0.46), futuresPriceCents: null }],
  };
  const html = render(doc, { byMonth: new Map(), commits: [] });
  assert.doesNotMatch(html, /Do not trust these numbers/);
  assert.doesNotMatch(html, /fail cash minus basis/);
  assert.match(html, /All 1 verifiable rows satisfy/);
  assert.match(html, /1 of 2 rows could not be checked/);
});

test("the re-check tolerance matches board.mjs rather than being far tighter", () => {
  /* board.mjs allows 0.05c of identity slack. A dashboard at 1e-9 dollars
     rendered red on files board.mjs had deliberately published green. */
  const doc = {
    checkedAt: H(0), pricedAt: H(0), count: 1, source: { location: "Boyceville" },
    bids: [{ ...bid("August", 0, -0.52), futuresPriceCents: 459.53 }],   // 0.03c off
  };
  assert.match(render(doc, { byMonth: new Map(), commits: [] }),
    /All 1 verifiable rows satisfy/);
});

test("a weekend commit cadence does not read as a gap", () => {
  /* At SLACK_H = 2 the threshold was 8.00h and the weekend cadence produced
     commits at exactly 8.00h, so ordinary scheduler drift flagged a false gap
     nearly every Monday. */
  const weekend = [0, 8, 16, 24, 32].map((h) => commit(H(h), H(0), -0.52));
  assert.equal(gaps(weekend).length, 0, "a clean 8h weekend cadence must be silent");

  const drifted = [0, 8.3, 16.1, 24.4].map((h) => commit(H(h), H(0), -0.52));
  assert.equal(gaps(drifted).length, 0, "and must stay silent through scheduler drift");

  const dead = [commit(H(0), H(0), -0.52), commit(H(40), H(0), -0.52)];
  assert.equal(gaps(dead).length, 1, "but a genuinely dead reader must still flag");
});

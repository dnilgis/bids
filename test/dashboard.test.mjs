/* The dashboard: status and data, and nothing that pretends.
 *
 * The version this replaces drew basis sparklines from four hundred commits
 * of git history. That is where its worst bug lived -- x-coordinates at minus
 * five hundred billion, which rendered as a flat dash rather than an error --
 * and none of it was asked for. There is no chart here and no history walk,
 * so most of these tests are about the page telling the truth when a source
 * is broken rather than about drawing anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, render, money } from "../scripts/dashboard.mjs";

const NOW = new Date("2026-08-18T22:10:00.000Z");
const hoursBefore = (h) => new Date(NOW.getTime() - h * 36e5).toISOString();
const src = (o = {}) => JSON.stringify({
  schema: "bigriver-boyceville/2",
  source: { name: "Big River Resources", location: "Boyceville" },
  checkedAt: hoursBefore(0.5), pricedAt: hoursBefore(3), status: "ok", count: 1,
  bids: [{ delivery: "August", cash: 4.1125, basisDollars: -0.52,
           futuresMonth: "Sep 26", futuresPriceCents: 463.25 }],
  ...o,
});
const read = (o) => readSource("boyceville.json", src(o), NOW);

/* ---- the states ---------------------------------------------------------- */

test("a source read inside the heartbeat is live", () => {
  assert.equal(read().state, "live");
  assert.equal(read().why, null);
});

test("past the heartbeat it is late, past the consumer's limit it is cold", () => {
  assert.equal(read({ checkedAt: hoursBefore(7) }).state, "late");
  assert.equal(read({ checkedAt: hoursBefore(20) }).state, "cold");
  assert.match(read({ checkedAt: hoursBefore(20) }).why, /past the 14h/);
});

test("A CLOCK AHEAD OF OURS IS BROKEN, NOT FRESH", () => {
  /* The subtraction goes negative and every naive freshness test passes for
     ever. It is the one state that looks healthiest while being worst. */
  const s = read({ checkedAt: hoursBefore(-10) });
  assert.equal(s.state, "broken");
  assert.match(s.why, /10\.0 h ahead of ours/);
  assert.doesNotMatch(s.why, /-/, "and it is not reported as a negative age");
});

test("READER HEALTH OUTRANKS WHAT THE SOURCE IS POSTING", () => {
  /* A board we have not reached in a day, posting nothing: "it is posting no
     rows" would be a statement about yesterday dressed up as one about now.
     Everything the file says about the board is a claim about when it was
     last read. */
  const s = readSource("x.json", src({ checkedAt: hoursBefore(26), bids: [], count: 0 }), NOW);
  assert.equal(s.state, "cold");
  const fresh = readSource("x.json", src({ bids: [], count: 0 }), NOW);
  assert.equal(fresh.state, "withdrawn", "read recently and posting nothing is a different fact");
});

test("a status the reader itself flagged is surfaced, not swallowed", () => {
  const s = read({ status: "manual" });
  assert.equal(s.state, "flagged");
  assert.match(s.why, /marked it "manual"/);
});

/* ---- files this page does not understand -------------------------------- */

test("A FILE THAT WILL NOT PARSE IS SHOWN, NOT SKIPPED", () => {
  /* Sources will arrive from platforms that are neither Big River nor
     FarmCentric. The day one writes something unexpected, the page has to say
     so by name -- a source that quietly vanishes from a status page is worse
     than one shown as broken. */
  const s = readSource("menomonie.json", "{ not json", NOW);
  assert.equal(s.state, "unreadable");
  assert.equal(s.id, "menomonie");
  assert.match(s.why, /not valid JSON/);
  assert.doesNotThrow(() => render([s], NOW));
  assert.match(render([s], NOW), /menomonie/);
});

test("...and so is one with no readable clock", () => {
  for (const v of [undefined, null, "", "whenever", 0]) {
    const s = readSource("x.json", src({ checkedAt: v }), NOW);
    assert.equal(s.state, "unreadable", String(v));
    assert.match(s.why, /age cannot be known/);
  }
});

test("a source with no bids array at all still renders", () => {
  const s = readSource("x.json", JSON.stringify({ checkedAt: hoursBefore(1) }), NOW);
  assert.doesNotThrow(() => render([s], NOW));
  assert.match(render([s], NOW), /No rows posted/);
});

/* ---- what it will not do ------------------------------------------------- */

test("THERE IS NO CHART, NO SPARKLINE AND NO HISTORY WALK", () => {
  const html = render([read()], NOW);
  assert.doesNotMatch(html, /<svg|<canvas|polyline|sparkline/i);
  const source = readSource.toString() + render.toString();
  assert.doesNotMatch(source, /git log|execSync|child_process/i);
});

test("no relative time is ever printed as if the page were live", () => {
  /* The page is baked and then sits there. "4 minutes ago" is false the
     moment it is written and worse all day; every age is stated against the
     bake time and says so. */
  const html = render([read()], NOW);
  assert.doesNotMatch(html, /\bago\b(?!,)/);
  assert.match(html, /before this page was made/);
  assert.match(html, /page made/);
});

test("a quote the reader could not verify is a dash, never a number", () => {
  const s = read({ bids: [{ delivery: "August", cash: 4.01, basisDollars: -0.62,
                            futuresMonth: "Sep 26", futuresPriceCents: null }] });
  assert.equal(s.unverified, 1);
  const html = render([s], NOW);
  assert.match(html, /not verified against cash minus basis/);
  assert.match(html, /1 without a verified quote/);
});

test("MONEY IS SHOWN TO THE PRECISION IT WAS PUBLISHED AT", () => {
  /* 4.44 * 100 is 444.00000000000006 in binary floating point, so testing the
     remainder said "fractional" and put $4.4400 on the page -- a precision
     nobody quoted. */
  assert.equal(money(4.44), "$4.44");
  assert.equal(money(4.1125), "$4.1125");
  assert.equal(money(4), "$4.00");
  assert.equal(money(4.5), "$4.50");
  assert.equal(money(4.635), "$4.635");
  for (const v of [null, undefined, NaN, "4.44"]) assert.equal(money(v), "—");
});

/* ---- room to grow -------------------------------------------------------- */

test("IT WORKS AT ONE SOURCE AND AT FORTY, WITH NO EDIT IN BETWEEN", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    readSource(`site-${i}.json`, src({ source: { name: `Elevator ${i}`, location: "Somewhere" } }), NOW));
  const html = render(many, NOW);
  assert.equal((html.match(/class="src"/g) || []).length, 40);
  assert.match(html, /40 sources/);
});

test("and at none, without looking broken", () => {
  const html = render([], NOW);
  assert.match(html, /0 sources/);
  assert.match(html, /appears here on its own/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("ANYTHING NOT LIVE IS SHOWN FIRST", () => {
  /* A page you glance at should put the thing that needs you at the top, and
     no other ordering survives the list getting long. */
  const list = [
    readSource("a.json", src({ source: { name: "A live one" } }), NOW),
    readSource("b.json", "{bad", NOW),
    readSource("c.json", src({ source: { name: "C late" }, checkedAt: hoursBefore(8) }), NOW),
  ];
  const html = render(list, NOW);
  /* Matched on the section tag, not on data-state anywhere: the stylesheet
     names several states too, and a looser pattern reads those instead. */
  const order = [...html.matchAll(/<section class="src" data-state="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["unreadable", "late", "live"]);
});

/* ---- the accessibility rule the status palette carries ------------------- */

test("A STATUS COLOUR NEVER CARRIES THE MEANING ON ITS OWN", () => {
  /* Warning and serious are sub-3:1 on a light surface by design, and sit
     only ΔE 13.6 apart to a full-colour reader. The palette's own mitigation
     is the icon-and-label pairing, so every coloured dot on this page has its
     word beside it -- in the tiles and on every card. */
  const list = ["live", "late", "cold", "withdrawn", "broken"].map((st, i) =>
    st === "broken"
      ? readSource(`${i}.json`, src({ checkedAt: hoursBefore(-5) }), NOW)
      : st === "cold" ? readSource(`${i}.json`, src({ checkedAt: hoursBefore(20) }), NOW)
      : st === "late" ? readSource(`${i}.json`, src({ checkedAt: hoursBefore(8) }), NOW)
      : st === "withdrawn" ? readSource(`${i}.json`, src({ bids: [], count: 0 }), NOW)
      : readSource(`${i}.json`, src(), NOW));
  const html = render(list, NOW);
  for (const m of html.matchAll(/<span class="dot"[^>]*><\/span>([^<]*)/g))
    assert.ok(m[1].trim().length > 0, "a dot with no word after it");
  for (const word of ["Live", "Late", "Cold", "No rows", "Clock wrong"])
    assert.match(html, new RegExp(word));
});

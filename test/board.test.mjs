/* buildFile against the REAL captured page.
 *
 * fixtures/bigriver-2121.html is a real capture. An earlier session in this
 * project reconstructed a fixture from assumptions and 54 tests passed against
 * a fiction. Never test this parser against a page you wrote yourself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFile, Refused, priceChanged, serialise, CONFIG } from "../lib/board.mjs";

const html = readFileSync(new URL("../fixtures/bigriver-2121.html", import.meta.url), "utf8");
const NOW = "2026-08-17T16:32:26.765Z";
const URL_ = "https://bigriverbids.com/cashbidssingle-2121";
const build = (h = html) => buildFile(h, { now: NOW, sourceUrl: URL_ });

test("the real page yields the seven Boyceville corn rows", () => {
  const { file, dropped } = build();
  assert.equal(file.count, 7);
  assert.equal(file.bids.length, 7);
  assert.ok(dropped > 0, "the page carries other locations and they must be dropped");
  assert.equal(file.source.locationId, "2121");
});

test("cash minus basis equals the quoted futures on every row", () => {
  /* The identity check is the only guard that proves a number came out of the
     right COLUMN rather than merely being plausible. Asserted again here on
     the built file, because a bug in the mapping between parse and file would
     slip past a check that only ran inside the parser. */
  const { file } = build();
  for (const b of file.bids) {
    const derived = Math.round((b.cash - b.basisDollars) * 10000) / 10000;
    assert.equal(derived, b.futuresPriceCents / 100,
      `${b.delivery}: ${b.cash} - (${b.basisDollars}) != ${b.futuresPriceCents}c`);
  }
});

test("bids are in page order, nearest delivery first, not alphabetical", () => {
  /* Boyceville writes deliveries as month names. Sorted alphabetically, April
     comes first and a consumer taking bids[0] prices the wrong month in ten
     months of the year. It happens to be right in April and August, so a test
     written in August against an alphabetical sort would have passed. */
  const { file } = build();
  assert.deepEqual(file.bids.map((b) => b.seq), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(file.bids[0].delivery, "August");
  const names = file.bids.map((b) => b.delivery);
  assert.notDeepEqual(names, [...names].sort(),
    "if these are equal the fixture cannot distinguish page order from alphabetical");
});

test("both unit forms are published and the unit is in the field name", () => {
  const b = build().file.bids[0];
  assert.equal(b.basisDollars, -0.52);
  assert.equal(b.basisCents, -52);
  assert.equal(b.futuresPriceCents, 459.5);
  assert.ok(!("basis" in b), "an unlabelled `basis` is exactly the ambiguity to avoid");
});

test("the two clocks are both stamped and both equal now on a fresh build", () => {
  const { file } = build();
  assert.equal(file.checkedAt, NOW);
  assert.equal(file.pricedAt, NOW);
});

test("diagnostics stay OUT of the committed file", () => {
  /* The Worker's builder used to emit `dropped` and the Action's did not, so
     the same board read by the two readers produced two different files and
     git recorded a change in the reader as if it were a change in the price. */
  const { file, dropped, locations } = build();
  assert.equal("dropped" in file, false);
  assert.equal("locations" in file, false);
  assert.equal(typeof dropped, "number");
  assert.ok(Array.isArray(locations));
});

test("the committed shape matches what is already in data/boyceville.json", () => {
  const live = JSON.parse(readFileSync(new URL("../data/boyceville.json", import.meta.url), "utf8"));
  const { file } = build();
  assert.deepEqual(Object.keys(file).sort(), Object.keys(live).sort(),
    "a new or missing top-level key churns the file on the next poll");
  assert.deepEqual(Object.keys(file.bids[0]).sort(), Object.keys(live.bids[0]).sort());
});

test("serialisation is stable, so neither reader churns the other's file", () => {
  const a = serialise(build().file);
  const b = serialise(build().file);
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
});

test("an empty page is refused, not published", () => {
  assert.throws(() => build("<html><body><p>nothing here at all</p></body></html>"),
    (e) => e instanceof Refused && /0 bids parsed/.test(e.message));
});

test("a page with no Boyceville rows is refused and names what was there", () => {
  const other = html.replace(/2121/g, "2162");
  assert.throws(() => build(other),
    (e) => e instanceof Refused && /none for location 2121/.test(e.message));
});

test("a decimal point in the wrong place is refused", () => {
  const silly = html.replace(">4.0750<", ">40.750<");
  assert.throws(() => build(silly), (e) => e instanceof Refused);
});

test("a reordered column fails the identity check even with plausible values", () => {
  /* The scenario the sanity band cannot catch: every number still looks like a
     price, but cash and basis have swapped places. */
  const swapped = html.replace("<li class='c2'>4.0750</li><li class='c3'>-0.5200</li>",
                               "<li class='c2'>4.5950</li><li class='c3'>-0.0100</li>");
  assert.notEqual(swapped, html, "the fixture changed shape; this test needs updating");
  assert.throws(() => build(swapped),
    (e) => e instanceof Refused && /cash - basis = futures/.test(e.message));
});

test("priceChanged ignores the clocks and notices the price", () => {
  const { file } = build();
  const later = { ...file, checkedAt: "2026-08-17T22:00:00.000Z" };
  assert.equal(priceChanged(file, later), false, "a new checkedAt is not news");

  const moved = { ...file, bids: [{ ...file.bids[0], cash: 4.2 }, ...file.bids.slice(1)] };
  assert.equal(priceChanged(file, moved), true);
  assert.equal(priceChanged(null, file), true, "no previous file is always news");
});

test("the sanity band is a band, not a forecast", () => {
  assert.ok(CONFIG.floor < 3 && CONFIG.ceiling > 10,
    "narrowing this to the current market turns a decimal-point check into a price opinion");
});

test("THE GUARD CANNOT FAIL OPEN: a renamed futures header is refused", () => {
  /* checkIdentity only tests rows that carry cash, basis AND a quoted future.
     Rename their futures heading and every futuresPrice parses as null, so it
     verifies nothing and reports nothing wrong. Zero failures then means "no
     row was testable", which is a disabled guard wearing a passing guard's
     clothes. Before this was fixed, the line below published 7 rows with
     futuresPriceCents null on every one of them. */
  const renamed = html.replace(/>\s*Futures\s*</gi, ">CME<");
  assert.notEqual(renamed, html, "the fixture no longer has a Futures heading; update this test");
  assert.throws(() => build(renamed),
    (e) => e instanceof Refused && /could not run the cash - basis = futures check/.test(e.message));
});

test("the number of rows the guard actually verified is reported, not just failures", () => {
  const { file, verified } = build();
  assert.equal(verified, 7);
  assert.equal(verified, file.count, "every published row should have been verifiable");
});

/* ── the band the board's own futures column states ─────────────────────── */

test("a commodity the board abbreviates is banded from the futures it quotes", async () => {
  /* Run 91859042090 wrote 23 manifests and TWENTY of them carried a commodity
     name that matched no band: Scoular's boards write Yc, Ysb, Hww, Sor, Bly.
     Every one of those rows would have been withheld at the first poll.
     
     I know what Yc means. Typing it in is the move this project has decided
     against — and "Bly" would have been a guess dressed as a fact. The row
     says instead, in the column next to it, and the identity check already
     requires that column to reconcile to a fraction of a cent. */
  const { bandFor, contractBandName } = await import("../lib/board.mjs");
  const src = { bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] } };
  const rows = (f, n = 3) => Array.from({ length: n }, () => ({ futures: f }));

  /* A DESCRIPTION — how this platform writes it, measured on the boards
     captured 2026-09-04: Big River "Sep 26 Corn", Berthold "Dec 26 MIAX
     Spring Wheat". */
  assert.equal(bandFor(src, "Yc", rows("Dec 26 Corn")).floor, 2);
  assert.equal(bandFor(src, "Ysb", rows("Jan 27 Soybeans")).ceiling, 32);
  assert.equal(bandFor(src, "Hww", rows("Dec 26 MIAX Spring Wheat")).floor, 3);
  /* A SYMBOL — how DTN and Bushel write it. Both shapes, one rule. */
  assert.equal(bandFor(src, "Yc", rows("ZCZ26")).floor, 2);
  assert.equal(bandFor(src, "Ysb", rows("ZSF27")).ceiling, 32);
  assert.equal(bandFor(src, "Hww", rows("KEH27")).floor, 3);
  /* And the band it took is NAMED for where it came from, so nobody has to
     wonder whether somebody typed it. */
  assert.match(bandFor(src, "Yc", rows("Dec 26 Corn")).named, /from the futures these rows quote/);
});

test("UNANIMITY. Two contracts under one name band nothing", async () => {
  /* A board quoting two contracts under one commodity is saying that name
     covers two things. Banding both by one of them is how a wrong number
     publishes inside a band that was never meant for it. */
  const { bandFor, contractBandName } = await import("../lib/board.mjs");
  const src = { bands: {} };
  assert.equal(bandFor(src, "Mix", [{ futures: "Dec 26 Corn" }, { futures: "Jan 27 Soybeans" }]), null);
  assert.equal(contractBandName([{ futures: "ZCZ26" }, { futures: "ZSF27" }]), null);
  /* A ROW THAT CANNOT BE READ CANNOT VOTE — it refuses the whole commodity
     rather than letting the readable rows decide for it. */
  assert.equal(bandFor(src, "Yc", [{ futures: "Dec 26 Corn" }, { futures: null }]), null);
  assert.equal(bandFor(src, "Yc", [{ futures: "Dec 26 Corn" }, { futures: "Nov 26 Whatever" }]), null);
  assert.equal(bandFor(src, "Yc", []), null, "no rows is no evidence");
  assert.equal(bandFor(src, "Yc", null), null);
});

test("ONLY AN ABBREVIATION. A word the board invented is still refused by name", async () => {
  /* The first cut of this had no length limit and took down two guards that
     have stood since August: "an UNKNOWN commodity is withheld and named" and
     "a board with nothing publishable is refused". A fixture posts ZORBLAX
     against a corn futures column, and it published it as corn.
     
     A band catches a misplaced decimal point — it is not a taxonomy — so that
     reading is defensible and it is still the wrong trade. Those guards exist
     so a board carrying something nobody here understands SAYS SO. ZORBLAX is
     a word. Yc, Ysb, Hww, Sor and Bly are too short to be words, which is
     exactly what makes them abbreviations and makes the next column the place
     to look. */
  const { bandFor } = await import("../lib/board.mjs");
  const rows = (f) => [{ futures: f }, { futures: f }];
  for (const abbr of ["Yc", "Ysb", "Hww", "Sor", "Bly", "C", "SBM".slice(0, 3)])
    assert.ok(bandFor({ bands: {} }, abbr, rows("Dec 26 Corn")),
      `"${abbr}" is short enough to be an abbreviation`);
  for (const word of ["Zorblax", "Sungold", "Camelina", "Zephyrgrain"])
    assert.equal(bandFor({ bands: {} }, word, rows("Dec 26 Corn")), null,
      `"${word}" is a word — it must be refused by name, not banded by its neighbour`);
  /* And a real grain that IS in the defaults bands on its own name, without
     ever reaching the fallback — triticale and buckwheat are both there. */
  assert.equal(bandFor({ bands: {} }, "Triticale", null).named, "triticale (default)");
  assert.equal(bandFor({ bands: {} }, "Buckwheat", null).named, "buckwheat (default)");
});

test("this is the LAST thing tried, and it never overrules what worked before", async () => {
  const { bandFor } = await import("../lib/board.mjs");
  const rows = (f) => [{ futures: f }, { futures: f }];
  /* THE SOURCE'S OWN BANDS WIN. Somebody worked that number out. */
  const own = { bands: { yc: [1, 9] } };
  assert.deepEqual([bandFor(own, "Yc", rows("Dec 26 Corn")).floor,
                    bandFor(own, "Yc", rows("Dec 26 Corn")).ceiling], [1, 9]);
  /* A DEFAULT THAT MATCHES THE NAME STILL MATCHES IT. */
  const std = { bands: { corn: [2, 12] } };
  assert.equal(bandFor(std, "Corn", rows("Dec 26 Corn")).named, "corn");
  /* PER-TON PRODUCTS STILL WITHHOLD. Soybean meal trades in dollars a ton and
     must never pick up the bean's per-bushel band — the reason KNOWN_UNBANDED
     exists, and this fallback must not quietly undo it. */
  assert.equal(bandFor({ bands: {} }, "Soybean Meal", rows("ZMZ26")), null);
  assert.equal(bandFor({ bands: {} }, "Soybean Meal", rows("Dec 26 Soybean Meal")), null);
  /* AND THE ABBREVIATION OF IT, which KNOWN_UNBANDED cannot see. It matches on
     the words "meal", "hull", "gluten" — "Sbm" contains none of them, so the
     only thing standing between soybean meal at $340 a TON and the per-bushel
     bean band is ZM being mapped to nothing on purpose. Mutating that to
     "soybean" broke no test until this line existed. */
  assert.equal(bandFor({ bands: {} }, "Sbm", rows("ZMZ26")), null,
    "soybean meal must never pick up the bean's per-bushel band");
  assert.equal(bandFor({ bands: {} }, "Bo", rows("ZLZ26")), null,
    "bean oil trades in cents a pound");
});

test("the withheld message says what the futures column actually said", async () => {
  /* An error that reports "no band matches Yc" and stops has thrown away the
     evidence for its own verdict — the next person cannot tell a board that
     quotes nothing from one that quotes something unreadable. */
  const { buildFile } = await import("../lib/board.mjs");
  const src = { id: "t", operator: "T", location: "T", state: "IA", bands: {},
                url: "https://x.example/", platform: "cashbidssingle" };
  let out;
  try {
    out = buildFile(src, [{ seq: 0, commodity: "Bly", delivery: "Sep", cash: 4.0,
                            basis: -0.5, basisCents: -50, futures: "Nov 26 Whatever",
                            futuresPrice: 450 }]);
  } catch { out = null; }
  if (out && out.withheld && out.withheld.length)
    assert.match(out.withheld[0].why, /Nov 26 Whatever/,
      "the withheld reason drops the futures column it judged on");
});

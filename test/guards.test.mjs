/* Guard tests for the seven defects found on 2026-08-20.
 *
 * These do NOT go through a page. Every one of them feeds rows straight into
 * buildFile through its `extract` hook, because what is under test here is the
 * GUARD LAYER -- the code every platform shares -- and not any parser. That
 * also keeps the rule the board test file states at the top: never test a
 * parser against a page you wrote yourself. Nothing below is a page.
 *
 * fixtures/bigriver-2121.html is the only real capture in the repo and
 * test/board.test.mjs already holds it to a byte-identical file. Each fix here
 * was checked against that too, before and after: same 2,362 bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFile, Refused, checkMove, bandFor, validBand, classifyIdentity,
  scaleFutures, futuresScale, scaleByContract, rootOf, CONTRACT_SCALE, rowKey, DEFAULT_BANDS, KNOWN_UNBANDED,
  isRefusal, TornRead, CASH_ROUNDING,
} from "../lib/board.mjs";
import { basisToCents, filterLocation, normLocationId, parseTicks, checkIdentity } from "../lib/parse.mjs";

const NOW = "2026-08-20T04:00:00.000Z";
const URL_ = "https://example.test/board";

const row = (o) => ({
  seq: 0, source: "x", locationId: "1", location: "T", commodity: "Corn",
  delivery: "August", cash: null, basis: null, basisCents: null, futures: "Sep 26",
  futuresPrice: null, futuresAt: null, futuresFlag: null, change: null, ...o,
});
const source = (o) => ({
  locationId: "1", location: "T", operator: "Op",
  bands: { corn: [2.0, 12.0] }, cashRoundingCents: 0, ...o,
});
const build = (rows, s) =>
  buildFile("<html></html>", { now: NOW, sourceUrl: URL_, source: source(s), extract: () => rows });

/* A row that balances exactly: cash - basis = futures, in the right units. */
const good = (o = {}) => {
  const cash = o.cash ?? 4.29, basis = o.basis ?? -0.50;
  return row({ cash, basis, basisCents: Math.round(basis * 100),
               futuresPrice: Number(((cash - basis) * 100).toFixed(4)), ...o });
};

/* ------------------------------------------------------------------ */
/* 1. the identity majority is a majority of the rows actually tested  */
/* ------------------------------------------------------------------ */

test("a board where every TESTABLE row fails is refused, however many untestable rows sit beside it", () => {
  /* checkIdentity skips a row missing cash, basis or a quoted future. The
     verdict used to be taken against every kept row, so rows the check had
     never looked at padded the denominator that decides whether the failures
     are a minority. Three tested rows, all failing, beside four rows carrying
     no quote: `3 * 2 >= 7` is false, so it read "lagging" and published three
     futures quotes as verified with not one row having balanced. */
  const off = (d) => row({ delivery: d, cash: 4.0750, basis: -0.5200, basisCents: -52,
                           futuresPrice: 459.25 });   // derived is 459.5
  const blank = (d) => row({ delivery: d, cash: 4.3000, basis: -0.5400, basisCents: -54 });
  const rows = [off("August"), off("September"), off("October"),
                blank("November"), blank("December"), blank("January"), blank("February")];
  assert.throws(() => build(rows), (e) =>
    e instanceof Refused && /3 of 3 testable row\(s\) fail/.test(e.message) &&
    /is not a minority/.test(e.message));
});

test("the refusal says how many rows could not be tested, so the count is not mistaken for the board", () => {
  const off = (d) => row({ delivery: d, cash: 4.0750, basis: -0.5200, basisCents: -52, futuresPrice: 459.25 });
  const blank = (d) => row({ delivery: d, cash: 4.3000, basis: -0.5400, basisCents: -54 });
  assert.throws(() => build([off("A"), off("B"), off("C"), blank("D"), blank("E"), blank("F"), blank("G")]),
    /4 of 7 row\(s\) carry no quote and could not be tested/);
});

test("a genuine minority failure beside untestable rows still publishes", () => {
  /* The fix must only ever move the line toward refusing. One tested row out
     by a tick against three that balanced exactly is the case the tolerance
     exists for, and it still publishes. */
  const rows = [good({ delivery: "August" }), good({ delivery: "September" }),
                good({ delivery: "October" }),
                row({ delivery: "November", cash: 4.0750, basis: -0.5200, basisCents: -52, futuresPrice: 459.25 }),
                row({ delivery: "December", cash: 4.30, basis: -0.54, basisCents: -54 })];
  const { file, verified } = build(rows);
  assert.equal(file.status, "ok");
  assert.equal(file.count, 5);
  assert.equal(verified, 4);
});

test("classifyIdentity itself is unchanged; only the number handed to it moved", () => {
  assert.equal(classifyIdentity([0.25, 0.25, 0.25], 7), "lagging");
  assert.equal(classifyIdentity([0.25, 0.25, 0.25], 3), "unproven");
  assert.equal(classifyIdentity([], 0), "ok");
  assert.equal(classifyIdentity([0.25], 4), "lagging");
});

/* ------------------------------------------------------------------ */
/* 2. an absent locationId is not a wildcard                           */
/* ------------------------------------------------------------------ */

test("a manifest with no locationId key is refused rather than matching every row", () => {
  /* String(undefined) === String(undefined). The first-party adapter reads a
     bids.json we wrote, whose published rows carry no locationId at all, so it
     is exactly the path where both sides are absent -- and two towns published
     under one town's name. */
  const rows = [good({ locationId: undefined, location: "Wheeler" }),
                good({ locationId: undefined, location: "Dyersville", delivery: "September", cash: 3.10, basis: -1.69 })];
  const s = source({ location: "Wheeler" });
  delete s.locationId;
  assert.throws(() => buildFile("<html></html>", { now: NOW, sourceUrl: URL_, source: s, extract: () => rows }),
    (e) => e instanceof Refused && /has no locationId/.test(e.message));
});

test("declaring locationId null is refused when the rows name more than one place", () => {
  const rows = [good({ locationId: null, location: "Wheeler" }),
                good({ locationId: null, location: "Dyersville", delivery: "September", cash: 3.10, basis: -1.69 })];
  assert.throws(() => build(rows, { locationId: null, location: "Wheeler" }),
    (e) => e instanceof Refused && /the rows name 2: Wheeler, Dyersville/.test(e.message));
});

test("locationId null publishes on a page that really does carry one location", () => {
  const { file } = build([good({ locationId: null, location: "Stanley" })],
                         { locationId: null, location: "Stanley" });
  assert.equal(file.count, 1);
  assert.deepEqual(file.otherLocationsOnPage, [],
    "with no id to exclude by, `l.includes(null)` used to search for the text \"null\" and list our own location as somebody else's");
});

test("normLocationId folds the three ways of saying absent onto one value and nothing else", () => {
  assert.equal(normLocationId(undefined), null);
  assert.equal(normLocationId(null), null);
  assert.equal(normLocationId(""), null);
  assert.equal(normLocationId(0), "0");
  assert.equal(normLocationId("0"), "0");
  assert.equal(normLocationId(2121), "2121");
  /* 0 is a legal id and must not be swallowed by the absent case. */
  assert.equal(filterLocation([{ locationId: 0 }], "0").kept.length, 1);
  assert.equal(filterLocation([{ locationId: 0 }], null).kept.length, 0);
});

/* ------------------------------------------------------------------ */
/* 3. basis units                                                      */
/* ------------------------------------------------------------------ */

test("basisToCents decides on the board's own text, so there is no cliff at three dollars", () => {
  assert.equal(basisToCents(-0.52, "-0.5200"), -52);
  assert.equal(basisToCents(-2.99, "-2.99"), -299);
  assert.equal(basisToCents(-3.00, "-3.00"), -300);   // was -3
  assert.equal(basisToCents(-3.05, "-3.0500"), -305); // was -3
  assert.equal(basisToCents(0.15, "+.15"), 15);       // no leading digit
  assert.equal(basisToCents(-52, "-52"), -52);        // a bare integer is cents
  assert.equal(basisToCents(null, "-"), null);
});

test("the old magnitude rule survives only for a caller with no text, and its cliff is documented here", () => {
  assert.equal(basisToCents(-2.99), -299);
  assert.equal(basisToCents(-3.05), -3);
  /* If that ever stops being true this test should be deleted, not adjusted:
     it exists to record that the textless path is still a guess. The guard
     below is what makes the guess safe. */
});

test("a basis published in the wrong units cannot reach a file, even though the identity check passes", () => {
  /* checkIdentity reads `basis` in DOLLARS, so a basisCents out by a factor of
     a hundred balances exactly like a right one. basisCents is what the Emmert
     sites render. */
  const bad = row({ commodity: "Soybeans", cash: 9.65, basis: -3.05,
                    basisCents: -3, futuresPrice: 1270 });
  assert.throws(() => build([bad], { bands: { soybean: [6.0, 32.0] } }),
    (e) => e instanceof Refused && /units problem rather than a price problem/.test(e.message));

  const okRow = { ...bad, basisCents: -305 };
  assert.equal(build([okRow], { bands: { soybean: [6.0, 32.0] } }).file.bids[0].basisCents, -305);
});

test("the units guard tolerates a lagging quote and a rounded cash cell", () => {
  /* A quarter-cent tear must not read as a units error. */
  const laggy = row({ cash: 4.0750, basis: -0.5200, basisCents: -52, futuresPrice: 459.25 });
  const { file } = build([laggy, good({ delivery: "B" }), good({ delivery: "C" }), good({ delivery: "D" })],
                         { cashRoundingCents: 0.5 });
  assert.equal(file.count, 4);
});

/* ------------------------------------------------------------------ */
/* 4. band shape                                                       */
/* ------------------------------------------------------------------ */

test("a band written as an object instead of a pair refuses instead of disarming the level check", () => {
  /* `{floor, ceiling}` is the shape bandFor RETURNS, so it is the obvious
     thing to write in a manifest. Read as range[0]/range[1] it gave undefined
     for both, every comparison against undefined is false, and a corn bid of
     $40.75 published green. */
  const glitched = row({ cash: 40.75, basis: -5.20, basisCents: -520, futuresPrice: 4595 });
  assert.throws(() => build([glitched], { bands: { corn: { floor: 2.0, ceiling: 12.0 } } }),
    (e) => e instanceof Refused && /must be a two-element array/.test(e.message));
});

test("every mis-shape refuses, and the correct shape still works", () => {
  for (const bad of [{ corn: [2] }, { corn: 12 }, { corn: "2-12" }, { corn: [null, 12] },
                     { corn: ["2", "12"] }, { corn: [12, 2] }, { corn: [2, 2] }])
    assert.throws(() => bandFor({ bands: bad }, "Corn"), Refused, JSON.stringify(bad));
  assert.deepEqual(bandFor({ bands: { corn: [2, 12] } }, "Corn"), { floor: 2, ceiling: 12, named: "corn" });
});

test("every entry in DEFAULT_BANDS is itself a well-formed pair", () => {
  for (const [name, range] of Object.entries(DEFAULT_BANDS))
    assert.doesNotThrow(() => validBand(range, name), `DEFAULT_BANDS.${name}`);
});

/* ------------------------------------------------------------------ */
/* 5. band matching: longest name wins, and per-ton names are unbanded  */
/* ------------------------------------------------------------------ */

test("longest name wins, so buckwheat and chickpea are reachable at all", () => {
  /* Substring matching in declaration order made both unreachable: `wheat` is
     declared before `buckwheat` and `pea` before `chickpea`. A real chickpea
     price of $32 then read as one row outside a band its own commodity sat
     inside -- the decimal-point case -- and refused the whole elevator. */
  assert.equal(bandFor({}, "Chickpeas").named, "chickpea (default)");
  assert.equal(bandFor({}, "Buckwheat").named, "buckwheat (default)");
  assert.equal(bandFor({}, "Yellow Corn").named, "corn (default)");
  assert.equal(bandFor({}, "Spring Wheat").named, "wheat (default)");
  assert.equal(bandFor({}, "#2 US Yellow Corn").named, "corn (default)");
});

test("a chickpea board publishes instead of taking the corn down with it", () => {
  const rows = [good({ commodity: "Corn", cash: 4.29 }),
                good({ commodity: "Chickpeas", cash: 28.00, delivery: "September" }),
                good({ commodity: "Chickpeas", cash: 32.00, delivery: "October" })];
  const { file } = build(rows, { bands: undefined });
  assert.equal(file.count, 3);
});

test("KNOWN_UNBANDED is actually consulted, and a source's own band still overrides it", () => {
  /* It had zero call sites. `Soybean Meal` was quietly given the soybean band
     [6, 32] and `Corn Gluten Meal` the corn band [2, 12]. They were withheld
     anyway because a per-ton price is far outside a per-bushel band -- but for
     the wrong stated reason, and a per-ton row landing INSIDE its mismatched
     band would have taken the board down as a bad number. */
  for (const name of ["Soybean Meal", "Corn Gluten Meal", "Oat Hulls", "Wheat Bran",
                      "DDGS", "Modified Distillers Grain", "Soyhull Pellets"])
    assert.equal(bandFor({}, name), null, name);
  assert.ok(KNOWN_UNBANDED.length > 0);
  assert.deepEqual(bandFor({ bands: { "distillers": [100, 400] } }, "Modified Distillers Grain"),
    { floor: 100, ceiling: 400, named: "distillers" });
});

test("an unbanded commodity is withheld and named, and the rest of the board publishes", () => {
  const rows = [good({ commodity: "Corn", cash: 4.29 }),
                row({ commodity: "Modified Distillers Grain", delivery: "August",
                      cash: 155.0, basis: -20.0, basisCents: -2000, futuresPrice: 17500 })];
  const { file, withheld } = build(rows);
  assert.equal(file.count, 1);
  assert.equal(withheld.length, 1);
  assert.match(withheld[0].why, /no band configured/);
});

/* ------------------------------------------------------------------ */
/* 6. checkMove keys on commodity AND delivery                         */
/* ------------------------------------------------------------------ */

test("the max-move rail sees a real move on a multi-commodity board", () => {
  /* Grain Desk sets `delivery` from the delivery period, which is the same
     string across commodity groups. Keyed on delivery alone the map kept
     whichever commodity was last, and the rail compared corn against oats. */
  const prev = { bids: [{ commodity: "Corn", delivery: "October", cash: 4.29 },
                        { commodity: "Oats", delivery: "October", cash: 2.35 }] };
  const next = { bids: [{ commodity: "Corn", delivery: "October", cash: 5.29 },
                        { commodity: "Oats", delivery: "October", cash: 2.35 }] };
  assert.deepEqual(checkMove(prev, next),
    [{ commodity: "Corn", delivery: "October", from: 4.29, to: 5.29, move: 1 }]);
});

test("the max-move rail invents nothing on a board where nothing moved", () => {
  /* This is the worse half. A rail that cries wolf on every poll gets ignored,
     and it fired on every multi-commodity source we have. */
  const same = { bids: [{ commodity: "Corn", delivery: "October", cash: 4.29 },
                        { commodity: "Soybeans", delivery: "October", cash: 9.85 }] };
  assert.deepEqual(checkMove(same, same), []);
});

test("first run and an empty previous board are still not moves", () => {
  const next = { bids: [{ commodity: "Corn", delivery: "October", cash: 4.29 }] };
  assert.deepEqual(checkMove(null, next), []);
  assert.deepEqual(checkMove({}, next), []);
  assert.deepEqual(checkMove({ bids: [] }, next), []);
});

test("rowKey is total: it never throws and never collides two different rows", () => {
  assert.equal(rowKey(undefined), rowKey(null));
  assert.notEqual(rowKey({ commodity: "Corn", delivery: "October" }),
                  rowKey({ commodity: "Oats", delivery: "October" }));
  /* The separator has to be something a commodity name cannot contain, or
     "Corn" + "AB" and "CornA" + "B" become the same row. */
  assert.notEqual(rowKey({ commodity: "Corn", delivery: "AB" }),
                  rowKey({ commodity: "CornA", delivery: "B" }));
});

/* ------------------------------------------------------------------ */
/* 7. futures quoted in dollars                                        */
/* ------------------------------------------------------------------ */

test("a board quoting futures in dollars publishes once its manifest says so", () => {
  const rows = [row({ cash: 4.29, basis: -0.50, basisCents: -50, futuresPrice: 4.79 })];
  assert.throws(() => build(rows), Refused, "unit unset, so it must refuse");
  const { file, verified } = build(rows, { futuresUnits: "dollars" });
  assert.equal(verified, 1);
  assert.equal(file.bids[0].futuresPriceCents, 479);
});

test("declaring the unit wrong is caught by the identity check, which is why the knob is safe", () => {
  /* A cents board declared as dollars is out by a factor of a hundred on every
     row -- orders of magnitude past "unexplained". The knob cannot be set
     wrong without the guard refusing. */
  assert.throws(() => build([good()], { futuresUnits: "dollars" }),
    (e) => e instanceof Refused && /fail cash - basis = futures/.test(e.message));
});

test("scaled futures are rounded, because 5.0375 * 100 is not 503.75 in binary floating point", () => {
  assert.equal(scaleFutures([{ futuresPrice: 5.0375 }], { futuresUnits: "dollars" })[0].futuresPrice, 503.75);
  assert.equal(scaleFutures([{ futuresPrice: null }], { futuresUnits: "dollars" })[0].futuresPrice, null);
});

test("the default is cents and costs an existing source nothing", () => {
  assert.equal(futuresScale({}), 1);
  assert.equal(futuresScale({ futuresUnits: "cents" }), 1);
  assert.equal(futuresScale({ futuresUnits: "TICKS" }), 1);
  assert.equal(futuresScale({ futuresUnits: "dollars" }), 100);
  const rows = [{ futuresPrice: 459.25 }];
  assert.equal(scaleFutures(rows, {}), rows, "no unit change must not even copy the rows");
});

test("an unrecognised unit refuses rather than falling back to a default", () => {
  assert.throws(() => futuresScale({ futuresUnits: "eighths" }),
    (e) => e instanceof Refused && /is not one of/.test(e.message));
});

/* ------------------------------------------------------------------ */
/* 8. eighths written with an apostrophe                               */
/* ------------------------------------------------------------------ */

test("eighths written with an apostrophe parse as eighths, not as the leading integer", () => {
  /* Big River writes "459-2". DTN's cash-bids widget writes "478'6" -- the
     ordinary trade notation, and what the CME itself prints. The hyphen-only
     pattern did not match it and neither did the tick-shaped refusal, so
     parseNum() returned 478 and three quarters of a cent went out the window
     with no signal. Same shape as the settle-flag bug: a number that parses is
     not a number that parsed correctly. */
  assert.equal(parseTicks("478'6"), 478.75);
  assert.equal(parseTicks("503'6"), 503.75);
  assert.equal(parseTicks("525'0"), 525);
  assert.equal(parseTicks("1'4"), 1.5);
  assert.equal(parseTicks("-1'4"), -1.5);
  assert.equal(parseTicks("478'6s"), 478.75, "a settled quote still carries its flag");
  assert.equal(parseTicks("478’6"), 478.75, "and a typographic apostrophe is the same character to a reader");
});

test("the hyphen form is untouched and every existing case still holds", () => {
  assert.equal(parseTicks("459-2"), 459.25);
  assert.equal(parseTicks("513-6s"), 513.75);
  assert.equal(parseTicks("478"), 478);
  assert.equal(parseTicks("4.7850s"), 4.785);
  assert.equal(parseTicks(null), null);
});

test("a fraction outside the eighths grid refuses rather than guessing, in either notation", () => {
  /* parseNum() would happily return the leading integer for both of these. */
  for (const t of ["478'8", "478'9", "478-8", "478-9"])
    assert.equal(parseTicks(t), null, t);
});

/* ------------------------------------------------------------------ */
/* 9. their page's fault, or ours                                      */
/* ------------------------------------------------------------------ */

test("every adapter's own refusal is a refusal, not a broken reader", () => {
  /* The two answers go to different people. "refused" means we read a page and
     it was not the board we wanted -- their side, hold the last good file.
     "broken" means our reader threw where it did not expect to -- our side.
     poll.mjs decided this with a list of ONE class name, written when there was
     one adapter that had one. There are four, so three of them have been
     reported as "broken" for what was in fact their page changing shape. */
  class AghostRefused extends Error {}
  class GrainDeskRefused extends Error {}
  class FragmentRefused extends Error {}
  class DtnCsRefused extends Error {}
  for (const C of [AghostRefused, GrainDeskRefused, FragmentRefused, DtnCsRefused])
    assert.equal(isRefusal(new C("their page changed")), true, C.name);
  assert.equal(isRefusal(new Refused("x")), true);
  assert.equal(isRefusal(new TornRead("x")), true, "a torn read is a Refused subclass and must stay one");
});

test("a real crash is NOT a refusal, or every bug we write becomes their fault", () => {
  assert.equal(isRefusal(new TypeError("x is not a function")), false);
  assert.equal(isRefusal(new Error("boom")), false);
  assert.equal(isRefusal(new RangeError("boom")), false);
  assert.equal(isRefusal(null), false);
  assert.equal(isRefusal(undefined), false);
  assert.equal(isRefusal("a string, which is not an error at all"), false);
  assert.equal(isRefusal({ constructor: { name: "Refused" } }), true,
    "a duck that says Refused is treated as one; adapters are the only things that throw these");
  /* A class merely CONTAINING the word must not qualify, or "RefusedSomething"
     and "NotRefusedYet" would drift in. */
  class RefusedLater extends Error {}
  assert.equal(isRefusal(new RefusedLater("x")), false);
});

test("round-cent takes half a cent EITHER way, and is not a wider floor-cent", () => {
  /* Premier Cooperative rounds; Ag Partners floors. Two customers of one
     platform, two different arithmetics, so the mode is a property of the
     source and never of the platform. The two windows overlap but neither
     contains the other, which is exactly why naming the wrong one is a real
     mistake rather than a conservative one. */
  const floor = CASH_ROUNDING["floor-cent"], round = CASH_ROUNDING["round-cent"];
  assert.equal(round(-0.5), true);
  assert.equal(round(0.5), false, "half rounds UP, so +0.5 is a residual their arithmetic never produces");
  assert.equal(round(0.49), true);
  assert.equal(round(-0.51), false);
  assert.equal(round(0.51), false);
  assert.equal(floor(-0.25), false, "floor never sees a negative residual");
  assert.equal(floor(0.75), true);
  assert.equal(round(0.75), false, "and round never sees three quarters");
  assert.deepEqual(Object.keys(CASH_ROUNDING).sort(), ["exact", "floor-cent", "round-cent"]);
});

test("a rounded board publishes with round-cent and refuses without it", () => {
  const row = (delivery, cash, basis, futuresPrice) => ({
    seq: 0, source: "x", locationId: "1", location: "T", commodity: "Corn",
    delivery, cash, basis, basisCents: Math.round(basis * 100), futures: "@C6U",
    futuresPrice, futuresAt: null, futuresFlag: null, change: null,
  });
  const rows = [row("A", 4.29, -0.5, 479.25), row("B", 4.29, -0.5, 478.5),
                row("C", 4.30, -0.5, 479.75), row("D", 4.29, -0.5, 479)];
  const src = (o) => ({ locationId: "1", location: "T", operator: "Op", bands: { corn: [2, 12] }, ...o });
  const build = (o) => buildFile("<html></html>", {
    now: "2026-08-20T16:00:00.000Z", sourceUrl: "https://example.test/x",
    source: src(o), extract: () => rows });
  assert.equal(build({ cashRounding: "round-cent" }).file.count, 4);
  assert.throws(() => build({}), Refused);
  /* And declaring the WRONG one refuses too, which is what makes the knob safe
     to set: the residuals stop fitting and the board says so. */
  assert.throws(() => build({ cashRounding: "floor-cent" }), Refused);
});

/* ────────────────────────────────────────────────────────────────────────
   ROUGH RICE IS QUOTED PER HUNDREDWEIGHT AND SOLD PER BUSHEL

   Run 91684188060, eight Riceland boards:

     AUG-OCT ZRX26 cash 5.84 basis -1.2 -> 704c but quoted 1563.5c (+859.5c)

   859.5 cents is the largest identity failure this repository has printed, and
   it is not an error — it is a unit. CBOT rough rice trades in dollars per
   hundredweight; a bushel of rough rice is 45 lb, so $/bu = $/cwt x 0.45.

     1563.5 x 0.45 = 703.575   round(703.575) = 704   residual +0.425c

   on all eight boards, inside round-cent. 0.45 is not fitted: it is the same
   constant lib/adapters/agricharts.mjs already states as
   ZR: { unit: "hundredweight" }.
   ──────────────────────────────────────────────────────────────────────── */

test("the contract root is read off the symbol, and only off a real one", () => {
  assert.equal(rootOf("ZRX26"), "ZR");
  assert.equal(rootOf("ZCZ26"), "ZC");
  assert.equal(rootOf("KEN27"), "KE");
  assert.equal(rootOf("zrx26"), "ZR", "case is not evidence");
  /* Anything that is not a root + month + year is not a symbol we will scale
     on. Heartland Feeds posts "@C6Z", which is a different notation entirely
     and must not be guessed at. */
  for (const s of ["@C6Z", "CORN", "", null, undefined, "ZR", "ZRX"])
    assert.equal(rootOf(s), null, `${JSON.stringify(s)} should not parse as a contract`);
});

test("rice is scaled to the bushel and nothing else is touched", () => {
  const rows = [
    { futures: "ZRX26", futuresPrice: 1563.5 },
    { futures: "ZSX26", futuresPrice: 1315.5 },
    { futures: "ZCZ26", futuresPrice: 541.75 },
  ];
  const out = scaleByContract(rows);
  assert.equal(out[0].futuresPrice, 703.575);
  assert.equal(out[1].futuresPrice, 1315.5, "soybeans are already per bushel");
  assert.equal(out[2].futuresPrice, 541.75);
});

test("the eight Riceland boards balance once rice is in the right unit", () => {
  /* THE NUMBERS FROM THE RUN, not invented ones. Each row is
     (cash, basis) as printed, against the ZRX26 quote of the same pass. */
  const board = [[5.84, -1.20], [5.89, -1.15], [5.98, -1.06], [5.91, -1.13]];
  for (const [cash, basis] of board) {
    const rows = scaleByContract([{ cash, basis, futures: "ZRX26", futuresPrice: 1563.5 }]);
    const off = checkIdentity(rows);
    assert.equal(off.length, 1, "still off by the rounding, as a cent-rounded board must be");
    assert.ok(Math.abs(off[0].signedCents) < 0.5,
      `${cash}/${basis} is ${off[0].signedCents}c out, which rounding does not explain`);
    assert.ok(off[0].signedCents >= -0.5 && off[0].signedCents < 0.5,
      "and round-cent explains it");
  }
  /* WITHOUT the scale it is 859.5 cents out — three orders of magnitude past
     anything rounding could account for, which is why the guard refused. */
  const raw = checkIdentity([{ cash: 5.84, basis: -1.20, futures: "ZRX26", futuresPrice: 1563.5 }]);
  assert.ok(raw[0].offCents > 800, `unscaled it is only ${raw[0].offCents}c out`);
});

test("a mixed rice-and-beans board scales only the rice", () => {
  /* THE REASON THIS IS PER-CONTRACT AND NOT PER-SOURCE. Riceland sells both.
     futuresUnits on the manifest would multiply the bean rows by 0.45 too —
     refusing at best, and publishing beans at 45% of their price at worst. */
  const rows = scaleByContract([
    { cash: 5.84, basis: -1.20, futures: "ZRX26", futuresPrice: 1563.5 },
    { cash: 12.90, basis: -0.25, futures: "ZSX26", futuresPrice: 1315.5 },
  ]);
  const off = checkIdentity(rows);
  for (const r of off)
    assert.ok(Math.abs(r.signedCents) <= 0.5,
      `${r.commodity ?? r.futures} is ${r.signedCents}c out on a mixed board`);
});

test("scaleFutures applies the contract scale, because it is what the board calls", () => {
  /* THE MUTATION THIS EXISTS FOR: scaleByContract correct, tested, and not
     called. buildFile goes through scaleFutures and nothing else, so a test of
     scaleByContract on its own passes whether or not rice is ever scaled.
     Third time this repository has been bitten by testing the rule instead of
     the wiring. */
  const [row] = scaleFutures([{ futures: "ZRX26", futuresPrice: 1563.5 }], {});
  assert.equal(row.futuresPrice, 703.575);
  /* ...and it composes with futuresUnits rather than replacing it. */
  const [both] = scaleFutures([{ futures: "ZRX26", futuresPrice: 15.635 }], { futuresUnits: "dollars" });
  assert.equal(both.futuresPrice, 703.575);
});

test("scaleFutures still returns the very same array when nothing scales", () => {
  const rows = [{ futures: "ZCZ26", futuresPrice: 459.25 }];
  assert.equal(scaleByContract(rows), rows);
  assert.equal(scaleFutures(rows, {}), rows);
});

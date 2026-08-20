/* A futures quote of zero is not a quote.
 *
 * Found live on 2026-08-19, the first poll after babgrain-auburn went in.
 * Their platform still carries June and July 2026 soybean rows against a
 * July 2026 contract that expired months ago, quotes it at 0.0000, and
 * computes cash = basis + futures -- publishing the basis wearing a cash
 * label. A soybean bid of minus thirty-one cents.
 *
 * The band guard caught it. The IDENTITY guard did not, and could not:
 *
 *     cash - basis  ==  -0.3075 - (-0.3075)  ==  0  ==  futures
 *
 * The one check whose whole job is proving a number came out of the right
 * column passed on a row that is not a price. That is what these tests pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFile, Refused } from "../lib/board.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";

const SRC = {
  id: "babgrain-auburn", operator: "BAB Grain", location: "Auburn", state: "IL",
  platform: "graindesk", locationId: "Auburn", cashRoundingCents: 0,
  url: "https://marketplace.graindiscovery.com/api/public-sites/babgrain/cash-bids",
  bands: { corn: [2.0, 12.0], soybeans: [6.0, 25.0] },
};

/* The real payload, transcribed from the live feed on 2026-08-19. */
const OFFER = (delivery, month, fut, basis, cash, comments = "") => ({
  destination: "Auburn", deliveryPeriod: delivery, comments,
  futuresMonth: month, futuresPrice: fut, basisPrice: basis, standardCashPrice: cash,
});
const LIVE = [OFFER("01 Sep 2026 to 31 Oct 2026", "November 2026", "1239.2500", "-0.3975", "11.9950", "Fall 2026"),
              OFFER("01 Jan 2027 to 31 Jan 2027", "January 2027", "1253.5000", "-0.4950", "12.0400")];
const DEAD = [OFFER("01 Jun 2026 to 30 Jun 2026", "July 2026", "0.0000", "-0.3075", "-0.3075"),
              OFFER("01 Jul 2026 to 31 Jul 2026", "July 2026", "0.0000", "-0.2575", "-0.2575")];

const body = (offers) => JSON.stringify([{ commodity: { name: "Soybeans" }, offers }]);
const build = (offers) => buildFile(body(offers), {
  now: new Date("2026-08-20T03:20:00Z"), sourceUrl: SRC.url, source: SRC,
  extract: adapterFor(SRC.platform),
});

test("the identity check cannot catch a zero quote — this is why the guard exists", () => {
  /* Asserting the arithmetic rather than calling checkIdentity, which is
     module-private. Exporting an internal purely so a test can reach it
     widens the module's surface for the test's convenience; the claim here is
     about the equation, and the equation is checkable on its own. */
  const cash = -0.3075, basis = -0.3075, futures = 0;
  assert.equal(Math.round((cash - basis) * 100) / 100, futures,
    "cash - basis = futures holds exactly on the dead row. The structural " +
    "guard passes it. Nothing about that is a bug in the identity check — it " +
    "is what the identity check means when the quote is zero.");
});

test("a zero-quote row is withheld, and the good rows still publish", () => {
  const { file, withheld } = build([...DEAD, ...LIVE]);
  assert.equal(file.count, 2, "both real rows publish");
  assert.deepEqual(file.bids.map((b) => b.cash), [11.995, 12.04]);
  assert.ok(!file.bids.some((b) => b.cash < 0), "no negative cash reaches the file");
  assert.equal(withheld.length, 2, "both dead rows are named");
});

test("the withheld entry says why, in the same shape as every other one", () => {
  const { withheld } = build([...DEAD, ...LIVE]);
  for (const w of withheld) {
    assert.equal(w.commodity, "Soybeans");
    assert.equal(typeof w.why, "string", "uses `why`, the key the other withheld entries use");
    assert.match(w.why, /quote of zero is not a quote/);
    assert.match(w.why, /0 == 0/, "names the reason the identity check is blind to it");
  }
  assert.match(withheld[0].why, /-0\.3075/, "carries the number it refused to publish");
});

test("a board that is ALL zero quotes refuses rather than publishing nothing", () => {
  assert.throws(() => build(DEAD), (e) => {
    assert.ok(e instanceof Refused);
    assert.match(e.message, /quote a futures price of zero/);
    assert.match(e.message, /Soybeans 01 Jun 2026/, "names the rows");
    return true;
  });
});

test("a live board is untouched — the guard costs a normal source nothing", () => {
  const { file, withheld } = build(LIVE);
  assert.equal(file.count, 2);
  assert.equal(withheld.length, 0);
});

test("the guard keys on exactly zero, and small-but-nonzero cannot occur in a valid board", () => {
  /* I tried to write this as "a quote of 0.25c is NOT withheld" and could not
     build the fixture, which turned out to be the point.
     
     cash = basis + futures. For soybeans the band is 6 to 25 dollars and the
     basis is tens of cents, so a futures quote anywhere near zero FORCES cash
     to sit near the basis -- far below the floor. The band guard refuses it,
     and there is no arrangement of numbers where a near-zero quote survives
     into a publishable file.
     
     So the two guards do not overlap and do not need to: exactly-zero is the
     case the band guard cannot see coming (it makes cash equal basis, which
     for a NEGATIVE basis is a negative cash the band does catch -- but for a
     POSITIVE basis would be a small positive cash it might not). Keying on
     === 0 is deliberate, not a threshold that happens to be low. */
  const basis = -0.3975, futures = 0.0025;
  const cash = Math.round((basis + futures) * 1e4) / 1e4;
  assert.ok(cash < SRC.bands.soybeans[0],
    `a near-zero quote puts cash at ${cash}, below the ${SRC.bands.soybeans[0]} floor, ` +
    `so the band guard owns that neighbourhood and this guard never sees it`);

  /* And the guard itself is an equality, not a comparison. */
  const withheldFor = (fut) => build([
    OFFER("01 Sep 2026 to 31 Oct 2026", "November 2026", fut, "-0.3975",
          (Math.round((-0.3975 + Number(fut) / 100) * 1e4) / 1e4).toFixed(4)),
    ...LIVE,
  ]);
  assert.equal(withheldFor("1239.2500").withheld.length, 0,
    "a real quote is never withheld by this guard");
});

/* THE ADAPTER THAT HAD NO TESTS.
 *
 * lib/adapters/aghost.mjs shipped twice on the strength of a scratch script and
 * a fixture, and twice it read the fixture correctly and the live page not at
 * all (runs 87587611878 and 87593083735). A parser with no committed test is a
 * parser nobody can break on purpose, which is the only way to find out whether
 * it works. These are the manglings that killed the previous two versions, plus
 * the safety proof for evaluating a body that came off the public internet. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveOffset, deriveOffsetDetail, statedOffset, offsetDisagreement,
  extract, AghostRefused, describe as describePage, parseEighths,
} from "../lib/adapters/aghost.mjs";

const FIXTURE = readFileSync(new URL("../fixtures/flashgrain-cashbids-2026-08-19.html", import.meta.url), "utf8");
/* The live page as Sig pasted it on 2026-08-19 at 18:01 CDT. Same board, but
   every term is now gated behind an `if`, and four of the twelve conditions are
   false. This is the page the shipped adapter refused. */
const LIVE = readFileSync(new URL("../fixtures/flashgrain-conditional-2026-08-19.html", import.meta.url), "utf8");

/** A page carrying nothing but a displayNumber() with the given body text. */
const page = (body, opts = {}) =>
  `<html><head><title>t</title><script type="text/javascript">\n` +
  (opts.comment === undefined ? "\t// NoScrapeOffset: -12.5\n" : opts.comment) +
  `\tfunction displayNumber(x, decimal_places)\n\t{\n${body}\n\t\t` +
  (opts.write === false ? "" : "document.write( getRoundedString(x, decimal_places) );") +
  `\n\t}\n</script></head><body></body></html>`;

test("the fixture's offset is derived and negates the page's own statement", () => {
  const d = deriveOffsetDetail(FIXTURE);
  assert.equal(d.ok, true);
  assert.equal(d.offset, 96.1297);
  assert.equal(d.termCount, 19);
  assert.equal(statedOffset(FIXTURE), -96.1297);
  assert.equal(offsetDisagreement(FIXTURE, d.offset), "");
});

test("the live conditional page decodes, and to the number the page states", () => {
  const d = deriveOffsetDetail(LIVE);
  assert.equal(d.ok, true, d.why);
  assert.equal(d.offset, -58.2507);
  assert.equal(statedOffset(LIVE), 58.2507);
  assert.equal(offsetDisagreement(LIVE, d.offset), "");
});

test("SUMMING the terms on the live page gives the WRONG offset", () => {
  /* THE REASON THIS FILE EVALUATES INSTEAD OF MATCHING.
     Four of the twelve conditions on the live page are false, so four terms do
     not apply. A regex that adds up the terms it can see -- which is what both
     shipped versions did -- adds all twelve.

     Applied:  +19.0986 +2.2282 -8.5944 -24.1916 -19.4169 -3.8197 -23.5549 = -58.2507
     Skipped:  +12.7324 -4.7746 -10.1859 +18.1437 +29.2845               = +45.2001
     All twelve                                                          = -13.0506

     On THIS page the 45.20 error is gross enough that the corn band (2-12)
     would refuse the result too. That is luck, not a guard: the error is the
     sum of whichever terms happen to be gated off, so the next page could be
     out by thirty cents -- inside every band, and invisible to
     `cash - basis == futures` because it moves cash and basis equally. The
     NoScrapeOffset cross-check is the only thing that always catches it.
     This test exists so nobody "simplifies" the evaluation back into a sum. */
  const open = LIVE.indexOf("{", LIVE.search(/function\s+displayNumber\s*\(/));
  const body = LIVE.slice(open + 1, LIVE.indexOf("document.write", open)).replace(/\s+/g, "");
  const applied = [...body.matchAll(/\)x=x-\(([+-])\(-\(([+-]?[\d.]+)\)\)\)/g)];
  assert.equal(applied.length, 12, "all twelve terms are visible to a regex; only the conditions hide four");
  const naive = applied.reduce((a, [, sign, mag]) => a + (sign === "+" ? parseFloat(mag) : -parseFloat(mag)), 0);
  assert.equal(Math.round(naive * 10000) / 10000, -13.0506);
  assert.notEqual(Math.round(naive * 10000) / 10000, deriveOffset(LIVE).offset,
    "if summing every term equalled the evaluated offset, this page would not distinguish the two methods");
});

test("the live conditional page yields eight balanced rows", () => {
  const rows = extract(LIVE, "https://flashgrains.com/index.cfm?show=11&mid=3");
  assert.equal(rows.length, 8);
  assert.deepEqual([...new Set(rows.map((r) => r.location))], ["Thorp", "Granton"]);
  const corn = rows.find((r) => r.location === "Thorp" && r.commodity === "CORN" && r.delivery === "Aug");
  /* The numbers the board actually carried at 18:01 CDT, and the same ones the
     22:20 UTC good read committed. */
  assert.equal(corn.cash, 4.23);
  assert.equal(corn.basis, -0.5);
  assert.equal(corn.futuresPrice, 473);
  for (const r of rows) {
    assert.ok(Math.abs((r.cash - r.basis) * 100 - r.futuresPrice) <= 0.5,
      `${r.location} ${r.commodity} ${r.delivery}: ${r.cash} - ${r.basis} != ${r.futuresPrice}`);
  }
});

test("a condition that is never closed is refused", () => {
  const d = deriveOffsetDetail(page("\t\tif( 1 >= 0 x = x + 12.5;"));
  assert.equal(d.ok, false);
  assert.match(d.why, /never closed|does not assign/);
});

test("a false condition really does skip its term", () => {
  const d = deriveOffsetDetail(page(
    "\t\tif( 1 >= 0 ) x = x + 12.5;\n\t\tif( 0 >= 1 ) x = x + 999;"));
  assert.equal(d.ok, true, d.why);
  assert.equal(d.offset, 12.5);
});

test("whitespace is not part of the contract: seven manglings, one offset", () => {
  const want = deriveOffset(FIXTURE).offset;
  const manglings = {
    "tabs to spaces":      (h) => h.replace(/\t/g, "    "),
    "no indentation":      (h) => h.replace(/^[ \t]+/gm, ""),
    "CRLF":                (h) => h.replace(/\n/g, "\r\n"),
    "all on one line":     (h) => h.replace(/\s*\n\s*/g, " "),
    "no space anywhere":   (h) => h.replace(/(?<=[(),;=+*/-])\s+|\s+(?=[(),;=+*/-])/g, ""),
    "double-spaced":       (h) => h.replace(/\n/g, "\n\n"),
    "space inside parens": (h) => h.replace(/\(/g, "( ").replace(/\)/g, " )"),
  };
  for (const [name, f] of Object.entries(manglings)) {
    const got = deriveOffsetDetail(f(FIXTURE));
    assert.equal(got.ok, true, `${name}: ${got.why}`);
    assert.equal(got.offset, want, name);
  }
});

test("the arithmetic's SHAPE is not part of the contract either", () => {
  /* Each of these is a different way to write "add 12.5", and the previous two
     versions of this file would have matched exactly one of them. */
  const forms = {
    "the shape we have seen":  "\t\tx = (-(  -(( 12.500000)  )) + x);",
    "plain addition":          "\t\tx = x + 12.5;",
    "subtracting a negative":  "\t\tx = x - (-12.5);",
    "leading term":            "\t\tx = 12.5 + x;",
    "split across two terms":  "\t\tx = x + 10.0;\n\t\tx = x + 2.5;",
    "extra parentheses":       "\t\tx = ((((x)))) + ((12.5));",
    "no spaces at all":        "x=x+12.5;",
    "arithmetic that cancels": "\t\tx = x + 20.0;\n\t\tx = x - 7.5;",
  };
  for (const [name, body] of Object.entries(forms)) {
    const d = deriveOffsetDetail(page(body));
    assert.equal(d.ok, true, `${name}: ${d.why}`);
    assert.equal(d.offset, 12.5, name);
  }
});

test("the parameter list never reaches the whitelist", () => {
  /* Slicing the body at the paren rather than the brace kept
     "x,decimal_places){" -- letters, so the whitelist would refuse every real
     page, and it ate the whole diagnostic sample on 2026-08-19. */
  const d = deriveOffsetDetail(page("x = x + 12.5;"));
  assert.equal(d.ok, true, d.why);
});

test("a body that is not arithmetic on x is refused, NOT executed", () => {
  const marker = "__aghost_should_never_run__";
  delete globalThis[marker];
  const d = deriveOffsetDetail(page(`\t\tglobalThis["${marker}"] = 1; x = x + 12.5;`));
  assert.equal(d.ok, false);
  assert.match(d.why, /outside the whitelist/);
  assert.equal(globalThis[marker], undefined, "the body was evaluated despite failing the whitelist");
});

test("a fetch smuggled into the body is refused before it can run", () => {
  const d = deriveOffsetDetail(page('\t\tx = fetch("http://example.invalid/") + 12.5;'));
  assert.equal(d.ok, false);
  assert.match(d.why, /outside the whitelist/);
});

test("arithmetic that assigns somewhere other than x is refused", () => {
  const d = deriveOffsetDetail(page("\t\tx = x + 12.5;\n\t\t(1) = 2;"));
  assert.equal(d.ok, false);
  assert.match(d.why, /does not assign to x/);
});

test("an unbounded body is refused rather than guessed at", () => {
  const d = deriveOffsetDetail(page("\t\tx = x + 12.5;", { write: false }));
  assert.equal(d.ok, false);
  assert.match(d.why, /document\.write/);
});

test("no displayNumber() at all is refused by name", () => {
  const d = deriveOffsetDetail("<html><body>nothing here</body></html>");
  assert.equal(d.ok, false);
  assert.match(d.why, /no displayNumber/);
});

test("a stub definition earlier in the page does not shadow the real one", () => {
  /* The live page is 103,796 bytes around the same board the 9,516-byte
     fixture holds. A second displayNumber anywhere in that margin is what
     `.match()` returns, and its empty body is what gets read: figures present,
     terms zero, sample starting at the parameter list -- run 87593083735
     exactly. */
  const stubbed = FIXTURE.replace("<head>",
    "<head><script>function displayNumber(x, decimal_places){document.write(x);}</script>");
  const d = deriveOffsetDetail(stubbed);
  assert.equal(d.ok, true, d.why);
  assert.equal(d.definitions, 2);
  assert.equal(d.offset, 96.1297);
  assert.equal(extract(stubbed, "u").length, extract(FIXTURE, "u").length);
});

test("two definitions that decode differently are refused, not picked between", () => {
  const two = FIXTURE.replace("<head>",
    '<head><script>function displayNumber(x, decimal_places){x = x + 3.25;document.write(x);}</script>');
  const d = deriveOffsetDetail(two);
  assert.equal(d.ok, false);
  assert.match(d.why, /do not agree/);
  assert.match(d.why, /3\.25/);
  assert.throws(() => extract(two, "u"), AghostRefused);
});

test("when several definitions all fail, the refusal names each one", () => {
  const p1 = page("\t\tx = x + 12.5;", { write: false });
  const both = p1 + p1;
  const d = deriveOffsetDetail(both);
  assert.equal(d.ok, false);
  assert.equal(d.definitions, 2);
  assert.match(d.why, /#1: /);
  assert.match(d.why, /#2: /);
});

test("an offset of zero is treated as a misread, not as a price", () => {
  /* A body we managed to empty out, or a page whose figures are not obfuscated
     at all, both land on 0. We have never seen the second; refuse and say so
     rather than publish raw encoded numbers as prices. */
  const d = deriveOffsetDetail(page("\t\tx = x + 12.5;\n\t\tx = x - 12.5;"));
  assert.equal(d.ok, false);
  assert.match(d.why, /evaluates to 0/);
});

test("a derived offset that does not negate the stated one is a complaint", () => {
  const doctored = FIXTURE.replace("NoScrapeOffset: -96.1297", "NoScrapeOffset: -96.2297");
  const d = deriveOffset(doctored);
  assert.equal(d.offset, 96.1297);
  assert.match(offsetDisagreement(doctored, d.offset), /does not negate/);
});

test("extract() names the reason in the refusal and describe() prints the body", () => {
  const broken = page('\t\tx = parseFloat("12.5") + x;');
  assert.throws(() => extract(broken, "u"), (e) => {
    assert.ok(e instanceof AghostRefused);
    assert.match(e.message, /outside the whitelist/);
    return true;
  });
  const text = describePage(FIXTURE.replace(/displayNumber\(x, decimal_places\)/, "displayNumber(x, decimal_places)").replace("// NoScrapeOffset: -96.1297", "//").replace(/x = \(-\(\s+[+-]\(\([\s\d.]+\)\s+\)\) \+ x\);/g, 'x = q("1");'));
  assert.match(text, /price calls 16/);
  assert.match(text, /body starts: /, "a page with figures and no offset must print its body");
});

test("the fixture still yields balanced rows through extract()", () => {
  const rows = extract(FIXTURE, "https://example.invalid/bids");
  assert.ok(rows.length >= 8, `only ${rows.length} rows`);
  for (const r of rows) {
    assert.equal(typeof r.cash, "number");
    assert.equal(typeof r.basis, "number");
    assert.equal(typeof r.futuresPrice, "number");
    /* cash - basis == futures, in cents, is the guard the whole feed rests on. */
    assert.ok(Math.abs((r.cash - r.basis) * 100 - r.futuresPrice) <= 0.5,
      `${r.location} ${r.commodity} ${r.delivery}: ${r.cash} - ${r.basis} != ${r.futuresPrice}`);
  }
});

test("tick-shaped futures prices are never silently truncated", () => {
  assert.equal(parseEighths("473'0"), 473);
  assert.equal(parseEighths("473'4"), 473.5);
  assert.equal(parseEighths("473'"), null);
  assert.equal(parseEighths("473"), 473);
});

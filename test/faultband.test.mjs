/* THE BAND ABOVE THE TABLE, AND THE GROUPING THAT MAKES IT A SUMMARY.
 *
 * The 02:11 board had 164 rows needing a look. Nineteen consecutive identical
 * "CHS High Plains / bushel" lines, then thirteen identical CHS Ag Services
 * lines, and so on: 164 rows carrying six facts, in a NOTE column clipped at
 * 52 characters so the end of every reason -- the part that says what to do --
 * was the part cut off.
 *
 * Two earlier groupings were built and both were wrong, which is why these
 * tests are written against the shape of the OUTPUT and not against a key:
 *
 *   by operator  -> one CHS outage became eighteen lines
 *   by message   -> eight boards failing `cash - basis = futures` by the same
 *                   quarter cent on the same contract became six lines,
 *                   because each message quotes its own numbers
 */
import test from "node:test";
import assert from "node:assert/strict";
import { faultGroups, faultKind, render, cronsOf } from "../scripts/status.mjs";
import { stateOf } from "../lib/freshness.mjs";

const NOW = Date.parse("2026-09-02T02:57:00.000Z");
const at = (h) => new Date(NOW - h * 3.6e6).toISOString();
const src = (id, operator, platform, health, error, h = 7) =>
  ({ id, operator, location: id, usState: "MN", platform, health, status: health,
     error, checkedAt: at(h), pricedAt: at(h), rows: 11 });
const ui = (list) => list.map((s) => ({ ...s, ui: stateOf(s, NOW) }));

test("one outage across many operators is one line, not one line per operator", () => {
  const same = "not attempted: 3 page loads in a row returned nothing on bushel, so the rest "
             + "of that platform was left for the next pass. Its last good file is untouched.";
  const rows = ui([
    src("a", "CHS Ag Services", "bushel", "skipped", same),
    src("b", "CHS High Plains", "bushel", "skipped", same),
    src("c", "CHS Herman", "bushel", "skipped", same),
    src("d", "Michigan Agricultural Commodities", "bushel", "skipped", same),
  ]);
  const g = faultGroups(rows, NOW);
  assert.equal(g.length, 1, "four operators, one outage, one line");
  assert.equal(g[0].n, 4);
  assert.equal(g[0].opCount, 4);
  assert.equal(g[0].who, "CHS Ag Services, CHS Herman +2 more",
    "at most two names, then a count — twenty-two names is a paragraph");
});

test("the same fault with different numbers in it is still one line", () => {
  /* The real case: eight DTN boards, three operators, every one out by exactly
     -0.25c on @C6Z because the futures cell was a tick behind. One finding. */
  const rows = ui([
    src("a", "Keystone Cooperative", "dtn-cs", "refused",
      "5 of 8 testable row(s) fail cash - basis = futures: October '26 @C6Z cash 5.01 basis -0.4 -> 541c but quoted 540.75c (-0.25c)"),
    src("b", "Niewohner Farms", "dtn-cs", "refused",
      "3 of 6 testable row(s) fail cash - basis = futures: September 26 @C6Z cash 5.06 basis -0.35 -> 541c but quoted 540.75c (-0.25c)"),
    src("c", "Heartland Feeds", "dtn-cs", "refused",
      "2 of 2 testable row(s) fail cash - basis = futures: New crop 2026 @C6Z cash 4.91 basis -0.5 -> 541c but quoted 540.75c (-0.25c)"),
  ]);
  const g = faultGroups(rows, NOW);
  assert.equal(g.length, 1, "one kind of failure, whatever numbers it quotes");
  assert.equal(g[0].kind, "rows fail cash - basis = futures");
});

test("two genuinely different faults on one platform stay two lines", () => {
  /* The grouping must not be so eager that it hides a second problem. Bushel
     had both a real outage and a skip on the same board and they are not the
     same thing to act on. */
  const rows = ui([
    src("a", "CHS Ag Services", "bushel", "broken",
      "no readable response matching https://api.bushelpowered.com/api/markets/x within 45000ms. The page did make 0 request(s): []"),
    src("b", "CHS Big Sky", "bushel", "skipped",
      "not attempted: 3 page loads in a row returned nothing on bushel, so the rest of that platform was left for the next pass."),
  ]);
  assert.equal(faultGroups(rows, NOW).length, 2);
});

test("the same fault on two platforms stays two lines", () => {
  const why = "no readable response matching https://api.x.com/a within 45000ms. The page did make 0 request(s): []";
  const rows = ui([src("a", "A", "bushel", "broken", why), src("b", "B", "dtn-cs", "broken", why)]);
  assert.equal(faultGroups(rows, NOW).length, 2, "one platform down is not the other platform down");
});

test("faultKind never returns a bare label with no reason in it", () => {
  /* Cutting at the first colon turned "skipped: bushel returned an empty page
     three times" into the word "skipped" -- which is the state the row already
     shows, and says nothing about why. */
  for (const m of [
    "skipped: bushel returned an empty page 3 times in a row this pass, so the rest was not attempted.",
    "refused: the page was not the board we wanted at all",
    "broken: the site did not answer",
  ]) {
    const k = faultKind(m);
    assert.ok(k.length > 20, `"${k}" is a label, not a reason`);
    assert.ok(/\s/.test(k.replace(/^\w+:\s*/, "")), `"${k}" carries nothing after the label`);
  }
});

test("live sources are never in the band, and an all-live board has no band", () => {
  const rows = ui([src("a", "Fine Co", "bushel", "live", null, 0.5)]);
  assert.equal(faultGroups(rows, NOW).length, 0);
  const html = render({ generated: at(0.05), counts: {}, sources: [src("a", "Fine Co", "bushel", "live", null, 0.05)] },
                      NOW, cronsOf('    - cron: "0,30 * * * *"'));
  assert.doesNotMatch(html, /class="faults"/, "nothing wrong, nothing to show");
  assert.match(html, /ALL 1 LIVE/);
});

test("down sorts above late, and the biggest fault first within each", () => {
  const rows = ui([
    src("small-late", "A", "bushel", "refused", "rows fail cash - basis = futures: x", 7),
    src("big-late-1", "B", "dtn-cs", "refused", "no readable response matching https://api.b.com/y within 45000ms", 7),
    src("big-late-2", "C", "dtn-cs", "refused", "no readable response matching https://api.b.com/y within 45000ms", 7),
    src("dead", "D", "graindesk", "broken", "rows at Chase quote a futures price of zero and nothing can be checked", 40),
  ]);
  const g = faultGroups(rows, NOW);
  assert.equal(g[0].ui, "down", "past the withdrawal window comes first");
  assert.equal(g[1].n, 2, "then the widest of what is merely late");
  assert.equal(g[2].n, 1);
});

test("the band renders into the page, above the table, with the reason on a title", () => {
  const why = "not attempted: 3 page loads in a row returned nothing on bushel, so the rest of "
            + "that platform was left for the next pass. Its last good file is untouched.";
  const index = { generated: at(0.4), counts: {},
                  sources: [src("a", "CHS Ag Services", "bushel", "skipped", why, 7),
                            src("b", "CHS Herman", "bushel", "skipped", why, 7)] };
  const html = render(index, NOW, cronsOf('    - cron: "0,30 * * * *"'));
  assert.match(html, /class="faults"/);
  assert.equal((html.match(/<div class="f f-/g) || []).length, 1, "two rows, one fault, one line");
  assert.ok(html.indexOf('class="faults"') < html.indexOf("<table"), "the summary comes before the detail");
  /* The full sentence must be reachable even though the line is clamped. */
  assert.ok(html.includes(`title="${why.replace(/&/g, "&amp;")}"`), "the whole reason is on a title=");
});

test("every clipped column in the table carries its full text on a title", () => {
  /* Fixed layout means these WILL be ellipsised; an ellipsis with nothing
     behind it destroys the fact rather than folding it. */
  const long = "CHS River Terminals & Processing Plants";
  const index = { generated: at(0.4), counts: {},
                  sources: [{ ...src("a", long, "bushel", "broken", "a long reason ".repeat(20), 7),
                              commodities: ["Corn", "Soybeans", "Wheat", "Sorghum"], phone: "(555) 555-5555" }] };
  const html = render(index, NOW, []);
  for (const cls of ["op", "lo", "cm", "pf", "ct", "no"])
    assert.match(html, new RegExp(`<td class="${cls}[^"]*" title="`), `td.${cls} must carry a title`);
  assert.match(html, /title="CHS River Terminals &amp; Processing Plants"/);
});

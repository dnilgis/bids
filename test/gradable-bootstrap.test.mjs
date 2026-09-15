/* THE CEILING THAT WAS RAISED WAS NOT THE CEILING THAT CUT.
 *
 * 2026-09-15T02:04. discover asked adm.gradable.com/market with
 * `--dump bootstrap --dump-max 1000000`, the ceiling having been made sayable
 * the night before for exactly this run, and the log said:
 *
 *     200 application/json 400000B (TRUNCATED at the cap)
 *       https://adm.gradable.com/api/commodities/merchandising/bootstrap
 *
 * There are two ceilings and they are in different files. `--dump-max` decides
 * how many bytes scripts/discover.mjs will PRINT. `maxBodyBytes` in
 * lib/cdp.mjs decides how many bytes the browser hands over at all, and it
 * defaults to 400,000. The second one cut the body before the first one was
 * ever consulted. Raising one and calling the job done is the shape of mistake
 * this file exists to make impossible to repeat.
 *
 * So: the number a person types must reach the capture, and the capture must
 * refuse to write a body that was cut. Both are asserted here against the
 * files that ship, not against a copy.
 *
 *     node --test test/gradable-bootstrap.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  PARTNERS, BOOTSTRAP_PATH, pageUrlFor, fixturePathFor,
  isBootstrapResponse, intentOf, marketCount, refusalFor, maxBodyFrom,
} from "../scripts/gradable_bootstrap.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const wf = readFileSync(join(ROOT, ".github/workflows/gradable-bootstrap.yml"), "utf8");
const script = readFileSync(join(ROOT, "scripts/gradable_bootstrap.mjs"), "utf8");

const body = (over = {}) => `while(1);${JSON.stringify({
  intent: "adm",
  markets: [{ id: 371713182, display_name: "Abilene, KS", address: {}, url_paths: [] },
            { id: 331847432, display_name: "Altamont, IL", address: {}, url_paths: [] }],
  ...over,
})}`;

test("THE CEILING A PERSON TYPES REACHES THE CAPTURE, not just the printer", () => {
  /* The form takes it... */
  assert.match(wf, /max_body:/, "the workflow offers no ceiling to raise");
  /* ...the step reads it... */
  assert.match(wf, /MAX_BODY:\s*\$\{\{\s*inputs\.max_body\s*\}\}/,
    "max_body never reaches the step's environment");
  /* ...and hands it to the script under the name the script parses. */
  assert.match(wf, /--max-body\s+\$MAX_BODY/,
    "the step never passes --max-body; the number would be typed and dropped");
  /* And the script hands THAT to captureAll's own parameter, which is the one
     that did the cutting. A script that parsed --max-body and never passed it
     on would satisfy every line above. */
  assert.match(script, /maxBodyBytes,/,
    "the script never passes maxBodyBytes to captureAll -- the 400,000 default would still cut");
  assert.match(script, /maxBodyFrom\(flag\("max-body"\)\)/,
    "the script does not derive the ceiling from --max-body");
});

test("the default ceiling is past ADM, not past POET", () => {
  /* POET measured 202,283 bytes for 36 markets on 2026-09-07 = 5,619 each.
     ADM's truncated capture reached "Maidstone, ON" at 400,000 bytes. */
  const perMarket = 202283 / 36;
  assert.ok(maxBodyFrom("") > 400000, "the default is not above the ceiling that cut");
  assert.ok(maxBodyFrom("") / perMarket > 150,
    `the default holds only ${Math.round(maxBodyFrom("") / perMarket)} markets`);
});

test("A TRUNCATED BODY IS REFUSED ON THE FLAG, not on failing to parse", () => {
  /* Today a cut body is also invalid JSON, so a script with no truncation check
     would pass a test that fed it cut bytes. This feeds it bytes that parse
     perfectly AND carry the flag: only a script that reads the flag refuses. */
  const r = refusalFor({ rec: { url: "u", body: body(), truncated: true }, partner: "adm" });
  assert.ok(r, "a body flagged truncated was accepted");
  assert.match(r, /TRUNCATED/);
  assert.match(r, /--max-body/, "the refusal does not say how to fix it");
});

test("the same bytes without the flag are written", () => {
  assert.equal(refusalFor({ rec: { url: "u", body: body(), truncated: false }, partner: "adm" }), null);
});

test("ONE PARTNER'S MARKETS ARE NEVER WRITTEN INTO ANOTHER'S FILE", () => {
  const r = refusalFor({ rec: { url: "u", body: body() }, partner: "poet" });
  assert.ok(r && /intent/.test(r), r);
  /* And the two files are genuinely different paths. */
  assert.notEqual(fixturePathFor("adm"), fixturePathFor("poet"));
});

test("a fixture never shrinks without somebody saying so", () => {
  assert.ok(refusalFor({ rec: { url: "u", body: body() }, partner: "adm", existingCount: 140 }),
    "a capture of 2 markets was allowed to replace a fixture of 140");
  assert.equal(refusalFor({ rec: { url: "u", body: body() }, partner: "adm",
                            existingCount: 140, allowShrink: true }), null);
  assert.match(wf, /allow_shrink:/, "the workflow offers no way to say so");
  assert.match(wf, /--allow-shrink/, "the workflow never passes it");
});

test("the bootstrap is matched on origin and path, never on a substring", () => {
  assert.ok(isBootstrapResponse(`https://adm.gradable.com${BOOTSTRAP_PATH}`, "adm"));
  assert.ok(isBootstrapResponse(`https://adm.gradable.com${BOOTSTRAP_PATH}?v=2`, "adm"));
  assert.ok(!isBootstrapResponse(`https://poet.gradable.com${BOOTSTRAP_PATH}`, "adm"),
    "POET's body would be written into ADM's file");
  assert.ok(!isBootstrapResponse(`https://evil.example.com/adm.gradable.com${BOOTSTRAP_PATH}`, "adm"),
    "a path that merely CONTAINS the host was accepted");
  assert.ok(!isBootstrapResponse("https://adm.gradable.com/static/css/bootstrap.css", "adm"));
  assert.ok(!isBootstrapResponse(`http://adm.gradable.com${BOOTSTRAP_PATH}`, "adm"),
    "an unencrypted wire was accepted");
  /* THE TWO THAT SURVIVE A SUBSTRING CHECK. Swapping the hostname equality for
     `href.includes(partner + ".gradable.com")` leaves every case above green,
     because the PATH check catches them anyway. These two it does not: both
     carry the exact bootstrap path and mention the host somewhere harmless. */
  assert.ok(!isBootstrapResponse(`https://adm.gradable.com.evil.example${BOOTSTRAP_PATH}`, "adm"),
    "a host with the partner's name as a PREFIX was accepted");
  assert.ok(!isBootstrapResponse(`https://evil.example${BOOTSTRAP_PATH}?from=adm.gradable.com`, "adm"),
    "a query string mentioning the host was enough to be accepted");
});

test("THE PARTNER IS A MENU IN BOTH PLACES, and the two menus agree", () => {
  /* The input reaches a filename. A dropdown option the script has never heard
     of is an option that gets as far as building a path. */
  const block = /options:\s*((?:\s*-\s*[a-z0-9_-]+\n)+)/.exec(wf);
  assert.ok(block, "the workflow's partner input is not a dropdown");
  const offered = block[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  assert.ok(offered.length > 0);
  for (const p of offered)
    assert.ok(PARTNERS.includes(p), `the form offers ${JSON.stringify(p)} and the script's menu does not have it`);
  for (const p of PARTNERS)
    assert.match(p, /^[a-z]+$/, `${JSON.stringify(p)} is not a bare slug and reaches a filename`);
});

test("the page it loads is the partner's own market page", () => {
  assert.equal(pageUrlFor("adm"), "https://adm.gradable.com/market");
  assert.equal(pageUrlFor("poet"), "https://poet.gradable.com/market");
});

test("intentOf and marketCount read the committed POET fixture", () => {
  /* The real bytes, anti-hijack prefix and all. If these two readers ever stop
     agreeing with the adapter, every guard above is checking nothing. */
  const poet = readFileSync(join(ROOT, "fixtures/gradable-poet-bootstrap.json"), "utf8");
  assert.equal(intentOf(poet), "poet");
  assert.equal(marketCount(poet), 36);
  assert.equal(refusalFor({ rec: { url: "u", body: poet, truncated: false }, partner: "poet" }), null);
  /* And that same fixture is refused for ADM. */
  assert.ok(refusalFor({ rec: { url: "u", body: poet }, partner: "adm" }));
});

test("the job writes one path and it is the fixture", () => {
  assert.match(wf, /permissions:\s*\n\s*contents:\s*write/);
  const adds = [...wf.matchAll(/git add ([^\n]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(adds, ['"$FIXTURE"'],
    `this job stages ${JSON.stringify(adds)}; it may stage the fixture and nothing else`);
  /* And $FIXTURE is not a string the form can set: the script writes it, from
     the same fixturePathFor() the write used. A `git add` built out of raw
     form input is a `git add` that can be pointed at `../`. */
  assert.match(script, /FIXTURE=\$\{outRel\}/,
    "the script never exports FIXTURE, so the commit step would stage nothing");
  assert.match(script, /MARKETS=\$\{n\}/,
    "the count in the commit message is not the adapter's own");
  assert.match(wf, /commit-and-push\.sh/, "a push with no rebase-and-retry loses to the poller");
  /* Dry run is the default, so a curious click cannot commit. */
  assert.match(wf, /commit:\n\s*description:[^\n]*\n\s*type: boolean\n\s*default: false/,
    "commit is not a default-off boolean");
});

test("the capture keeps ONE body, not every body", () => {
  /* The market page pulled 78 responses in the run that motivated this. Holding
     all of them at a 1.5 MB ceiling is how a runner dies for no reason. */
  assert.match(script, /keep:\s*\(u\)\s*=>\s*isBootstrapResponse\(u, partner\)/,
    "the capture keeps more than the one response it needs");
});

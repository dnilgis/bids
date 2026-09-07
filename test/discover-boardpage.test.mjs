/* WHICH PAGE GETS ASKED AT ALL.
 *
 * 268 operators in data/platforms.json are filed "no known platform", and every
 * one of those verdicts rests on this: the home page said nothing, so which page
 * was asked next. It lived inside main(), where no test could reach it, and it
 * threw away nine of the eleven conventional paths written down beside it
 * without a word in the log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bidLink, boardPagesToTry, FALLBACK_PATHS, DEFAULT_FOLLOW, verdict, SIGNATURES,
         fingerprint } from "../scripts/discover.mjs";
import { readFileSync, existsSync } from "node:fs";

const page = (html, url = "https://coop.example.com/") =>
  ({ responses: [{ url, mime: "text/html", body: html, status: 200 }] });

/* --- their own link beats our guesses ------------------------------------ */

test("the link the operator publishes is the page that gets asked", () => {
  /* A guessed path 404s silently. A link they wrote is the page they mean. */
  const r = page(`<nav><a href="/grain/cash-bids">Cash Bids</a></nav>`);
  const got = boardPagesToTry(r, "https://coop.example.com/");
  assert.deepEqual(got.pages, ["https://coop.example.com/grain/cash-bids"]);
  assert.equal(got.theirs, true);
  assert.equal(got.skipped, 0, "nothing was skipped — we did not fall back");
});

test("an explicit cash-bids link outranks a bare bids link and a markets link", () => {
  const r = page(`<a href="/markets/">Market Zone</a>
                  <a href="/b">Bids</a>
                  <a href="/cb">Cash Bids</a>`);
  assert.deepEqual(bidLink(r, "https://coop.example.com/", 3),
    ["https://coop.example.com/cb", "https://coop.example.com/b", "https://coop.example.com/markets/"]);
});

test("a cash bids link pointing at somebody else's site is not this operator's board", () => {
  const r = page(`<a href="https://someoneelse.com/cash-bids">Cash Bids</a>`);
  assert.deepEqual(bidLink(r, "https://coop.example.com/"), []);
});

test("www and bare host are the same site", () => {
  const r = page(`<a href="https://www.coop.example.com/cashbids">Cash Bids</a>`);
  assert.deepEqual(bidLink(r, "https://coop.example.com/"),
    ["https://www.coop.example.com/cashbids"]);
});

/* --- the nine paths that were written down and never asked --------------- */

test("the conventional paths are the fallback, and how many were skipped is reported", () => {
  /* MEASURED, 2026-09-07. Across the 268 sites in data/platforms.json filed
     "no-platform", the paths actually tried are /cash-bids/ 180 times,
     /cashbids 172 and /cash-bids 58 — and not one of the other eight in
     FALLBACK_PATHS appears anywhere. `.slice(0, 2)` with no comment on it was
     discarding nine paths on every run, and the log said nothing. */
  const r = page(`<p>no links here at all</p>`);
  const got = boardPagesToTry(r, "https://coop.example.com/");
  assert.equal(got.theirs, false);
  assert.equal(got.pages.length, DEFAULT_FOLLOW);
  assert.equal(got.skipped, FALLBACK_PATHS.length - DEFAULT_FOLLOW);
  assert.ok(got.skipped > 0, "if this is ever zero the log line below is dead code");
  assert.deepEqual(got.pages,
    ["https://coop.example.com/cashbids", "https://coop.example.com/cash-bids/"]);
});

test("--follow asks the rest of them", () => {
  const r = page(`<p>nothing</p>`);
  const all = boardPagesToTry(r, "https://coop.example.com/", FALLBACK_PATHS.length);
  assert.equal(all.pages.length, FALLBACK_PATHS.length);
  assert.equal(all.skipped, 0);
  for (const p of FALLBACK_PATHS)
    assert.ok(all.pages.includes(new URL(p, "https://coop.example.com/").href), `${p} was not asked`);
});

test("the unhyphenated spelling is still asked first", () => {
  /* Assumption Coop publishes a full Barchart board at /cashbids and was
     reported to Sig as an elevator that posts no bids online. */
  assert.equal(FALLBACK_PATHS[0], "/cashbids");
});

test("a page with no anchors falls through rather than throwing", () => {
  assert.deepEqual(bidLink({ responses: [] }, "https://coop.example.com/"), []);
  assert.deepEqual(bidLink({}, "https://coop.example.com/"), []);
  assert.equal(boardPagesToTry({}, "https://coop.example.com/").theirs, false);
});

/* --- a near miss must be reportable ------------------------------------- */

test("aghost can raise a lead, which is the sunriseco-op case", () => {
  /* sunriseco-op.com called api.aghost.net AND charts.aghost.net on 2026-08-28
     and the run reported NO KNOWN PLATFORM with a dtn-cs lead only, because
     verdict() skips any signature with no `family` and aghost had none.
     AgHost is also a co-op website CMS, so this must stay a LEAD and never
     become a classification — a line for a person to accept or dismiss. */
  const v = verdict({ responses: [
    { url: "https://api.aghost.net/style.css", mime: "text/css", status: 200 },
    { url: "https://www.sunriseco-op.com/", mime: "text/html", status: 200 },
  ] }, []);
  assert.equal(v.kind, "no-platform", "a stylesheet is not a board and must not classify");
  assert.ok(v.leads.some((l) => l.platform === "aghost" && l.host === "api.aghost.net"),
    "the vendor was on the page and the log must say so");
});

test("every signature either has a family or its identity is a path, not a host", () => {
  /* A family is tested against a HOST. cashbidssingle is
     bigriverbids.com/cashbidssingle-2121 and fragment is /ajax/ — both are
     paths, so there is no vendor domain to lead on and the absence is correct.
     Anything else missing a family is the aghost oversight repeating. */
  const PATH_IDENTITY = new Set(["cashbidssingle", "fragment"]);
  for (const s of SIGNATURES)
    assert.ok(s.family || PATH_IDENTITY.has(s.platform),
      `${s.platform} has no family, so it can never report a near miss`);
});

/* --- gradable, found 2026-09-07 in discover run 92318597788 -------------- */

test("gradable is named, and the market id comes off the path", () => {
  /* Ten poetgrain.com sites sat as "no known platform" while calling four
     poet.gradable.com endpoints each. A platform without its id names an
     adapter and still cannot produce a source file, so the id is the test. */
  const board = fingerprint(
    "https://poet.gradable.com/api/commodities/v2/merchandising/instruments/market/331845223?offer_type=public");
  assert.equal(board.platform, "gradable");
  assert.equal(board.market, "331845223", "the market id is the one fact a source file needs");
  assert.equal(fingerprint("https://adm.gradable.com/api/commodities/v2/merchandising/instruments/market/371713182?offer_type=public").market,
    "371713182", "ADM answers the same shape on its own subdomain");
});

test("the 202 KB bootstrap is not the same finding as the 6 KB board", () => {
  /* Keeping the endpoint in the identity is what stops four sibling calls on
     one page collapsing to one in dedupe() — the fault bushel and barchart are
     both commented for. The bootstrap is byte-identical on all ten POET sites;
     the board is different on every one. */
  const boot = fingerprint("https://poet.gradable.com/api/commodities/merchandising/bootstrap");
  const board = fingerprint("https://poet.gradable.com/api/commodities/v2/merchandising/instruments/market/331847160?offer_type=public");
  assert.notDeepEqual(boot, board);
  assert.equal(boot.market, null, "the bootstrap belongs to no one market");
});

test("gradable has no adapter, and says so rather than implying one", () => {
  /* Nothing has read a gradable payload. A platform flag claiming an adapter
     that does not exist is what filed 47 finished Bushel feeds under "the
     build queue" on 2026-08-23, and a parser written against a shape nobody
     has seen is the same error pointing the other way. */
  const sig = SIGNATURES.find((s) => s.platform === "gradable");
  assert.equal(sig.adapter, null);
  assert.ok(sig.family.test("poet.gradable.com") && sig.family.test("adm.gradable.com"));
});

test("the gradable probe list holds the pages that found it", () => {
  const txt = readFileSync(new URL("../probe-lists/gradable-sites.txt", import.meta.url), "utf8");
  const urls = txt.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  assert.equal(urls.length, 11, "ten POET plants and ADM");
  for (const u of urls) assert.match(u, /^https?:\/\//);
});

/* --- the Run workflow form ---------------------------------------------- */

test("every list the dropdown offers has a case arm and a file behind it", () => {
  /* A menu entry with no case arm is a run that fails after the checkout, and
     a case arm pointing at a file that is not in the repository is the same
     thing one step later. Both are only findable by pressing the button. */
  const yml = readFileSync(new URL("../.github/workflows/discover.yml", import.meta.url), "utf8");
  const opts = [...yml.matchAll(/^          - ([a-z0-9-]+)\s*(#.*)?$/gm)].map((m) => m[1]);
  assert.ok(opts.length >= 8, `only ${opts.length} option(s) parsed out of the dropdown`);
  const arms = new Map([...yml.matchAll(/^            ([a-z0-9-]+>?\)?)\s*\)?\s+(?:FILE=(\S+)|node )/gm)]
    .map((m) => [m[1].replace(/\)$/, ""), m[2] ?? "(built at run time)"]));
  for (const o of opts) {
    assert.ok(arms.has(o), `the dropdown offers "${o}" and the case statement does not answer it`);
    const file = arms.get(o);
    if (file.startsWith("probe-lists/"))
      assert.ok(existsSync(new URL("../" + file, import.meta.url)),
        `"${o}" points at ${file}, which is not in the repository`);
  }
});

test("no count is written into the form, because that is what went stale", () => {
  /* "national — 487 pages" (it is 475), "sweep-2-wi-mn — 15 still unasked"
     (34), "discover-candidates — the original 56, spent" (109 still owed).
     scripts/list_report.mjs prints the real ones at the top of every run. */
  const yml = readFileSync(new URL("../.github/workflows/discover.yml", import.meta.url), "utf8");
  const listDesc = /^      list:\n        description: "([^"]*)"/m.exec(yml)?.[1];
  assert.ok(listDesc, "the list input has no description");
  /* Narrow on purpose. "Blank = 45" is a DEFAULT and stays true for ever; what
     went stale was a count of what is IN a list, and every one of those lived
     on this input. A default value in another box is not the same thing and is
     not policed here. */
  assert.ok(!/\d/.test(listDesc),
    `the list input carries a number, and a number typed into a form is a number nobody updates: "${listDesc}"`);
  for (const name of ["national", "sweep-2-wi-mn", "discover-candidates", "gd-candidates"])
    assert.ok(!new RegExp(`${name}[^"]*\\d`).test(listDesc), `${name} has a count beside it again`);
  assert.match(yml, /node scripts\/list_report\.mjs/,
    "the counts have to be printed somewhere if they are not in the form");
});

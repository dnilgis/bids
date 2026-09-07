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
import { bidLink, boardPagesToTry, FALLBACK_PATHS, DEFAULT_FOLLOW, verdict, SIGNATURES }
  from "../scripts/discover.mjs";

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

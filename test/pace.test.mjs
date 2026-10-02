/* PLATFORM_PACE and captureFetched, both added 2026-10-02 for Landus. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pacedIn, paceOf, PLATFORM_PACE, captureOf } from "../lib/sources.mjs";
import { captureFetched } from "../lib/cdp.mjs";

const src = (id, platform = "landus") => ({ id, platform });

test("a paced platform asks its least-recently-asked first: never asked, then oldest; ties by id", () => {
  const all = [src("l-a"), src("l-b"), src("l-c"), src("l-d"), src("x-1", "dtn-cs")];
  const seen = new Map([["l-a", 300], ["l-b", 100], ["l-d", 200]]);
  const got = pacedIn(all, seen, { landus: { perPass: 2 } });
  assert.deepEqual([...got].sort(), ["l-b", "l-c"], "l-c never asked, then l-b the oldest");
  assert.ok(!got.has("x-1"), "an unpaced platform is not in the set; it is not paced at all");
});

test("over a full rotation every location is asked once before any is asked twice", () => {
  const all = Array.from({ length: 12 }, (_, i) => src(`l-${String(i).padStart(2, "0")}`));
  const seen = new Map();
  const asked = [];
  for (let pass = 1; pass <= 3; pass++) {
    const ids = [...pacedIn(all, seen, { landus: { perPass: 4 } })];
    for (const id of ids) seen.set(id, pass);
    asked.push(...ids);
  }
  assert.equal(new Set(asked).size, 12);
});

test("Landus is paced at five a pass and read with the in-page fetch", () => {
  assert.deepEqual(PLATFORM_PACE.landus, { perPass: 5 });
  assert.equal(paceOf("dtn-cs"), null);
  assert.equal(captureOf("landus"), "fetched");
});

test("captureFetched will not fetch across origins: their page makes same-origin requests only", async () => {
  await assert.rejects(
    captureFetched({ pageUrl: "https://www.landus.ag/businesses/grain/grain-bids", target: "https://evil.example/api" }),
    /different origins/);
});

import { acceptOf } from "../lib/sources.mjs";
import { readFileSync as rf } from "node:fs";
test("NEW Coop: a response is the board only when it carries the location headings (2026-10-02)", () => {
  const accept = acceptOf("newcoop");
  assert.equal(accept(rf(new URL("../fixtures/newcoop-cashbids-2026-10-02.html", import.meta.url), "utf8")), true);
  assert.equal(accept("<html><head><title>Just a moment...</title></head><body></body></html>"), false);
  assert.equal(acceptOf("dtn-cs"), null);
  /* and poll hands it to capture() */
  const poll = rf(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(poll, /capture\(\{ pageUrl: s\.browserPage, target: s\.url, timeoutMs: browserMs, accept: acceptOf\(s\.platform\) \}\)/);
});

import { extract as dtnExtract, DtnCsEmpty, DtnCsRefused } from "../lib/adapters/dtn-cs.mjs";
import { isRefusal } from "../lib/board.mjs";
test("an empty DTN board is still refused, and says it is empty so the poll can count it apart (2026-10-02)", () => {
  let err = null;
  try { dtnExtract("[]", "https://api.dtn.com/markets/sites/e0013301/cash-bids?units=us"); } catch (e) { err = e; }
  assert.ok(err instanceof DtnCsEmpty && err instanceof DtnCsRefused);
  assert.equal(err.empty, true);
  /* and the poll must classify it REFUSED, which it decides by name */
  assert.equal(isRefusal(err), true, "an empty board was classified broken: isRefusal() reads the class name");
  let other = null;
  try { dtnExtract("not json", "u"); } catch (e) { other = e; }
  assert.ok(other instanceof DtnCsRefused);
  assert.notEqual(other.empty, true, "a malformed body is a refusal, not an empty board");
  const poll = rf(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(poll, /if \(e\?\.empty === true\) r\.emptyBoard = true;/);
  assert.match(poll, /emptyBoard: results\.filter\(\(r\) => r\.health === "refused" && r\.emptyBoard\)\.length/,
    "only refused results count as empty boards, or the summary goes negative");
  assert.match(poll, /posting nothing/);
});

test("a Cloudflare challenge in front of a browser board is a skip, never an attempt to get past it", () => {
  const poll = rf(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  const i = poll.indexOf("A BOT CHECK IS THE SITE SAYING NO");
  assert.ok(i > 0);
  const block = poll.slice(i, i + 1200);
  assert.ok(block.includes("challenge-platform|challenges"), "the challenge hosts are what it looks for");
  assert.match(block, /throw new Skipped\(/);
  assert.ok(i < poll.indexOf("if (breaker.fail(s.platform, e.message, operatorOf(s)))"), "checked before the breaker counts a failure");
});

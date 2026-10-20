/* A BOARD SIG PASTED BY HAND -- 2026-10-20.
 * www.newcoop.com puts a Cloudflare bot check in front of our reader. Sig pastes
 * their public page into the elevator desk; the subs worker serves the rows at
 * /elev/paste/newcoop; poll.mjs uses them when the live read gives no board and
 * the paste is at least as new as what is held. Held 7 days, aged by the paste. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractPaste, extractAny, isPaste } from "../lib/adapters/newcoop.mjs";
import { buildFile } from "../lib/board.mjs";
import { loadSources, toConfig, pasteOf } from "../lib/sources.mjs";
import { adapterFor } from "../lib/adapters/index.mjs";
import { withdrawHFor, feedVerdict, PASTED_WITHDRAW_H, WITHDRAW_H, stateOf } from "../lib/freshness.mjs";

/* The worker's answer for a paste of the Oct 20 page (Afton corn Oct 2026:
   $4.26, basis -35, futures 461-4, change -5-4), cells exactly as printed. */
const PASTE = {
  site: "newcoop", pastedAt: "2026-10-20T14:05:00.000Z",
  source: "posted from NEW Cooperative's public bid page",
  locations: [
    { name: "Afton", rows: [
      { commodity: "Corn", delivery: "10/1/2026 - 10/31/2026", cash: "$4.26", basis: "-35", future: "461-4", change: "-5-4" },
      { commodity: "Soybeans", delivery: "10/1/2026 - 10/31/2026", cash: "$9.66", basis: "-80", future: "1046-0", change: "-6-2" },
    ] },
    { name: "Creston 1", rows: [
      { commodity: "Corn", delivery: "10/1/2026 - 10/31/2026", cash: "$4.21", basis: "-40", future: "461-4", change: "-5-4" },
    ] },
  ],
};

test("the paste reads through the same cell readers as a live page", () => {
  const rows = extractPaste(JSON.stringify(PASTE), pasteOf("newcoop"));
  assert.equal(rows.length, 3);
  const a = rows[0];
  assert.deepEqual([a.locationId, a.cash, a.basisCents, a.futuresPrice, a.futuresChange, a.delivery],
    ["Afton", 4.26, -35, 461.5, -5.5, "01 Oct 2026 to 31 Oct 2026"]);
  assert.equal(a.postedAt, "2026-10-20T14:05:00.000Z");
  assert.ok(isPaste(JSON.stringify(PASTE)));
  assert.equal(isPaste("<html>"), null);
  assert.equal(extractAny(JSON.stringify(PASTE)).length, 3, "the newcoop platform takes either");
});

test("newcoop-afton publishes the pasted row, stamped with the paste time, cash proved", () => {
  const src = JSON.parse(readFileSync(new URL("../sources/newcoop-afton.json", import.meta.url), "utf8"));
  const { sources } = loadSources([src]);
  const built = buildFile(JSON.stringify(PASTE), { now: PASTE.pastedAt, sourceUrl: pasteOf("newcoop"),
    source: toConfig(sources[0]), extract: adapterFor("newcoop", null) });
  assert.equal(built.file.checkedAt, PASTE.pastedAt, "a pasted board is as old as the paste");
  assert.equal(built.postedAt, PASTE.pastedAt);
  assert.deepEqual(built.file.bids.map((b) => b.cash), [4.26, 9.66]);
});

test("a paste that is not one, or carries no time or no row, is refused", () => {
  assert.throws(() => extractPaste({ ...PASTE, pastedAt: "" }), /no paste time/);
  assert.throws(() => extractPaste({ ...PASTE, locations: [{ name: "Afton", rows: [{ commodity: "Corn" }] }] }), /no readable row/);
  assert.throws(() => extractPaste("<title>Just a moment...</title>"), /not a NEW Cooperative paste/);
  /* a row that does not add up is still caught by lib/board.mjs */
  const bad = { ...PASTE, locations: [{ name: "Afton", rows: [{ ...PASTE.locations[0].rows[0], cash: "$5.26" }] }] };
  const src = JSON.parse(readFileSync(new URL("../sources/newcoop-afton.json", import.meta.url), "utf8"));
  const { sources } = loadSources([src]);
  assert.throws(() => buildFile(JSON.stringify(bad), { now: PASTE.pastedAt, sourceUrl: "u",
    source: toConfig(sources[0]), extract: adapterFor("newcoop", null) }));
});

test("only a row marked pasted is held 7 days; no manifest can stretch a live read", () => {
  assert.equal(PASTED_WITHDRAW_H, 168);
  assert.equal(withdrawHFor({ pasted: true }), 168);
  assert.equal(withdrawHFor({ maxAgeH: 168 }), WITHDRAW_H);
  assert.equal(withdrawHFor({ pasted: "true" }), WITHDRAW_H);
  const now = Date.parse("2026-10-24T14:05:00Z");          // 96 h after the paste
  assert.equal(feedVerdict("ok", PASTE.pastedAt, now, WITHDRAW_H, { pasted: true }).publish, true);
  assert.equal(feedVerdict("ok", PASTE.pastedAt, now, WITHDRAW_H).publish, false, "unmarked: 14 h");
  const week = Date.parse("2026-10-27T14:06:00Z");          // 168 h and a minute
  const v = feedVerdict("ok", PASTE.pastedAt, week, WITHDRAW_H, { pasted: true });
  assert.equal(v.publish, false);
  assert.match(v.why, /past the 168h withdrawal for a board pasted by hand/);
  assert.equal(stateOf({ health: "live", pasted: true, checkedAt: PASTE.pastedAt, observedAt: PASTE.pastedAt }, now) !== "down", true);
});

test("poll.mjs: the newer of live and pasted wins, and a paste row says what the live read did", () => {
  const poll = readFileSync(new URL("../scripts/poll.mjs", import.meta.url), "utf8");
  assert.match(poll, /try \{ page = await getPage\(s\); \}\n    catch \(liveErr\) \{/);
  assert.match(poll, /if \(!p \|\| \(Number\.isFinite\(heldAt\) && Date\.parse\(p\.pastedAt\) < heldAt\)\) throw liveErr;/,
    "a paste older than the board held is not used");
  assert.match(poll, /now: pasted \? pasted\.at : now/, "checkedAt is the paste time");
  assert.match(poll, /r\.pasted = true;/);
  assert.match(poll, /if \(pasted\) r\.observedAt = pasted\.at;/);
  const merge = readFileSync(new URL("../scripts/merge_bids.mjs", import.meta.url), "utf8");
  assert.match(merge, /withdrawHFor\(files\.get\(id\) \?\? s\), \{ pasted \}\);/);
  assert.match(merge, /via: pasted \? "paste" : "scrape"/);
});

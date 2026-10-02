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

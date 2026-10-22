/* The agsist subs Worker moved to agsist-api.dnilgis.workers.dev (Oct 22,
 * 2026: Cloudflare blocked the old agsist-subs host on Oct 21). The elevator
 * portal feed and the hand-pasted NEW Cooperative board are read from the new
 * host. No code, test or workflow may name the old one. The data files keep
 * the address they were really read from until the next pass reads them
 * again (poll.mjs writes sourceUrl from the read itself), so data/ is not
 * checked here.
 *
 *   node --test test/agsist-api-host.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FEED_URL } from "../lib/adapters/agsist-portal.mjs";
import { pasteOf } from "../lib/sources.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF = "test/agsist-api-host.test.mjs";

test("the portal feed and the newcoop paste are on the new host", () => {
  assert.equal(FEED_URL, "https://agsist-api.dnilgis.workers.dev/elev/feed");
  assert.equal(pasteOf("newcoop"), "https://agsist-api.dnilgis.workers.dev/elev/paste/newcoop");
});

test("no code, test or workflow names the old host", () => {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-n", "-I", "-i", "-E", "agsist-subs\\\\?\\.dnilgis", "--", ".", ":!data", ":!" + SELF],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    if (e.status !== 1) throw e;   // 1 = git grep found nothing
  }
  assert.equal(out.trim(), "", "still names the old host:\n" + out.split("\n").slice(0, 10).join("\n"));
});

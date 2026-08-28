/* THE PAGINATION BUG THAT REPORTED SUCCESS WHILE HOLDING A THIRD OF THE DATA.
 *
 * fetch_registries.py probes several spellings of a page parameter and keeps
 * the first that returns a different body. Missouri answered `?page=2`, the
 * probe recorded it as working — and the run then took 288 records and stopped,
 * because the fetch loop rebuilt its URLs from the step alone and asked for
 * `?page=1`, which IS the page it had already read. Zero new rows, and the
 * zero-new guard broke out before page two was ever requested.
 *
 * A confident run holding a third of a state is worse than a run that fails,
 * so this stands up a server where ONLY the page parameter turns the page and
 * asserts the whole list comes back. It failed at 25 of 75 before the fix.
 *
 * The second test is the other half: a parameter the server ignores must not
 * be reported as working, or the same silence returns under a different name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const ROWS = Array.from({ length: 75 }, (_, i) => [
  `Biz ${String(i + 1).padStart(3, "0")}`, `Town${i + 1}`, `Cty${i + 1}`,
  `515-555-${String(i + 1).padStart(4, "0")}`,
]);

function page(rows) {
  return "<html><table><tr><th>Name</th><th>City</th><th>County</th><th>Phone</th></tr>" +
    rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
    "</table></html>";
}

/** honour: which query key actually turns the page. null = ignore every key. */
function serve(honour) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const n = honour && u.searchParams.has(honour)
        ? Number(u.searchParams.get(honour)) || 1 : 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(ROWS.slice((n - 1) * 25, n * 25)));
    });
    s.listen(0, "127.0.0.1", () => resolve([s, s.address().port]));
  });
}

// ASYNC ON PURPOSE. execFileSync blocks this process's event loop, and the
// server under test is IN this process — so the synchronous version deadlocks
// until python times out and every assertion reads a connection error.
const exec = promisify(execFile);

async function run(port, dump) {
  const { stdout } = await exec("python3", [
    join(ROOT, "scripts/fetch_registries.py"), "--probe-url",
    `http://127.0.0.1:${port}/list`, "--pages", "10", "--timeout", "10",
    ...(dump ? ["--dump-dir", dump] : []),
  ], { encoding: "utf8" });
  return JSON.parse(stdout);
}

test("every page is read when the server only answers to ?page=", async () => {
  const [s, port] = await serve("page");
  try {
    const r = await run(port);
    assert.equal(r.diagnostic.pagination.works.includes("?page="), true,
      `probe missed the working parameter: ${JSON.stringify(r.diagnostic.pagination)}`);
    assert.equal(r.records, 75,
      `took ${r.records} of 75 — the loop is not starting where the probe proved it moved`);
  } finally { s.close(); }
});

test("a parameter the server ignores is not reported as working", async () => {
  const [s, port] = await serve(null);
  try {
    const r = await run(port);
    assert.equal(r.diagnostic.pagination.works, null,
      "a page that never changes was called paginated");
    assert.equal(r.records, 25, `took ${r.records}, expected the single page of 25`);
  } finally { s.close(); }
});

test("the pages it read are kept as fixtures, capped", async () => {
  const [s, port] = await serve("page");
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  try {
    await run(port, dir);
    const files = readdirSync(dir);
    assert.equal(files.length, 2, `dumped ${files.length} pages, expected the cap of 2`);
    assert.ok(files.some((f) => f.endsWith("list.html")), files.join(","));
  } finally { s.close(); }
});

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
import { execFile, execFileSync } from "node:child_process";
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

/* THE PROBE THAT SAID YES TO EVERY SPELLING.
 *
 * agriculture.mo.gov answered the FIRST pagination parameter it was offered and
 * the diagnostic recorded `?page=` as working. The page has 304 rows, one table
 * and no pager in it anywhere. What differed between page one and "page two"
 * was a single script tag:
 *
 *   <script src="/_Incapsula_Resource?SWJIYLWA=719d34...&ns=4&cb=655034020">
 *   <script src="/_Incapsula_Resource?SWJIYLWA=719d34...&ns=5&cb=1825576555">
 *
 * A per-response nonce. Every body differs from every other body, so a byte
 * comparison makes any parameter look like it works and the first one tried
 * wins by accident. The probe now compares the BUSINESSES on the page.
 */
test("a per-response nonce does not make a dead parameter look alive", async () => {
  let n = 0;
  const s = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page(ROWS.slice(0, 25)) +
      `<script src="/_Incapsula_Resource?ns=${n}&cb=${Math.random()}"></script>`);
    n += 1;
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const r = await run(s.address().port);
    assert.equal(r.diagnostic.pagination.works, null,
      "a page that only changes its nonce was called paginated");
    const tried = r.diagnostic.pagination.tried;
    assert.ok(tried.some((t) => t.bytesDiffer === true),
      "the fixture should differ byte for byte, or it is not testing the nonce");
    assert.ok(tried.every((t) => !t.newBusinesses),
      "no spelling should have produced a new business");
  } finally { s.close(); }
});

/* IOWA PAGES BY POSTING A RELATIVE OFFSET INSIDE A SESSION.
 *
 * Twelve GET spellings were refused and the run took 25 of 251 dealers, three
 * times, reporting success each time. The form is method="post" with a hidden
 * offset that Next sets to 25 and Prev sets to -25 — a delta, with the position
 * held server-side. No URL can produce page two.
 *
 * Three servers: one that reads the offset as a delta, one that reads it as an
 * absolute position, and one that refuses to move. The first two must return
 * all 251. The third must SAY SO — the page prints "25 out of 251", and a walk
 * that ends short of a total the source itself published is the failure the
 * first three runs hid.
 */
function iowaish(kind) {
  const TOTAL = 251;
  const all = Array.from({ length: TOTAL }, (_, i) => [
    `Biz ${String(i + 1).padStart(3, "0")}`, `Town${i + 1}`, `Cty${i + 1}`,
    `515-555-${String(i + 1).padStart(4, "0")}`,
  ]);
  const pos = new Map();
  const body = (off) => page(all.slice(off, off + 25)) +
    `<p>${Math.min(25, TOTAL - off)} out of ${TOTAL}<button id="next">Next &gt;</button></p>`;
  return createServer((req, res) => {
    const cookie = /sid=([^;]+)/.exec(req.headers.cookie || "");
    const head = { "content-type": "text/html" };
    if (req.method === "GET") {
      const sid = String(Math.random()).slice(2);
      pos.set(sid, 0);
      head["set-cookie"] = `sid=${sid}; Path=/`;
      res.writeHead(200, head); res.end(body(0)); return;
    }
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const off = Number(new URLSearchParams(raw).get("offset") || 0);
      const sid = cookie && cookie[1];
      let at = pos.get(sid) ?? 0;
      if (kind === "delta") at = Math.max(0, Math.min(TOTAL - 1, at + off));
      else if (kind === "absolute") at = Math.max(0, Math.min(TOTAL - 1, off));
      else at = 0;                                    // refuses to page
      pos.set(sid, at);
      res.writeHead(200, head); res.end(body(at));
    });
  });
}

async function walk(kind) {
  const s = iowaish(kind);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const { stdout } = await exec("python3", [
      join(ROOT, "scripts/fetch_registries.py"), "--probe-url",
      `http://127.0.0.1:${s.address().port}/graindealers/`,
      "--post-walk", "--pages", "20", "--timeout", "10",
    ], { encoding: "utf8" });
    return JSON.parse(stdout);
  } finally { s.close(); }
}

test("a session that pages by a relative offset gives up all 251", async () => {
  const r = await walk("delta");
  assert.equal(r.records, 251, `took ${r.records} of 251`);
  assert.equal(r.diagnostic.INCOMPLETE, undefined);
});

test("a server reading the offset as a position also gives up all 251", async () => {
  const r = await walk("absolute");
  assert.equal(r.records, 251, `took ${r.records} of 251`);
  assert.equal(r.diagnostic.offsetMode, "absolute");
});

test("a walk that ends short of the source's own total says so", async () => {
  const r = await walk("stuck");
  assert.equal(r.records, 25);
  assert.match(r.diagnostic.INCOMPLETE || "", /says 251 and this walk took 25/,
    "25 of 251 reported as a success is the failure this whole file exists for");
});

/* THE REAL PAGES, NOT HAND-MADE FIXTURES.
 *
 * Every parser fix in this file's history was written blind: idalsdata.org,
 * data.iowaagriculture.gov and agriculture.mo.gov are all unreachable from the
 * machine the parser is written on, so five hand-made fixtures stood in for
 * three real pages and each fix corrected a real defect while leaving the next
 * one invisible. The run now commits the pages it reads under debug/registries/.
 * These tests are what those pages are for.
 *
 * The counts are not round numbers picked to pass. 140 is how many "Name:"
 * labels the Iowa warehouse report contains; 304 is Missouri's <tr> count; 251
 * and 102 are what Iowa prints under its own tables.
 */
import { existsSync } from "node:fs";

const PAGES = join(ROOT, "debug/registries");
const fixture = (f) => join(PAGES, f);

const parse = (file) => execFileSync("python3",
  [join(ROOT, "scripts/fetch_registries.py"), "--fixture", fixture(file)],
  { encoding: "utf8" });

const IOWA_REPORT = "http-idalsdata-org-iowadata-grainwarehousedirectoryreporthtml-cfm-version-html.html";
const IOWA_DEALERS = "https-data-iowaagriculture-gov-licensing-lists-graindealers.html";
const IOWA_WHOUSE = "https-data-iowaagriculture-gov-licensing-lists-grainwarehouse.html";
const MISSOURI = "https-agriculture-mo-gov-grains-grainsearch-php.html";

test("the Iowa warehouse report gives up all 140 of its records", { skip: !existsSync(fixture(IOWA_REPORT)) }, () => {
  const out = parse(IOWA_REPORT);
  assert.match(out, /label\/value pairs/,
    "the report is a two-column label/value table; any other route loses records");
  assert.match(out, /\n\s+140 records/,
    `expected 140, got:\n${out}`);
});

test("Missouri parses as one table and says nothing about paging", { skip: !existsSync(fixture(MISSOURI)) }, () => {
  const out = parse(MISSOURI);
  assert.match(out, /route: table/);
  assert.ok(!/out of/.test(out), "Missouri publishes no total; do not invent one");
  const n = Number(/(\d+) records/.exec(out)[1]);
  assert.ok(n > 280 && n <= 304, `${n} records from a 304-row table`);
});

for (const [file, total] of [[IOWA_DEALERS, 251], [IOWA_WHOUSE, 102]]) {
  test(`the Iowa list page publishes its own total of ${total}`, { skip: !existsSync(fixture(file)) }, () => {
    const out = parse(file);
    assert.match(out, new RegExp(`the page says: 25 out of ${total}`),
      "the completeness check reads this line; without it 25 of 251 looks like success");
  });
}

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
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
  assert.match(r.diagnostic.INCOMPLETE || "", /says 251, this walk took 25 and only read as far as/,
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

/* THE NUMBER IS IOWA'S, NOT OURS, AND IOWA CHANGES IT.
 *
 * This asked for "25 out of 251" and "25 out of 102" by name. Iowa licensed a
 * dealer out of existence and the page began saying 250; the guard went red
 * over a state's paperwork, in a test whose whole subject is whether OUR
 * parser reads the line. A number the Department of Agriculture controls is
 * not a fact about this repository.
 *
 * So the fixture is asked what it says, and the parser is required to agree
 * with it. That is strictly stronger than the equality it replaces: it would
 * catch a parser that reads the wrong number, which "== 251" could not — 251
 * was hardcoded on both sides of the comparison in every sense that mattered.
 */
for (const [file, label] of [[IOWA_DEALERS, "dealers"], [IOWA_WHOUSE, "warehouses"]]) {
  test(`the Iowa ${label} page publishes its own total and we read it`, { skip: !existsSync(fixture(file)) }, () => {
    const raw = readFileSync(fixture(file), "utf8");
    const said = /(\d+)\s+out\s+of\s+(\d+)/.exec(raw);
    assert.ok(said,
      "the committed Iowa page no longer contains an 'N out of M' line at " +
      "all — either Iowa stopped printing its total, or the wrong page was " +
      "captured, and the completeness check has nothing to stand on");
    const total = Number(said[2]);
    assert.ok(total > 50,
      `Iowa's page states a total of ${total}, which is not a licensee list`);
    const out = parse(file);
    assert.match(out, new RegExp(`the page says: \\d+ out of ${total}`),
      `the page itself says ${total} and the parser did not report that ` +
      `number — without this line, 25 of ${total} reads as a success:\n${out}`);
  });
}

/* THE OFFSET WAS DERIVED FROM THE DEDUPED COUNT, SO IT DRIFTED.
 *
 * The first live POST walk took 250 of Iowa's stated 251 dealers, and the
 * diagnostic showed why: eight pages running came back with 24 new records
 * instead of 25. The absolute offset was `len(recs)` — how many UNIQUE
 * businesses were held — so every repeated row left the cursor one behind the
 * walk's real position, the next page re-read a row already seen, and the lag
 * compounded to the end of the list.
 *
 * The cursor advances by the rows the server RETURNED now, which cannot skip a
 * row whether the offset is 0- or 1-based.
 *
 * The second half matters more than the first. A walk that ends short of a
 * published total has two completely different causes and only one of them is a
 * failure: rows were lost, or two licensees share a name and a town and
 * collapsed on the dedup key. Reporting both as INCOMPLETE cries wolf until
 * nobody reads it; reporting both as fine is worse. So coverage has to be
 * EVIDENCE. The first version credited the tail sweep with reaching the end
 * whether or not it had, and a server truncating at row 150 came back "173 of
 * 251 — the walk read every row". A false all-clear beats a false alarm to the
 * top of the list of things not to ship.
 */
function iowaAbsolute({ total = 251, duplicateAt = null, truncateAfter = null } = {}) {
  const all = Array.from({ length: total }, (_, i) => [
    `Biz ${String(i + 1).padStart(3, "0")}`, `Town${i + 1}`, `Cty${i + 1}`,
    `515-555-${String(i + 1).padStart(4, "0")}`,
  ]);
  if (duplicateAt !== null) {                       // same name AND town as row 8
    all[duplicateAt][0] = all[7][0];
    all[duplicateAt][1] = all[7][1];
  }
  const body = (off) => {
    const start = Math.max(0, off > 0 ? off - 1 : 0);   // 1-based, as Iowa reads it
    const rows = all.slice(start, start + 25);
    return page(rows) +
      `<p>${rows.length} out of ${total}<button id="next">Next &gt;</button></p>`;
  };
  return createServer((req, res) => {
    const head = { "content-type": "text/html" };
    if (req.method === "GET") { res.writeHead(200, head); res.end(body(0)); return; }
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let off = Number(new URLSearchParams(raw).get("offset") || 0);
      if (truncateAfter !== null && off > truncateAfter) off = 0;   // ignores the offset
      res.writeHead(200, head); res.end(body(off));
    });
  });
}

async function walkAbs(opts) {
  const s = iowaAbsolute(opts);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const { stdout } = await exec("python3", [
      join(ROOT, "scripts/fetch_registries.py"), "--probe-url",
      `http://127.0.0.1:${s.address().port}/graindealers/`,
      "--post-walk", "--pages", "25", "--timeout", "10",
    ], { encoding: "utf8" });
    return JSON.parse(stdout);
  } finally { s.close(); }
}

test("an absolute 1-based offset does not drift, and the tail is reached", async () => {
  const r = await walkAbs({});
  assert.equal(r.records, 251, `took ${r.records} of 251 — the cursor is drifting again`);
  assert.equal(r.diagnostic.INCOMPLETE, undefined);
  /* Two short pages are the delta probe finding out the server is absolute —
     on a 1-based server `offset=25` re-serves the row page one ended on. What
     must not happen is a short page EVERY page, which is the drift: eight in a
     row on the live Iowa walk. */
  const pages = r.diagnostic.newPerPage.slice(1, -1);
  assert.ok(pages.filter((n) => n === 24).length <= 2,
    `${pages.filter((n) => n === 24).length} pages came back one short: ${pages.join(",")}`);
});

test("a name repeated in the same town is NOT reported as a missed row", async () => {
  const r = await walkAbs({ duplicateAt: 200 });
  assert.equal(r.records, 250, "251 rows with one duplicate pair is 250 unique businesses");
  assert.equal(r.diagnostic.INCOMPLETE, undefined,
    "a duplicate is not a missed row, and calling it one is how a guard stops being read");
  assert.match(r.diagnostic.shortButCovered || "", /read every row/);
});

test("a server that quietly stops paging IS reported, and never as all-clear", async () => {
  const r = await walkAbs({ truncateAfter: 150 });
  assert.ok(r.records < 251, "the fixture truncates; it cannot return everything");
  assert.equal(r.diagnostic.shortButCovered, undefined,
    "a false all-clear: rows were lost and it said the walk read every one");
  assert.match(r.diagnostic.INCOMPLETE || "", /only read as far as row/);
  assert.ok(r.diagnostic.offsetIgnoredFrom !== undefined,
    "the page came back identical to page one and nothing noticed");
});

/* THE OTHER TWENTY STATES ARE NOT SHAPED LIKE IOWA.
 *
 * Twenty-two states were checked one at a time on 2026-08-28, by fetching each
 * page rather than assuming from the last one. What they actually publish: ten
 * PDFs, five one-page HTML tables, five search forms with nothing to page
 * through, two client-side dashboards that leak no rows, one CSV. Kansas and
 * Oklahoma publish no list at all — confirmed by looking, not inferred from a
 * 403.
 *
 * So "nineteen more scrapers like Iowa's" was wrong before it started. It is
 * three routes and a row per state, and these guard the two new routes.
 *
 * The CSV test exists because of Missouri: an eleven-column table where
 * "Manager Name" sat left of "Company Name", and taking the first name-ish
 * column threw away every street address on a 288-record run. Longest header
 * match wins, and this proves it still does.
 */
import { execFileSync as run1 } from "node:child_process";

const py = (code) => run1("python3", ["-c", code], { encoding: "utf8" });
const LOAD = `
import importlib.util
spec = importlib.util.spec_from_file_location("fr", "${join(ROOT, "scripts/fetch_registries.py")}")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
`;

test("a csv column order we have never seen maps correctly", () => {
  const out = py(`${LOAD}
csv = ("Manager Name,Company Name,Address,City,State,Zip,County,Phone,License Type,Capacity\\n"
       "Jane Roe,Heartland Grain LLC,12 Elevator Rd,Bucyrus,OH,44820,Crawford,419-555-0101,Warehouse,1250000\\n"
       "John Doe,\\"Smith & Sons, Inc.\\",4 Depot St,Fostoria,OH,44830,Seneca,(419) 555-0102,Dealer,0\\n")
d = {}
r = m.read_csv(csv, d)
print(len(r), "|", r[0]["name"], "|", r[0]["capacity"], "|", r[1]["name"])
`).trim();
  const [n, name, cap, quoted] = out.split(" | ");
  assert.equal(n, "2");
  assert.equal(name, "Heartland Grain LLC", "Manager Name stole the business name again");
  assert.equal(cap, "1250000", "the capacity column was dropped");
  assert.equal(quoted, "Smith & Sons, Inc.", "a quoted comma split one business into two");
});

test("a state that prints its own total is checked against it, in either spelling", () => {
  const out = py(`${LOAD}
for t in ("Showing 25 out of 251 results", "TOTAL LICENSED GRAIN DEALERS 116",
          "TOTAL NUMBER OF LICENSED WAREHOUSES: 44", "no total here"):
    print(m.stated_total(t))
`).trim().split("\n");
  assert.equal(out[0], "(25, 251)", "Iowa's spelling");
  assert.equal(out[1], "(0, 116)", "Nebraska prints its total on the PDF and it must count");
  assert.equal(out[2], "(0, 44)");
  assert.equal(out[3], "None", "a document with no total must not invent one");
});

test("every source in the table declares a route the code implements", () => {
  /* THE ROUTES ARE READ OFF THE CODE, NOT LISTED HERE.
   *
   * This held a hardcoded ["html","csv","pdf"], so adding Texas — which
   * publishes a legacy .xls, the only shape that reaches its 139 licensees —
   * went red in a guard that was meant to catch a TYPO in a route name. A
   * guard that has to be edited every time the thing it guards grows is a
   * guard people learn to edit rather than read.
   *
   * The dispatch is `src["route"] == "<name>"` in fetch_file() and its
   * sibling, so that is where the answer is. A route in the table with no
   * branch is still caught, which is the check that was wanted. */
  const out2 = py(`${LOAD}
print(",".join(m.ROUTES))
`).trim();
  const implemented = new Set(out2.split(","));
  assert.ok(implemented.size >= 4,
    `only ${implemented.size} route(s) declared — ROUTES has shrunk`);
  /* AND EVERY NAMED ROUTE MUST HAVE A BRANCH. A list that names a shape the
     fetchers do not handle is the same defect one level up: "pdf" is the
     fallback and has no equality test, so it is checked by name. */
  const src = readFileSync(join(ROOT, "scripts/fetch_registries.py"), "utf8");
  /* THE EQUALITY TEST ITSELF, ONCE. A first cut accepted the substring
     `"docx")` as evidence of a branch — which the ROUTES tuple itself
     contains, so adding a route with no code passed.

     This then asked for TWO branches, because fetch_file() had been pasted
     into the file twice, byte for byte, and the second copy shadowed the
     first. The guard did not catch the duplication; it REQUIRED it, and so
     every edit to the dead first copy read as covered. Deleting the dead copy
     turned this red, which is the right way round. One fetcher, one branch —
     and a 2 here now means it has been duplicated again. */
  for (const r of implemented) {
    if (r === "html" || r === "pdf") continue;
    const branches = src.split(`src["route"] == "${r}"`).length - 1;
    assert.equal(branches, 1,
      `ROUTES names "${r}" and ${branches} fetcher branches read it ` +
      `(0 = no code at all; 2 = fetch_file has been duplicated again)`);
  }
  const pdfFallback = src.split("text = pdf_text(raw, diag)").length - 1;
  assert.equal(pdfFallback, 1,
    `the pdf fallback appears ${pdfFallback} times and there is one fetcher`);

  /* AND THE ROUTER MUST SEND THEM THERE. A branch inside fetch_file() is
     worth nothing if the line that CHOOSES fetch_file() does not name the
     route. Texas fetched its .xls perfectly — status 200, 63,998 bytes — and
     was handed to the HTML reader, because `route in ("csv", "pdf")` was the
     third place the word "xls" had to be written and the only one missed.
     tables: 0, rowsSeen: 0, firstRowRaw a wall of U+FFFD.

     Read the tuple off the code; require every non-html route in ROUTES. */
  const router = src.match(/src\.get\("route"\)\s+in\s+\(([^)]*)\)/);
  assert.ok(router,
    'the router line `src.get("route") in (...)` is gone from the script');
  const dispatched = new Set(
    [...router[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  for (const r of implemented) {
    if (r === "html") continue;
    assert.ok(dispatched.has(r),
      `ROUTES declares "${r}" but the router sends only ` +
      `${[...dispatched].sort().join(", ") || "nothing"} to the file ` +
      `fetcher — a "${r}" source would be fetched and then read as HTML`);
  }
  const out = py(`${LOAD}
routes = sorted({s.get("route", "html") for s in m.SOURCES})
print(",".join(routes))
print(len(m.SOURCES), len({s["state"] for s in m.SOURCES}))
`).trim().split("\n");
  for (const r of out[0].split(",")) {
    assert.ok(implemented.has(r),
      `source declares route "${r}" and no fetcher branches on it — ` +
      `the code implements ${[...implemented].sort().join(", ")}`);
  }
  const [, states] = out[1].split(" ").map(Number);
  assert.ok(states >= 6, `only ${states} states in the table — the country is fifty`);
});

/* A PHONE WAS THE ENTRY REQUIREMENT, AND MOST STATES DO NOT PUBLISH ONE.
 *
 * Six states were added and all six returned zero. One reason covered five of
 * them: `if ("phone" not in idx) continue`, written when the only states in the
 * table were Iowa and Missouri, which both publish phones.
 *
 * North Dakota's register had parsed PERFECTLY — 286 rows, name, county, city
 * and zip all mapped — and every record was thrown away for want of a column
 * North Dakota does not have. Arkansas the same, Ohio the same, and all three
 * PDFs. A phone is the best dedup key this project has; it is not proof that a
 * row is a business.
 *
 * These run against the documents the run committed. The counts are what those
 * files contain, not round numbers chosen to pass.
 */
const PDFS = {
  IN: "https-www-in-gov-da-163601981f-licensees-by-county-06-18-2026-pdf-language-id-1.txt",
  SD: "http-puc-sd-gov-commission-warehouse-grain-20license-20info-pdf.txt",
  NE: "https-psc-nebraska-gov-sites-default-files-doc-2026-08-27-20grain-20dealer-20lis.txt",
};
const OHIO = "https-dam-assets-ohio-gov-raw-upload-v1745847679-grain-csv.csv";
const NDAK = "https-lars-ndda-nd-gov-public-alllicenses-4.html";
const ARK = "https-agriculture-arkansas-gov-crops-industry-quality-control-and-compliance-gra.html";

const pyOn = (code) => py(`${LOAD}\n${code}`).trim();

/* EVERY ROW THE DOCUMENT HAS, COUNTED FROM THE DOCUMENT.
 *
 * These asked for 285 and 32 by name, and North Dakota licensed three more
 * elevators. The guard exists because `if ("phone" not in idx): continue`
 * silently threw away five whole states — a failure that shows up as ZERO
 * records, or a fraction of them, never as three extra. Pinning the exact
 * number caught nothing that the row count does not catch, and broke on a
 * state doing its job.
 *
 * The table's own <tr> count, less its header, is what the parse must equal.
 * A dropped column, a dropped state, a rejoin eating rows: all still red.
 */
for (const [file, label, floor] of [[NDAK, "North Dakota", 288], [ARK, "Arkansas", 32]]) {
  test(`${label} publishes no phone column and every row is still read`, { skip: !existsSync(fixture(file)) }, () => {
    const raw = readFileSync(fixture(file), "utf8");
    const rows = (raw.match(/<tr\b/gi) || []).length;
    const n = Number(pyOn(`
b = open(r"${fixture(file)}", encoding="utf-8", errors="replace").read()
print(len(m.extract(b, {})))`));
    assert.ok(rows > 1,
      `the committed ${label} page has ${rows} table row(s) — the wrong page ` +
      "was captured and this guard is measuring nothing");
    assert.equal(n, rows - 1,
      `${n} records from a table of ${rows - 1} data rows — a state without ` +
      "phones is being dropped again");
    /* THE SECOND CHECK ASKS A DIFFERENT QUESTION, AND IT IS NOT "HOW MANY".
     *
     * The equality above already answers completeness: every row the document
     * has became a record. What it cannot see is a document that is WRONG —
     * an error page, a login wall, a truncated capture — because a four-row
     * error table parsed into three records passes `n == rows - 1` perfectly.
     *
     * The floor that stood here was 285, with a comment saying "this list has
     * only ever grown". I reasoned that; I did not measure it. Six North
     * Dakota licences lapsed the same day and the register went 288 -> 282,
     * which would have turned this red for a state doing its paperwork — the
     * exact defect this test was rewritten to remove, reintroduced one clause
     * lower down.
     *
     * So it is a PLAUSIBILITY floor, at half of what was last measured. It
     * cannot fire on a renewal cycle and it still catches a page that is not
     * the register. */
    assert.ok(n >= Math.floor(floor / 2),
      `${n} records where ${floor} were last measured — less than half the ` +
      "register is not a licensing cycle, it is the wrong page");
  });
}

test("Nebraska's dealer list reconciles to the total it prints", { skip: !existsSync(fixture(PDFS.NE)) }, () => {
  /* IT READ 114 OF A STATED 116 FOR WEEKS, AND SAID SO EVERY RUN.
   *
   * The INCOMPLETE line was doing its job — "the document says 116 and this
   * parse found 114" — and the two it could not read were the two Nebraska
   * lists outside the United States:
   *
   *     LYFT COMMODITY TRADING LTD  3079  220,000  BC, CANADA
   *     SURESOURCE COMMODITIES, LLC 3056   75,000  PETROLIA, ONTARIO CANADA
   *
   * They are licensed Nebraska grain dealers and they belong in the count.
   * They get no state, which is the truth about them, and they join the 31
   * businesses a state licenses and places somewhere else.
   *
   * This asks the DOCUMENT what its total is and requires the parse to reach
   * it, so a state adding a dealer moves both sides together. */
  const out = pyOn(`
src = [s for s in m.SOURCES if s["state"] == "NE" and s.get("kind") == "dealer"][0]
t = open(r"${fixture(PDFS.NE)}", encoding="utf-8", errors="replace").read()
d = {}
r = m.pdf_records(t, d, src["pattern"], src.get("continuation"), src.get("cityStrip"))
told = m.stated_total(t)
names = sorted("%s @ %s" % (x["name"], x.get("city", "NO CITY")) for x in r if not x.get("st"))
loose = m.pdf_records("SOME COMPANY LLC 1234 50,000 SPRINGFIELD ILLINOIS", {},
                      src["pattern"], src.get("continuation"), src.get("cityStrip"))
print(len(r), told[1] if told else 0, "|".join(names), len(loose), sep=";")`).split(";");
  const [got, said] = [Number(out[0]), Number(out[1])];
  assert.ok(said > 0, "the Nebraska document no longer prints its own total");
  assert.equal(got, said,
    `the document says ${said} and this parse found ${got}`);
  /* AND THE TWO WITHOUT A STATE ARE THE TWO THAT HAVE NONE — not a US
     licensee whose state the pattern quietly stopped capturing. */
  const stateless = out[2] ? out[2].split("|") : [];
  /* THREE, NOT TWO. C.B. Constantini of Vancouver joined them when a
     two-letter code outside US_STATES stopped counting as a state: it had
     been filed under "BC" as though British Columbia were Iowa. */
  assert.deepEqual(stateless.sort(),
    ["C.B. CONSTANTINI LTD @ VANCOUVER",
     "LYFT COMMODITY TRADING LTD @ BC",
     "SURESOURCE COMMODITIES, LLC @ PETROLIA"],
    `these Nebraska records came back with no state: ${stateless.join(", ")}`);
  /* AND THE FOREIGN BRANCH IS ANCHORED ON THE WORD THE DOCUMENT PRINTS.
     Written as "a town and then any trailing capitals", it matches a line
     with a spelled-out US state and no comma — a shape this document does
     not have today and the next one might. It must not match one. */
  assert.equal(Number(out[3]), 0,
    "the pattern read 'SOME COMPANY LLC 1234 50,000 SPRINGFIELD ILLINOIS' " +
    "as a record — the foreign branch has stopped requiring CANADA and now " +
    "accepts any trailing words as a location");
});

test("no record is filed under a two-letter code that is not a US state", () => {
  /* THE COMMITTED RUN PUT THREE BUSINESSES IN THREE COUNTRIES THAT DO NOT
     EXIST — "BC", "ON" and "CN" appeared in the per-state map beside Iowa
     and Ohio:

       BC  C.B. CONSTANTINI LTD              VANCOUVER
       ON  SURESOURCE COMMODITIES LLC        PETROLIA
       CN  C.B. CONSTANTINI LTD BVANCOUVER,  city "C"

     Nebraska and South Dakota both license Constantini, of Vancouver. The US
     branch matched "VANCOUVER, BC" and took the trailing CANADA as the
     optional word a state code may be followed by. The third is South
     Dakota's glued permit letter producing a company called "...BVANCOUVER,"
     in a town called "C" — an invented town, which is the one thing this
     file must never produce.

     The rule is not one state's regex. US_STATES is the list of things that
     ARE states; anything else means the location is foreign. */
  const out = pyOn(`
bad = []
for st, f in (("NE", "${fixture(PDFS.NE)}"), ("SD", "${fixture(PDFS.SD)}")):
    src = [x for x in m.SOURCES if x["state"] == st and x.get("pattern")][0]
    t = open(f, encoding="utf-8", errors="replace").read()
    for r in m.pdf_records(t, {}, src["pattern"], src.get("continuation"), src.get("cityStrip")):
        if r.get("st") and r["st"] not in m.US_STATES:
            bad.append("%s %s %s" % (st, r["st"], r.get("name", "")[:30]))
print(len(bad), "|".join(bad), sep=";")`).split(";");
  assert.equal(Number(out[0]), 0,
    `filed under a code that is not a US state: ${out[1] || ""}`);

  /* AND THE FOREIGN ONES ARE STILL READ, not quietly dropped. A licensee we
     cannot place is still a licensee, and the count must not fall. */
  const kept = pyOn(`
src = [x for x in m.SOURCES if x["state"] == "NE" and x.get("kind") == "dealer"][0]
t = open(r"${fixture(PDFS.NE)}", encoding="utf-8", errors="replace").read()
r = m.pdf_records(t, {}, src["pattern"], src.get("continuation"), src.get("cityStrip"))
f = [x for x in r if x.get("outOfCountry")]
print(len(r), len(f), (f[0]["city"] if f else ""), sep=";")`).split(";");
  assert.equal(Number(kept[0]), 116,
    "moving the foreign records out of the state column lost some of them");
  assert.ok(Number(kept[1]) >= 1, "no record was marked out of country");
  assert.equal(kept[2], "VANCOUVER",
    "Constantini kept its state code and lost its town, which is backwards");
});

test("Ohio's header is on the second row and the first is junk", { skip: !existsSync(fixture(OHIO)) }, () => {
  const out = pyOn(`
b = open(r"${fixture(OHIO)}", encoding="utf-8", errors="replace").read()
d = {}
r = m.read_csv(b, d)
print(len(r), d["headerRow"], r[0]["name"], sep="|")`).split("|");
  assert.equal(Number(out[0]), 335, "Ohio's 335 rows are being dropped");
  assert.equal(out[1], "1", "the header is row 1; row 0 is `s,s,s,s,s,s`");
  assert.equal(out[2], "541 GRAIN COMPANY, LLC");
});

/* SD is 354. It was 265 before the wrapped lines were rejoined, then 293 once
   they were — and 293 was still wrong, because the rejoin was also eating 63 of
   the document's own records: every licensee whose name begins with B, F, S or
   W has the same line shape as a wrapped fragment. Gating the join on the
   record pattern gives those 63 back and leaves the 18 genuine wraps joined.
   The number went UP because records were being lost, not because a threshold
   was relaxed; 354 is what the committed page contains.

   The call below passes the source's FULL config — pattern, continuation and
   cityStrip — because a test that exercises less than the run does is a test of
   something nobody runs. */
/* A FLOOR, NOT AN EQUALITY, AND THE REASON IS IN THE PARAGRAPH ABOVE.
 *
 * Every regression this guard was written to catch made the number go DOWN:
 * 265 when wrapped lines were left broken, 293 when the rejoin was eating
 * records. Not one of them made it go up. South Dakota licensed one more
 * elevator, the count went 354 -> 355, and an equality turned red over a
 * document that had got MORE complete.
 *
 * The floor keeps every historical failure red — 265 and 293 are both below
 * 354 — and lets the register grow. It is not a softened threshold: it is the
 * same number, with the direction the bug actually travels.
 */
for (const [st, file, floor] of [["IN", PDFS.IN, 307], ["SD", PDFS.SD, 355], ["NE", PDFS.NE, 116]]) {
  test(`the ${st} bid sheet's own line shape is read`, { skip: !existsSync(fixture(file)) }, () => {
    const out = pyOn(`
src = [s for s in m.SOURCES if s["state"] == "${st}" and s.get("pattern")][0]
t = open(r"${fixture(file)}", encoding="utf-8", errors="replace").read()
d = {}
r = m.pdf_records(t, d, src["pattern"], src.get("continuation"), src.get("cityStrip"))
print(len(r), r[0]["name"], r[0].get("city", ""), sep="|")`).split("|");
    const n = Number(out[0]);
    /* NINETY PER CENT OF WHAT WAS MEASURED, FOR THE SAME REASON THE STATE
       TABLES ABOVE STOPPED ASKING FOR AN EXACT COUNT. These documents are
       republished and the counts move: South Dakota went 354 -> 355 the day
       after this was written, and North Dakota's register fell by six. Ten
       per cent of slack cannot be reached by a licensing cycle and leaves
       every regression this guard exists for red — the rejoin read 265 and
       then 293 against 354, both far below 318. */
    const least = Math.floor(floor * 0.9);
    assert.ok(n >= least,
      `${n} lines matched, below the ${least} this guard allows against the ` +
      `${floor} last measured — the rejoin is eating records again (it read ` +
      "265, then 293, before it read " + floor + ")");
    /* AND NOT WILDLY MORE, WHICH WOULD MEAN THE PATTERN HAS GONE LOOSE AND IS
       matching the document's headers, footers and page numbers as licensees. */
    assert.ok(n <= floor * 1.25,
      `${n} lines matched against ${floor} last measured — a jump that size ` +
      "is a pattern matching things that are not records");
    /* The name must be GREEDY. Non-greedy read South Dakota's "ADVANCED
       SUNFLOWER LLC BHURON" as a company called "ADVANCED" whose permit letter
       was the S of SUNFLOWER, and split "Berne Hi-Way Hatchery, Inc." into a
       city called "Inc. Berne". */
    assert.ok(out[1].length > 8, `name truncated to "${out[1]}" — the pattern went non-greedy`);
    assert.ok(!/^(Inc|LLC)\.?\s/.test(out[2]), `city "${out[2]}" is the tail of the company name`);
  });
}

/* TWO DOCUMENTS FROM ONE AGENCY, IN TWO DIFFERENT SHAPES.
 *
 * Nebraska's PSC publishes a dealer list and a warehouse list side by side:
 *
 *   dealers    ADVANCED SUNFLOWER, LLC 3070 35,000 HURON, SD
 *   warehouses 19 J. E. MEURET GRAIN CO., INC. BRUNSWICK ANTELOPE
 *
 * Licence first instead of last, no capacity, no state, a county instead.
 * Running the dealer's pattern over the warehouse list returned ZERO, which is
 * the right failure and the reason each document gets its own line rather than
 * one clever regex for all of them.
 *
 * Two things the warehouse list then taught:
 *
 *   - "43 TOTAL LICENSED GRAIN WAREHOUSES" — the totals line, with the number
 *     IN FRONT. It parsed as a business called "TOTAL LICENSED" in a town
 *     called "GRAIN", and it was invisible to the completeness check, so that
 *     document had no guard at all.
 *   - NAME CITY COUNTY with nothing between them means a two-word town is split
 *     by whitespace and its first word joins the company name: "ELYS
 *     INCORPORATED GUIDE" / "ROCK". Nothing in this repository KNOWS the right
 *     answer, so both readings are carried and the geocoder decides — "ROCK, NE"
 *     does not resolve and "GUIDE ROCK, NE" does.
 */
const NEW = "https-psc-nebraska-gov-sites-default-files-doc-2026-07-28-20grain-20warehouse-20.txt";

test("Nebraska's warehouse list has its own shape and is read whole", { skip: !existsSync(fixture(NEW)) }, () => {
  const out = pyOn(`
src = [s for s in m.SOURCES if s["state"] == "NE" and s["kind"] == "warehouse"][0]
t = open(r"${fixture(NEW)}", encoding="utf-8", errors="replace").read()
r = m.pdf_records(t, {}, src["pattern"])
junk = [x for x in r if x["name"].upper().startswith("TOTAL")]
print(len(r), m.stated_total(t), len(junk), sep="|")`).split("|");
  assert.equal(Number(out[0]), 43, "the warehouse list is not being read");
  assert.equal(out[1], "(0, 43)", "the totals line with the number in front is invisible to the check");
  assert.equal(Number(out[2]), 0, "the totals line came back as a business called TOTAL");
});

test("a two-word town keeps its alternative instead of being guessed", { skip: !existsSync(fixture(NEW)) }, () => {
  const out = pyOn(`
src = [s for s in m.SOURCES if s["state"] == "NE" and s["kind"] == "warehouse"][0]
t = open(r"${fixture(NEW)}", encoding="utf-8", errors="replace").read()
r = m.pdf_records(t, {}, src["pattern"])
alts = {x["cityAlt"] for x in r if x.get("cityAlt")}
print("GUIDE ROCK" in alts, "BATTLE CREEK" in alts, "WEST POINT" in alts, sep="|")`).split("|");
  for (const [i, town] of ["GUIDE ROCK", "BATTLE CREEK", "WEST POINT"].entries())
    assert.equal(out[i], "True", `${town} lost its first word to the company name`);
});

test("both spellings of a printed total are read, in either order", () => {
  const out = pyOn(`
for t in ("TOTAL LICENSED GRAIN DEALERS 116", "43 TOTAL LICENSED GRAIN WAREHOUSES",
          "Showing 25 out of 251", "43 Farmers Coop GENEVA FILLMORE"):
    print(m.stated_total(t))`).split("\n");
  assert.equal(out[0], "(0, 116)");
  assert.equal(out[1], "(0, 43)", "the number-first spelling is not recognised");
  assert.equal(out[2], "(25, 251)");
  assert.equal(out[3], "None", "an ordinary licence row is being read as a total");
});

/* A STATE'S LIST IS WHO IT LICENSES, NOT WHO IS INSIDE ITS BORDERS.
 *
 * Iowa writes "out-of-state" in the county column for a business licensed to
 * buy Iowa grain from somewhere else. Thirty-one of them were counted as Iowa
 * elevators and looked for in the Iowa gazetteer: Lighthouse Commodities of
 * Bismarck (701 = North Dakota), Viserion of Boulder, Bunge of Chesterfield
 * (314 = Missouri). They never resolved — the right outcome for the wrong
 * reason. The towns are fine; they are simply not in Iowa.
 *
 * The licensing state is kept and the location state emptied rather than
 * guessed. Nothing here knows where Boulder is, and an area code is a hint, not
 * an address. An unplaced pin is honest; a pin in the wrong state is not, and
 * neither is a state count inflated by thirty-one businesses somewhere else.
 */
test("a business the state says is out-of-state is not counted as in it", () => {
  const out = pyOn(`
for c in ("out-of-state", "Out of State", "OUT OF STATE", "Boone"):
    r = {"name": "X", "city": "Bismarck", "county": c, "state": "IA", "st": "IA"}
    m.mark_out_of_state(r)
    print(r.get("outOfState"), r.get("licensedBy"), repr(r.get("st")), sep="|")`).split("\n");
  for (const i of [0, 1, 2]) {
    const [flag, by, st] = out[i].split("|");
    assert.equal(flag, "True", `spelling ${i} not recognised as out-of-state`);
    assert.equal(by, "IA", "the licensing state must be kept, not thrown away");
    assert.equal(st, "''", "the licensing state is being claimed as the location");
  }
  const [flag, , st] = out[3].split("|");
  assert.equal(flag, "None", "a real county was mistaken for the out-of-state marker");
  assert.equal(st, "'IA'", "an ordinary Iowa business lost its state");
});

/* A RECORD THAT WRAPS ONTO A SECOND LINE IS STILL ONE RECORD.
 *
 * South Dakota's PDF wraps long licensee names:
 *     FREDERICK FARMERS ELEVATOR
 *     BHARROLD A+VCS
 * a name with no location, and a location with no name. One line at a time,
 * that produced garbage that LOOKED like data — a company called "FREDERICK" in
 * a town called "ARMERS" — because the class pattern accepted any capitalised
 * word, so "ELEVATOR" passed as a licence class. The Class column is only ever
 * A+VCS, A or B.
 *
 * A wrong town is worse than a missing one: it puts a pin somewhere real.
 */
const SDF = "http-puc-sd-gov-commission-warehouse-grain-20license-20info-pdf.txt";
test("South Dakota's wrapped lines are rejoined, not parsed as separate records", { skip: !existsSync(fixture(SDF)) }, () => {
  const out = pyOn(`
import re
src = [s for s in m.SOURCES if s["state"] == "SD"][0]
t = open(r"${fixture(SDF)}", encoding="utf-8", errors="replace").read()
d = {}
r = m.pdf_records(t, d, src["pattern"], src.get("continuation"), src.get("cityStrip"))
bad = [x for x in r if x["city"] in ("A", "ARMERS", "EST") or re.search(r"-\\d+$", x["city"] or "")]
names = {x["name"] for x in r}
# THE 63 THE JOINER USED TO EAT MUST EACH BE PRESENT AS THEIR OWN RECORD.
# Re-implementing the join here would be circular — it would carry the same gate
# and could only ever report success. So this asks the OUTPUT instead: take every
# line that has a wrapped fragment's shape but is really a record, and require
# that its own name came through. Before the gate, none of them did.
lines = [re.sub(r"\\s+", " ", l.strip()) for l in t.splitlines() if l.strip()]
rxc, rxr = re.compile(src["continuation"]), re.compile(src["pattern"])
lookalikes = [rxr.match(l) for l in lines if rxc.match(l) and rxr.match(l)]
have = {x["name"] for x in r}
missing = [g.group("name").strip() for g in lookalikes if g.group("name").strip() not in have]
mashed = [x for x in r if m._run_together(x["name"])]
print(len(r), d.get("pdfLinesJoined"), len(bad), "FREDERICK" in names,
      "%d/%d" % (len(missing), len(lookalikes)), len(mashed), sep="|")`).split("|");
  assert.ok(Number(out[0]) >= 350, `${out[0]} records — the rejoin lost some`);
  /* EXACTLY THE GENUINE WRAPS, AND NOTHING ELSE. This used to assert "more than
     50 joined", which passed at 81 — and 63 of that 81 were whole records being
     glued onto the line above. A floor cannot catch over-joining, so the number
     is exact and the next assertion states the rule behind it. */
  assert.equal(Number(out[1]), 18, `${out[1]} lines joined; the document has 18 wraps`);
  assert.equal(out[4], "0/63", `${out[4]} records whose line looked like a fragment were eaten by the joiner`);
  assert.ok(Number(out[2]) <= 5, `${out[2]} records still have a fragment for a town`);
  assert.equal(out[3], "False", 'a company called "FREDERICK" is a wrapped name read as a record');
  assert.equal(out[5], "0", `${out[5]} records name two states — several licensees on one line`);
});

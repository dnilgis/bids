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

for (const [file, total] of [[IOWA_DEALERS, 251], [IOWA_WHOUSE, 102]]) {
  test(`the Iowa list page publishes its own total of ${total}`, { skip: !existsSync(fixture(file)) }, () => {
    const out = parse(file);
    assert.match(out, new RegExp(`the page says: 25 out of ${total}`),
      "the completeness check reads this line; without it 25 of 251 looks like success");
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
  const out = py(`${LOAD}
routes = sorted({s.get("route", "html") for s in m.SOURCES})
print(",".join(routes))
print(len(m.SOURCES), len({s["state"] for s in m.SOURCES}))
`).trim().split("\n");
  for (const r of out[0].split(",")) {
    assert.ok(["html", "csv", "pdf"].includes(r), `source declares unknown route "${r}"`);
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

for (const [file, label, want] of [[NDAK, "North Dakota", 285], [ARK, "Arkansas", 32]]) {
  test(`${label} publishes no phone column and is still read`, { skip: !existsSync(fixture(file)) }, () => {
    const n = Number(pyOn(`
b = open(r"${fixture(file)}", encoding="utf-8", errors="replace").read()
print(len(m.extract(b, {})))`));
    assert.equal(n, want, `${n} records — a state without phones is being dropped again`);
  });
}

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

for (const [st, file, want] of [["IN", PDFS.IN, 307], ["SD", PDFS.SD, 265], ["NE", PDFS.NE, 114]]) {
  test(`the ${st} bid sheet's own line shape is read`, { skip: !existsSync(fixture(file)) }, () => {
    const out = pyOn(`
src = [s for s in m.SOURCES if s["state"] == "${st}" and s.get("pattern")][0]
t = open(r"${fixture(file)}", encoding="utf-8", errors="replace").read()
d = {}
r = m.pdf_records(t, d, src["pattern"])
print(len(r), r[0]["name"], r[0].get("city", ""), sep="|")`).split("|");
    assert.equal(Number(out[0]), want, `${out[0]} of an expected ${want} lines matched`);
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

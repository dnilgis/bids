/* THE FINDER MUST NEVER FILE A WEBSITE IT CANNOT PROVE.
 *
 * Missing a co-operative's site costs us a row on a worklist. Filing the WRONG
 * site puts a stranger's phone number and a stranger's board under a real
 * elevator's name, and everything downstream — the map, the merged feed, the
 * two Emmert sites — believes it. So the tests that matter most here are the
 * ones where a page answers 200, looks entirely plausible, and is REFUSED.
 *
 * All of this runs with no network. The candidate rule and the evidence rule
 * are pure; the fetching is injected. One real HTTP round trip against a
 * loopback server covers getText itself, because a transport nothing exercises
 * is a transport nobody has tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  nameCore, candidateHosts, phoneOnPage, evidenceIn, verdict, digits10, textOf,
  addressParts, addressOnPage, isPlaceholderPhone, usablePhone,
} from "../lib/urlfinder.mjs";
import {
  askBusiness, rootDisallowed, parseCsv, keyOf, decided, getText,
  PROBE_VERSION, foundList, worklist,
  NEVER_CRAWL, isDenied, hostOf, keep, record,
} from "../scripts/urlfinder.mjs";

const BIZ = { name: "Ursa Farmers Cooperative Co", city: "Ursa", state: "IL", phone: "217-964-2131" };

/* --- the name -------------------------------------------------------------- */

test("legal tails come off and trade words stay on", () => {
  assert.deepEqual(nameCore("Ursa Farmers Cooperative Co"), ["ursa", "farmers", "cooperative"]);
  assert.deepEqual(nameCore("The Andersons Inc"), ["andersons"]);
  assert.deepEqual(nameCore("A & B Grain LLC"), ["a", "and", "b", "grain"]);
  /* "cooperative", "farmers" and "grain" are SIGNAL here, whatever
     lib/place.mjs's SUFFIX list says about them when the question is towns. */
  assert.deepEqual(nameCore("Farmers Cooperative Company"), ["farmers", "cooperative"]);
});

test("a name that is nothing but boilerplate yields no candidate", () => {
  assert.deepEqual(candidateHosts("LLC"), []);
  assert.deepEqual(candidateHosts(""), []);
  assert.deepEqual(candidateHosts("   "), []);
});

test("candidates are name-derived, ordered, deduped and capped", () => {
  const h = candidateHosts(BIZ.name);
  assert.ok(h.length <= 8);
  assert.equal(new Set(h).size, h.length, "no duplicates");
  assert.equal(h[0], "ursafarmerscooperative.com", ".com on the full name comes first");
  assert.ok(h.includes("ursafarmerscoop.com"));
  assert.ok(h.includes("ursafarmers.com"));
  assert.ok(h.some((x) => x.endsWith(".coop")), ".coop is tried — it is restricted to co-operatives");
});

test("the town is NOT spliced into a hostname", () => {
  /* Two facts we hold do not entitle us to invent a third. */
  const h = candidateHosts("Farmers Cooperative", {});
  assert.ok(!h.some((x) => x.includes("dorchester")));
});

test("a stem under five characters is not a hostname anybody is identified by", () => {
  assert.ok(!candidateHosts("Key Cooperative").includes("key.com"));
  assert.ok(candidateHosts("Key Cooperative").includes("keycoop.com"));
});

/* --- the phone, which is the whole proof ---------------------------------- */

test("a phone is recognised however the page punctuates it", () => {
  for (const rendered of [
    "(217) 964-2131", "217-964-2131", "217.964.2131", "2179642131",
    "1-217-964-2131", "Call 217 964 2131 today",
    "<span>217</span>-<span>964</span>-<span>2131</span>",
    "tel:+12179642131",
  ]) assert.equal(phoneOnPage(`<p>${rendered}</p>`, BIZ.phone), true, rendered);
});

test("a phone that is not on the page is not found on it", () => {
  assert.equal(phoneOnPage("<p>(217) 964-2132</p>", BIZ.phone), false, "one digit out");
  assert.equal(phoneOnPage("<p>217-964</p><p>lots of other text here</p><p>2131</p>", BIZ.phone),
    false, "the groups are too far apart to be one number");
  assert.equal(phoneOnPage("<p>nothing numeric</p>", BIZ.phone), false);
  assert.equal(phoneOnPage("<p>217-964-2131</p>", "964-2131"), false, "a nine-digit phone is not identity");
});

/* --- the evidence and the line it draws ----------------------------------- */

test("a town is matched on word boundaries, not as a substring", () => {
  const ada = { name: "Ada Grain", city: "Ada", state: "MN", phone: "218-784-1000" };
  assert.equal(evidenceIn("<p>we ship to Canada daily</p>", ada).town, false);
  assert.equal(evidenceIn("<p>Ada, Minnesota</p>", ada).town, true);
});

test("the state counts by abbreviation or by name", () => {
  assert.equal(evidenceIn("<p>Ursa, IL 62376</p>", BIZ).state, true);
  assert.equal(evidenceIn("<p>Ursa, Illinois</p>", BIZ).state, true);
  assert.equal(evidenceIn("<p>Ursa</p>", BIZ).state, false);
});

test("only a phone match is a verdict of phone", () => {
  const page = "<h1>Ursa Farmers Cooperative</h1><p>Ursa, Illinois</p><p>(217) 964-2131</p>";
  assert.equal(verdict(evidenceIn(page, BIZ)), "phone");
});

test("a page naming the town and the business, with no phone, is TOWN-ONLY and never a website", () => {
  /* This is the case the whole design turns on. It looks right. It is not
     identity — build_directory.mjs: "a town can hold three elevators". */
  const page = "<h1>Ursa Farmers Cooperative</h1><p>Serving Ursa, Illinois since 1919</p>";
  const ev = evidenceIn(page, BIZ);
  assert.equal(ev.phone, false);
  assert.equal(verdict(ev), "town-only");
});

test("a plausible page with the town but no name word is refused outright", () => {
  const page = "<h1>Ursa Village Hardware</h1><p>Ursa, Illinois</p>";
  const b = { ...BIZ, name: "Kellerman Brothers" };
  assert.equal(verdict(evidenceIn(page, b)), "none");
});

test("a parked page is refused", () => {
  const page = "<html><title>ursafarmers.com is for sale</title><body>Buy this domain. "
             + "Related searches: grain, farm supply, cooperative.</body></html>";
  assert.equal(verdict(evidenceIn(page, BIZ)), "none");
});

test("textOf drops script and style bodies", () => {
  const t = textOf("<style>.a{content:'Ursa'}</style><script>var x='2179642131'</script><p>Hello</p>");
  assert.ok(!t.includes("Ursa"));
  assert.ok(!t.includes("2179642131"));
  assert.ok(t.includes("Hello"));
});

/* --- robots --------------------------------------------------------------- */

test("a blanket disallow is honoured, and a narrower one is not a blanket", () => {
  assert.equal(rootDisallowed("User-agent: *\nDisallow: /"), true);
  assert.equal(rootDisallowed("User-agent: *\nDisallow: /admin/"), false);
  assert.equal(rootDisallowed("User-agent: BadBot\nDisallow: /"), false, "not aimed at everyone");
  assert.equal(rootDisallowed("User-agent: *\nAllow: /\nDisallow: /"), false, "an explicit Allow wins");
  assert.equal(rootDisallowed(""), false);
  assert.equal(rootDisallowed("<html>404 not found</html>"), false, "a 404 page is not a rule");
});

/* --- the input ------------------------------------------------------------ */

test("a quoted comma in a business name survives the CSV reader", () => {
  /* The real row: "Auvergne Grain Company, L.L.C.". Split on "," and the name
     becomes "Auvergne Grain Company" and the city becomes " L.L.C.". */
  const rows = parseCsv('name,city,state\n"Auvergne Grain Company, L.L.C.",Newport,AR\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Auvergne Grain Company, L.L.C.");
  assert.equal(rows[0].city, "Newport");
});

test("two businesses of the same name in different towns are different ledger rows", () => {
  const a = { name: "Farmers Cooperative", city: "Dorchester", state: "NE", phone: "402-946-2211" };
  const b = { name: "Farmers Cooperative", city: "Hallam", state: "NE", phone: "402-787-2255" };
  assert.notEqual(keyOf(a), keyOf(b));
});

test("a found website is decided forever; a write-off only until the probe improves", () => {
  assert.equal(decided({ status: "found" }), true);
  assert.equal(decided({ status: "exhausted", probeVersion: PROBE_VERSION }), true);
  assert.equal(decided({ status: "exhausted", probeVersion: PROBE_VERSION - 1 }), false);
  assert.equal(decided(undefined), false);
});

/* --- one business, end to end, with the transport injected ---------------- */

const serve = (pages) => {
  const asked = [];
  return {
    asked,
    get: async (url) => {
      asked.push(url);
      const body = pages[url];
      if (body === undefined) return { status: 0, body: "", url, why: "getaddrinfo ENOTFOUND" };
      return { status: 200, body, url };
    },
  };
};

test("the right site is found, proved, and the questioning stops there", async () => {
  const s = serve({
    "https://ursafarmerscooperative.com/":
      "<h1>Ursa Farmers Cooperative</h1><p>Ursa, IL</p><p>(217) 964-2131</p>",
  });
  const rec = await askBusiness(BIZ, { get: s.get, robotsCache: new Map() });
  assert.equal(rec.status, "found");
  assert.equal(rec.website, "https://ursafarmerscooperative.com/");
  assert.equal(rec.probeVersion, PROBE_VERSION);
  assert.ok(!s.asked.some((u) => u.includes("ursafarmerscoop.com")),
    "a proved answer ends the questioning — later candidates are never asked");
});

test("a site that answers but cannot be proved is EXHAUSTED, not found", async () => {
  /* Every candidate answers 200 with something agricultural and none carries
     the phone. This is the failure this tool is built against. */
  const pages = {};
  for (const h of candidateHosts(BIZ.name))
    pages[`https://${h}/`] = "<h1>Grain marketing</h1><p>Cash bids, storage, agronomy.</p>";
  const s = serve(pages);
  const rec = await askBusiness(BIZ, { get: s.get, robotsCache: new Map() });
  assert.equal(rec.status, "exhausted");
  assert.equal(rec.website, null);
  assert.match(rec.why, /none carried the phone or the street address we hold/);
});

test("a town-only match is recorded as such and carries no acceptance", async () => {
  const s = serve({
    "https://ursafarmerscooperative.com/":
      "<h1>Ursa Farmers Cooperative</h1><p>Ursa, Illinois</p><p>call the office</p>",
  });
  const rec = await askBusiness(BIZ, { get: s.get, robotsCache: new Map() });
  assert.equal(rec.status, "town-only");
  assert.ok(rec.host, "the host is kept so a person can look");
  assert.notEqual(rec.status, "found");
});

test("robots.txt is asked first, and a disallowed host is never fetched", async () => {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    if (url.endsWith("/robots.txt")) return { status: 200, body: "User-agent: *\nDisallow: /", url };
    return { status: 200, body: `<p>(217) 964-2131</p>`, url };
  };
  const rec = await askBusiness(BIZ, { get, robotsCache: new Map() });
  assert.equal(rec.status, "exhausted", "nothing may be accepted from a host that said no");
  assert.ok(asked.every((u) => u.endsWith("/robots.txt")),
    `only robots was fetched; got ${asked.filter((u) => !u.endsWith("/robots.txt")).join(", ")}`);
  assert.ok(rec.tried.every((t) => t.verdict === "robots"));
});

test("a name with no candidates is not asked at all", async () => {
  const s = serve({});
  const rec = await askBusiness({ ...BIZ, name: "LLC" }, { get: s.get, robotsCache: new Map() });
  assert.equal(rec.status, "no-candidates");
  assert.deepEqual(s.asked, []);
});

/* --- the transport itself, over real HTTP --------------------------------- */

test("getText reads a page, refuses a non-page, and survives a 404", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>hello</p>"); }
    else if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.4 ..."); }
    else if (req.url === "/big") { res.writeHead(200, { "content-type": "text/html" }); res.end("x".repeat(50_000)); }
    else { res.writeHead(404); res.end("nope"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await getText(`${base}/ok`)).body, "<p>hello</p>");
    const pdf = await getText(`${base}/pdf`);
    assert.equal(pdf.body, "", "a PDF proves nothing about a business");
    assert.match(pdf.why, /content-type/);
    const four = await getText(`${base}/missing`);
    assert.equal(four.body, "");
    assert.equal(four.status, 404);
    const big = await getText(`${base}/big`, { maxBytes: 1000 });
    assert.equal(big.body.length, 1000, "the body is capped");
  } finally { server.close(); }
});

test("getText returns a reason rather than throwing when the host does not exist", async () => {
  const r = await getText("https://this-host-does-not-exist.invalid/", { timeoutMs: 3000 });
  assert.equal(r.status, 0);
  assert.equal(r.body, "");
  assert.ok(r.why.length, "the reason is kept");
});

/* --- the outputs ---------------------------------------------------------- */

test("the found list is a probe list scripts/discover.mjs can read", async () => {
  const { readList } = await import("../scripts/discover.mjs");
  const text = foundList([{ website: "https://ursafarmerscooperative.com/", name: "Ursa Farmers Cooperative Co",
                            city: "Ursa", state: "IL", source: "registry-il" }]);
  const urls = readList(text);
  assert.deepEqual(urls, ["https://ursafarmerscooperative.com/"],
    "the comment carrying the evidence must not become part of the URL");
});

test("an empty found list is still a readable probe list, not a broken one", async () => {
  const { readList } = await import("../scripts/discover.mjs");
  assert.deepEqual(readList(foundList([])), []);
});

test("the worklist quotes a name containing a comma", () => {
  const csv = worklist([{ name: "Auvergne Grain Company, L.L.C.", city: "Newport", state: "AR",
                          phone: "870-523-1000", host: "x.com", website: "https://x.com/", why: "t", source: "registry-ar" }]);
  assert.match(csv, /"Auvergne Grain Company, L\.L\.C\."/);
  assert.equal(csv.split("\n")[0], "name,city,state,phone,address,host,url,why,source");
});

/* --- the second proof: the street address -------------------------------- */

test("a post-office box is not a place and yields no address proof", () => {
  assert.deepEqual(addressParts("PO Box 617"), { number: null, words: [] });
  assert.equal(addressOnPage("<p>PO Box 617, Colfax WA</p>", "PO Box 617"), false);
});

test("a box run together with the street is separated, not swallowed", () => {
  /* The real Arkansas row: "4337 Hwy 158PO Box 549". */
  assert.deepEqual(addressParts("4337 Hwy 158PO Box 549"), { number: "4337", words: ["158"] });
});

test("the route number carries a rural address, not the word highway", () => {
  /* First version kept only alphabetic words and reduced "1529 Highway 193" to
     "highway", which matches half of Arkansas. */
  assert.deepEqual(addressParts("1529 Highway 193"), { number: "1529", words: ["193"] });
  assert.equal(addressOnPage("<p>1529 Highway 193, Wynne AR</p>", "1529 Highway 193"), true);
  assert.equal(addressOnPage("<p>We are on Highway 193 in Wynne</p>", "1529 Highway 193"), false,
    "the house number has to be there too");
});

test("an address of nothing but street types proves nothing", () => {
  assert.deepEqual(addressParts("6211 Southwest Drive").words, []);
  assert.equal(addressOnPage("<p>6211 Southwest Drive</p>", "6211 Southwest Drive"), false);
});

test("two unrelated numbers in prose are not an address", () => {
  /* THE FIRST VERSION OF THIS TEST PASSED FOR THE WRONG REASON. It used
     "Founded 1529. Call about route 193", where the full stop straight after
     the number stops the match whatever the word bound is — so widening
     ADDRESS_GAP_WORDS from 2 to 8 left it green, and the mutation went
     uncaught. This sentence puts plain whitespace between the two numbers, so
     the ONLY thing refusing it is the bound. */
  const prose = "<p>1529 bushels of corn were sold on route 193 last week</p>";
  assert.equal(addressOnPage(prose, "1529 Highway 193"), false,
    "six intervening words is prose, not an address");
  assert.equal(addressOnPage("<p>1529 Highway 193</p>", "1529 Highway 193"), true,
    "and one intervening word is still an address");
});

test("an address proves a site ONLY with the town and the state beside it", () => {
  const b = { name: "Erwin - Keith, Inc.", city: "Wynne", state: "AR",
              phone: "", address: "1529 Highway 193" };
  const full = "<h1>Erwin-Keith</h1><p>1529 Highway 193, Wynne, AR 72396</p>";
  assert.equal(verdict(evidenceIn(full, b)), "address");

  /* The same address, no town named: refused. A house number on its own is a
     number. */
  const noTown = "<h1>Erwin-Keith</h1><p>1529 Highway 193</p>";
  const ev = evidenceIn(noTown, b);
  assert.equal(ev.address, true);
  assert.equal(ev.town, false);
  assert.notEqual(verdict(ev), "address");
});

test("a phone still outranks an address when both are on the page", () => {
  const b = { name: "Erwin - Keith, Inc.", city: "Wynne", state: "AR",
              phone: "870-238-1234", address: "1529 Highway 193" };
  const page = "<p>1529 Highway 193, Wynne, AR</p><p>870-238-1234</p>";
  assert.equal(verdict(evidenceIn(page, b)), "phone");
});

/* --- filler that is ten digits long -------------------------------------- */

test("a filler phone is not identity", () => {
  /* data/known-elevators.json really does carry 9999999999 for CGB Pine Bluff. */
  for (const p of ["9999999999", "0000000000", "1234567890", "111-111-1111"]) {
    assert.equal(isPlaceholderPhone(p), true, p);
    assert.equal(usablePhone(p), false, p);
    assert.equal(phoneOnPage("<p>9999999999 0000000000 1234567890 1111111111</p>", p), false,
      `${p} must never match, even against a page full of it`);
  }
  assert.equal(usablePhone("217-964-2131"), true);
  assert.equal(usablePhone("718-123-4567"), true, "a real number with a run in it is still real");
});

/* --- one fetch per host ---------------------------------------------------- */

test("branches of one operator do not re-fetch the same host", async () => {
  /* data/known-elevators.json holds Riceland Co-op three times and ADM Grain
     dozens of times, all deriving the same candidate hostnames. */
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    return { status: 200, body: "<p>nothing identifying</p>", url };
  };
  const robotsCache = new Map(), pageCache = new Map();
  const a = { name: "Riceland Co-op", city: "Des Arc", state: "AR", phone: "870-256-4125" };
  const b = { name: "Riceland Co-op", city: "Weiner", state: "AR", phone: "870-684-1234" };
  await askBusiness(a, { get, robotsCache, pageCache });
  const after = asked.length;
  await askBusiness(b, { get, robotsCache, pageCache });
  assert.equal(asked.length, after, "the second branch asked no host a second time");
  assert.ok(after > 0, "the first branch did ask");
});

/* --- the input the finder depends on ------------------------------------- */

test("no row in the gap list has something to prove by and no name to guess from", () => {
  /* THE REGRESSION THIS PINS, found 2026-09-08. scripts/gap_lists.mjs read
     `e.company` from data/known-elevators.json, whose records carry `facility`.
     Every one of the 1,804 Barchart rows came out with an EMPTY NAME — 1,585 of
     them holding a good phone and nothing to attach it to — and the row count
     was right, so nothing looked wrong. It cut this tool's reach from 2,539
     businesses to 946. */
  const rows = parseCsv(readFileSync(new URL("../data/gaps/no-website-on-file.csv", import.meta.url), "utf8"));
  assert.ok(rows.length > 1000, `${rows.length} rows — the gap list is present`);
  const nameless = rows.filter((r) => !String(r.name ?? "").trim()
    && (usablePhone(r.phone) || addressParts(r.address).number));
  assert.equal(nameless.length, 0,
    `${nameless.length} row(s) carry a phone or an address and no name at all, `
    + `e.g. ${JSON.stringify(nameless.slice(0, 3))} — gap_lists.mjs is reading a key `
    + `that file does not have`);
});

/* --- a run that reached nothing has found nothing ------------------------ */

test("a host that could not be reached is NOT decided", async () => {
  /* scripts/discover.mjs's rule, and this tool learned it the same way: the
     first run of it happened in a sandbox with no route to any of these hosts
     and wrote forty businesses off as `exhausted` in six seconds. --resume
     would then have skipped every one of them for good. */
  const get = async (url) => ({ status: 0, body: "", url, code: "ETIMEDOUT", why: "timed out" });
  const rec = await askBusiness(BIZ, { get, robotsCache: new Map(), pageCache: new Map() });
  assert.equal(rec.status, "unreachable");
  assert.equal(decided(rec), false, "it must come round again on the next run");
  assert.match(rec.why, /has not been asked yet/);
});

test("a hostname that does not exist IS decided — that is an answer about the guess", async () => {
  const get = async (url) => ({ status: 0, body: "", url, code: "ENOTFOUND", why: "no such host" });
  const rec = await askBusiness(BIZ, { get, robotsCache: new Map(), pageCache: new Map() });
  assert.equal(rec.status, "exhausted");
  assert.equal(decided({ ...rec, probeVersion: PROBE_VERSION }), true);
});

test("one unreachable candidate is enough to hold the whole business open", async () => {
  /* Otherwise the run writes the business off on the strength of the seven
     hostnames that happen not to exist, having never reached the one that does. */
  const get = async (url) => url.includes("ursafarmerscooperative.com")
    ? { status: 0, body: "", url, code: "ETIMEDOUT", why: "timed out" }
    : { status: 0, body: "", url, code: "ENOTFOUND", why: "no such host" };
  const rec = await askBusiness(BIZ, { get, robotsCache: new Map(), pageCache: new Map() });
  assert.equal(rec.status, "unreachable");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A PROOF IS NOT THROWN AWAY BECAUSE OF ONE BAD MORNING
 *
 * Measured 2026-09-08: Central Farm Service was `found`, proved by phone on
 * cfscoop.com, in two rows. Both came back `unreachable` after
 * centralfarmservice.com answered ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR once, and
 * cfscoop.com left probe-lists/urlfinder-found.txt.
 *
 * The rule was already written down. It lived in decided(), which filters the
 * QUEUE and only when --resume is passed; the write itself was unconditional.
 * These tests are against the WRITE, because that is the thing that was wrong.
 * ═══════════════════════════════════════════════════════════════════════════ */

const PROVEN = { status: "found", provedBy: "phone", website: "https://cfscoop.com/",
                 host: "cfscoop.com", probeVersion: PROBE_VERSION };
const BAD_DAY = { status: "unreachable", provedBy: null, website: null, host: null,
                  probeVersion: PROBE_VERSION };

test("a proved row survives a run that could not reach the host", () => {
  assert.equal(keep(PROVEN, BAD_DAY), PROVEN);
  assert.equal(keep(PROVEN, { ...BAD_DAY, status: "exhausted" }), PROVEN);
  assert.equal(keep(PROVEN, { ...BAD_DAY, status: "town-only" }), PROVEN);
});

test("a new proof still replaces an older one", () => {
  const better = { ...PROVEN, website: "https://www.cfscoop.com/markets", provedBy: "address" };
  assert.equal(keep(PROVEN, better), better);
});

test("a row that was never proved is simply overwritten", () => {
  assert.equal(keep(undefined, BAD_DAY), BAD_DAY);
  assert.equal(keep({ status: "exhausted" }, BAD_DAY), BAD_DAY);
});

test("a proof standing on a denied host is not a proof and does not survive", () => {
  const onDenied = { ...PROVEN, website: "https://www.bigriverbids.com/", host: "bigriverbids.com" };
  assert.equal(keep(onDenied, BAD_DAY), BAD_DAY, "a row we should never have read is not defended");
  assert.equal(decided(onDenied), false, "--resume would skip it forever and it would never correct");
  assert.equal(decided(PROVEN), true, "an ordinary proof is still permanent");
});

test("record() is how a row reaches the ledger, and it keeps the proof", () => {
  const ledger = { businesses: { k: PROVEN } };
  const kept = record(ledger, "k", BAD_DAY);
  assert.equal(kept, PROVEN);
  assert.equal(ledger.businesses.k, PROVEN);
  record(ledger, "new", BAD_DAY);
  assert.equal(ledger.businesses.new, BAD_DAY);
});

/* COUNT THE COPIES. The bug was one unguarded assignment. A second one added
   later would restore it while every test above still passed. */
test("there is exactly one writer into the ledger", () => {
  const src = readFileSync(new URL("../scripts/urlfinder.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const writes = src.match(/ledger\.businesses\[[^\]]*\]\s*=/g) || [];
  assert.equal(writes.length, 1,
    "ledger.businesses is assigned in " + writes.length + " places; keep() guards one of them");
  assert.match(src, /export function record\(ledger, key, rec\) \{[\s\S]{0,200}keep\(/,
    "the one writer does not go through keep()");
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A HOST THIS PROJECT DOES NOT FETCH IS NOT FETCHED, BY ANY ROUTE
 * ═══════════════════════════════════════════════════════════════════════════ */

test("the standing no-crawl decisions are actually in the list", () => {
  assert.ok(NEVER_CRAWL.has("bigriverbids.com"));
  assert.ok(NEVER_CRAWL.has("apps.agr.illinois.gov"));
});

/* THE LIST MUST NOT ESCAPE THIS PROBE.
   sources/boyceville.json reads https://bigriverbids.com/cashbidssingle-2121
   on every poll pass, by arrangement, and data/boyceville.json is what both
   Emmert sites consume. This list is about a crawler guessing at hosts, not
   about that one arranged URL. If it is ever imported by the reader, Boyceville
   stops and two customer sites go quiet with nothing red to show it. */
test("the no-crawl list is urlfinder's alone, and the arranged board still stands", () => {
  const root = new URL("../", import.meta.url);
  const src = readFileSync(new URL("sources/boyceville.json", root), "utf8");
  const boyceville = JSON.parse(src);
  assert.equal(boyceville.enabled, true, "the arranged board has been disabled");
  assert.ok(isDenied(hostOf(boyceville.url)),
    "this test is only meaningful while the arranged board is on a listed host");

  const readers = ["scripts/poll.mjs", "scripts/one-pass.sh", "scripts/merge_bids.mjs",
                   "scripts/discover.mjs", "scripts/board-sweep.mjs", "scripts/build_directory.mjs"];
  let looked = 0;
  for (const f of readers) {
    let body;
    try { body = readFileSync(new URL(f, root), "utf8"); } catch { continue; }
    looked++;
    assert.ok(!/NEVER_CRAWL|isDenied/.test(body),
      f + " imports urlfinder's no-crawl list; that would stop the arranged Boyceville read");
  }
  assert.ok(looked >= 4, "this check looked at " + looked + " files and is not searching");
});

test("the denylist matches a host and its subdomains, and nothing that merely ends the same way", () => {
  assert.ok(isDenied("bigriverbids.com"));
  assert.ok(isDenied("www.bigriverbids.com"));
  assert.ok(isDenied("cash.bigriverbids.com"));
  assert.ok(!isDenied("notbigriverbids.com"), "a suffix test without the dot matches the wrong hosts");
  assert.ok(!isDenied("bigriverunitedenergy.com"), "the host we are allowed to ask is not denied");
  assert.ok(!isDenied(""), "an unparseable URL is not silently permitted by being empty");
});

test("getText refuses a denied host without making a request", async () => {
  let called = 0;
  const fetchImpl = async () => { called++; throw new Error("should never be called"); };
  const r = await getText("https://www.bigriverbids.com/", { fetchImpl });
  assert.equal(called, 0, "the request was made anyway");
  assert.equal(r.body, "");
  assert.equal(r.denied, true);
});

test("getText throws away a body that arrived from a denied host by redirect", async () => {
  /* THE CASE THAT BROKE IT. The host asked is allowed; the host that answered
     is not, and 283 KB of it came back. */
  const fetchImpl = async () => ({
    ok: true, status: 200, url: "https://www.bigriverbids.com/",
    headers: { get: () => "text/html" },
    text: async () => "<p>217-964-2131</p>",
  });
  const r = await getText("https://bigriverunitedenergy.com/", { fetchImpl });
  assert.equal(r.body, "", "the denied page was read");
  assert.equal(r.denied, true);
  assert.match(r.why, /redirected to bigriverbids\.com/);
});

test("a guess that redirects to a denied host is refused, not proved", async () => {
  /* The page carries the phone. Without the refusal this is a FOUND row, which
     is exactly what shipped on 2026-09-08. */
  const get = async (url) => {
    if (url.endsWith("/robots.txt")) return { status: 404, body: "", url };
    return { status: 200, url: "https://www.bigriverbids.com/",
             body: "<h1>Ursa Farmers Cooperative</h1><p>Ursa, IL</p><p>(217) 964-2131</p>" };
  };
  const rec = await askBusiness(BIZ, { get, robotsCache: new Map(), pageCache: new Map() });
  assert.notEqual(rec.status, "found", "a denied host was filed as this business's website");
  assert.ok(rec.tried.some((x) => x.verdict === "denied"), "the refusal is not recorded");
  assert.ok(!JSON.stringify(rec).includes("bigriverbids.com/") || rec.status !== "found");
});

test("a guess that redirects to a host disallowing everyone is refused", async () => {
  /* The destination's robots.txt had never been asked, because robots was
     asked of the host we GUESSED. */
  let askedRobotsFor = [];
  const get = async (url) => {
    if (url.endsWith("/robots.txt")) {
      askedRobotsFor.push(hostOf(url));
      if (url.includes("elsewhere.example"))
        return { status: 200, body: "User-agent: *\nDisallow: /", url };
      return { status: 404, body: "", url };
    }
    return { status: 200, url: "https://elsewhere.example/",
             body: "<h1>Ursa Farmers Cooperative</h1><p>Ursa, IL</p><p>(217) 964-2131</p>" };
  };
  const rec = await askBusiness(BIZ, { get, robotsCache: new Map(), pageCache: new Map() });
  assert.ok(askedRobotsFor.includes("elsewhere.example"),
    "the host that actually answered was never asked whether it permits this");
  assert.notEqual(rec.status, "found");
  assert.ok(rec.tried.some((x) => x.verdict === "robots" && /redirects to/.test(x.why)));
});

test("an ordinary redirect is still fine — this refuses denials, not rebrands", async () => {
  /* 16 of the 165 found rows are redirect landings and 15 of them are correct:
     agvantagefs -> fscooperatives, coshoctongrain -> centerracoop. Recording
     the final URL is the right behaviour and must not be broken by the above. */
  const get = async (url) => {
    if (url.endsWith("/robots.txt")) return { status: 404, body: "", url };
    return { status: 200, url: "https://www.newname.example/",
             body: "<h1>Ursa Farmers Cooperative</h1><p>Ursa, IL</p><p>(217) 964-2131</p>" };
  };
  const rec = await askBusiness(BIZ, { get, robotsCache: new Map(), pageCache: new Map() });
  assert.equal(rec.status, "found");
  assert.equal(rec.website, "https://www.newname.example/");
});

test("a denied host is not asked at all, not even for its robots.txt", async () => {
  /* ADDED AFTER A MUTATION LEFT THE SUITE GREEN. Deleting the denied-candidate
     branch in askBusiness changed nothing, because every other test reached
     the denial by redirect. "Big River Bids" is a name whose FIRST candidate
     hostname is the denied host itself, so this is the only path that covers
     it. Rule 47. */
  const asked = [];
  const get = async (url) => { asked.push(url); return { status: 404, body: "", url }; };
  const rec = await askBusiness(
    { name: "Big River Bids LLC", city: "Dyersville", state: "IA", phone: "319-753-1100" },
    { get, robotsCache: new Map(), pageCache: new Map() });
  assert.ok(!asked.some((u) => u.includes("bigriverbids.com")),
    "the denied host was requested: " + asked.filter((u) => u.includes("bigriverbids.com")).join(", "));
  assert.ok(rec.tried.some((t) => t.host === "bigriverbids.com" && t.verdict === "denied"),
    "the refusal is not written down, so a reader cannot tell it from never-asked");
  assert.notEqual(rec.status, "found");
});

/* THE SHIPPED FILE, not the code that writes it. probe-lists/urlfinder-found.txt
   is the input to scripts/discover.mjs, so a denied host in it is a denied host
   queued to be probed. With the changes above this cannot happen; if this ever
   fires, the denylist has been routed around and that is a defect, not drift. */
test("no denied host is sitting in the committed found list", () => {
  const list = readFileSync(new URL("../probe-lists/urlfinder-found.txt", import.meta.url), "utf8");
  const bad = list.split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => isDenied(hostOf(u)));
  assert.deepEqual(bad, [], "denied host(s) in the probe list: " + bad.join(", "));
});

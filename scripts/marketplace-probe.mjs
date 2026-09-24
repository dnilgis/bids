#!/usr/bin/env node
/* WHAT BARCHART MARKETPLACE'S GRAPHQL WILL ANSWER, AND TO WHOM.
 *
 * scripts/discover.mjs has known since 2026-08-26 that the whole Barchart
 * Marketplace surface is TEN responses to one endpoint --
 * connect.api.barchart.com/graphql -- and said so in its own comment while
 * the tally was claiming 587. Nobody has ever asked that endpoint a question.
 * This asks it five.
 *
 * THIS WRITES NOTHING. It prints, and a person reads it and decides. No
 * manifest, no source file, no data/. A source file is a claim about somebody
 * else's business.
 *
 *   node scripts/marketplace-probe.mjs --company VIA
 *   node scripts/marketplace-probe.mjs --company 658 --pages 2
 *
 * WHY IT RUNS ON THE RUNNER. The sandbox's egress proxy refuses arbitrary
 * hosts, so this cannot be asked from where the code is written. One
 * workflow_dispatch and the answer is in the log. It needs no browser: this
 * is a plain HTTPS POST, not a rendered board, which is the first thing that
 * makes it different from every other probe in this repo.
 *
 * ── THE ONE QUESTION THIS EXISTS TO ANSWER ─────────────────────────────────
 *
 * A cURL captured from a logged-out browser on 2026-09-24 carried NO cookie
 * and NO Authorization header. The only credential-shaped thing in it was
 *
 *     x-device-token: base64("384652:DO1tB9QAmXbY4MCT16QVPkurcRQm3EMGecRXA4wZ")
 *
 * a device id and a random, issued to a browser rather than to a person. So
 * the question is not "can we log in" -- nobody logged in. It is whether that
 * header is checked at all.
 *
 *   if REQUEST B answers  -> this endpoint is readable with no credential,
 *                            and 519 AgriCharts sources in this repo have a
 *                            real futures quote available to them for the
 *                            first time.
 *   if only REQUEST A     -> a token is needed, and the next question is
 *                            whether one can be minted anonymously.
 *
 * NO TOKEN IS COMMITTED TO THIS REPOSITORY. --device-token is a box a person
 * fills in for one run, and the default is to send none, because sending none
 * IS THE EXPERIMENT. A token pasted into a source file would answer the
 * question wrongly for ever after by making REQUEST B impossible to observe.
 *
 * ── WHAT IT ASKS, AND WHY IT IS THIS SMALL ─────────────────────────────────
 *
 * Five requests. Not a sweep. The point is a yes or a no about access, and
 * one company's board answers that as well as four hundred would; asking more
 * would be taking data to settle a question one page already settles.
 *
 *   A  browser headers + device token   the control. If A fails the probe
 *                                       has learnt nothing about B.
 *   B  browser headers, NO token        the question.
 *   C  no origin, no referer, no token  what a server, not a browser, gets.
 *   D  companies(filter: displayId eq)  does a slug resolve to a company id.
 *   E  companies() with no filter       is the tenant roster readable.
 *
 * E is the one worth reading twice. The cash bids are a day's prices; the
 * roster is every white-label customer Barchart has, which is the list this
 * repo has been reconstructing from geocodes/places.json a facility at a time.
 *
 * ── F: THE TEST THAT DECIDES WHETHER THIS MATTERS AT ALL ───────────────────
 *
 * Nexus's Marketplace company id decodes to 01:Company:658, and its logo is
 * served from media.agricharts.com/sites/658/. Same number. Marketplace
 * company ids ARE AgriCharts site ids -- one observation, so far.
 *
 * If that holds generally then the 519 AgriCharts sources in this repo -- 429
 * agricharts-cashgrid and 90 agricharts, 47% of the network -- each have a
 * company id already, and lib/adapters/agricharts.mjs's founding problem goes
 * away. Its own header states that problem: "There is no futures PRICE
 * anywhere on the page, which is the fact that governs this whole file."
 * futuresPrice stays null, board.mjs refuses, and cross-location voting
 * stands in for a quote. This endpoint returns quote.lastPrice per row.
 *
 * --also takes company numbers read off live AgriCharts boards this repo
 * already polls, by their logo URLs on 2026-09-24:
 *
 *     99    Legacy Farmers Cooperative   legacyfarmers-fostoria, -eastfindlay
 *     1446  Kokomo Grain                 kokomograin-amboy
 *
 * Those two are not a sample, they are two. What they can prove is that the
 * numbering is shared; only a sweep could say how far it goes, and a sweep is
 * not what this is.
 *
 * ── AND IT CHECKS THE NUMBERS THAT COME BACK ───────────────────────────────
 *
 * Reading rows is not the same as trusting them. Every row is put through
 * `cash == quote.lastPrice + basis`, which is the same identity lib/board.mjs
 * enforces, and then through something board.mjs does NOT do: a test that the
 * cash price is above zero.
 *
 * That second test is here because of a row measured on 2026-09-24. Conger MN
 * soybeans came back
 *
 *     price -0.004999999999999   basis -13.18   quote.lastPrice 13.175
 *
 * a negative cash soybean bid -- and it SATISFIES the identity, because
 * 13.175 + (-13.18) really is -0.005. A check that is satisfied by the
 * arithmetic of the error cannot catch the error. lib/board.mjs has no
 * non-positive guard; until it does, this probe is where that row gets seen.
 */

const ENDPOINT = "https://connect.api.barchart.com/graphql";

/* The queries are copied from a captured request, verbatim apart from the
 * __typename noise Apollo adds. They are evidence. A query rewritten to look
 * tidier is a query nobody has seen answered. */
const Q_CASHBIDS = `query GetCashBids($companyId: ID!, $filter: CashBidFilter, $cursor: String) {
  node(id: $companyId) {
    ... on Company {
      id
      locations(first: 100) { edges { node { id name hasCashBids cashBidVisibility } } }
      commodities(first: 100) { edges { node { id name } } }
      cashBids(filter: $filter, sort: [{sortOrder: ASC}], first: 100, after: $cursor) {
        edges { node {
          id deliveryStart deliveryEnd futuresMonth price
          basis(format: DECIMAL)
          quote { lastPrice priceChange unitCode }
          commodity { id name }
          location { id name city state addressOne zipCode phoneNumber }
          roundAt
        } }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`;

const Q_COMPANIES = `query GetCompanies($filter: CompanyFilter) {
  companies(filter: $filter) {
    edges { node { id displayId name website logo } }
  }
}`;

/* base64("01:Company:<n>") -- the global id scheme, confirmed by decoding the
 * one the browser sent. Kept as a function so a numeric id typed into the
 * workflow box becomes the same string the browser used, rather than a
 * second spelling of it. */
const companyGid = (n) => Buffer.from(`01:Company:${n}`).toString("base64");

const BROWSER_HEADERS = {
  "accept": "*/*",
  "content-type": "application/json",
  "origin": "https://via.marketplace.barchart.com",
  "referer": "https://via.marketplace.barchart.com/cash-bids",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
};

async function ask(label, { query, variables, headers }) {
  const started = Date.now();
  let res, body, json = null;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ variables, query }),
    });
    body = await res.text();
    try { json = JSON.parse(body); } catch { /* not JSON; body is kept */ }
  } catch (e) {
    return { label, ok: false, why: `network: ${e.message}`, ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  if (!res.ok)
    return { label, ok: false, status: res.status, why: `HTTP ${res.status}`,
             snippet: body.slice(0, 300), ms };
  if (!json)
    return { label, ok: false, why: "body was not JSON", snippet: body.slice(0, 300), ms };
  if (json.errors?.length)
    return { label, ok: false, why: json.errors.map((e) => e.message).join("; "),
             status: res.status, ms, json };
  return { label, ok: true, status: res.status, ms, json };
}

/* ---------- reading what came back ---------- */

const edges = (c) => (c?.edges || []).map((e) => e.node).filter(Boolean);

function readBids(json) {
  const co = json?.data?.node;
  if (!co) return null;
  const locs = edges(co.locations);
  const coms = edges(co.commodities);
  const bids = edges(co.cashBids);
  return { locs, coms, bids, page: co.cashBids?.pageInfo || {} };
}

/* The identity lib/board.mjs enforces, and the guard it does not have. */
function checkRows(bids) {
  let checked = 0, identity = 0;
  const offBy = [], nonPositive = [], noQuote = [];
  for (const b of bids) {
    const q = b?.quote?.lastPrice, p = b?.price, s = b?.basis;
    if (typeof p !== "number") continue;
    if (p <= 0) nonPositive.push(b);
    if (typeof q !== "number" || typeof s !== "number") { noQuote.push(b); continue; }
    checked++;
    const d = (q + s) - p;
    if (Math.abs(d) < 0.0001) identity++;
    else offBy.push({ b, d });
  }
  return { checked, identity, offBy, nonPositive, noQuote };
}

const money = (n) => (typeof n === "number" ? n.toFixed(4) : String(n));
const where = (b) => `${b?.location?.name || "?"} ${b?.commodity?.name || "?"} ` +
                     `${String(b?.deliveryStart || "").slice(0, 7)}`;

/* ---------- the run ---------- */

const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

async function main() {
  const company = arg("--company", "VIA");
  const token = arg("--device-token", "");
  const pages = Math.max(1, Math.min(5, Number(arg("--pages", "1")) || 1));
  const roster = process.argv.includes("--roster");
  const also = String(arg("--also", "")).split(",")
    .map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).slice(0, 12);

  /* Findings print at the END. A probe that reports as it goes tells you what
     it saw right up to the moment it crashed, and a partial verdict reads
     exactly like a whole one. */
  const notes = [];
  const say = (s) => { notes.push(s); console.log(s); };

  console.log(`── asking ${ENDPOINT}`);
  console.log(`   company: ${company}`);
  console.log(`   device token: ${token ? "supplied for request A only" : "NONE SUPPLIED — A and B are the same request"}`);
  console.log("");

  /* Resolve a slug like VIA to a global id. A number is taken as a company
     number and encoded; anything else is looked up. */
  let gid = null, resolved = null;
  if (/^\d+$/.test(company)) {
    gid = companyGid(company);
    console.log(`   ${company} is numeric -> ${gid} (01:Company:${company})`);
  }

  const D = await ask("D  companies(filter: displayId eq)", {
    query: Q_COMPANIES,
    variables: { filter: { displayId: { eq: company } } },
    headers: BROWSER_HEADERS,
  });
  if (D.ok) {
    const cs = edges(D.json?.data?.companies);
    resolved = cs[0] || null;
    console.log(`D  ok  ${D.ms}ms  ${cs.length} company/companies matched "${company}"`);
    for (const c of cs.slice(0, 5)) {
      const num = Buffer.from(c.id, "base64").toString("utf8");
      console.log(`      ${c.displayId}  ${c.name}  ${num}  ${c.website || ""}`);
      if (c.logo) console.log(`         logo: ${c.logo}`);
    }
    if (!gid && resolved) gid = resolved.id;
  } else {
    console.log(`D  no  ${D.why}`);
  }
  if (!gid) {
    console.log("\n── verdict");
    console.log("could not work out a company id to ask for. Give --company as a");
    console.log("number (e.g. 658) rather than a slug, and run again.");
    return;
  }
  console.log("");

  const variables = { companyId: gid, filter: { location: { id: {} }, commodity: { id: {} } } };

  const A = token
    ? await ask("A", { query: Q_CASHBIDS, variables,
                       headers: { ...BROWSER_HEADERS, "x-device-token": token } })
    : null;
  if (A) console.log(A.ok ? `A  ok  ${A.ms}ms  browser headers + device token`
                          : `A  no  ${A.why}`);

  const B = await ask("B", { query: Q_CASHBIDS, variables, headers: BROWSER_HEADERS });
  console.log(B.ok ? `B  ok  ${B.ms}ms  browser headers, NO device token`
                   : `B  no  ${B.why}`);

  const C = await ask("C", { query: Q_CASHBIDS, variables,
                             headers: { "accept": "*/*", "user-agent": "agsist-bids-probe" } });
  console.log(C.ok ? `C  ok  ${C.ms}ms  no origin, no referer, no token`
                   : `C  no  ${C.why}`);

  let E = null;
  if (roster) {
    E = await ask("E", { query: Q_COMPANIES, variables: { filter: {} },
                         headers: BROWSER_HEADERS });
    if (E.ok) {
      const cs = edges(E.json?.data?.companies);
      console.log(`E  ok  ${E.ms}ms  companies() unfiltered returned ${cs.length}`);
      for (const c of cs.slice(0, 10))
        console.log(`      ${c.displayId}  ${c.name}`);
      if (cs.length > 10) console.log(`      ... and ${cs.length - 10} more`);
    } else {
      console.log(`E  no  ${E.why}`);
    }
  }

  /* Read the rows from whichever of the three answered, preferring the one
     that proves the most: C over B over A. */
  const best = [C, B, A].find((r) => r?.ok);
  console.log("");
  if (!best) {
    console.log("── verdict");
    console.log("nothing answered. Nothing is known about whether the token matters,");
    console.log("only that this shape of request did not work from a runner today.");
    return;
  }

  let read = readBids(best.json);
  let all = read?.bids || [];
  let cursor = read?.page?.endCursor;
  let more = Boolean(read?.page?.hasNextPage);
  for (let i = 1; i < pages && more && cursor; i++) {
    const n = await ask("page", { query: Q_CASHBIDS,
      variables: { ...variables, cursor },
      headers: best === C ? { "accept": "*/*", "user-agent": "agsist-bids-probe" }
                          : BROWSER_HEADERS });
    if (!n.ok) { console.log(`   page ${i + 1}: ${n.why}`); break; }
    const r = readBids(n.json);
    all = all.concat(r?.bids || []);
    cursor = r?.page?.endCursor; more = Boolean(r?.page?.hasNextPage);
  }

  const withBids = (read?.locs || []).filter((l) => l.hasCashBids);
  const shipTo = (read?.locs || []).filter((l) => !l.hasCashBids);
  const q = checkRows(all);

  console.log(`── what came back (${best.label.trim()} was used)`);
  console.log(`locations listed        ${read?.locs?.length ?? 0}`);
  console.log(`   hasCashBids true     ${withBids.length}`);
  console.log(`   hasCashBids false    ${shipTo.length}  (ship-to destinations, NOT elevators)`);
  console.log(`commodity records       ${read?.coms?.length ?? 0}`);
  for (const c of read?.coms || [])
    console.log(`   ${Buffer.from(c.id, "base64").toString("utf8")}  ${c.name}`);
  console.log(`bid rows read           ${all.length}${more ? "  (more pages remain)" : ""}`);
  console.log(`   with an address      ${all.filter((b) => b?.location?.addressOne).length}`);
  console.log(`   with a phone         ${all.filter((b) => b?.location?.phoneNumber).length}`);
  console.log(`   with a zip           ${all.filter((b) => b?.location?.zipCode).length}`);

  console.log("");
  console.log(`cash == quote.lastPrice + basis`);
  console.log(`   checked              ${q.checked}`);
  console.log(`   satisfied            ${q.identity}`);
  console.log(`   off by more than 1c  ${q.offBy.length}`);
  for (const { b, d } of q.offBy.slice(0, 8))
    console.log(`      ${where(b)}  cash ${money(b.price)} basis ${money(b.basis)} ` +
                `quote ${money(b.quote?.lastPrice)}  off by ${d.toFixed(4)}`);
  if (q.noQuote.length) console.log(`   no quote at all      ${q.noQuote.length}`);

  console.log("");
  console.log(`cash price above zero`);
  console.log(`   at or below zero     ${q.nonPositive.length}`);
  for (const b of q.nonPositive.slice(0, 8))
    console.log(`      ${where(b)}  cash ${money(b.price)} basis ${money(b.basis)} ` +
                `quote ${money(b.quote?.lastPrice)}`);

  /* ---------- F: do AgriCharts site numbers answer as companies? ---------- */
  const F = [];
  if (also.length) {
    console.log("");
    console.log("── F  AgriCharts site numbers asked as Marketplace companies");
    const hdr = best === C ? { "accept": "*/*", "user-agent": "agsist-bids-probe" }
                           : BROWSER_HEADERS;
    for (const n of also) {
      const r = await ask(`F:${n}`, { query: Q_CASHBIDS,
        variables: { companyId: companyGid(n),
                     filter: { location: { id: {} }, commodity: { id: {} } } },
        headers: hdr });
      if (!r.ok) { console.log(`   ${String(n).padEnd(6)} no   ${r.why}`); F.push({ n, ok: false }); continue; }
      const rd = readBids(r.json);
      if (!rd) { console.log(`   ${String(n).padEnd(6)} no   answered, but node was null (no such company)`); F.push({ n, ok: false }); continue; }
      const wb = (rd.locs || []).filter((l) => l.hasCashBids).length;
      const qq = checkRows(rd.bids || []);
      console.log(`   ${String(n).padEnd(6)} ok   ${wb} location(s) with bids, ` +
                  `${(rd.bids || []).length} row(s), identity ${qq.identity}/${qq.checked}` +
                  (qq.nonPositive.length ? `, ${qq.nonPositive.length} at or below zero` : ""));
      for (const l of (rd.locs || []).filter((x) => x.hasCashBids).slice(0, 4))
        console.log(`             ${l.name}`);
      F.push({ n, ok: true, locs: wb, rows: (rd.bids || []).length });
    }
  }

  /* ---------- verdict ---------- */
  console.log("");
  console.log("── verdict");
  if (C.ok) {
    console.log("READABLE WITH NO CREDENTIAL AND NO BROWSER HEADERS.");
    console.log("Request C carried no origin, no referer and no device token and was");
    console.log("answered. An adapter needs nothing this repo does not already have.");
  } else if (B.ok) {
    console.log("READABLE WITH NO DEVICE TOKEN, but the origin or referer is checked.");
    console.log("C was refused and B was not, so the difference is those two headers.");
    console.log("An adapter must send them; it needs no credential.");
  } else if (A?.ok) {
    console.log("THE DEVICE TOKEN IS CHECKED. A answered and B did not.");
    console.log("The next question is whether a token can be minted anonymously --");
    console.log("look in the browser for the request that issues one on first load.");
  } else {
    console.log("nothing answered from a runner today; see the reasons above.");
  }
  if (q.nonPositive.length)
    console.log(`\n${q.nonPositive.length} row(s) came back at or below zero cash. ` +
                `lib/board.mjs has no guard for that\nand the identity check cannot catch it. ` +
                `That is a defect in the feed, not in the read.`);
  if (F.length) {
    const hit = F.filter((x) => x.ok);
    console.log(`\n${hit.length} of ${F.length} AgriCharts site number(s) answered as a ` +
                `Marketplace company.`);
    if (hit.length === F.length)
      console.log("The numbering is shared on every one asked. Every AgriCharts source in\n" +
                  "this repo can be given a company id by reading its logo URL, and with it\n" +
                  "a real futures quote per row instead of an implied one.");
    else if (hit.length)
      console.log("Shared on some and not others, so a company id cannot be assumed from a\n" +
                  "site number. It has to be looked up per operator.");
    else
      console.log("None answered. Nexus sharing its number with site 658 looks like a\n" +
                  "coincidence of one, and AgriCharts sources gain nothing here.");
  }
  if (E?.ok) {
    const n = edges(E.json?.data?.companies).length;
    console.log(`\ncompanies() answered unfiltered with ${n} tenant(s). If that is the ` +
                `whole\nroster it is a better list than the one reconstructed from ` +
                `geocodes/places.json.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

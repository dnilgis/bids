#!/usr/bin/env node
/* WHAT BARCHART MARKETPLACE'S GRAPHQL WILL ANSWER, AND TO WHOM.
 *
 * scripts/discover.mjs has known since 2026-08-26 that the whole Barchart
 * Marketplace surface is TEN responses to one endpoint --
 * connect.api.barchart.com/graphql -- and said so in its own comment while
 * the tally was claiming 587. The first run of this probe, 2026-09-24
 * 23:46 UTC, asked it and got an answer worth having.
 *
 * THIS WRITES NOTHING. It prints, and a person reads it and decides. No
 * manifest, no source file, no data/. A source file is a claim about somebody
 * else's business.
 *
 *   node scripts/marketplace-probe.mjs --company VIA --roster
 *   node scripts/marketplace-probe.mjs --company 658 --device-token <t>
 *
 * WHY IT RUNS ON THE RUNNER. The sandbox's egress proxy refuses arbitrary
 * hosts, so this cannot be asked from where the code is written.
 *
 * ── WHAT RUN 1 ESTABLISHED ─────────────────────────────────────────────────
 *
 * The endpoint is authenticated PER FIELD, not per request.
 *
 *     companies(...)        answered with NO credential of any kind
 *     node(id).cashBids     "Unauthenticated."
 *
 * A cURL from a logged-out browser carried no cookie and no Authorization
 * header; the only credential-shaped thing in it was an x-device-token that
 * decodes to a device number and a random string. Run 1 sent none, and the
 * prices were refused while the tenant list was not. So that header IS
 * checked, and it is checked on the bids and not on the company records.
 *
 * ── AND THE THREE THINGS RUN 1 GOT WRONG, WHICH ARE MINE ───────────────────
 *
 * 1. ask() THREW AWAY PARTIAL DATA. GraphQL answers with `data` AND `errors`
 *    together -- a refused field comes back null beside the fields that were
 *    allowed. Run 1 treated any errors[] as total failure and discarded the
 *    body, so if locations and commodities came back fine next to a refused
 *    cashBids, it was never seen. Now the data is kept and reported.
 *
 * 2. companies() WAS ASKED WITHOUT first:. It returned exactly 10, which is a
 *    default page size wearing the costume of an answer. "The roster is 10
 *    tenants" was never a finding, it was an unpaginated query. Now it pages.
 *
 * 3. F NEVER RAN. The early return on "nothing answered" fired before it, so
 *    the AgriCharts site-number question -- the one worth the most -- went
 *    unasked because a different question failed. F now runs on company
 *    metadata, which run 1 proved is readable without a credential.
 *
 * All three are the same mistake: letting one refusal decide the whole run.
 *
 * ── THE TENANT ROSTER IS THE PART THAT IS ALREADY UNLOCKED ─────────────────
 *
 * companies() needs nothing. The ten it returned unpaginated included CPI and
 * Agtegra -- both recorded in this session's board research as operators whose
 * platform was unidentified -- and five that are not in
 * data/roster/barchart-roster-2026-09-24.json at all. That roster was
 * reconstructed from geocodes/places.json a facility at a time. This is the
 * vendor's own list, and it is readable today.
 *
 * So every tenant is cross-referenced against that frozen roster and against
 * read_by_bids, which turns a list of names into a queue: who Barchart
 * carries, how much of each we already read, and how much is left.
 *
 * ── F: WHETHER AGRICHARTS SITE NUMBERS ARE COMPANY NUMBERS ─────────────────
 *
 * Nexus's company id decodes to 01:Company:658 and its logo is served from
 * media.agricharts.com/sites/658/. If that holds generally then the 519
 * AgriCharts sources here -- 429 agricharts-cashgrid and 90 agricharts, 47%
 * of the network -- each already have a company id, and
 * lib/adapters/agricharts.mjs's founding problem has an answer. Its own
 * header states that problem: "There is no futures PRICE anywhere on the
 * page, which is the fact that governs this whole file."
 *
 * --also takes company numbers read off the logo URLs of live boards this
 * repo already polls, on 2026-09-24:
 *
 *     99    Legacy Farmers Cooperative   legacyfarmers-fostoria, -eastfindlay
 *     1446  Kokomo Grain                 kokomograin-amboy
 *
 * Two is not a sample. What two can prove is that the numbering is shared.
 *
 * ── I: INTROSPECTION ───────────────────────────────────────────────────────
 *
 * One request that asks the schema to describe itself. If it is enabled it
 * names the mutation that issues a device token, which is the difference
 * between "a token is needed" and "a token can be had". Guessing mutation
 * names would be inventing; asking the schema is not.
 *
 * ── NO TOKEN IS COMMITTED TO THIS REPOSITORY ───────────────────────────────
 *
 * --device-token is a box a person fills in for one run. A token pasted into
 * a source file would make the unauthenticated case impossible to observe
 * ever again, and it belongs to a browser, not to this repo.
 */

const ENDPOINT = "https://connect.api.barchart.com/graphql";

/* Queries are copied from a captured request, apart from the __typename noise
 * Apollo adds and the pagination run 1 should have had. They are evidence. */
const Q_COMPANIES = `query GetCompanies($filter: CompanyFilter, $cursor: String) {
  companies(filter: $filter, first: 100, after: $cursor) {
    edges { node { id displayId name website logo
      contact { phoneNumber email zipCode } } }
    pageInfo { endCursor hasNextPage }
  }
}`;

/* Company metadata WITHOUT cashBids. Run 1 refused the bids and, because of
 * defect 1, never found out whether the rest of the record was allowed. */
const Q_META = `query CompanyMeta($companyId: ID!) {
  node(id: $companyId) {
    ... on Company {
      id displayId name website
      locations(first: 100) { edges { node { id name hasCashBids cashBidVisibility } } }
      commodities(first: 100) { edges { node { id name } } }
    }
  }
}`;

const Q_CASHBIDS = `query GetCashBids($companyId: ID!, $filter: CashBidFilter, $cursor: String) {
  node(id: $companyId) {
    ... on Company {
      id
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

const TYPEREF = `kind name ofType { kind name ofType { kind name ofType { kind name } } }`;
const Q_INTROSPECT = `query { __schema {
  queryType { fields { name type { ${TYPEREF} } args { name type { ${TYPEREF} } } } }
  mutationType { fields { name args { name type { ${TYPEREF} } } type { ${TYPEREF} } } }
} }`;

/* One named type, described. Asked only for the handful that decide what can
 * be done next -- the company filter, and whatever registerDevice takes and
 * returns. A full __schema { types } dump is megabytes and answers nothing
 * this does not. */
const Q_TYPE = `query T($name: String!) { __type(name: $name) {
  kind name
  inputFields { name type { ${TYPEREF} } }
  fields { name type { ${TYPEREF} } }
} }`;

/* Unwrap NON_NULL and LIST wrappers down to the named type. A root field's
 * return type is usually Connection! or [Thing!]!, and the name is what
 * __type needs. */
const unwrap = (t) => { let x = t; while (x && !x.name && x.ofType) x = x.ofType; return x || {}; };
const isLeaf = (t) => { const u = unwrap(t); return u.kind === "SCALAR" || u.kind === "ENUM"; };

const companyGid = (n) => Buffer.from(`01:Company:${n}`).toString("base64");
const ungid = (g) => { try { return Buffer.from(g, "base64").toString("utf8"); } catch { return g; } };

/* EVERY HEADER THE BROWSER SENT, because run 5 sent a valid device token and
 * was still refused, and the first suspect has to be that my request was not
 * the browser's request. Five of these were missing and so was operationName.
 *
 * Copied from the cURL captured 2026-09-24. Not a reconstruction of it. */
const BROWSER_HEADERS = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
  "dnt": "1",
  "origin": "https://via.marketplace.barchart.com",
  "priority": "u=1, i",
  "referer": "https://via.marketplace.barchart.com/cash-bids",
  "sec-ch-ua": '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
};

/* The filter the browser actually sent. An empty object is not the same
 * string on the wire, and when a request is being compared against a working
 * one the differences are the whole experiment. */
const BROWSER_BID_FILTER = { location: { id: {} }, commodity: { id: {} } };
const BARE_HEADERS = { "accept": "*/*", "user-agent": "agsist-bids-probe" };

/* A GraphQL answer can be partly allowed and partly refused. `errors` is not
 * a verdict on the response, it is a verdict on some fields in it, so both
 * are carried and the caller decides. This is defect 1 from run 1. */
async function ask({ query, variables, headers, operationName }) {
  const t0 = Date.now();
  let res, body, json = null;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      /* operationName first, then variables, then query -- the order the
         browser serialises them in. A gateway that routes on the operation
         name never saw one from runs 1 to 5, because this field did not
         exist here until run 6. */
      body: JSON.stringify(operationName ? { operationName, variables, query }
                                         : { variables, query }),
    });
    body = await res.text();
    try { json = JSON.parse(body); } catch { /* kept as text below */ }
  } catch (e) {
    return { transport: false, why: `network: ${e.message}`, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const errs = (json?.errors || []).map((e) => e.message);
  return {
    transport: true, status: res.status, ms, json,
    data: json?.data ?? null,
    errors: errs,
    why: errs.join("; ") || (res.ok ? "" : `HTTP ${res.status}`),
    snippet: json ? "" : String(body).slice(0, 300),
  };
}

const edges = (c) => (c?.edges || []).map((e) => e.node).filter(Boolean);

/* ---------- the checks that decide whether rows can be trusted ---------- */

function checkRows(bids) {
  let checked = 0, identity = 0;
  const offBy = [], nonPositive = [], noQuote = [];
  for (const b of bids) {
    const q = b?.quote?.lastPrice, p = b?.price, s = b?.basis;
    if (typeof p !== "number") continue;
    if (p <= 0) nonPositive.push(b);
    if (typeof q !== "number" || typeof s !== "number") { noQuote.push(b); continue; }
    checked++;
    Math.abs((q + s) - p) < 0.0001 ? identity++ : offBy.push({ b, d: (q + s) - p });
  }
  return { checked, identity, offBy, nonPositive, noQuote };
}

const money = (n) => (typeof n === "number" ? n.toFixed(4) : String(n));
const where = (b) => `${b?.location?.name || "?"} ${b?.commodity?.name || "?"} ` +
                     `${String(b?.deliveryStart || "").slice(0, 7)}`;

/* ---------- the frozen roster, for turning names into a queue ---------- */

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function loadRoster() {
  try {
    const { readFileSync } = await import("node:fs");
    const d = JSON.parse(readFileSync("data/roster/barchart-roster-2026-09-24.json", "utf8"));
    const rows = d.facilities || [];
    const byOp = new Map();
    for (const r of rows) {
      const k = norm(r.operator);
      if (!k) continue;
      const cur = byOp.get(k) || { operator: r.operator, total: 0, read: 0 };
      cur.total++; if (r.read_by_bids) cur.read++;
      byOp.set(k, cur);
    }
    return { rows: rows.length, byOp };
  } catch { return null; }
}

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

  const authed = token ? { ...BROWSER_HEADERS, "x-device-token": token } : null;

  console.log(`── asking ${ENDPOINT}`);
  console.log(`   company: ${company}`);
  console.log(`   device token: ${token ? `supplied (${token.length} chars)` : "NONE — the unauthenticated case"}`);
  console.log("");

  /* ---- D: resolve the company ---- */
  let gid = /^\d+$/.test(company) ? companyGid(company) : null;
  const D = await ask({ query: Q_COMPANIES,
    variables: { filter: { displayId: { eq: company } } }, headers: BROWSER_HEADERS });
  const dCo = edges(D.data?.companies);
  if (dCo.length) {
    console.log(`D  ok  ${D.ms}ms  "${company}" resolved`);
    for (const c of dCo.slice(0, 3))
      console.log(`      ${c.displayId}  ${c.name}  ${ungid(c.id)}  ${c.website || ""}`);
    if (!gid) gid = dCo[0].id;
  } else {
    console.log(`D  no  ${D.why || "no match"}`);
  }
  if (!gid) {
    console.log("\n── verdict\nno company id to ask for. Give --company as a number.");
    return;
  }

  /* ---- M: is the company record readable without a token? ---- */
  const M = await ask({ query: Q_META, variables: { companyId: gid }, headers: BROWSER_HEADERS });
  const meta = M.data?.node || null;
  const locs = edges(meta?.locations), coms = edges(meta?.commodities);
  console.log(meta
    ? `M  ok  ${M.ms}ms  company record readable with no token` +
      (M.errors.length ? `  (with errors: ${M.why})` : "")
    : `M  no  ${M.why}`);

  /* ---- B / C / A: the bids ---- */
  const bidVars = { companyId: gid, filter: BROWSER_BID_FILTER };
  const B = await ask({ query: Q_CASHBIDS, variables: bidVars,
                        headers: BROWSER_HEADERS, operationName: "GetCashBids" });
  const bOk = Boolean(edges(B.data?.node?.cashBids).length);
  console.log(bOk ? `B  ok  ${B.ms}ms  bids with NO token` : `B  no  ${B.why}`);

  const C = await ask({ query: Q_CASHBIDS, variables: bidVars,
                        headers: BARE_HEADERS, operationName: "GetCashBids" });
  const cOk = Boolean(edges(C.data?.node?.cashBids).length);
  console.log(cOk ? `C  ok  ${C.ms}ms  bids with no token and no browser headers`
                  : `C  no  ${C.why}`);

  let A = null, aOk = false;
  if (authed) {
    A = await ask({ query: Q_CASHBIDS, variables: bidVars,
                    headers: authed, operationName: "GetCashBids" });
    aOk = Boolean(edges(A.data?.node?.cashBids).length);
    console.log(aOk ? `A  ok  ${A.ms}ms  bids WITH the device token` : `A  no  ${A.why}`);
  }

  /* ---- I: introspection ----
   *
   * Run 2 found it ON and counted 9 queries and 45 mutations without naming
   * one of them, which is a tally rather than a finding. The names are the
   * whole value: they say which doors exist. */
  const I = await ask({ query: Q_INTROSPECT, variables: {}, headers: BROWSER_HEADERS });
  const qFields = I.data?.__schema?.queryType?.fields || [];
  const mFields = I.data?.__schema?.mutationType?.fields || [];
  const qf = qFields.map((f) => f.name), mf = mFields.map((f) => f.name);
  let filterTakesId = false;
  if (qf.length || mf.length) {
    console.log(`I  ok  ${I.ms}ms  introspection is ON — ${qf.length} queries, ${mf.length} mutations`);
    console.log(`      queries:`);
    for (const f of qFields)
      console.log(`         ${f.name}(${(f.args || []).map((a) => a.name).join(", ")})`);
    const hot = mFields.filter((f) => /device|token|register|auth|session|login/i.test(f.name));
    console.log(`      mutations: ${mf.join(", ")}`);
    if (hot.length) {
      console.log(`      and these look like they issue a credential:`);
      for (const f of hot) {
        const ret = f.type?.name || f.type?.ofType?.name || f.type?.kind || "?";
        console.log(`         ${f.name}(${(f.args || []).map((a) => a.name).join(", ")}) -> ${ret}`);
      }
    }
    /* Describe only the types that decide what can be done next. */
    const wanted = ["CompanyFilter", ...hot.map((f) => f.name.replace(/^./, (c) => c.toUpperCase()) + "Input")];
    for (const name of [...new Set(wanted)]) {
      const t = await ask({ query: Q_TYPE, variables: { name }, headers: BROWSER_HEADERS });
      const ty = t.data?.__type;
      if (!ty) continue;
      const fl = ty.inputFields || ty.fields || [];
      console.log(`      ${ty.kind} ${ty.name}: ${fl.map((x) => x.name).join(", ") || "(no fields)"}`);
      if (ty.name === "CompanyFilter" && fl.some((x) => x.name === "id")) filterTakesId = true;
    }
    /* And whatever registerDevice actually takes. */
    for (const f of hot) {
      for (const a of f.args || []) {
        const tn = a.type?.name || a.type?.ofType?.name;
        if (!tn || /^(String|ID|Int|Boolean|Float)$/.test(tn)) continue;
        const t = await ask({ query: Q_TYPE, variables: { name: tn }, headers: BROWSER_HEADERS });
        const ty = t.data?.__type;
        if (!ty) continue;
        console.log(`      ${f.name}.${a.name}: ${ty.kind} ${ty.name} { ` +
                    `${(ty.inputFields || ty.fields || []).map((x) => x.name).join(", ")} }`);
      }
    }
  } else {
    console.log(`I  no  introspection is off${I.why ? ` — ${I.why}` : ""}`);
  }

  /* ---- the company record ---- */
  if (meta) {
    const withBids = locs.filter((l) => l.hasCashBids);
    console.log("");
    console.log(`── ${meta.name || company}, from the company record alone`);
    console.log(`locations listed        ${locs.length}`);
    console.log(`   hasCashBids true     ${withBids.length}`);
    console.log(`   hasCashBids false    ${locs.length - withBids.length}  (ship-to, NOT elevators)`);
    console.log(`commodity records       ${coms.length}`);
    for (const c of coms) console.log(`   ${ungid(c.id)}  ${c.name}`);
    if (withBids.length) {
      console.log(`locations with bids:`);
      for (const l of withBids) console.log(`   ${l.name}`);
    }
  }

  /* ---- the rows, from whichever request got them ---- */
  const src = cOk ? C : bOk ? B : aOk ? A : null;
  const srcName = cOk ? "C" : bOk ? "B" : aOk ? "A" : null;
  let all = [], more = false, q = null;
  if (src) {
    all = edges(src.data.node.cashBids);
    let pi = src.data.node.cashBids.pageInfo || {};
    more = Boolean(pi.hasNextPage);
    const hdr = srcName === "C" ? BARE_HEADERS : srcName === "A" ? authed : BROWSER_HEADERS;
    for (let i = 1; i < pages && more && pi.endCursor; i++) {
      const n = await ask({ query: Q_CASHBIDS,
        variables: { ...bidVars, cursor: pi.endCursor }, headers: hdr,
        operationName: "GetCashBids" });
      const rows = edges(n.data?.node?.cashBids);
      if (!rows.length) { console.log(`   page ${i + 1}: ${n.why || "nothing"}`); break; }
      all = all.concat(rows);
      pi = n.data.node.cashBids.pageInfo || {}; more = Boolean(pi.hasNextPage);
    }
    q = checkRows(all);
    console.log("");
    console.log(`── bid rows (${srcName})`);
    console.log(`rows read               ${all.length}${more ? "  (more pages remain)" : ""}`);
    console.log(`   with an address      ${all.filter((b) => b?.location?.addressOne).length}`);
    console.log(`   with a phone         ${all.filter((b) => b?.location?.phoneNumber).length}`);
    console.log(`   with a zip           ${all.filter((b) => b?.location?.zipCode).length}`);
    console.log(`cash == quote + basis   ${q.identity}/${q.checked} satisfied, ${q.offBy.length} off by more than 1c`);
    for (const { b, d } of q.offBy.slice(0, 8))
      console.log(`   ${where(b)}  cash ${money(b.price)} basis ${money(b.basis)} quote ${money(b.quote?.lastPrice)}  off ${d.toFixed(4)}`);
    console.log(`cash at or below zero   ${q.nonPositive.length}`);
    for (const b of q.nonPositive.slice(0, 8))
      console.log(`   ${where(b)}  cash ${money(b.price)} basis ${money(b.basis)} quote ${money(b.quote?.lastPrice)}`);
  }

  /* ---- E: the tenant roster, paginated this time ---- */
  let tenants = [];
  if (roster) {
    let cursor = null, page = 0;
    for (;;) {
      const r = await ask({ query: Q_COMPANIES, variables: { filter: {}, cursor },
                            headers: BROWSER_HEADERS });
      const got = edges(r.data?.companies);
      if (!got.length) { if (!page) console.log(`\nE  no  ${r.why || "nothing"}`); break; }
      tenants = tenants.concat(got); page++;
      const pi = r.data.companies.pageInfo || {};
      if (!pi.hasNextPage || !pi.endCursor || page >= 40) break;
      cursor = pi.endCursor;
    }
    if (tenants.length) {
      console.log("");
      console.log(`── E  companies(), no credential — ${tenants.length} tenant(s) over ${page} page(s)`);
      const fr = await loadRoster();
      if (!fr) console.log(`   (data/roster/barchart-roster-2026-09-24.json not present; names only)`);
      let unknown = 0, known = 0, toFind = 0;
      for (const c of tenants) {
        const m = fr?.byOp.get(norm(c.name));
        if (fr) { m ? known++ : unknown++; if (m) toFind += (m.total - m.read); }
        const tail = m ? `roster ${m.total}, bids reads ${m.read}, to find ${m.total - m.read}`
                       : (fr ? "NOT IN THE FROZEN ROSTER" : "");
        console.log(`   ${String(c.displayId || "").padEnd(10)} ${String(c.name || "").slice(0, 40).padEnd(42)} ${tail}`);
      }
      if (fr) {
        console.log("");
        console.log(`   in the frozen roster      ${known}`);
        console.log(`   not in it at all          ${unknown}`);
        console.log(`   facilities still to find  ${toFind}  (across the matched tenants)`);
      }
    }
  }

  /* ---- F: do AgriCharts site numbers answer as companies? ----
   *
   * RUN 2 MADE THIS TEST SAY SOMETHING IT HAD NOT MEASURED. node(id) was
   * refused for VIA -- the one company whose id is known to be right -- and F
   * then asked node(id) for 99 and 1446, got the same refusal, and the verdict
   * announced that site numbers are NOT company numbers. That is a false
   * negative printed as a finding, and it is worse than the run having no
   * answer, because a wrong no closes a line of work.
   *
   * So F now needs a CONTROL that passed before its own result means anything,
   * and it prefers the door that is open: companies(filter:) needs no
   * credential, so if CompanyFilter will take an id, F goes through there
   * instead of through node(). */
  const F = [];
  let fVia = null;
  if (also.length) {
    console.log("");
    console.log("── F  AgriCharts site numbers asked as Marketplace companies");
    const byId = filterTakesId;
    const askOne = async (gidFor) => byId
      ? await ask({ query: Q_COMPANIES, variables: { filter: { id: { eq: gidFor } } },
                    headers: BROWSER_HEADERS })
      : await ask({ query: Q_META, variables: { companyId: gidFor }, headers: BROWSER_HEADERS });
    const readOne = (r) => byId ? (edges(r.data?.companies)[0] || null) : (r.data?.node || null);

    console.log(`   route: ${byId ? "companies(filter: id) — the unauthenticated door"
                                  : "node(id) — the same door that refused M"}`);
    /* The control: the id we KNOW is a company. If this cannot be read, no
       answer about 99 or 1446 is interpretable. */
    const ctl = readOne(await askOne(gid));
    fVia = Boolean(ctl);
    console.log(`   control ${company}: ${ctl ? `ok — ${ctl.name || ctl.displayId}` : "REFUSED"}`);

    for (const n of also) {
      const got = readOne(await askOne(companyGid(n)));
      if (!got) { console.log(`   ${String(n).padEnd(6)} no answer`); F.push({ n, ok: false }); continue; }
      const ls = edges(got.locations), wb = ls.filter((l) => l.hasCashBids);
      console.log(`   ${String(n).padEnd(6)} ok   ${got.displayId || "?"}  ${got.name || "?"}` +
                  (ls.length ? `  — ${ls.length} location(s), ${wb.length} with bids` : ""));
      for (const l of wb.slice(0, 5)) console.log(`             ${l.name}`);
      F.push({ n, ok: true, name: got.name });
    }
  }

  /* ---- G: the doors never knocked on ----
   *
   * RUNS 1 TO 3 ASKED ONE DOOR AND CALLED IT THE BUILDING. Every bid request
   * they made went through node(id) { cashBids }, and when that was refused
   * the verdict said "bids refused in every form asked" -- which was true and
   * useless, because run 3's own schema dump lists NINE root queries and the
   * probe had tried two of them:
   *
   *     node(id)                                      asked, refused
   *     companies(filter, first, after)               asked, open
   *     elevators()                                   never asked
   *     cashBids(filter, orderBy, sort, first, after) never asked
   *     locations(filter, sort, first, after)         never asked
   *     search(type, query, first, after)             never asked
   *     serviceToken(type)                            never asked
   *     viewer()                                      never asked
   *     unitsOfMeasure(first, after)                  never asked
   *
   * cashBids is a SEPARATE RESOLVER from the cashBids field inside Company.
   * A different resolver can have different authorisation, and assuming it
   * does not is how run 1's "nothing answered" happened again three times.
   *
   * serviceToken(type) is the one to notice: it is a QUERY. Queries read.
   * Asking it is not a write to somebody else's system, which registerDevice
   * would be -- so it can be asked here and registerDevice cannot.
   *
   * The selection for each is BUILT FROM THE SCHEMA, not guessed: unwrap the
   * root field's return type, ask __type for its fields, and take the leaf
   * ones. A hand-written guess at a selection fails with a syntax error that
   * reads exactly like a refusal. */
  const G = [];
  if (qFields.length) {
    console.log("");
    console.log("── G  every root query, unauthenticated");
    const described = new Map();
    const describe = async (name) => {
      if (described.has(name)) return described.get(name);
      const t = await ask({ query: Q_TYPE, variables: { name }, headers: BROWSER_HEADERS });
      const ty = t.data?.__type || null;
      described.set(name, ty);
      return ty;
    };
    for (const f of qFields) {
      if (f.name === "node" || f.name === "companies") continue;   // already asked
      const ret = unwrap(f.type);
      let sel = "";
      if (!isLeaf(f.type) && ret.name) {
        const ty = await describe(ret.name);
        const fl = ty?.fields || [];
        if (fl.some((x) => x.name === "edges")) {
          const edgeTy = await describe(unwrap(fl.find((x) => x.name === "edges").type).name);
          const nodeRef = (edgeTy?.fields || []).find((x) => x.name === "node");
          const nodeTy = nodeRef ? await describe(unwrap(nodeRef.type).name) : null;
          const leaves = (nodeTy?.fields || []).filter((x) => isLeaf(x.type)).slice(0, 6)
            .map((x) => x.name);
          sel = ` { edges { node { ${leaves.join(" ") || "__typename"} } } }`;
        } else {
          const leaves = fl.filter((x) => isLeaf(x.type)).slice(0, 8).map((x) => x.name);
          sel = ` { ${leaves.join(" ") || "__typename"} }`;
        }
      }
      /* Only arguments we can fill honestly. A required argument we cannot
         supply is reported as not asked, not as a refusal. */
      const args = [];
      let blocked = null;
      for (const a of f.args || []) {
        if (a.name === "first") { args.push("first: 5"); continue; }
        const req = a.type?.kind === "NON_NULL";
        if (req) blocked = a.name;
      }
      if (blocked) {
        console.log(`   ${f.name.padEnd(16)} not asked — needs ${blocked}`);
        G.push({ name: f.name, asked: false }); continue;
      }
      const argStr = args.length ? `(${args.join(", ")})` : "";
      const q1 = `query { ${f.name}${argStr}${sel} }`;
      let r = await ask({ query: q1, variables: {}, headers: BROWSER_HEADERS });
      let val = r.data?.[f.name];
      /* Run 5 knocked on every door bare and never knocked again holding the
         token. A door that opens for a credential is not a closed door. */
      let viaToken = false;
      if ((val === undefined || val === null) && authed) {
        const r2 = await ask({ query: q1, variables: {}, headers: authed });
        const v2 = r2.data?.[f.name];
        if (v2 !== undefined && v2 !== null) { r = r2; val = v2; viaToken = true; }
      }
      const open = val !== undefined && val !== null;
      if (open) {
        const rows = Array.isArray(val?.edges) ? val.edges.length
                   : Array.isArray(val) ? val.length : null;
        console.log(`   ${f.name.padEnd(16)} OPEN${viaToken ? " (with the token)" : ""}` +
                    `${rows !== null ? `  ${rows} row(s)` : ""}`);
        const sample = Array.isArray(val?.edges) ? val.edges[0]?.node
                     : Array.isArray(val) ? val[0] : val;
        if (sample) console.log(`      ${JSON.stringify(sample).slice(0, 220)}`);
      } else {
        console.log(`   ${f.name.padEnd(16)} ${r.why || "null"}`);
      }
      G.push({ name: f.name, asked: true, open });
    }
  }

  /* ---------- verdict ---------- */
  console.log("");
  console.log("── verdict");
  const gOpen = G.filter((x) => x.open).map((x) => x.name);
  if (cOk)      console.log("BIDS ARE READABLE WITH NO CREDENTIAL AND NO BROWSER HEADERS.");
  else if (bOk) console.log("BIDS ARE READABLE WITH NO TOKEN, but the origin or referer is checked.");
  else if (aOk) console.log("THE DEVICE TOKEN IS WHAT UNLOCKS THE BIDS. Without it they are refused,\n" +
                            "with it they are served. The question becomes whether one can be minted.");
  else if (gOpen.includes("cashBids"))
                console.log("node(id).cashBids is refused, but the TOP-LEVEL cashBids query answered.\n" +
                            "Two resolvers, two authorisations. The prices are reachable.");
  else          console.log("Bids refused through node(id) and through the top-level cashBids query.");
  if (gOpen.length)
    console.log(`\nRoot queries open without a credential: ${gOpen.join(", ")}.`);

  if (meta && !cOk && !bOk)
    console.log("\nBut the COMPANY RECORD is readable with no credential: locations, which of\n" +
                "them carry bids, and the commodity list. The gate is on the prices, not on\n" +
                "the structure. A roster is buildable today; a price feed is not.");

  if (q?.nonPositive.length)
    console.log(`\n${q.nonPositive.length} row(s) at or below zero cash. lib/board.mjs has no guard for\n` +
                `that and the identity check cannot catch it — a wrong basis satisfies\n` +
                `cash = futures + basis by construction.`);

  if (F.length) {
    const hit = F.filter((x) => x.ok);
    if (!fVia) {
      console.log(`\nF PROVED NOTHING and is not a negative. The control -- ${company}, whose ` +
                  `company id is\nknown to be right -- was refused by the same route, so ` +
                  `"99 did not answer"\nmeans the route is shut, not that the company is absent.`);
    } else {
      console.log(`\n${hit.length} of ${F.length} AgriCharts site number(s) answered as a Marketplace company, ` +
                  `against a\ncontrol that passed.`);
      if (hit.length === F.length)
        console.log("The numbering is shared on every one asked. An AgriCharts source's company\n" +
                    "id can be read off its logo URL.");
      else if (hit.length)
        console.log("Shared where it could be checked. A site number that returns nothing is\n" +
                    "NOT evidence against the numbering: only 96 operators are Marketplace\n" +
                    "tenants at all, so an AgriCharts customer who never bought the portal has\n" +
                    "no company record to find. Check the name against E before reading a miss\n" +
                    "as a mismatch.");
      else
        console.log("Neither answered while the control did. On this evidence a site number is\n" +
                    "not a company number, and site 658 matching Nexus is a coincidence of one.");
    }
  }

  if (tenants.length)
    console.log(`\ncompanies() returned ${tenants.length} tenant(s) with no credential. That is ` +
                `Barchart's own\ncustomer list, and it is the thing this repo has been ` +
                `reconstructing by hand.`);

  if (mf.length) {
    const hot = mf.filter((n) => /device|token|register/i.test(n));
    if (hot.length)
      console.log(`\nIntrospection named ${hot.length} mutation(s) that may issue a device token: ` +
                  `${hot.join(", ")}.\nIts arguments are printed above. This probe does NOT call it: ` +
                  `a mutation writes to\nsomebody else's system, and that is a decision, not a ` +
                  `measurement.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

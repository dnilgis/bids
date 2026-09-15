#!/usr/bin/env node
/* READ EVERY BOARD A GRADABLE PARTNER POSTS, AND MEASURE HOW EACH ONE ROUNDS.
 *
 * WHAT IS MISSING AND WHY THIS EXISTS. fixtures/gradable-adm-bootstrap.json
 * names 152 ADM markets, 136 of which post at least one public instrument.
 * scripts/gradable-markets.mjs turns each into a manifest skeleton, and every
 * skeleton comes out `enabled: false` with `bands: {}`, because lib/sources.mjs
 * refuses to load a manifest with no band:
 *
 *     no bands. Every commodity needs a floor and ceiling before it can publish.
 *
 * That refusal is correct. Two measurements stand between 152 skeletons and 152
 * files, and NEITHER IS IN THE BOOTSTRAP:
 *
 *   1. WHICH CROPS each market posts. A band is per commodity, and a crop that
 *      has no band is withheld -- loudly, but withheld.
 *   2. HOW each market rounds its cash cell. POET declares a mode per market in
 *      commodity_settings. ADM declares NOTHING: commodity_settings is `{}` on
 *      all 152, measured. So ADM's rounding has to be COUNTED, from the
 *      residuals of cash - basis - futures on that market's own board.
 *
 * Both come from the same place: reading the boards. This is that read.
 *
 * IT MEASURES AND WRITES ONE REPORT. It writes no source manifest, enables
 * nothing and publishes no bid. It records no price, either -- only crop names,
 * row counts, the residuals and the mode those residuals admit. A price is a
 * fact about today; a rounding mode is a fact about the board.
 *
 * NOTHING HERE REIMPLEMENTS THE ARITHMETIC. The residual is
 * lib/rounding.mjs's `residualCents`, which is checkIdentity's own formula, and
 * the mode is `roundingEvidence`'s verdict. The band names come from
 * lib/board.mjs's `bandFor` against its own DEFAULT_BANDS. A probe that
 * measured any of these its own way would eventually disagree with the guard
 * that uses them, and the probe would be believed, because it runs first --
 * which is the exact bug lib/rounding.mjs was written to kill.
 *
 * THE TRANSPORT IS MEASURED, NOT ASSUMED. lib/sources.mjs puts gradable on the
 * browser and says why: "a plain GET might well work ... this sandbox cannot
 * reach gradable.com to find out. Declaring it fetch on that reasoning would be
 * a guess that fails as 0 bids at six in the morning." This run is the place
 * that can find out, so it asks a few boards with a plain fetch BEFORE walking
 * 136 of them, and reports what happened either way. A browser walk is one page
 * load per market at roughly 45 seconds each -- about 100 minutes for ADM --
 * so it is never entered by accident: it has to be asked for.
 *
 *   node scripts/gradable_boards.mjs --partner adm
 *   node scripts/gradable_boards.mjs --partner adm --write
 *   node scripts/gradable_boards.mjs --partner adm --limit 5
 *   node scripts/gradable_boards.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { marketsFrom, boardUrl, extract, describe, GradableRefused, roundingFor }
  from "../lib/adapters/gradable.mjs";
import { roundingEvidence, describeEvidence, NARROWER_THAN } from "../lib/rounding.mjs";
import { bandFor } from "../lib/board.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* A MENU, NOT A STRING. `partner` reaches a filename in both directions -- it
   picks the fixture that is read and the report that is written -- and an input
   that reaches a filename is an input that can reach `../`. */
export const PARTNERS = ["poet", "adm"];

export const fixturePathFor = (partner) => `fixtures/gradable-${partner}-bootstrap.json`;

/* WHY data/gradable/ AND NOT data/. scripts/merge_bids.mjs enumerates
   `data/*.json` and treats every one of them as a poller capture. A report
   dropped at the top level of data/ would be picked up by the merge as a board
   file, fail to parse as one, and do it inside the step that builds the public
   feed. A subdirectory is invisible to that scan -- `readdirSync` returns
   "gradable", which does not end in .json -- and test/gradable-boards.test.mjs
   pins exactly that. */
export const reportPathFor = (partner) => `data/gradable/${partner}-boards.json`;

export const pageUrlFor = (partner) => `https://${partner}.gradable.com/market`;

/** Markets worth asking: not a demo, has a public site, claims an instrument. */
export function boardsToRead(markets) {
  return (markets ?? [])
    .filter((m) => !m.demo && m.publicSite && (m.publicInstruments ?? 0) > 0)
    .sort((a, b) => Number(a.marketId) - Number(b.marketId));
}

/* ONE MARKET'S BOARD, TURNED INTO FACTS THAT DO NOT EXPIRE.
 *
 * Crop names and row counts and residuals, and no price anywhere. Committing
 * today's cash into a report would make every run a diff of numbers nobody is
 * measuring, and would put a price in a file the merge does not guard. */
export function readingFor(market, body, url) {
  const rows = extract(body, url);

  const byCrop = new Map();
  for (const r of rows) {
    /* KEYED ON THEIR CODE, NOT ON THE NAME IT RESOLVES TO. Two codes can carry
       the same word — a name collision would merge two of their instruments
       into one line and hide that one of them is unbanded. */
    const k = r.commodityCode ?? r.commodity;
    if (!byCrop.has(k))
      byCrop.set(k, { code: k, commodity: r.commodity, rows: 0, deliveries: new Set() });
    const e = byCrop.get(k);
    e.rows++;
    e.deliveries.add(r.delivery);
  }

  const crops = [...byCrop.values()]
    .sort((a, b) => a.commodity.localeCompare(b.commodity))
    .map((e) => {
      /* lib/board.mjs's own matcher against its own DEFAULT_BANDS, asked with
         no source bands of its own, so the answer is the standard band a
         manifest would have to declare -- or null, which is a crop this
         repository has no band for and which must not be quietly given one. */
      let band = null;
      try { band = bandFor({ bands: {} }, e.commodity, rows); } catch { band = null; }
      return {
        /* THEIR CODE AND THE NAME IT RESOLVED TO, BOTH. A code still showing as
           its own name is a code their dictionary does not carry, and that has
           to be readable at a glance — on 2026-09-15 every ADM row came back as
           a bare code and the report is where that has to show. */
        code: e.code,
        commodity: e.commodity,
        unresolved: e.commodity === e.code,
        rows: e.rows,
        deliveries: e.deliveries.size,
        /* bandFor names its answer "corn (default)" to say where the band came
           from. A manifest's bands key is the bare name, so the suffix is
           stripped here and the pair below is the band itself -- which is what
           a manifest would have to declare, copied rather than chosen. */
        band: band ? String(band.named).replace(/\s*\(default\)$/, "") : null,
        range: band ? [band.floor, band.ceiling] : null,
      };
    });

  const ev = roundingEvidence(rows);

  /* WHICH MONEY THIS BOARD IS IN, BY ITS OWN ROWS.
     lib/currency.mjs calls this the strongest tier there is — "the feed said
     so, per row, and every row agreed". A board stating two is not a board with
     a currency; resolveCurrency refuses it and so does this, by recording both
     rather than picking one. */
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort();
  const units = [...new Set(rows.map((r) => r.quantityUnit).filter(Boolean))].sort();
  const futuresUnits = [...new Set(rows.map((r) => r.futuresUnit).filter(Boolean))].sort();
  const notCheckable = rows.filter((r) => r.identityCheckable === false).length;

  /* THE DECLARED MODE IS CARRIED BESIDE THE COUNTED ONE, NEVER INSTEAD OF IT.
     POET declares always_down at Big Stone City and the residuals agree; that
     agreement is worth something only if both numbers are in the file. A board
     that declares one mode and counts as another is the single most interesting
     row this report can produce, and it is unreadable if either is dropped. */
  const declaredOnRows = [...new Set(rows.map((r) => r.cashRoundingDeclared).filter(Boolean))];

  return {
    marketId: market.marketId,
    displayName: market.displayName,
    city: market.city,
    state: market.state,
    company: market.company,
    url,
    rows: rows.length,
    crops,
    /* From the bootstrap. Null on every ADM market, measured. */
    declaredInBootstrap: market.declaredRounding ?? null,
    /* From the board's own rows. A board may state it where the bootstrap did
       not, and that would be the cheapest possible answer to question 2. */
    declaredOnBoard: declaredOnRows.length === 1 ? declaredOnRows[0]
                   : declaredOnRows.length ? declaredOnRows.sort() : null,
    /* One entry means every row agreed. Two means this board cannot publish
       under either, and saying which two is the whole point. */
    currency: currencies.length === 1 ? currencies[0] : null,
    currenciesSeen: currencies,
    units,
    futuresUnits,
    /* Rows whose cash and futures are not both in bushels. They are carried and
       counted, never dropped and never checked against each other. */
    rowsNotInBushels: notCheckable,
    rounding: {
      testable: ev.testable,
      mode: ev.mode,
      confident: ev.confident,
      margin: ev.margin,
      residuals: ev.residuals,
      exact: ev.exact, floor: ev.floor, round: ev.round, either: ev.either,
    },
    roundingSaid: describeEvidence(ev),
  };
}

/* ---- transport -----------------------------------------------------------
 *
 * The question lib/sources.mjs could not answer from the sandbox: does the
 * board endpoint answer a plain GET? It carries no key and its own query string
 * says offer_type=public, so it might. "Might" is not a transport.
 *
 * Asked on a SAMPLE before the walk, because the answer costs one request and
 * being wrong about it costs 136. A sample that half works is not a yes: a
 * transport that fails a third of the time reads as "those elevators posted
 * nothing today", which is the failure mode this repository exists to prevent.
 * ------------------------------------------------------------------------- */
export const UA = "bids/1.0 (+https://github.com/dnilgis/bids)";

export async function fetchBoard(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
    });
  } catch (e) {
    /* No HTTP response at all: DNS, TCP, TLS, a refused CONNECT. Nothing here
       is evidence about their host. */
    const err = new Error(`no response: ${e?.message ?? e}`);
    err.reached = false;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}`);
    err.status = res.status;
    err.body = body;
    err.reached = !isEnvironmentBlock(res, body);
    throw err;
  }
  const body = await res.text();
  if (!body.length) { const e = new Error("empty body"); e.reached = true; throw e; }
  return body;
}

/* WHOSE 403 IS IT? — FOUND BY RUNNING THIS, 2026-09-15.
 *
 * The first draft asked ADM's board endpoint, got 403 three times out of three,
 * and refused with "a plain fetch did not read the sampled board(s), so the
 * board endpoint needs the browser." That sentence is a conclusion about ADM.
 * The 403 was not ADM's. Its body was:
 *
 *     Host not in allowlist: adm.gradable.com. Add this host to your network
 *     egress settings to allow access.
 *
 * — the sandbox's own egress gateway, which never opened a connection to them.
 * A run in that environment would have written "browser required" into a report
 * as a measured fact about a host it never reached, and the next person would
 * have believed it, because it was measured.
 *
 * So a failure that did not come from their origin is NOT a verdict. It says
 * this environment cannot ask the question, which is what lib/sources.mjs
 * already says, and the answer has to come from somewhere with open egress.
 *
 * Matching is on the gateway's own shape — a short text/plain body that names
 * the block — never on a status code: 403 is exactly what a real site returns
 * when it refuses a robot, and treating every 403 as an environment problem
 * would be the same mistake pointed the other way. */
export function isEnvironmentBlock(res, body) {
  const type = String(res?.headers?.get?.("content-type") ?? "");
  const text = String(body ?? "");
  if (text.length > 600) return false;              // their error pages are not this short
  if (/json|html/i.test(type)) return false;        // an answer from an origin, not a gateway
  return /not in allowlist|egress|proxy denied|denied by policy|blocked by (?:the )?(?:gateway|proxy)|tunnel/i
    .test(text);
}

export async function probeFetch(markets, partner, fetchImpl = fetch, sample = 3) {
  const tried = [];
  for (const m of markets.slice(0, sample)) {
    const url = boardUrl(m.marketId, partner);
    try {
      const body = await fetchBoard(url, fetchImpl);
      const rows = extract(body, url);
      tried.push({ marketId: m.marketId, ok: true, rows: rows.length });
    } catch (e) {
      tried.push({
        marketId: m.marketId, ok: false, why: e?.message ?? String(e),
        /* false when nothing from their origin answered. */
        reached: e?.reached !== false,
      });
    }
  }
  const ok = tried.filter((t) => t.ok).length;
  const reached = tried.filter((t) => t.reached !== false).length;
  return {
    tried,
    ok,
    reached,
    /* EVERY sampled board, not most of them. */
    usable: tried.length > 0 && ok === tried.length,
    /* NOT A VERDICT ABOUT THEM. Nothing from their origin answered, so this
       run learned nothing about whether the endpoint needs a browser. */
    unreachable: tried.length > 0 && reached === 0,
  };
}

/* ---- refusals ------------------------------------------------------------ */

/** Why this report must not be written, or null. */
export function refusalFor({ partner, read, attempted, existingCount = null, allowShrink = false }) {
  if (!PARTNERS.includes(partner))
    return `unknown partner ${JSON.stringify(partner)}. Known: ${PARTNERS.join(", ")}`;
  if (!attempted)
    return `no market in ${fixturePathFor(partner)} posts a public instrument, so there is ` +
           `nothing to read. Re-capture the bootstrap before reading boards.`;
  if (!read)
    /* NOT A MEASUREMENT. Zero boards read out of 136 attempted is their site
       being unreachable or the transport being wrong, and writing that as a
       report would record "no crops anywhere" as a finding about ADM. */
    return `0 of ${attempted} board(s) were read. That is an outage or a wrong transport, ` +
           `not a finding about ${partner}, and a report saying every market posts nothing ` +
           `would be read later as a measurement. Nothing written.`;
  if (existingCount != null && read < existingCount && !allowShrink)
    return `the committed report carries ${existingCount} market(s) and this run read ${read}. ` +
           `A report that shrank is a partial run or a closure and both deserve a person. ` +
           `Pass --allow-shrink to write it anyway.`;
  return null;
}

/** The committed report's market count, or null if there is none. */
export function existingCountAt(path) {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(j?.markets) ? j.markets.length : null;
  } catch { return null; }
}

export const REPORT_VERSION = 1;

export function reportFrom({ partner, transport, fixture, marketsInFixture, attempted, readings, failures }) {
  return {
    version: REPORT_VERSION,
    partner,
    transport,
    fixture,
    capturedAt: new Date().toISOString(),
    marketsInFixture,
    marketsAttempted: attempted,
    marketsRead: readings.length,
    /* Sorted by market id so a diff between two runs is the measurements that
       moved and not the order they came back in. */
    markets: [...readings].sort((a, b) => Number(a.marketId) - Number(b.marketId)),
    failures: [...failures].sort((a, b) => Number(a.marketId) - Number(b.marketId)),
  };
}

/** What a person needs off the end of the run, in lines rather than a file. */
export function summarise(report) {
  const out = [];
  const ms = report.markets;
  out.push(`${report.marketsRead} of ${report.marketsAttempted} board(s) read over ${report.transport}` +
           (report.failures.length ? `; ${report.failures.length} failed` : ""));

  const crops = new Map();
  for (const m of ms) for (const c of m.crops) {
    const k = `${c.code}\t${c.commodity}`;
    crops.set(k, (crops.get(k) ?? 0) + 1);
  }
  out.push(`crops posted, by how many markets post them:`);
  for (const [k, n] of [...crops].sort((a, b) => b[1] - a[1])) {
    const [code, name] = k.split("\t");
    out.push(`    ${String(n).padStart(4)}  ${String(code).padEnd(9)} ${name}`);
  }

  /* A CODE THAT DID NOT RESOLVE IS THE LOUDEST LINE THIS REPORT CAN PRINT. */
  const unresolved = [...new Set(ms.flatMap((m) => m.crops.filter((c) => c.unresolved).map((c) => c.code)))];
  if (unresolved.length)
    out.push(`THEIR DICTIONARY DOES NOT NAME: ${unresolved.join(", ")} — these are codes, not ` +
             `crops, and every row carrying one is withheld. Re-capture the bootstrap.`);

  const unbanded = [...new Set(ms.flatMap((m) => m.crops.filter((c) => !c.band).map((c) => c.commodity)))];
  out.push(unbanded.length
    ? `NO BAND IN lib/board.mjs FOR: ${unbanded.join(", ")} — these rows would be withheld`
    : `every crop posted has a band in lib/board.mjs`);

  const modes = new Map();
  for (const m of ms) modes.set(String(m.rounding.confident), (modes.get(String(m.rounding.confident)) ?? 0) + 1);
  out.push(`rounding COUNTED from residuals:`);
  for (const [k, n] of [...modes].sort((a, b) => b[1] - a[1]))
    out.push(`    ${String(n).padStart(4)}  ${k === "null" ? "not established — no mode explains every row, or too few rows" : k}`);

  /* A COUNTED MODE NARROWER THAN THE DECLARED ONE IS NOT A CONTRADICTION —
   * fixed 2026-09-15, having printed a false alarm on the first POET run.
   *
   * That run reported "DECLARED AND COUNTED DISAGREE ON 1 MARKET(S): Mitchell,
   * SD declares half_down, counts round-cent". It does not disagree.
   * lib/rounding.mjs's own NARROWER_THAN says round-cent is contained by
   * round-cent-either — the same window with the top end open — so a board that
   * declares half_down and counts round-cent has simply not posted a +0.5
   * residual today. Naming that a contradiction sends somebody to look at a
   * board that is behaving exactly as it says.
   *
   * The line had a second fault in the same breath: it carried its own copy of
   * DECLARED_ROUNDING, typed inline. Two copies of that table is how one of them
   * stops matching the adapter. Both are gone — the mapping is roundingFor()
   * and the containment is NARROWER_THAN, each imported from the file that owns
   * it.
   *
   * What is left is a real contradiction: two modes where neither explains the
   * other, like a board declaring always_down whose residuals only fit
   * round-cent. */
  const contradicts = (declared, counted) => {
    const d = roundingFor(declared);
    if (!d || !counted || d === counted) return false;
    /* Counted narrower than declared: they have shown us less than they
       promised, which is what a quiet day looks like. Counted WIDER than
       declared is a board doing something its own settings do not allow, and
       that is the interesting one — it is still a contradiction and still
       reported. */
    return !(NARROWER_THAN[counted] ?? []).includes(d);
  };
  const disagree = ms.filter((m) => contradicts(m.declaredInBootstrap, m.rounding.confident));
  out.push(disagree.length
    ? `DECLARED AND COUNTED CONTRADICT EACH OTHER ON ${disagree.length} MARKET(S): ` +
      disagree.map((m) => `${m.displayName} declares ${m.declaredInBootstrap} ` +
        `(${roundingFor(m.declaredInBootstrap)}), counts ${m.rounding.confident}`).join("; ")
    : `no market's counted mode contradicts what its bootstrap declares ` +
      `(a counted mode NARROWER than the declared one is a quiet day, not a disagreement)`);

  const onBoard = ms.filter((m) => m.declaredOnBoard).length;
  out.push(`${onBoard} of ${ms.length} board(s) state a cash_bid_rounding_mode on their own rows`);

  /* THE CURRENCY, WHICH THIS ADAPTER USED TO THROW AWAY. */
  const cur = new Map();
  for (const m of ms) cur.set(String(m.currency), (cur.get(String(m.currency)) ?? 0) + 1);
  out.push(`currency STATED BY THEIR OWN ROWS:`);
  for (const [k, n] of [...cur].sort((a, b) => b[1] - a[1]))
    out.push(`    ${String(n).padStart(4)}  ${k === "null" ? "none, or two on one board — nothing publishes on that" : k}`);
  const mixed = ms.filter((m) => (m.currenciesSeen ?? []).length > 1);
  if (mixed.length)
    out.push(`TWO CURRENCIES ON ONE BOARD: ` +
      mixed.map((m) => `${m.displayName} (${m.currenciesSeen.join(", ")})`).join("; "));

  const allUnits = new Map();
  for (const m of ms) for (const u of m.units ?? []) allUnits.set(u, (allUnits.get(u) ?? 0) + 1);
  out.push(`quantity_unit, by how many markets use it:`);
  for (const [u, n] of [...allUnits].sort((a, b) => b[1] - a[1]))
    out.push(`    ${String(n).padStart(4)}  ${u}`);
  const notBu = ms.filter((m) => (m.rowsNotInBushels ?? 0) > 0);
  out.push(notBu.length
    ? `${notBu.length} market(s) carry ${notBu.reduce((a, m) => a + m.rowsNotInBushels, 0)} row(s) whose ` +
      `cash and futures are not both in bushels — carried, counted, never checked against each other: ` +
      notBu.map((m) => `${m.displayName} (${m.rowsNotInBushels})`).join("; ")
    : `every row on every board has cash and futures both in bushels`);
  return out.join("\n");
}

/* ---- the run ------------------------------------------------------------- */

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] ?? d; };
const has = (n) => args.includes(`--${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const partner = String(flag("partner", "adm"));
  if (!PARTNERS.includes(partner))
    throw new Error(`unknown partner ${JSON.stringify(partner)}. Known: ${PARTNERS.join(", ")}`);

  const fixture = flag("fixture", fixturePathFor(partner));
  const fixtureAbs = join(ROOT, fixture);
  if (!existsSync(fixtureAbs))
    throw new Error(`${fixture} does not exist. Capture it first: ` +
                    `Actions -> gradable bootstrap -> partner ${partner}, commit on.`);

  const markets = marketsFrom(readFileSync(fixtureAbs, "utf8"));
  let boards = boardsToRead(markets);
  const attempted0 = boards.length;
  const limit = Number(flag("limit", 0)) || 0;
  if (limit > 0) boards = boards.slice(0, limit);

  console.log(`${markets.length} market(s) in ${fixture}; ${attempted0} post a public instrument` +
              (limit ? `; --limit ${limit} means only ${boards.length} will be read` : ""));

  /* A REHEARSAL, WHICH IS NOT A MEASUREMENT AND CANNOT BECOME ONE.
   *
   * --rehearse <board.json> replays one committed board body for every market,
   * so the walk, the report shape, the summary and every refusal run end to end
   * with no network. It exists because the sandbox this was written in cannot
   * reach gradable.com, and a path proven only by unit tests is a path nobody
   * has run.
   *
   * It is fenced three ways: transport is recorded as "rehearsal" in the file,
   * --write is refused outright below, and the summary says so. A rehearsal
   * report describes one board copied 136 times; published, it would be the
   * most confident wrong number this repository has ever produced. */
  const rehearse = flag("rehearse", null);

  /* THE TRANSPORT QUESTION, ASKED ON THREE BOARDS BEFORE 136. */
  const want = String(flag("transport", "auto"));
  let transport = null;

  if (rehearse) {
    const body = readFileSync(join(ROOT, rehearse), "utf8");
    const readings = [], failures = [];
    for (const m of boards) {
      const url = boardUrl(m.marketId, partner);
      try { readings.push(readingFor(m, body, url)); }
      catch (e) { failures.push({ marketId: m.marketId, displayName: m.displayName, why: e?.message ?? String(e) }); }
    }
    const report = reportFrom({
      partner, transport: "rehearsal", fixture,
      marketsInFixture: markets.length, attempted: boards.length, readings, failures,
    });
    console.log(`
REHEARSAL against ${rehearse} — every market below was handed the SAME ` +
                `committed board. The shape is real; not one crop or residual is.
`);
    console.log(summarise(report));
    if (has("write")) throw new GradableRefused(
      `--rehearse and --write together would commit one board copied ${boards.length} times ` +
      `as a measurement of ${boards.length} markets. Refused.`);
    console.log(`
REHEARSAL — nothing written, and --write is refused in this mode.`);
    return;
  }
  if (want === "fetch" || want === "auto") {
    const probe = await probeFetch(boards, partner, fetch, Math.min(3, boards.length));
    for (const t of probe.tried)
      console.log(`  probe market ${t.marketId}: ` +
        (t.ok ? `OK, ${t.rows} row(s)`
              : `${t.reached === false ? "UNREACHABLE" : "NO"} — ${t.why}`));

    /* NOTHING FROM THEIR ORIGIN ANSWERED. This is not a finding about the
       partner and must never be written down as one. */
    if (probe.unreachable)
      throw new GradableRefused(
        `nothing from ${partner}.gradable.com answered — every sampled request was stopped ` +
        `before it reached them (see the lines above). That says this environment cannot ask ` +
        `the question, not that the board endpoint needs a browser, and writing it down as ` +
        `the latter would put a conclusion about ${partner} into a report on the strength of ` +
        `a local network policy. Run it where egress is open: Actions -> gradable boards. ` +
        `lib/sources.mjs keeps gradable on the browser until something measured says otherwise. ` +
        `Nothing written.`);

    if (probe.usable) {
      transport = "fetch";
      console.log(`PLAIN FETCH WORKS on ${probe.ok} of ${probe.tried.length} sampled board(s). ` +
                  `This answers the open question in lib/sources.mjs for the board endpoint — ` +
                  `and only for the board endpoint, on this host, today.`);
    } else if (want === "fetch") {
      throw new Error(`--transport fetch was asked for and ${probe.ok} of ${probe.tried.length} ` +
                      `sampled board(s) read. Not walking ${boards.length} of them on that.`);
    }
  }

  if (!transport) {
    /* NOT ENTERED BY ACCIDENT. One page load per market, ~45s each: 136 markets
       is about 100 minutes, which is not a job that should start because a
       fetch probe came back 403. */
    throw new GradableRefused(
      `${partner}.gradable.com ANSWERED and did not hand over a board over a plain fetch, so ` +
      `the board endpoint needs the ` +
      `browser — one page load per market at roughly 45 seconds each, about ` +
      `${Math.round((boards.length * 45) / 60)} minutes for ${boards.length} market(s). ` +
      `That is a deliberate run, not a fallback: re-run with --transport browser and a ` +
      `--limit, and lib/sources.mjs keeps gradable on the browser in the meantime, which is ` +
      `where it already is. Nothing written.`);
  }

  const delayMs = Number(flag("delay-ms", 250));
  const readings = [], failures = [];
  for (const m of boards) {
    const url = boardUrl(m.marketId, partner);
    try {
      const body = await fetchBoard(url, fetch);
      readings.push(readingFor(m, body, url));
    } catch (e) {
      failures.push({
        marketId: m.marketId,
        displayName: m.displayName,
        /* A refusal from the adapter already says what the body was. */
        why: e instanceof GradableRefused ? e.message : (e?.message ?? String(e)),
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const outRel = reportPathFor(partner);
  const outAbs = join(ROOT, outRel);
  const existing = existingCountAt(outAbs);
  const refusal = refusalFor({
    partner, read: readings.length, attempted: boards.length,
    /* A --limit run is a partial by construction and must never be measured
       against the whole committed report. */
    existingCount: limit ? null : existing,
    allowShrink: has("allow-shrink"),
  });
  if (refusal) throw new GradableRefused(refusal);

  const report = reportFrom({
    partner, transport, fixture,
    marketsInFixture: markets.length,
    attempted: boards.length,
    readings, failures,
  });

  console.log("");
  console.log(summarise(report));
  for (const f of report.failures) console.log(`  FAILED ${f.marketId} ${f.displayName} — ${f.why}`);

  if (!has("write")) {
    console.log(`\nDRY RUN — nothing written. Pass --write to write ${outRel}.`);
    return;
  }
  if (limit) throw new GradableRefused(
    `--limit and --write together would commit a partial report over a whole one. ` +
    `Read them all, or write nothing.`);

  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nwrote ${outRel}: ${report.marketsRead} market(s)` +
              (existing == null ? " (new file)" : `, was ${existing}`));

  /* ONE COUNTER. The commit message's number is this one, handed to the shell,
     never a second one grepped out of the file in the workflow. */
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV,
      `BOARDS_READ=${report.marketsRead}\nREPORT=${outRel}\nTRANSPORT=${transport}\n`);
}

/* ---- selftest ------------------------------------------------------------
 * Needs no network, no browser and no fixture beyond the committed POET board,
 * because the guards that decide whether a report may be written have to run
 * before any of this run's bytes exist.
 * ------------------------------------------------------------------------- */
async function selftest() {
  const ok = [], bad = [];
  const t = (name, cond) => (cond ? ok : bad).push(name);

  t("the report path is the partner's own", reportPathFor("adm") === "data/gradable/adm-boards.json");
  t("the fixture path is the partner's own", fixturePathFor("poet") === "fixtures/gradable-poet-bootstrap.json");
  t("every partner on the menu is a bare slug", PARTNERS.every((p) => /^[a-z]+$/.test(p)));
  /* THE REPORT MUST NOT LAND WHERE merge_bids ENUMERATES. It reads
     data/*.json and treats each one as a poller capture. */
  t("THE REPORT IS NOT A TOP-LEVEL data/*.json",
    PARTNERS.every((p) => /^data\/[^/]+\/[^/]+\.json$/.test(reportPathFor(p))));

  const ms = [
    { marketId: 3, demo: false, publicSite: true, publicInstruments: 4 },
    { marketId: 1, demo: false, publicSite: true, publicInstruments: 1 },
    { marketId: 2, demo: true,  publicSite: true, publicInstruments: 9 },
    { marketId: 4, demo: false, publicSite: false, publicInstruments: 9 },
    { marketId: 5, demo: false, publicSite: true, publicInstruments: 0 },
  ];
  const picked = boardsToRead(ms).map((m) => m.marketId);
  t("a demo market is never asked", !picked.includes(2));
  t("a market with no public site is never asked", !picked.includes(4));
  t("a market claiming zero instruments is never asked", !picked.includes(5));
  t("and the walk is in market-id order", JSON.stringify(picked) === JSON.stringify([1, 3]));

  t("an unknown partner is refused", refusalFor({ partner: "../etc", read: 1, attempted: 1 }) !== null);
  t("nothing to read is refused", refusalFor({ partner: "adm", read: 0, attempted: 0 }) !== null);
  t("ZERO READ OUT OF MANY IS AN OUTAGE, NOT A FINDING",
    /outage/.test(refusalFor({ partner: "adm", read: 0, attempted: 136 }) ?? ""));
  t("a shrinking report is refused",
    refusalFor({ partner: "adm", read: 100, attempted: 136, existingCount: 136 }) !== null);
  t("and --allow-shrink says so",
    refusalFor({ partner: "adm", read: 100, attempted: 136, existingCount: 136, allowShrink: true }) === null);
  t("growing is never refused",
    refusalFor({ partner: "adm", read: 136, attempted: 136, existingCount: 100 }) === null);
  t("a clean run is not refused", refusalFor({ partner: "adm", read: 136, attempted: 136 }) === null);

  /* A SAMPLE THAT HALF WORKS IS NOT A YES. A transport failing a third of the
     time reads downstream as those elevators posting nothing today.
     THE REAL probeFetch IS DRIVEN HERE, with a stubbed fetch. The first draft
     of these three checks re-typed the `ok === tried.length` rule inside the
     assertion and proved only that the rule equals itself — the same mistake
     test/gradable-markets.test.mjs caught at the gradable-markets call site,
     made again three files later. */
  const board = existsSync(join(ROOT, "fixtures/gradable-poet-bigstonecity.json"))
    ? readFileSync(join(ROOT, "fixtures/gradable-poet-bigstonecity.json"), "utf8") : null;
  const stub = (bodies) => {
    let i = 0;
    return async () => {
      const b = bodies[i++];
      if (b === null) throw new Error("refused by the stub");
      return { ok: true, text: async () => b };
    };
  };
  const three = [{ marketId: 1 }, { marketId: 2 }, { marketId: 3 }];
  if (board) {
    t("three good boards out of three is usable",
      (await probeFetch(three, "poet", stub([board, board, board]), 3)).usable === true);
    t("THE RULE IS EVERY SAMPLED BOARD, NOT MOST — two of three is not a transport",
      (await probeFetch(three, "poet", stub([board, board, null]), 3)).usable === false);
    t("a body that answers 200 but does not read is not a good board",
      (await probeFetch(three, "poet", stub(["<html>down for maintenance</html>", board, board]), 3)).usable === false);
    t("and a sample of zero is never usable",
      (await probeFetch([], "poet", stub([]), 3)).usable === false);
    t("the probe reports per-market rather than only a verdict",
      (await probeFetch(three, "poet", stub([board, null, board]), 3)).tried.length === 3);
  } else {
    t("the committed POET board fixture is present for the probe checks", false);
  }

  /* The board reader, driven on the committed POET board rather than described. */
  const boardFixture = join(ROOT, "fixtures/gradable-poet-bigstonecity.json");
  if (existsSync(boardFixture)) {
    const body = readFileSync(boardFixture, "utf8");
    const r = readingFor({ marketId: 331845223, displayName: "Big Stone City, SD", city: "Big Stone City",
                           state: "SD", company: "POET Grain", declaredRounding: "always_down" },
                         body, "https://poet.gradable.com/x");
    t("the committed POET board reads to rows", r.rows > 0);
    t("its crop carries a band lib/board.mjs already has", r.crops.every((c) => c.band));
    t("THE BAND NAME IS A MANIFEST KEY, not bandFor's provenance string",
      r.crops.every((c) => !/\(default\)/.test(c.band)));
    t("its counted mode is floor-cent, which is what its bootstrap declares",
      r.rounding.confident === "floor-cent" && r.declaredInBootstrap === "always_down");
    t("NO PRICE REACHES THE REPORT",
      !/"cash"|"basis"|"futuresPrice"/.test(JSON.stringify(r)));
    t("the declared mode is carried beside the counted one, not instead of it",
      "declaredInBootstrap" in r && "declaredOnBoard" in r && "rounding" in r);
  } else {
    t("the committed POET board fixture is present", false);
  }

  for (const n of ok) console.log(`  ok   ${n}`);
  for (const n of bad) console.log(`  FAIL ${n}`);
  console.log(`${ok.length} passed, ${bad.length} failed`);
  process.exit(bad.length === 0 ? 0 : 1);
}

/* ONLY WHEN THIS FILE IS THE THING BEING RUN. test/gradable-boards.test.mjs
   imports the guards to drive them directly; without this line that import
   starts asking adm.gradable.com for 136 boards inside the test runner. */
const RUN_DIRECTLY = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/* SPELLED OUT, NOT `has("selftest")`, AND THAT IS NOT A STYLE CHOICE.
   test/script-selftests.test.mjs finds the scripts it must run by grepping for
   the literal `process.argv.includes("--selftest")`. A script that reaches the
   same flag through a helper is a script whose checks nothing runs. */
if (RUN_DIRECTLY && process.argv.includes("--selftest"))
  selftest().catch((e) => { console.error(`::error::${e?.message ?? e}`); process.exit(1); });
else if (RUN_DIRECTLY) main().catch((e) => { console.error(`::error::${e?.message ?? e}`); process.exit(1); });

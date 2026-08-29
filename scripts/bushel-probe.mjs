#!/usr/bin/env node
/* WHAT CAME BACK FROM A BUSHEL BOARD, AND WHAT ROUNDING RULE IT USES.
 *
 * The sibling of scripts/dtn-probe.mjs, and it exists for the same reason.
 * One Bushel page can carry a whole co-operative: the sweep on 2026-08-25
 * asked ten pages and every one of them answered, so the expensive part of
 * adding them is not the adapter -- that is written and already reading CHS
 * Farmers Alliance live -- it is finding out WHAT came back and writing a
 * manifest per location without inventing anything.
 *
 * THIS WRITES NOTHING. It prints. A source file is a claim about somebody
 * else's business and it gets made by a person who has read the evidence.
 *
 *   node scripts/bushel-probe.mjs --page https://www.chs-herman.com/grain/cash-bids/
 *   node scripts/bushel-probe.mjs --list probe-lists/bushel-candidates.txt
 *   node scripts/bushel-probe.mjs --fixture fixtures/bushel-chsfarmersalliance.json
 *
 * WHY IT RUNS ON THE RUNNER. It needs a real Chromium against a real network.
 * The sandbox has neither: its egress proxy re-signs TLS with a certificate
 * Chromium will not accept, so the browser makes zero requests and the capture
 * times out. Measured 2026-08-25, three handshake failures and no request ever
 * reaching the host. On the runner it is one workflow_dispatch.
 *
 * IT HOLDS NO CREDENTIAL. Bushel's board is fetched by the customer's own page
 * in the reader's browser, so loading that page is all the authorisation there
 * is or needs to be. Same arrangement as dtn-cs. See lib/cdp.mjs.
 *
 * THE ROUNDING MODE IS MEASURED, NOT GUESSED, and that is the whole point of
 * running this before writing manifests. On 2026-08-25 six operators were
 * enabled without it and every one was refused on `cash - basis = futures`:
 * Ag-Land floors its cash 80 rows out of 80, CHS floors 12 out of 12, and
 * three others round BOTH displayed figures independently so no rule on one of
 * them can ever reconcile the pair. Same evidence, three different answers.
 * Guessing would have been wrong five times out of six.
 */
import { readFileSync } from "node:fs";
import { capture } from "../lib/cdp.mjs";
import { extract } from "../lib/adapters/bushel.mjs";

/* TWO GENERATIONS, AND THIS KNEW ONE — 2026-08-29.
 *
 * The 2026-08-29 run asked seventeen pages and read five. The other twelve
 * were not silent: discover.mjs had already recorded what they call, and it
 * is `cash-bids`, not `GetBidsList`. scripts/discover.mjs says so in its own
 * bushel signature comment and has since 2026-08-21:
 *
 *     Two generations are in use and both are real:
 *       api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList
 *       futures.bushelops.com/api/v1/cash-bids
 *
 * This file knew the first and waited 60 seconds for it on pages that were
 * never going to send it. Twelve boards read as "unread" because the probe
 * was listening on the wrong address.
 *
 * THE SECOND ENTRY IS A PATH, NOT A URL, AND DELIBERATELY SO. discover's
 * ledger keeps only the last path segment of each response, so the ORIGIN of
 * the second generation has not been measured for these particular sites --
 * `futures.bushelops.com` is what the comment above records, and asserting it
 * for a site nobody has watched would be inventing it. matchesTarget() in
 * lib/cdp.mjs falls back to a plain substring test when its target will not
 * parse as a URL, which is exactly the tool for this. The run prints the full
 * URL it captured, so the first run measures the origin instead of guessing
 * it, and this line can become a URL afterwards.
 *
 * ORDER MATTERS ONLY FOR SPEED. A page is loaded once per target until one
 * answers, so the generation that already worked for five sites is tried
 * first.
 *
 * THE ORIGIN IS NOW MEASURED — 2026-08-29, run 90064858519. Riceland answered
 * the second entry and the probe printed the full URL it captured:
 *
 *     https://futures.bushelops.com/api/v1/cash-bids
 *
 * which is the origin the comment above could only record from discover's
 * ledger. The entry below STAYS A PATH anyway: one site measured is one site,
 * and a substring target costs nothing while a wrong origin costs a run. */
const TARGETS = [
  "https://api.bushelpowered.com/api/markets/aggregator/bids/v1/GetBidsList",
  "/api/v1/cash-bids",
];

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

/* ---- the rounding question, asked of one location's rows ---------------- */
/* Deliberately the same shape as dtn-probe's, so the two probes can be read
   against each other. A quarter cent is the tick corn trades in, which is why
   the residuals come out in quarters and why a board that displays to the
   whole cent cannot reconcile exactly. */
export function roundingEvidence(rows) {
  const cents = (n) => Math.round(n * 100);
  let exact = 0, round = 0, floor = 0, ceil = 0, testable = 0, otherUnit = 0;
  const residuals = new Set();
  for (const r of rows) {
    /* A ROW QUOTED IN ANOTHER UNIT IS NOT EVIDENCE ABOUT ROUNDING.
       Added 2026-08-29 evening, run 90133552278. Six CHS boards came back
       "NO RULE EXPLAINS IT" with residuals of -69522c, -73537c, -66040c --
       hundreds of dollars, on boards whose ordinary rows carry the clean
       floor-cent signature {0, -0.25, -0.5, -0.75}. Every one of those boards
       quotes CANOLA in USD/CWT against a futures contract in another unit, so
       `cash === basis + futures` was never going to hold between the two
       printed numbers, and testing it produced a verdict calling the whole
       board unmeasurable when only the canola was.
       The adapter already knows -- it folds the unit into the commodity name
       so DEFAULT_BANDS cannot match it and board.mjs withholds the row. It now
       says so in a field instead of only in a string. Rows from a source that
       does not set it are tested exactly as before. */
    if (r.identityCheckable === false) { otherUnit++; continue; }
    /* `futures` IS THE SYMBOL, "ZCU26". The price is `futuresPrice`, and it is
       already in CENTS -- 476.25 -- which is where the quarter comes from.
       Reading r.futures as the number gave NaN on every row of the fixture and
       reported "no rule explains it" for a board nothing had measured yet. */
    if (r.cash == null || r.basis == null || r.futuresPrice == null) continue;
    testable++;
    const want = r.futuresPrice + (r.basisCents ?? cents(r.basis));
    const got = cents(r.cash);
    residuals.add(Math.round((got - want) * 100) / 100);
    if (Math.abs(got - want) < 0.005) exact++;
    if (Math.abs(got - Math.round(want)) < 0.005) round++;
    if (Math.abs(got - Math.floor(want + 1e-9)) < 0.005) floor++;
    if (Math.abs(got - Math.ceil(want - 1e-9)) < 0.005) ceil++;
  }
  return { testable, exact, round, floor, ceil, otherUnit,
           residuals: [...residuals].sort((a, b) => a - b) };
}

/* SAY BOTH AND LET A PERSON LOOK. A probe that picked the winning rule itself
   would be the same guess, made somewhere harder to see. */
function verdict(e) {
  /* SAY WHAT WAS SET ASIDE. A silent withholding is worse than a refusal
     (rule 20): a reader told "floor-cent explains ALL 13" about a twenty-row
     board has to be able to see where the other seven went. */
  const aside = e.otherUnit
    ? ` (${e.otherUnit} row(s) set aside -- quoted in another unit, identity not checkable)` : "";
  if (!e.testable) return `no testable row -- nothing carried cash, basis and futures together${aside}`;
  const best = [["exact", e.exact], ["floor-cent", e.floor],
                ["round-cent", e.round], ["ceil-cent", e.ceil]]
    .filter(([, n]) => n === e.testable).map(([k]) => k);
  if (best.length) return `${best.join(" or ")} explains ALL ${e.testable}${aside}`;
  return `NO RULE EXPLAINS IT: floor ${e.floor}, round ${e.round}, ceil ${e.ceil}, ` +
         `exact ${e.exact} of ${e.testable}${aside}. Both displayed figures are probably ` +
         `rounded independently -- see cashRoundingCents, and measure the maximum ` +
         `residual rather than reaching for a round number.`;
}

/* RETURNS { body, from } ON EVERY PATH. A fixture has no address to report,
   and returning a bare string from this one branch is what broke the first
   version of this change: probeOne destructures the result, and destructuring
   a string yields undefined for both halves and refuses with "Body was 0
   character(s)". The fixture run is the cheapest check in the file and it is
   what said so. */
async function bodyFor({ page, fixture }) {
  if (fixture) return { body: readFileSync(fixture, "utf8"), from: null };
  const problems = [];
  for (const target of TARGETS) {
    try {
      const got = await capture({
        pageUrl: page, target,
        browser: process.env.CHROME || undefined,
        timeoutMs: Number(process.env.PROBE_MS || 60000),
      });
      /* WHICH ADDRESS ANSWERED IS THE FINDING, not a detail. It is how the
         second generation's real origin gets measured instead of assumed.
         IT IS RETURNED, NOT PRINTED — 2026-08-29 evening. Printing it here put
         the line ABOVE the `── page` header its caller had not written yet, so
         in run 90064858519 Meyer Brothers' address appeared under Luckey
         Farmers and Riceland's under Meyer Brothers. A reader copying that log
         would have attributed both to the wrong operator. */
      return { body: got?.body ?? got, from: got?.url ?? null };
    } catch (e) {
      problems.push(`${target}: ${e.message}`);
    }
  }
  /* BOTH ADDRESSES, NAMED. "no readable response" against one target sent
     somebody looking at the elevator's website; against both it says the page
     is not either generation we know. */
  throw new Error(`no bushel board on this page. Tried ${TARGETS.length} known ` +
                  `endpoint(s):\n     ${problems.join("\n     ")}`);
}

/* A SEPARATOR THAT CANNOT OCCUR IN EITHER HALF. Added 2026-08-29 evening.
   The key was built as `${r.locationId}${r.location}` with NOTHING between the
   two halves, and was then taken apart with `k.split("")` — which does not
   split on a separator, it splits a string INTO ITS CHARACTERS. So `id` was
   the first character of the key and `name` the second. Meyer Brothers printed

       5
          locationId  0

   against a live source file whose locationId is
   055d5343-343c-4cb3-b3d2-83b870a4c399 at Elk Mound: "0" and "5" are that
   string's first two characters. EVERY IDENTITY THIS PROBE HAS EVER PRINTED
   WAS ONE CHARACTER WIDE — and the identity is the one value a person is meant
   to copy out of this log into a manifest. The rows, the rounding and the
   residuals were never affected; the key still grouped correctly, it was only
   unreadable. Rule 20: a wrong answer printed confidently is worse than none. */
const SEP = "\u001f";

export async function probeOne(where, opts = {}) {
  /* THE HEADER GOES FIRST so that everything printed afterwards — the address
     that answered, the locations, or a refusal from main's catch — belongs to
     the page named on it and to no other. */
  console.log(`\n── ${where}`);
  const { body, from } = await bodyFor(opts);
  if (from) console.log(`   read from ${from}`);
  const rows = extract(body, opts.page || opts.fixture || where);
  const byLoc = new Map();
  for (const r of rows) {
    const k = `${r.locationId}${SEP}${r.location}`;
    if (!byLoc.has(k)) byLoc.set(k, { id: r.locationId, name: r.location, rows: [] });
    byLoc.get(k).rows.push(r);
  }
  console.log(`   ${rows.length} row(s) across ${byLoc.size} location(s)`);
  for (const { id, name, rows: rs } of byLoc.values()) {
    const e = roundingEvidence(rs);
    const commodities = [...new Set(rs.map((r) => r.commodity))].join(", ");
    console.log(`\n   ${name}`);
    console.log(`      locationId  ${id}`);
    console.log(`      rows        ${rs.length}   ${commodities}`);
    console.log(`      rounding    ${verdict(e)}`);
    console.log(`      residuals   ${e.residuals.length ? e.residuals.join("c, ") + "c" : "none"}`);
    /* THE STATE IS NOT IN THIS PAYLOAD and must not be invented. Bushel's
       location object is {id, name, groups} -- the same shortcoming DTN's has.
       Read it off the operator's own locations page. Country Partners has a
       CEDAR RAPIDS and it is in NEBRASKA. */
    console.log(`      state       NOT IN THE PAYLOAD — read it off the operator's own locations page`);
  }
  return { where, locations: byLoc.size, rows: rows.length };
}

export async function main() {
  const list = arg("--list");
  const pages = list
    ? readFileSync(list, "utf8").split("\n")
        .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split(/\s+/)[0])
    : [arg("--page")].filter(Boolean);

  if (arg("--fixture")) {
    await probeOne(arg("--fixture"), { fixture: arg("--fixture") });
    return;
  }
  if (!pages.length) {
    console.error("give me --page <url>, --list <file> or --fixture <file>");
    process.exit(2);
  }
  const done = [];
  for (const p of pages) {
    try { done.push(await probeOne(p, { page: p })); }
    catch (e) {
      /* ONE PAGE FAILING IS NOT THE RUN FAILING. Ten candidates and one
         certificate problem should still leave nine answers on the screen.
         probeOne has already printed the `── page` header, so this adds the
         reason under it rather than opening a second header for the same page. */
      console.log(`   COULD NOT READ: ${e.message}`);
      done.push({ where: p, locations: 0, rows: 0, error: e.message });
    }
  }
  const ok = done.filter((d) => d.locations > 0);
  console.log(`\n── tally`);
  console.log(`pages asked: ${done.length}; answered: ${ok.length}; ` +
              `locations found: ${ok.reduce((n, d) => n + d.locations, 0)}`);
  for (const d of done.filter((x) => x.error)) console.log(`   unread: ${d.where}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

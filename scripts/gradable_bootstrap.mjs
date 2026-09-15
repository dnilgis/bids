#!/usr/bin/env node
/* CAPTURE A GRADABLE PARTNER'S BOOTSTRAP AND COMMIT IT AS A FIXTURE.
 *
 * WHY THIS EXISTS AND scripts/discover.mjs --dump DOES NOT COVER IT.
 *
 * POET's bootstrap is 202,283 bytes and thirty-six markets. It reached this
 * repository the way everything reaches it -- a discover run printed the body
 * into a log and the log was read. That works at 202 KB.
 *
 * ADM's does not. Run 2026-09-15T02:04 asked adm.gradable.com/market with
 * --dump bootstrap --dump-max 1000000 and the log says:
 *
 *     200 application/json 400000B (TRUNCATED at the cap)
 *       https://adm.gradable.com/api/commodities/merchandising/bootstrap
 *
 * TWO DIFFERENT CEILINGS, and only one of them was the one that had been
 * raised. --dump-max governs how many bytes discover will PRINT. captureAll's
 * `maxBodyBytes` governs how many bytes the browser hands over in the first
 * place, and it defaults to 400,000 in lib/cdp.mjs. The body was cut before
 * anything decided whether to print it.
 *
 * What survived the cut runs alphabetically from "Abilene, KS" to a half-word
 * in "Maidstone, ON": about 71 markets at POET's measured 5,619 bytes each. So
 * the whole payload is something over 700 KB, and a payload that size is not a
 * thing to move by pasting a log into a chat window.
 *
 * So this captures it and WRITES IT, and a workflow commits the file. The
 * bytes never pass through a person.
 *
 * WHAT IT REFUSES TO DO. Every one of these has cost this project a day:
 *
 *   - A TRUNCATED BODY IS NEVER WRITTEN. Today a cut body also fails to parse,
 *     so a cheaper script would appear to be safe. That is luck, not a check:
 *     the cut lands mid-token in a 700 KB object today and could land after a
 *     closing brace tomorrow, and the file would then be a valid JSON document
 *     that is missing half of ADM. The flag is asserted on its own.
 *   - A FIXTURE NEVER SHRINKS QUIETLY. If the file already names more markets
 *     than this capture found, the write is refused. --allow-shrink says so out
 *     loud, in the log, with both counts.
 *   - THE PAYLOAD MUST SAY WHOSE IT IS. `intent` has to equal the partner that
 *     was asked for, or a redirect could write ADM's markets into POET's file.
 *   - THE PARTNER IS A MENU, NOT A STRING. It is the only input and it reaches
 *     a filename. An input that reaches a filename is an input that can reach
 *     `../`.
 *
 * Usage:
 *   node scripts/gradable_bootstrap.mjs --partner adm
 *   node scripts/gradable_bootstrap.mjs --partner adm --max-body 1500000
 *   node scripts/gradable_bootstrap.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureAll } from "../lib/cdp.mjs";
import { marketsFrom } from "../lib/adapters/gradable.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* THE MENU. Adding a partner is adding a line here, which is a review, not a
   run-time string. */
export const PARTNERS = ["poet", "adm"];

/* Their body opens with an anti-hijack prefix, and the fixture keeps it: the
   file on disk is the bytes the wire carried, not a cleaned copy of them.
   lib/adapters/gradable.mjs strips it on read. */
export const BOOTSTRAP_PATH = "/api/commodities/merchandising/bootstrap";

export const pageUrlFor = (partner) => `https://${partner}.gradable.com/market`;
export const fixturePathFor = (partner) => `fixtures/gradable-${partner}-bootstrap.json`;

/* MATCHED ON ORIGIN AND PATH, NEVER ON A SUBSTRING. `includes("bootstrap")`
   would accept a bootstrap.css from a CDN and, worse, would accept
   evil.example.com/adm.gradable.com/api/.../bootstrap. */
export function isBootstrapResponse(url, partner) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  return u.protocol === "https:"
      && u.hostname === `${partner}.gradable.com`
      && u.pathname === BOOTSTRAP_PATH;
}

/** How many markets a body names, or null when it is not a bootstrap at all. */
export function marketCount(body) {
  try { return marketsFrom(body).length; }
  catch { return null; }
}

/** The intent a body declares, or null. */
export function intentOf(body) {
  try {
    const s = String(body ?? "").replace(/^\s*while\s*\(\s*1\s*\)\s*;/, "");
    const d = JSON.parse(s);
    return typeof d?.intent === "string" ? d.intent : null;
  } catch { return null; }
}

/* THE WHOLE DECISION, AS A FUNCTION OF WHAT WAS SEEN.
 *
 * Returns a refusal string, or null to write. It is separate from the capture
 * so that every branch can be driven by a test without a browser: the reason a
 * guard exists is a run nobody can reproduce on demand. */
export function refusalFor({ rec, partner, existingCount = null, allowShrink = false }) {
  if (!rec) return `no response from ${pageUrlFor(partner)} was ${BOOTSTRAP_PATH}`;
  if (rec.truncated === true)
    return `the body was TRUNCATED at the capture ceiling (${rec.body == null ? "?" : String(rec.body).length} bytes handed over). ` +
           `Raise --max-body past the whole payload and ask again; a cut bootstrap is not a short bootstrap, it is a wrong one.`;
  if (rec.body == null || String(rec.body) === "")
    return "the response matched but no body was handed over";
  const intent = intentOf(rec.body);
  if (intent == null)
    return `the body did not parse as the bootstrap object (${String(rec.body).length} bytes, starts ${JSON.stringify(String(rec.body).slice(0, 80))})`;
  if (intent !== partner)
    return `this body says intent ${JSON.stringify(intent)} but ${JSON.stringify(partner)} was asked for -- refusing to write one partner's markets into another's file`;
  const n = marketCount(rec.body);
  if (n == null) return "the body parsed but has no markets array";
  if (n === 0) return "the body names zero markets";
  const missing = marketsFrom(rec.body).filter((m) => m.marketId == null || !m.displayName).length;
  if (missing > 0)
    return `${missing} of ${n} market(s) carry no id or no display name; the payload is not the shape this repository reads`;
  if (existingCount != null && n < existingCount && !allowShrink)
    return `the committed fixture names ${existingCount} market(s) and this capture found ${n}. ` +
           `Refusing to shrink it. Pass --allow-shrink if ADM really did close ${existingCount - n} of them.`;
  return null;
}

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] ?? d; };

/* THE CEILING IS SAYABLE AND ITS DEFAULT IS NOT A GUESS. POET measured 5,619
   bytes per market; 1,500,000 holds about 267 of them, which is comfortably
   past ADM's ~140 without asking a runner to hold a body it will never see. */
export function maxBodyFrom(raw, fallback = 1500000) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  const partner = String(flag("partner", "") || "").toLowerCase();
  if (!PARTNERS.includes(partner)) {
    console.error(`::error title=unknown partner::${JSON.stringify(partner)} is not one of ${PARTNERS.join(", ")}`);
    process.exit(2);
  }
  const maxBodyBytes = maxBodyFrom(flag("max-body"));
  const patienceS = Math.max(5, Number(flag("patience", 60)) || 60);
  const outRel = fixturePathFor(partner);
  const out = join(ROOT, outRel);

  let existingCount = null;
  if (existsSync(out)) {
    existingCount = marketCount(readFileSync(out, "utf8"));
    console.log(`the committed ${outRel} names ${existingCount ?? "an unreadable number of"} market(s)`);
  }

  console.log(`asking ${pageUrlFor(partner)}, keeping only ${BOOTSTRAP_PATH}, ceiling ${maxBodyBytes} bytes`);
  const result = await captureAll({
    pageUrl: pageUrlFor(partner),
    /* ONE BODY, NOT EVERY BODY. The market page pulls ninety-odd responses and
       this needs exactly one of them; holding the rest at a 1.5 MB ceiling is
       how a runner runs out of memory for no reason. */
    keep: (u) => isBootstrapResponse(u, partner),
    maxBodyBytes,
    timeoutMs: patienceS * 1000,
    quietMs: 5000,
  });

  const rec = (result.responses ?? []).find((r) => isBootstrapResponse(r.url, partner))
           ?? (result.responses ?? []).find((r) => r.body != null);
  console.log(`   ${(result.responses ?? []).length} response(s)${result.quiet ? "" : ", network never went quiet"}`);
  if (result.error) console.log(`   page error: ${result.error}`);

  const refusal = refusalFor({ rec, partner, existingCount, allowShrink: has("allow-shrink") });
  if (refusal) {
    console.error(`::error title=bootstrap not written::${refusal}`);
    process.exit(1);
  }

  const body = String(rec.body);
  const n = marketCount(body);
  writeFileSync(out, body);
  console.log(`wrote ${outRel}: ${body.length} bytes, ${n} market(s)` +
              (existingCount == null ? " (new file)" : `, was ${existingCount}`));
  if (existingCount != null && n < existingCount)
    console.log(`::warning title=fixture shrank::${existingCount} -> ${n} market(s), allowed by --allow-shrink`);

  /* SAY WHAT IS IN IT, so the log is worth reading on its own. */
  const ms = marketsFrom(body);
  const states = [...new Set(ms.map((m) => m.state).filter(Boolean))].sort();
  const companies = [...new Set(ms.map((m) => m.company).filter(Boolean))].sort();
  const withBoard = ms.filter((m) => (m.publicInstruments ?? 0) > 0).length;
  const demo = ms.filter((m) => m.demo === true).length;
  console.log(`   ${withBoard} market(s) post at least one public instrument; ${demo} flagged demo`);
  console.log(`   ${states.length} state/province code(s): ${states.join(" ")}`);
  console.log(`   ${companies.length} company name(s): ${companies.slice(0, 12).join(" | ")}${companies.length > 12 ? " ..." : ""}`);
  console.log(`\nnext: node scripts/gradable-markets.mjs ${outRel} --partner ${partner}`);

  /* ONE COUNTER, AND THE COMMIT MESSAGE READS IT.
     The alternative was a second count in the workflow's shell -- a grep for
     "display_name", say -- which is a number that can disagree with the one
     the adapter produces. It did not disagree on POET; that is not a reason to
     keep two of them. */
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV, `MARKETS=${n}\nFIXTURE=${outRel}\n`);
}

/* --selftest, so test/script-selftests.test.mjs runs these without a browser. */
function selftest() {
  const ok = [];
  const bad = [];
  const t = (name, cond) => (cond ? ok : bad).push(name);

  t("adm bootstrap url matches", isBootstrapResponse("https://adm.gradable.com/api/commodities/merchandising/bootstrap", "adm"));
  t("query string does not stop the match", isBootstrapResponse("https://adm.gradable.com/api/commodities/merchandising/bootstrap?x=1", "adm"));
  t("poet's is not adm's", !isBootstrapResponse("https://poet.gradable.com/api/commodities/merchandising/bootstrap", "adm"));
  t("a look-alike host is refused", !isBootstrapResponse("https://evil.example.com/adm.gradable.com/api/commodities/merchandising/bootstrap", "adm"));
  t("A HOST THAT ONLY STARTS WITH THEIRS IS REFUSED", !isBootstrapResponse("https://adm.gradable.com.evil.example/api/commodities/merchandising/bootstrap", "adm"));
  t("and naming them in a query string is not being them", !isBootstrapResponse("https://evil.example/api/commodities/merchandising/bootstrap?from=adm.gradable.com", "adm"));
  t("http is refused", !isBootstrapResponse("http://adm.gradable.com/api/commodities/merchandising/bootstrap", "adm"));
  t("a substring is not a path", !isBootstrapResponse("https://adm.gradable.com/static/css/bootstrap.css", "adm"));
  t("junk does not throw", !isBootstrapResponse("not a url", "adm"));

  const good = `while(1);${JSON.stringify({ intent: "adm", markets: [
    { id: 1, display_name: "A, KS", address: {}, url_paths: [] },
    { id: 2, display_name: "B, IL", address: {}, url_paths: [] }] })}`;
  t("a good body is written", refusalFor({ rec: { url: "u", body: good, truncated: false }, partner: "adm" }) === null);
  t("TRUNCATION IS REFUSED ON ITS OWN, even when the body parses",
    /TRUNCATED/.test(refusalFor({ rec: { url: "u", body: good, truncated: true }, partner: "adm" }) ?? ""));
  t("a missing response is refused", refusalFor({ rec: null, partner: "adm" }) !== null);
  t("an empty body is refused", refusalFor({ rec: { url: "u", body: "" }, partner: "adm" }) !== null);
  t("unparseable is refused", refusalFor({ rec: { url: "u", body: "<html>" }, partner: "adm" }) !== null);
  t("THE WRONG PARTNER'S BODY IS REFUSED",
    /intent/.test(refusalFor({ rec: { url: "u", body: good }, partner: "poet" }) ?? ""));
  t("zero markets is refused",
    refusalFor({ rec: { url: "u", body: `while(1);{"intent":"adm","markets":[]}` }, partner: "adm" }) !== null);
  t("a market with no id is refused",
    refusalFor({ rec: { url: "u", body: `while(1);{"intent":"adm","markets":[{"display_name":"A"}]}` }, partner: "adm" }) !== null);
  t("A SHRINKING FIXTURE IS REFUSED", refusalFor({ rec: { url: "u", body: good }, partner: "adm", existingCount: 9 }) !== null);
  t("and --allow-shrink says so", refusalFor({ rec: { url: "u", body: good }, partner: "adm", existingCount: 9, allowShrink: true }) === null);
  t("growing is never refused", refusalFor({ rec: { url: "u", body: good }, partner: "adm", existingCount: 1 }) === null);

  t("the ceiling falls back rather than becoming zero", maxBodyFrom("") === 1500000 && maxBodyFrom("abc") === 1500000 && maxBodyFrom("0") === 1500000);
  t("and a real ceiling is honoured", maxBodyFrom("2000000") === 2000000);
  t("the default ceiling clears POET's measured 5,619 bytes/market by 100 markets", maxBodyFrom("") / 5619 > 200);

  t("the fixture path is the partner's own", fixturePathFor("adm") === "fixtures/gradable-adm-bootstrap.json");
  t("every partner on the menu is a bare slug", PARTNERS.every((p) => /^[a-z]+$/.test(p)));

  for (const n of ok) console.log(`  ok   ${n}`);
  for (const n of bad) console.log(`  FAIL ${n}`);
  console.log(`${ok.length} passed, ${bad.length} failed`);
  process.exit(bad.length === 0 ? 0 : 1);
}

/* ONLY WHEN THIS FILE IS THE THING BEING RUN.
   test/gradable-bootstrap.test.mjs imports the guards to drive them directly.
   Without this line that import launches a browser at adm.gradable.com and
   then exits the test runner with "unknown partner", which is what it did. */
const RUN_DIRECTLY = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/* SPELLED OUT, NOT `has("selftest")`, AND THAT IS NOT A STYLE CHOICE.
   test/script-selftests.test.mjs finds the scripts it must run by grepping for
   the literal `process.argv.includes("--selftest")`. A script that reaches the
   same flag through a helper is a script whose checks nothing runs — which is
   the exact failure that file was written for. */
if (RUN_DIRECTLY && process.argv.includes("--selftest")) selftest();
else if (RUN_DIRECTLY) main().catch((e) => { console.error(`::error::${e?.message ?? e}`); process.exit(1); });

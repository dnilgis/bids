#!/usr/bin/env node
/* AGRICHARTS — IS THE 403 ABOUT US, OR ABOUT WHERE WE ARE STANDING?
 *
 * WHAT IS ALREADY KNOWN, AND WHY THAT IS NOT ENOUGH
 *
 * AgriCharts is the largest single unread platform in this repository: 211
 * sites, ~945 locations, one adapter's worth of work. Their desktop board at
 * /markets/* is robots-disallowed on essentially every site. Their MOBILE
 * board is not, and serves every location and every price as plain HTML with
 * no browser and no JavaScript:
 *
 *     https://<sub>.mobile.agricharts.com/cash/prices.php
 *     https://mobile.<vanity-domain>/cash/prices.php
 *
 * Eight of those were read and verified on 2026-08-26 — from a workstation.
 * From the GitHub runner, the same URL answered:
 *
 *     <html><head><title>403 Forbidden</title>          (520 bytes)
 *
 * That is the THIRD time AgriCharts has refused a runner; /alertform did it
 * twice during the ALCIVIA work. probe-lists/agricharts-mobile.txt was closed
 * with the honest note that nobody had yet established WHY, and that the
 * cheap test left was one run with an ordinary desktop user-agent.
 *
 * This is that run, and it asks the question properly.
 *
 * TWO CAUSES, AND THEY NEED COMPLETELY DIFFERENT WORK
 *
 *   The CLIENT.   Our user-agent carries "agsist-bidreader" — both the poller's
 *                 and, less obviously, the browser one in lib/cdp.mjs, which
 *                 appends the same token to a real Chrome string. A rule that
 *                 matches on it refuses us and serves everyone else. If that is
 *                 it, the fix is a header and it is finished today.
 *
 *   The NETWORK.  A deny list over the runner's address range. If that is it,
 *                 no header on earth helps and the next lever is a different
 *                 egress — which is a different day's work and should not be
 *                 started on a guess.
 *
 * So: every target is asked once per PROFILE, the profiles differ ONLY in
 * headers, and the run prints a grid. Same address, same second, same path.
 * The only variable is who we say we are.
 *
 * THE CONTROLS ARE NOT OPTIONAL, and both of them earned their place.
 *
 *   A NETWORK control. If the runner cannot reach the open internet at all,
 *   every 403 below is noise. One fetch of a host we know answers, first.
 *
 *   A PLATFORM control. zzznotarealcoopxyz.mobile.agricharts.com answers 500 —
 *   measured 2026-08-26 — because 500 is AgriCharts' "no mobile site
 *   provisioned". A 500 there proves we are talking to AgriCharts and not to
 *   something in front of them. A 403 THERE, on a subdomain that does not
 *   exist, would say the refusal happens before their application sees the
 *   request, which is itself the answer.
 *
 * IT BRINGS BACK A BODY. If any profile gets in, the full page is written to
 * fixtures/agricharts-<slug>.html, verbatim and unedited, and committed. There
 * is no adapter for this platform yet and there should not be one until it can
 * be written against bytes somebody actually received. A fixture is the
 * difference between an adapter and a guess.
 *
 * IT DOES NOT GO RED FOR A REFUSAL. dtn-probe exits 1 on "wrote nothing", so
 * every honest run of it shows a red tick and the tick stops meaning anything.
 * A refusal is an ANSWER here. This exits non-zero only when it failed to ask.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/* ---------- flags ---------- */

const args = process.argv.slice(2);
const VALUED = new Set(["--list", "--url", "--profiles", "--out", "--timeout", "--control",
                        "--quotes-host"]);

/* WHERE THE FUTURES COME FROM, AND WHY ONE HOST IS ENOUGH.
 *
 * The cash board carries cash, basis and a futures CHANGE -- no futures price.
 * That matters more than it sounds: lib/board.mjs refuses any source where not
 * one row carries a quoted future, because a structural check whose absence
 * looks identical to its success is not a check. So AgriCharts cannot publish
 * at all until a real quote is in hand.
 *
 * Every AgriCharts mobile site carries the same CBOT quote pages, because they
 * are CBOT's numbers and not the operator's. One host answers for all 211, so
 * this captures from one and the fixtures are named for the page, not the
 * co-op. Measured 2026-09-02 on Legacy Farmers: Corn Dec 26 quoted 543-4s, and
 * cash minus basis across ten of their locations implied 543 or 544 -- 543.5,
 * rounded each way. Two pages, two independent numbers, agreeing to half a
 * cent. That is the check AgriCharts is missing and this is where it lives. */
const QUOTES_HOST_DEFAULT = "https://legacyfarmers.mobile.agricharts.com";

/* The overview lists two contracts per commodity; a root lists the whole strip,
   and a cash board quotes deliveries out past two contracts (Legacy Farmers
   priced a 01/01/2027 corn delivery off a 558 board, which is Mar 27 and is not
   on the overview). Both shapes are captured because the adapter has to know
   which one it can rely on. */
export const QUOTE_PAGES = [
  ["grains-overview", "/markets/futures.php?category=Grains&overview=1"],
  ["corn",            "/markets/futures.php?category=Grains&root=ZC"],
  ["soybeans",        "/markets/futures.php?category=Grains&root=ZS"],
  ["wheat-chicago",   "/markets/futures.php?category=Grains&root=ZW"],
  ["wheat-kc",        "/markets/futures.php?category=Grains&root=KE"],
  ["wheat-mpls",      "/markets/futures.php?category=Grains&root=MW"],
  ["oats",            "/markets/futures.php?category=Grains&root=ZO"],
  ["rice",            "/markets/futures.php?category=Grains&root=ZR"],
];
export function parseArgs(argv) {
  const out = { urls: [], list: null, profiles: null, out: "fixtures", timeoutMs: 20000,
                control: "https://raw.githubusercontent.com/dnilgis/bids/main/package.json",
                noFixture: false, quotes: false, quotesHost: QUOTES_HOST_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.urls.push(argv[++i]);
    else if (a === "--list") out.list = argv[++i];
    else if (a === "--profiles") out.profiles = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === "--control") out.control = argv[++i];
    else if (a === "--no-fixture") out.noFixture = true;
    else if (a === "--quotes") out.quotes = true;
    else if (a === "--quotes-host") out.quotesHost = argv[++i];
    else if (/^https?:\/\//.test(a) && !VALUED.has(argv[i - 1])) out.urls.push(a);
  }
  return out;
}

/* ---------- the target list ---------- */

/* probe-lists/agricharts-mobile.txt is nine tenths prose, and the prose is the
   valuable part of it — it is where the 403 was written down. A URL is a line
   that starts with a scheme; everything else is somebody's reasoning. */
export function urlsFrom(text) {
  return [...new Set(String(text).split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\/\S+$/.test(l)))];
}

/* ---------- profiles ---------- */

/* WHAT EACH ONE IS FOR. The value of the grid is that the differences are
   small and deliberate; a profile that changes two things at once cannot
   answer anything.
 *
 *   bidreader     exactly what scripts/poll.mjs sends. If the reader is ever
 *                 going to read this platform, this is the row that matters.
 *   cdp           exactly what lib/cdp.mjs sends — a real Chrome string with
 *                 our token appended. This is the profile that was refused on
 *                 2026-08-26, so it is the baseline the others are compared to.
 *   chrome        the same Chrome string with the token REMOVED and nothing
 *                 else changed. cdp vs chrome isolates the token by itself.
 *   browser       chrome plus the headers a real browser always sends. If
 *                 chrome fails and browser passes, they fingerprint the header
 *                 set rather than the UA string.
 *   bare          no user-agent at all. Some rules refuse only what they can
 *                 name; this is the other end of the range.
 */
export const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/141.0.0.0 Safari/537.36";

export const PROFILES = {
  bidreader: { "user-agent": "agsist-bidreader/1.0 (+https://agsist.com; posted bid)",
               accept: "text/html" },
  cdp:       { "user-agent": `${CHROME} agsist-bidreader (+https://agsist.com)`,
               accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  chrome:    { "user-agent": CHROME,
               accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  browser:   { "user-agent": CHROME,
               accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
               "accept-language": "en-US,en;q=0.9",
               "accept-encoding": "gzip, deflate, br",
               "upgrade-insecure-requests": "1",
               "sec-fetch-dest": "document", "sec-fetch-mode": "navigate",
               "sec-fetch-site": "none", "sec-fetch-user": "?1",
               "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="24"',
               "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Linux"' },
  bare:      {},
};

export const PROFILE_ORDER = ["bidreader", "cdp", "chrome", "browser", "bare"];

/* ---------- naming a fixture ---------- */

/* legacyfarmers.mobile.agricharts.com -> legacyfarmers
   mobile.thefarmerselevator.com       -> thefarmerselevator
   Both hostname forms are in use for the same board, and a fixture named after
   the form we happened to try would file the same operator twice. */
export function slugOf(hostname) {
  let h = String(hostname).toLowerCase().replace(/^www\./, "");
  if (h.endsWith(".agricharts.com")) h = h.slice(0, -".agricharts.com".length);
  h = h.replace(/^mobile\./, "").replace(/\.mobile$/, "");
  h = h.replace(/\.(com|net|org|coop|ca|us|biz|info)$/, "");
  return h.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/* A 200 is not a board. A parked hostname, a redirect to a marketing page and
   a "choose your location" splash all answer 200, and any of them written into
   fixtures/ would be built against later by somebody who trusted the name. */
export function looksLikeBoard(body) {
  const t = String(body);
  if (t.length < 400) return false;
  return /cash\s*price/i.test(t) && /<t[dr]\b/i.test(t);
}

/* A QUOTES PAGE IS NOT A BOARD AND IS NOT A MENU. futures.php with no root and
   no overview answers 200 with a category menu and no prices at all, which is
   exactly the shape that would get filed as a fixture and built against. */
export function looksLikeQuotes(body) {
  const t = String(body);
  if (t.length < 400) return false;
  if (!/<t[dr]\b/i.test(t)) return false;
  if (!/\bLast\b/.test(t) || !/\bChange\b/.test(t)) return false;
  /* A price in eighths (543-4s), or a decimal quote (7.5975s). Menus have
     neither, and this is the cell the adapter will have to read. */
  return /\d{2,4}-\d\d?[sb]?\b/.test(t) || /\d+\.\d{2,4}s\b/.test(t);
}

/* ---------- one request ---------- */

const squeeze = (s, n = 200) => String(s).replace(/\s+/g, " ").trim().slice(0, n);

async function ask(url, headers, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: ac.signal });
    const body = await res.text();
    return { ok: true, status: res.status, finalUrl: res.url, ms: Date.now() - t0,
             bytes: Buffer.byteLength(body), body,
             type: res.headers.get("content-type") || "",
             server: res.headers.get("server") || "",
             cfRay: res.headers.get("cf-ray") || "",
             via: res.headers.get("via") || "" };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - t0,
             error: `${e.name}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ""}` };
  } finally { clearTimeout(timer); }
}

/* ---------- the verdict ---------- */

/* THE POINT OF THE RUN IS THIS FUNCTION, and it is pure so it can be tested
   without the network. A grid of status codes is data; what somebody does on
   Monday is the sentence underneath it. */
export function verdict({ rows, networkControl, platformControl }) {
  const lines = [];
  if (!networkControl?.ok || (networkControl.status ?? 0) >= 400) {
    lines.push("INCONCLUSIVE. The network control did not answer either "
      + `(${networkControl?.error ?? `status ${networkControl?.status}`}), so nothing below is `
      + "about AgriCharts. Re-run when the runner has egress.");
    return { call: "inconclusive", lines };
  }
  const attempted = rows.filter((r) => r.ok || r.error);
  if (!attempted.length) {
    lines.push("INCONCLUSIVE. Nothing was asked.");
    return { call: "inconclusive", lines };
  }

  const opened = rows.filter((r) => r.status === 200);
  const byProfile = new Map();
  for (const r of rows) {
    const e = byProfile.get(r.profile) ?? { n: 0, ok: 0, refused: 0 };
    e.n++;
    if (r.status === 200) e.ok++;
    if (r.status === 403) e.refused++;
    byProfile.set(r.profile, e);
  }

  if (opened.length) {
    const winners = [...byProfile.entries()].filter(([, e]) => e.ok > 0)
      .map(([p, e]) => `${p} (${e.ok}/${e.n})`);
    lines.push(`A DOOR IS OPEN. Profile(s) that got a 200: ${winners.join(", ")}.`);
    const losers = [...byProfile.entries()].filter(([, e]) => e.ok === 0).map(([p]) => p);
    if (losers.length) {
      lines.push(`Refused as before: ${losers.join(", ")}. The difference between those two `
        + "sets IS the rule they are applying — read the header tables above and copy the "
        + "smallest winning set into the reader, not the whole of it.");
    }
    if (byProfile.get("cdp")?.ok === 0 && byProfile.get("chrome")?.ok > 0) {
      lines.push("cdp failed and chrome passed on the same string minus our token: they are "
        + "matching on \"agsist-bidreader\". lib/cdp.mjs and scripts/poll.mjs both send it.");
    }
    if (byProfile.get("chrome")?.ok === 0 && byProfile.get("browser")?.ok > 0) {
      lines.push("chrome failed and browser passed: the user-agent alone is not enough for "
        + "them; they want the header set a browser sends.");
    }
    return { call: "client", lines };
  }

  const codes = [...new Set(rows.map((r) => r.status ?? r.error).filter(Boolean))];
  const allRefused = rows.length > 0 && rows.every((r) => r.status === 403);
  if (allRefused) {
    lines.push("REFUSED IDENTICALLY BY EVERY PROFILE. Five different clients, one address, "
      + "one second apart, all 403 — while the network control answered normally. "
      + "The client is not the variable.");
    if (platformControl && platformControl.status === 500) {
      lines.push("The platform control (a subdomain that does not exist) still answered 500, "
        + "which is AgriCharts' own \"no mobile site\" reply. So their application IS seeing "
        + "these requests and IS choosing to refuse them — this is not something in front of "
        + "them swallowing us.");
    } else if (platformControl && platformControl.status === 403) {
      lines.push("The platform control — a subdomain that DOES NOT EXIST — was refused too. "
        + "A 403 for a hostname with nothing behind it cannot be about the page, the path or "
        + "the headers. Whatever refuses us does so before AgriCharts is reached.");
    } else if (platformControl) {
      lines.push(`The platform control answered ${platformControl.status ?? platformControl.error} `
        + "rather than the 500 measured on 2026-08-26, so the shape of their refusal has "
        + "changed since; do not read the rest of this against the old note without saying so.");
    }
    lines.push("NEXT LEVER IS EGRESS, not headers. Nothing in this repository's reader can "
      + "fix a block on the address range it runs in, and no further user-agent is worth "
      + "trying. That is a decision to take deliberately, not a patch.");
    return { call: "network", lines };
  }

  lines.push(`MIXED: ${codes.join(", ")}. Not one rule — read the grid row by row before `
    + "concluding anything, and say which target each statement is about.");
  return { call: "mixed", lines };
}

/* ---------- main ---------- */

const DEFAULT_LIST = "probe-lists/agricharts-mobile.txt";
const PLATFORM_CONTROL = "https://zzznotarealcoopxyz.mobile.agricharts.com/cash/prices.php";

/* THE QUOTE CAPTURE. A separate run because it asks a different question:
   not "will they let us in" -- that is settled -- but "is the number the cash
   board is missing on a page we can read". Same rules: it writes fixtures and
   it does not go red for a page that is not there. */
async function quotesRun(cfg) {
  const base = cfg.quotesHost.replace(/\/+$/, "");
  console.log(`AGRICHARTS QUOTES CAPTURE — ${QUOTE_PAGES.length} page(s) from ${base}`);
  console.log("These are CBOT's numbers, not the operator's, so one host answers for all 211.\n");
  const wrote = [], missed = [];
  for (const [name, path] of QUOTE_PAGES) {
    const url = base + path;
    const r = await ask(url, PROFILES.chrome, cfg.timeoutMs);
    if (!r.ok) { console.log(`   ${name.padEnd(16)} ${r.error}`); missed.push({ name, why: r.error }); continue; }
    const quotes = r.status === 200 && looksLikeQuotes(r.body);
    console.log(`   ${name.padEnd(16)} ${String(r.status).padEnd(4)} ${String(r.bytes).padStart(7)}B `
      + `${String(r.ms).padStart(5)}ms  ${quotes ? "QUOTES" : "no price table"}  ${url}`);
    if (!quotes) { missed.push({ name, why: `${r.status}, no price table` }); continue; }
    if (cfg.noFixture) continue;
    mkdirSync(cfg.out, { recursive: true });
    const file = join(cfg.out, `agricharts-quotes-${name}.html`);
    writeFileSync(file, r.body);
    wrote.push({ file, url, bytes: r.bytes });
  }
  console.log("");
  if (wrote.length) {
    console.log(`── FIXTURES WRITTEN (${wrote.length})`);
    for (const x of wrote) console.log(`   ${x.file}  ${x.bytes}B  from ${x.url}`);
    console.log(`::notice title=${wrote.length} AgriCharts quote page(s) captured::`
      + "the futures side of cash - basis = futures can now be written against bytes.");
  } else {
    console.log("── NOTHING CAPTURED. Every quote page answered without a price table, so the "
      + "futures number the cash board is missing is NOT where it was on 2026-09-02. "
      + "That is a finding about the platform, not a failure of this run.");
  }
  if (missed.length) {
    console.log(`\n── PAGES WITH NO PRICE TABLE (${missed.length})`);
    for (const m of missed) console.log(`   ${m.name.padEnd(16)} ${m.why}`);
    console.log("   A commodity with no strip here is one this platform cannot be published for, "
      + "because its rows would carry no quoted future and lib/board.mjs refuses that.");
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const cfg = parseArgs(argv);

  /* The quote capture asks a different question and takes no target list, so it
     branches before one is resolved -- a missing probe list must not stop it. */
  if (cfg.quotes) {
    console.log(`── NETWORK CONTROL  ${cfg.control}`);
    const nc = await ask(cfg.control, PROFILES.chrome, cfg.timeoutMs);
    console.log(`   ${nc.ok ? `${nc.status} ${nc.bytes}B in ${nc.ms}ms` : nc.error}\n`);
    if (!nc.ok || nc.status >= 400) {
      console.log("INCONCLUSIVE. The runner could not reach the control host, so nothing below "
        + "would be about AgriCharts.");
      return 1;
    }
    return await quotesRun(cfg);
  }

  let targets = cfg.urls.slice();
  if (!targets.length) {
    const path = cfg.list ?? DEFAULT_LIST;
    if (!existsSync(path)) { console.error(`::error::no targets and no ${path}`); return 2; }
    targets = urlsFrom(readFileSync(path, "utf8"));
  }
  const profiles = (cfg.profiles ?? PROFILE_ORDER).filter((p) => {
    if (PROFILES[p]) return true;
    console.log(`   (ignoring unknown profile "${p}"; known: ${PROFILE_ORDER.join(", ")})`);
    return false;
  });
  if (!targets.length || !profiles.length) { console.error("::error::nothing to ask"); return 2; }

  console.log(`AGRICHARTS PROBE — ${targets.length} target(s) x ${profiles.length} profile(s)`);
  console.log(`Profiles, in order: ${profiles.join(", ")}\n`);

  console.log(`── NETWORK CONTROL  ${cfg.control}`);
  const networkControl = await ask(cfg.control, PROFILES.chrome, cfg.timeoutMs);
  console.log(`   ${networkControl.ok ? `${networkControl.status} ${networkControl.bytes}B in ${networkControl.ms}ms`
                                       : networkControl.error}\n`);

  console.log(`── PLATFORM CONTROL  ${PLATFORM_CONTROL}`);
  console.log("   (a subdomain that does not exist; 500 was AgriCharts' own reply on 2026-08-26)");
  const platformControl = await ask(PLATFORM_CONTROL, PROFILES.chrome, cfg.timeoutMs);
  console.log(`   ${platformControl.ok ? `${platformControl.status} ${platformControl.bytes}B  server=${platformControl.server || "?"}`
                                       : platformControl.error}\n`);

  const rows = [];
  const wrote = [];
  for (const url of targets) {
    console.log(`── ${url}`);
    for (const p of profiles) {
      const r = await ask(url, PROFILES[p], cfg.timeoutMs);
      rows.push({ url, profile: p, ...r });
      if (!r.ok) { console.log(`   ${p.padEnd(9)} ${r.error}`); continue; }
      const marks = [r.server && `server=${r.server}`, r.cfRay && "cf-ray", r.via && `via=${r.via}`]
        .filter(Boolean).join(" ");
      console.log(`   ${p.padEnd(9)} ${String(r.status).padEnd(4)} ${String(r.bytes).padStart(7)}B `
        + `${String(r.ms).padStart(5)}ms  ${r.type.split(";")[0] || "?"} ${marks}`);
      /* A REFUSAL'S BODY IS EVIDENCE. 520 bytes of it named the whole problem
         last time and was quoted from a log, not from a fixture. */
      if (r.status !== 200 && r.bytes <= 2000) console.log(`     body: ${squeeze(r.body, 300)}`);
      if (r.finalUrl && r.finalUrl !== url) console.log(`     redirected to ${r.finalUrl}`);

      if (r.status === 200 && !cfg.noFixture) {
        const board = looksLikeBoard(r.body);
        if (!board) {
          console.log("     200 but this does not look like a board (no \"Cash Price\" and no "
            + "table cells) — NOT saved as a fixture.");
        } else {
          const slug = slugOf(new URL(r.finalUrl || url).hostname);
          const file = join(cfg.out, `agricharts-${slug}.html`);
          if (wrote.some((w) => w.file === file)) {
            console.log(`     board confirmed; fixture already written this run (${file})`);
          } else {
            mkdirSync(cfg.out, { recursive: true });
            writeFileSync(file, r.body);
            wrote.push({ file, url, profile: p, bytes: r.bytes });
            console.log(`     BOARD. Wrote ${file} (${r.bytes} bytes, verbatim) — the adapter `
              + "gets written against this and not against a description of it.");
          }
        }
      }
    }
    console.log("");
  }

  console.log("── GRID  (rows are targets, columns are profiles)");
  const w = Math.max(...targets.map((t) => t.length), 6);
  console.log(`${"target".padEnd(w)}  ${profiles.map((p) => p.padEnd(9)).join(" ")}`);
  for (const t of targets) {
    const cells = profiles.map((p) => {
      const r = rows.find((x) => x.url === t && x.profile === p);
      return String(r ? (r.status ?? "ERR") : "—").padEnd(9);
    });
    console.log(`${t.padEnd(w)}  ${cells.join(" ")}`);
  }

  const v = verdict({ rows, networkControl, platformControl });
  console.log("\n── VERDICT");
  for (const l of v.lines) console.log(`   ${l}`);

  if (wrote.length) {
    console.log(`\n── FIXTURES WRITTEN (${wrote.length})`);
    for (const x of wrote) console.log(`   ${x.file}  ${x.bytes}B  from ${x.url} as ${x.profile}`);
    console.log(`::notice title=${wrote.length} AgriCharts board(s) captured::`
      + `${wrote.map((x) => x.file).join(", ")} — an adapter can now be written against bytes.`);
  } else {
    console.log(`\n── NO FIXTURE WRITTEN. ${v.call === "network"
      ? "Nothing got in; that is the finding, not a failure."
      : "No 200 answered with a board."}`);
  }

  /* ASKING AND FAILING TO ASK ARE DIFFERENT THINGS, and only the second is red.
     dtn-probe exits 1 when it writes nothing, so every honest run of it shows a
     red tick and the tick has stopped carrying information. */
  return v.call === "inconclusive" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`::error::${e.stack || e}`); process.exit(1); });
}

#!/usr/bin/env node
/*
 * email-bids.mjs: read Bunge's morning "Cash Bids for Haw Creek" email out of
 * a dedicated mailbox and write its bids to data/email/<listing id>.json.
 *
 * WHY A MAILBOX. Bunge at Ladoga, IN posts no bids on bungeag.com (see
 * lib/adapters/bungeag.mjs, "Haw Creek"). Bunge does mail them, every morning,
 * from noreply@mobile.bunge.us to any customer who signs up. Sig gets that
 * email and auto-forwards it to a Gmail address kept for this alone; this
 * script logs into that mailbox over IMAP and reads it. The poller then reads
 * the snapshot like any other board (platform "bunge-email",
 * lib/adapters/bunge-email.mjs), through every guard.
 *
 *   env BIDS_IMAP_USER, BIDS_IMAP_PASSWORD   the mailbox and its app password
 *   env BIDS_IMAP_HOST (imap.gmail.com), BIDS_IMAP_PORT (993)
 *
 *   node scripts/email-bids.mjs
 *
 * WHICH MESSAGES. Unseen ones, and anything from the last two days (so a run
 * whose push failed is redone by the next one instead of losing the email it
 * had already marked seen). A message counts when it is FROM Bunge's sender,
 * directly or as a forward (Gmail's auto-forward keeps the original From; a
 * hand forward carries "From: ... noreply@mobile.bunge.us" in its body or as
 * an attached message), and its text has a "Cash bids for" heading. Anything
 * else in the mailbox is left exactly as it was, unread.
 *
 * WHAT IT DOES WITH THEM. Every cash-bid email is parsed; the newest (by the
 * date Bunge printed, then when it was sent) is written, only when its date or
 * its rows differ from the snapshot already committed. The emails it read are
 * then marked seen.
 *
 * WHEN IT CANNOT. Secrets missing: one line, "email bids: not set up yet",
 * exit 0. An email that does not parse (Bunge changed the layout, a row does
 * not balance): NOTHING is written and nothing is marked seen; it exits 1 with
 * the reason, so the run goes red and says why, and the next run tries again.
 *
 * WHAT IT PRINTS. The parsed bid rows and counts. Never an email address, the
 * password, a header or a message body.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Imap, imapDate } from "../lib/imap.mjs";
import { parseMessage, textOf, addressOf } from "../lib/mime.mjs";
import { SENDER, parseEmail, snapshotOf, snapshotChanged, snapshotPath, htmlToText,
         BungeEmailRefused } from "../lib/adapters/bunge-email.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOOKBACK_DAYS = 2;
export const MAX_MESSAGES = 30;
const NOT_SET_UP = "email bids: not set up yet";

const senderRx = new RegExp(`^[>\\s]*(?:\\*\\s*)?From:?\\*?[^\\n]*${SENDER.replace(/[.]/g, "\\.")}`, "im");

/** "direct", "forwarded", or null: is this message Bunge's? */
export function bungeOrigin(msg) {
  if (addressOf(msg.header("from")) === SENDER) return "direct";
  for (const m of msg.inner) if (addressOf(m.header("from")) === SENDER) return "forwarded";
  const { text, html } = textOf(msg);
  if (senderRx.test(text ?? "") || senderRx.test(html ? htmlToText(html) : "")) return "forwarded";
  return null;
}

/* A message that says it is from Bunge and that Gmail found failing DMARC
   is somebody else's; it is not read. A forward is judged by its contents. */
export const dmarcFailed = (msg) =>
  (msg.headers.get("authentication-results") ?? []).some((v) => /\bdmarc=fail\b/i.test(v));

const isoOf = (v) => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
/* IMAP's INTERNALDATE is "14-Oct-2026 12:01:33 +0000". */
const internalIso = (v) => {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})/.exec(String(v ?? ""));
  return m ? isoOf(`${m[2]} ${m[1]} ${m[3]} ${m[4]} ${m[5]}`) : null;
};

/**
 * One raw message. Returns { skip: why } for one that is not a Bunge cash-bid
 * email, { parsed, receivedAt, origin } for one that is, and throws
 * BungeEmailRefused for one that is and will not read.
 */
export function readMessage(raw, internalDate = null) {
  const msg = parseMessage(raw);
  const origin = bungeOrigin(msg);
  if (!origin) return { skip: "not from Bunge" };
  if (origin === "direct" && dmarcFailed(msg)) return { skip: "claims to be from Bunge and fails DMARC" };
  const { text, html } = textOf(msg);
  const hasBids = (s) => /cash bids for/i.test(s ?? "");
  if (!hasBids(text) && !hasBids(html)) return { skip: "a Bunge message that is not a cash-bid notice" };
  let parsed = null, first = null;
  for (const [body, isHtml] of [[text, false], [html, true]]) {
    if (!hasBids(body)) continue;
    try { parsed = parseEmail(body, { html: isHtml }); break; }
    catch (e) { if (!(e instanceof BungeEmailRefused)) throw e; first ??= e; }
  }
  if (!parsed) throw first;
  const inner = msg.inner.find((m) => addressOf(m.header("from")) === SENDER);
  const receivedAt = isoOf((inner ?? msg).header("date")) ?? internalIso(internalDate) ?? isoOf(msg.header("date"));
  if (!receivedAt) throw new BungeEmailRefused("the email has no readable Date and the mailbox gave no arrival time");
  return { parsed, receivedAt, origin };
}

const rowLine = (b) => `    ${b.commodity.padEnd(12)} ${b.delivery.padEnd(14)} bid ${String(b.cash).padStart(6)}  `
  + `basis ${String(b.basis).padStart(5)}  futures ${String(b.futures).padStart(6)} ${b.contract ?? "(no contract)"}`;

/**
 * The whole job. Injected so it can be tested against a fake server and a
 * temporary checkout. Returns the exit code.
 */
export async function run({ env = process.env, root = ROOT, nowMs = Date.now(), connect = null,
                            log = console.log, error = console.error } = {}) {
  const user = String(env.BIDS_IMAP_USER ?? "").trim(), pass = String(env.BIDS_IMAP_PASSWORD ?? "");
  if (!user || !pass) { log(NOT_SET_UP); return 0; }
  const host = env.BIDS_IMAP_HOST || "imap.gmail.com", port = Number(env.BIDS_IMAP_PORT || 993);

  let imap;
  try {
    imap = connect ? await connect({ host, port }) : await Imap.connect({ host, port });
    await imap.greeting();
    await imap.login(user, pass);
    await imap.select("INBOX");
  } catch (e) {
    error(`::error title=email bids::could not open the mailbox: ${e.message}`);
    imap?.logout().catch(() => {});
    return 1;
  }

  try {
    const since = imapDate(nowMs - LOOKBACK_DAYS * 86_400_000);
    const uids = (await imap.search(`OR UNSEEN SINCE ${since}`)).slice(-MAX_MESSAGES);
    const found = [], refused = [], skipped = new Map();
    for (const uid of uids) {
      const m = await imap.fetch(uid);
      try {
        const r = readMessage(m.raw, m.internalDate);
        if (r.skip) { skipped.set(r.skip, (skipped.get(r.skip) ?? 0) + 1); continue; }
        found.push({ uid, ...r });
      } catch (e) {
        if (!(e instanceof BungeEmailRefused)) throw e;
        refused.push({ uid, why: e.message });
      }
    }
    log(`email bids: ${uids.length} message(s) looked at, ${found.length} Bunge cash-bid email(s)`
      + [...skipped].map(([w, n]) => `, ${n} skipped (${w})`).join(""));
    if (skipped.get("claims to be from Bunge and fails DMARC"))
      error(`::warning title=email bids::a message claiming to be Bunge's failed DMARC and was not read`);

    if (refused.length) {
      for (const r of refused)
        error(`::error title=email bids: Bunge's email did not read::${r.why}. Nothing was written and the `
          + `email is left unread, so the next run tries it again. If Bunge changed the email's layout, `
          + `lib/adapters/bunge-email.mjs parseEmail() is what to update.`);
      return 1;
    }
    if (!found.length) {
      if (skipped.get("a Bunge message that is not a cash-bid notice"))
        error(`::warning title=email bids::Bunge mail arrived with no "Cash bids for" heading; `
          + `if the bid email changed its wording, nothing will be read until parseEmail() follows it`);
      return 0;
    }

    /* The newest per location: the date Bunge printed, then when it was sent. */
    const newest = new Map();
    for (const f of found) {
      const k = f.parsed.listingId, cur = newest.get(k);
      if (!cur || f.parsed.asOf > cur.parsed.asOf
          || (f.parsed.asOf === cur.parsed.asOf && f.receivedAt > cur.receivedAt)) newest.set(k, f);
    }
    const wrote = [];
    for (const [listingId, f] of newest) {
      const rel = snapshotPath(listingId), file = join(root, rel);
      let prev = null;
      try { prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { prev = null; }
      const next = snapshotOf(f.parsed, f.receivedAt);
      log(`  ${listingId}: Bunge "${f.parsed.location}" for ${next.asOf}, sent ${next.receivedAt} (${f.origin})`);
      for (const b of next.bids) log(rowLine(b));
      if (prev && prev.asOf > next.asOf) { log(`  ${rel} already holds ${prev.asOf}; an older email does not replace it`); continue; }
      if (!snapshotChanged(prev, next)) { log(`  ${rel}: no change`); continue; }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      wrote.push(`${listingId} ${next.asOf}`);
      log(`  wrote ${rel} (${next.bids.length} rows)`);
    }
    for (const f of found) await imap.markSeen(f.uid);
    if (env.GITHUB_OUTPUT)
      appendFileSync(env.GITHUB_OUTPUT, `message=bids: email ${wrote.length ? wrote.join(", ") : "no change"}\n`);
    return 0;
  } catch (e) {
    error(`::error title=email bids::${e.message}`);
    return 1;
  } finally {
    await imap.logout().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then((c) => process.exit(c), (e) => { console.error(`::error title=email bids::${e?.message ?? e}`); process.exit(1); });
}

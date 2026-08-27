#!/usr/bin/env node
/*
 * alert-email.mjs — put a failure in Sig's inbox, not on a page he has to visit.
 *
 * WHY THIS EXISTS
 *
 * Sig, 2026-08-27: "i want this thing to run, if it doesnt run i want a backup
 * to run the moment we realize the primary run failed, if that doesnt run i
 * want an email sent to me immediately to address the issue."
 *
 * The first two he already had. The third he did not: the alert was a GitHub
 * issue, which reaches a person only if they are watching the repository AND
 * the notification setting nobody remembers choosing happens to be on AND the
 * mail does not land in a filtered folder. On 2026-08-27 the reader was down
 * for six hours and the first anybody knew of it was Sig opening a browser
 * tab. That is not an alert, it is an archive.
 *
 * ONE IMPLEMENTATION, TWO CALLERS. poll.yml's backup job and watchdog.yml both
 * send through this file, so there is exactly one place where the subject
 * line, the escaping and the SMTP dialogue live.
 *
 * NO DEPENDENCIES. This repository ships no production npm packages and is not
 * about to add one for sixty lines of SMTP. node:tls speaks to Gmail on 465
 * directly, and 465 is implicit TLS, so there is no STARTTLS negotiation to
 * get subtly wrong.
 *
 * IT FAILS OPEN, LOUDLY. A missing secret must never turn a recoverable feed
 * problem into a failed workflow — but it must not be silent either, or the
 * day the alert is needed it will turn out to have been off for a month. No
 * credentials: say so on stderr as a GitHub warning annotation, exit 0.
 *
 * NO SECRETS IN THIS FILE. Everything comes from the environment:
 *   SMTP_HOST  default smtp.gmail.com
 *   SMTP_PORT  default 465 (implicit TLS)
 *   SMTP_USER  the account
 *   SMTP_PASS  a Gmail APP PASSWORD, not the account password
 *   ALERT_TO   where the alarm goes; defaults to SMTP_USER
 *   ALERT_FROM defaults to SMTP_USER
 *
 * Usage:  node scripts/alert-email.mjs "subject" "body"
 */
import tls from "node:tls";

const env = (k, d) => (process.env[k] ?? "").trim() || d;
const HOST = env("SMTP_HOST", "smtp.gmail.com");
const PORT = Number(env("SMTP_PORT", "465"));
const USER = env("SMTP_USER");
const PASS = env("SMTP_PASS");
const FROM = env("ALERT_FROM", USER);
const TO = env("ALERT_TO", USER);

const subject = process.argv[2] || "bids: the reader needs a look";
const body = process.argv[3] || "";

if (!USER || !PASS || !TO) {
  console.error(
    "::warning title=no alert email sent::SMTP_USER, SMTP_PASS or ALERT_TO is not set on this " +
    "repository, so the failure below reached nobody by mail. Add them as repository secrets. " +
    "Subject was: " + subject);
  process.exit(0);
}

/* A header value may not carry a bare newline: that is how a subject line
   becomes an injected header. Fold nothing, strip everything. */
const header = (s) => String(s).replace(/[\r\n]+/g, " ").slice(0, 900);

/* RFC 5321: a line consisting of a single dot ends DATA, so any body line
   that starts with one gets a second. Missing this truncates the message at
   the first such line, silently. */
const dotStuff = (s) => String(s).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");

function talk(sock, expect, line) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      /* An SMTP reply is finished when a line begins with the three-digit code
         followed by a SPACE. Continuation lines use a hyphen instead, and Gmail
         sends several of them after EHLO, so resolving on the first line would
         desynchronise every exchange after it. Test the last COMPLETE line. */
      const lines = buf.split(/\r?\n/);
      lines.pop();                                  // trailing partial line
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      sock.removeListener("data", onData);
      const code = Number(last.slice(0, 3));
      if (expect && !expect.includes(code))
        return reject(new Error(`expected ${expect} got: ${buf.trim().slice(0, 200)}`));
      resolve(buf);
    };
    sock.on("data", onData);
    if (line !== undefined) sock.write(line + "\r\n");
  });
}

const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");

const sock = tls.connect({ host: HOST, port: PORT, servername: HOST });
sock.setEncoding("utf8");
sock.setTimeout(25000, () => { console.error("::warning title=alert email timed out::" + HOST); sock.destroy(); process.exit(0); });

try {
  await new Promise((r, j) => { sock.once("secureConnect", r); sock.once("error", j); });
  await talk(sock, [220]);
  await talk(sock, [250], "EHLO bids.local");
  await talk(sock, [334], "AUTH LOGIN");
  await talk(sock, [334], b64(USER));
  await talk(sock, [235], b64(PASS));
  await talk(sock, [250], `MAIL FROM:<${FROM}>`);
  for (const rcpt of TO.split(/[,\s]+/).filter(Boolean)) await talk(sock, [250, 251], `RCPT TO:<${rcpt}>`);
  await talk(sock, [354], "DATA");
  const msg = [
    `From: AGSIST bid reader <${FROM}>`,
    `To: ${TO}`,
    `Subject: ${header(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "", dotStuff(body), ".",
  ].join("\r\n");
  await talk(sock, [250], msg);
  await talk(sock, [221], "QUIT").catch(() => {});
  sock.end();
  console.log(`alert emailed to ${TO}: ${header(subject)}`);
} catch (e) {
  /* Still fail open. A mail server having a bad day must not be the reason a
     recovered feed is reported as broken. */
  console.error("::warning title=alert email failed::" + String(e.message).slice(0, 300));
  try { sock.destroy(); } catch { /* already gone */ }
  process.exit(0);
}

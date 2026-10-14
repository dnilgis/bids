/* THE SMALLEST IMAP CLIENT THAT READS ONE MAILBOX. No dependencies: this
 * repository installs nothing. Gmail over TLS on 993 with an app password is
 * the case it is written for (RFC 3501, the commands below and nothing else):
 *
 *   LOGIN, SELECT, UID SEARCH, UID FETCH (BODY.PEEK[] so reading does not mark
 *   a message seen), UID STORE +FLAGS (\Seen), LOGOUT
 *
 * NOTHING SECRET IS EVER IN AN ERROR. A refused command is reported by its
 * verb and the server's answer; the command line itself (which for LOGIN holds
 * the password) is never echoed, logged or thrown. */
import tls from "node:tls";

export class ImapError extends Error {}

export const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A date as IMAP SEARCH wants it: 13-Oct-2026. */
export const imapDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };

export class Imap {
  /** socket: a connected duplex stream (a TLS socket in production, a plain one in tests). */
  constructor(socket, { timeoutMs = 30_000 } = {}) {
    this.sock = socket;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiter = null;
    this.failed = null;
    this.n = 0;
    socket.setTimeout?.(timeoutMs);
    socket.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    socket.on("timeout", () => this.fail(new ImapError(`the mail server did not answer within ${timeoutMs / 1000}s`)));
    socket.on("error", (e) => this.fail(new ImapError(`the connection to the mail server failed: ${e.code || e.message}`)));
    socket.on("close", () => this.fail(new ImapError("the mail server closed the connection")));
  }

  static connect({ host = "imap.gmail.com", port = 993, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host, port, servername: host }, () => resolve(new Imap(s, { timeoutMs })));
      s.once("error", (e) => reject(new ImapError(`could not reach ${host}:${port}: ${e.code || e.message}`)));
    });
  }

  fail(e) {
    if (this.failed) return;
    this.failed = e;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(e); }
  }

  /* One complete response off the buffer: its lines and the literals inside it. */
  parseOne() {
    let pos = 0;
    const lines = [], literals = [];
    for (;;) {
      const nl = this.buf.indexOf("\r\n", pos);
      if (nl < 0) return null;
      const line = this.buf.subarray(pos, nl).toString("latin1");
      lines.push(line);
      const m = /\{(\d+)\}$/.exec(line);
      if (!m) { this.buf = this.buf.subarray(nl + 2); return { text: lines.join("\n"), literals }; }
      const start = nl + 2, n = Number(m[1]);
      if (this.buf.length < start + n) return null;
      literals.push(Buffer.from(this.buf.subarray(start, start + n)));
      pos = start + n;
    }
  }

  pump() {
    for (let r; (r = this.parseOne()); ) this.queue.push(r);
    if (this.waiter && this.queue.length) { const w = this.waiter; this.waiter = null; w.resolve(this.queue.shift()); }
  }

  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  async greeting() {
    const r = await this.next();
    if (!/^\* (OK|PREAUTH)/i.test(r.text)) throw new ImapError(`the mail server's greeting was not OK: ${r.text.slice(0, 120)}`);
  }

  /** Send one command; resolve with its untagged responses, or throw naming the verb. */
  async command(cmd, verb = cmd.split(" ")[0]) {
    if (this.failed) throw this.failed;
    const tag = `A${++this.n}`;
    this.sock.write(`${tag} ${cmd}\r\n`);
    const untagged = [];
    for (;;) {
      const r = await this.next();
      if (r.text.startsWith(`${tag} `)) {
        const st = /^\S+ (OK|NO|BAD)\b\s*(.*)$/s.exec(r.text);
        if (st && st[1] === "OK") return untagged;
        throw new ImapError(`${verb} was refused: ${(st?.[2] ?? r.text).slice(0, 160)}`);
      }
      if (r.text.startsWith("*")) untagged.push(r);
    }
  }

  login(user, pass) { return this.command(`LOGIN ${quote(user)} ${quote(pass)}`, "LOGIN"); }
  select(box = "INBOX") { return this.command(`SELECT ${quote(box)}`, "SELECT"); }

  async search(criteria) {
    const rs = await this.command(`UID SEARCH ${criteria}`, "SEARCH");
    const uids = [];
    for (const r of rs) {
      const m = /^\* SEARCH\b(.*)$/i.exec(r.text);
      if (m) uids.push(...m[1].trim().split(/\s+/).filter(Boolean).map(Number));
    }
    return [...new Set(uids)].sort((a, b) => a - b);
  }

  /** The whole message, without marking it seen. */
  async fetch(uid) {
    const rs = await this.command(`UID FETCH ${uid} (UID INTERNALDATE BODY.PEEK[])`, "FETCH");
    for (const r of rs) {
      if (!/FETCH/i.test(r.text) || !r.literals.length) continue;
      const u = /\bUID (\d+)/i.exec(r.text);
      if (u && Number(u[1]) !== uid) continue;
      const d = /INTERNALDATE "([^"]+)"/i.exec(r.text);
      return { uid, raw: r.literals[r.literals.length - 1], internalDate: d ? d[1] : null };
    }
    throw new ImapError(`FETCH returned no message body for uid ${uid}`);
  }

  markSeen(uid) { return this.command(`UID STORE ${uid} +FLAGS (\\Seen)`, "STORE"); }

  async logout() {
    try { await this.command("LOGOUT", "LOGOUT"); } catch { /* closing anyway */ }
    this.sock.end?.();
  }
}

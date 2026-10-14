/* A MAIL MESSAGE, READ FAR ENOUGH TO FIND ITS TEXT. No dependencies: this
 * repository installs nothing (see lib/check-workflows.mjs), so this is the
 * small part of RFC 5322 / RFC 2045 that a notification email uses:
 *
 *   headers, folded lines unfolded, =?charset?Q|B?...?= words decoded
 *   multipart/* by boundary, nested, and message/rfc822 (a forward sent as an
 *     attachment) read as a message of its own
 *   base64 and quoted-printable bodies; utf-8, us-ascii, iso-8859-1 and
 *     windows-1252 charsets
 *
 * It never prints anything. What it returns is used to find the bid rows, and
 * only those leave scripts/email-bids.mjs. */

const CRLF2 = /\r?\n\r?\n/;

function decodeBytes(buf, charset) {
  const cs = String(charset || "utf-8").toLowerCase().replace(/^"|"$/g, "");
  const name = cs === "us-ascii" || cs === "ascii" ? "utf-8" : cs;
  try { return new TextDecoder(name).decode(buf); }
  catch { return Buffer.from(buf).toString("latin1"); }
}

export function qpDecode(s) {
  const bytes = [];
  const t = String(s).replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(c, "utf8"));
  }
  return Uint8Array.from(bytes);
}

/** =?utf-8?Q?Cash_Bids?= words in a header value. */
export function decodeWords(v) {
  return String(v ?? "").replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    try {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : qpDecode(txt.replace(/_/g, " "));
      return decodeBytes(bytes, cs);
    } catch { return m; }
  });
}

export function parseHeaders(block) {
  const out = new Map();
  const lines = String(block).split(/\r?\n/);
  let cur = null;
  for (const l of lines) {
    if (/^[ \t]/.test(l) && cur) { cur[1] += " " + l.trim(); continue; }
    const i = l.indexOf(":");
    if (i <= 0) { cur = null; continue; }
    cur = [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
    if (!out.has(cur[0])) out.set(cur[0], []);
    out.get(cur[0]).push(cur);
  }
  const h = new Map();
  for (const [k, v] of out) h.set(k, v.map((x) => decodeWords(x[1])));
  return h;
}

/** "text/plain; charset=UTF-8; format=flowed" -> { type, params } */
export function contentType(v) {
  const [type, ...rest] = String(v || "text/plain").split(";");
  const params = {};
  for (const p of rest) {
    const m = /^\s*([\w-]+)\s*=\s*"?([^"]*)"?\s*$/.exec(p);
    if (m) params[m[1].toLowerCase()] = m[2];
  }
  return { type: type.trim().toLowerCase(), params };
}

/**
 * Parse a raw message (Buffer or latin1/utf-8 string).
 * Returns { headers, header(name), leaves: [{ type, text }], inner: [messages] }.
 */
export function parseMessage(raw, depth = 0) {
  const s = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw);
  const m = CRLF2.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const body = m ? s.slice(m.index + m[0].length) : "";
  const headers = parseHeaders(head);
  const header = (n) => (headers.get(n.toLowerCase()) ?? [])[0] ?? null;
  const msg = { headers, header, leaves: [], inner: [] };
  walk(headers, body, msg, depth);
  return msg;
}

function walk(headers, body, msg, depth) {
  const get = (n) => (headers.get(n) ?? [])[0] ?? null;
  const ct = contentType(get("content-type"));
  if (depth > 8) return;
  if (ct.type.startsWith("multipart/") && ct.params.boundary) {
    const b = "--" + ct.params.boundary;
    const chunks = body.split(new RegExp(`(?:^|\\r?\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*(?=\\r?\\n|$)`));
    for (const c of chunks.slice(1)) {
      const part = c.replace(/^\r?\n/, "");
      if (!part.trim()) continue;
      const mm = CRLF2.exec(part);
      const ph = parseHeaders(mm ? part.slice(0, mm.index) : part);
      walk(ph, mm ? part.slice(mm.index + mm[0].length) : "", msg, depth + 1);
    }
    return;
  }
  const enc = String(get("content-transfer-encoding") || "7bit").toLowerCase();
  const bytes = enc === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64")
    : enc === "quoted-printable" ? qpDecode(body)
    : Buffer.from(body, "latin1");
  if (ct.type === "message/rfc822") {
    msg.inner.push(parseMessage(Buffer.from(bytes), depth + 1));
    return;
  }
  if (ct.type === "text/plain" || ct.type === "text/html")
    msg.leaves.push({ type: ct.type, text: decodeBytes(bytes, ct.params.charset) });
}

/** The first text/plain and text/html in the message or anything it carries. */
export function textOf(msg) {
  const all = [msg, ...msg.inner.flatMap((m) => [m, ...m.inner])];
  const pick = (t) => { for (const x of all) { const l = x.leaves.find((p) => p.type === t); if (l) return l.text; } return null; };
  return { text: pick("text/plain"), html: pick("text/html") };
}

/** The bare address in a From value: "Bunge <noreply@x>" -> "noreply@x". */
export const addressOf = (v) => {
  const s = String(v ?? "");
  const m = /<([^>]+)>/.exec(s) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(s);
  return m ? m[1].trim().toLowerCase() : null;
};

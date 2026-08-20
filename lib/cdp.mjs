/* A BROWSER, DRIVEN OVER THE DEVTOOLS PROTOCOL, WITH NO DEPENDENCIES.
 *
 * WHY THERE IS A BROWSER IN A SCRAPER AT ALL — 2026-08-20.
 *
 * DTN Content Services answered a probe from the Actions runner like this:
 *
 *   HTTP 403
 *   {"messages":[{"type":"Authorization","id":"AGW-403=002","status":403,
 *     "message":"The api key is valid, but it is valid to be used within a
 *                browser only."}]}
 *
 * The key was valid. The site id was valid. The path was right. The gateway
 * scopes those widget keys to browser use, and no server-side request can pass
 * that check — which is also why every path under /markets/ answered 403
 * whether or not it existed, and why two days of probing found nothing.
 *
 * There are two ways past it. One is to forge the Origin and Referer headers
 * the check reads, which is three lines and is a request claiming to come from
 * a page it did not come from. The other is to use a browser, on the
 * customer's own public page, which is what the message asks for and what a
 * visitor's machine does. Sig chose the browser. Nothing here forges anything:
 * we load the page they publish, and read the response their own widget asked
 * for.
 *
 * WHY NOT PLAYWRIGHT. This repository has zero dependencies, on purpose — the
 * test suite exercises exactly the code that runs, and there is no lockfile to
 * drift. Node 22 ships a global WebSocket, and both the sandbox and GitHub's
 * ubuntu runner already have a Chromium. That is the whole requirement, so the
 * client is about a hundred lines here instead of a hundred megabytes there.
 *
 * WHAT IT TAKES CARE TO DO
 *   - It asks for ONE response, the one whose URL matches, and gives up with a
 *     list of what it did see rather than hanging.
 *   - It blocks images, fonts, media and stylesheets. We want one JSON body,
 *     not their whole page, and their bandwidth is not ours to spend.
 *   - It always kills the browser, including on the failure paths. A leaked
 *     Chromium on a runner is a job that never ends.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/* Where a Chromium might be, most specific first. BIDS_BROWSER wins, because
   the one thing worse than not finding a browser is finding the wrong one. */
export const BROWSER_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/hostedtoolcache/chromium/latest/x64/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/snap/bin/chromium",
];

export function findBrowser(env = process.env, exists = existsSync) {
  if (env.BIDS_BROWSER) {
    if (!exists(env.BIDS_BROWSER))
      throw new Error(`BIDS_BROWSER is set to ${env.BIDS_BROWSER} and there is nothing there`);
    return env.BIDS_BROWSER;
  }
  /* GitHub's ubuntu images set CHROME_BIN, and taking their word for it is
     better than hard-coding a path that an image refresh can move. It is only
     believed if it is actually there. */
  if (env.CHROME_BIN && exists(env.CHROME_BIN)) return env.CHROME_BIN;
  for (const p of BROWSER_CANDIDATES) if (exists(p)) return p;
  throw new Error(
    `no browser found. Looked at: ${BROWSER_CANDIDATES.join(", ")}. Set BIDS_BROWSER ` +
    `to one, or install Chromium. GitHub's ubuntu runners ship Google Chrome.`);
}

/* Does this response belong to the request we are waiting for?
   Substring, not equality: the widget appends its own query parameters and the
   key, and the key must never be written into a manifest to match against. */
export function matchesTarget(url, target) {
  if (!url || !target) return false;
  try {
    const u = new URL(url), t = new URL(target);
    return u.origin === t.origin && u.pathname === t.pathname;
  } catch {
    return String(url).includes(String(target));
  }
}

/* THE BROWSER PUTS THE KEY IN THE URL, WHICH IS THE THING WE MOVED IT OUT OF.
 *
 * poll.mjs was changed today to send keys as a header precisely so they would
 * stay out of log lines and error messages in a public repository. The widget
 * does not have that discipline: it asks for
 * `...cash-bids?apikey=exwhq…&units=us`, and that URL is what comes back from
 * the capture, goes into the log, and is stamped into `source.url` in the
 * committed file. Redacted here, at the only place that ever sees it, rather
 * than at each of the places that would have printed it. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()])
      if (/(^|_)(apikey|api_key|key|token|secret|sig)$/i.test(k)) u.searchParams.set(k, "<redacted>");
    return u.toString();
  } catch {
    return String(url).replace(/([?&](?:apikey|api_key|key|token|secret|sig)=)[^&#]*/gi, "$1<redacted>");
  }
}

const BLOCK = ["Image", "Font", "Media", "Stylesheet"];

/**
 * Load `pageUrl` in a browser and hand back the body of the first response
 * whose origin+path match `target`.
 * @returns {Promise<{body: string, url: string, status: number}>}
 */
export async function capture({ pageUrl, target, browser, timeoutMs = 45000, port = 0,
                                spawnFn = spawn, WS = WebSocket }) {
  return withBrowser({ browser, timeoutMs, port, spawnFn, WS }, async (send, on) => {
      await send("Network.enable", {});
      await send("Network.setBlockedURLs", { urls: [] });
      await send("Page.enable", {});
      /* Blocking by TYPE needs Fetch domain interception; blocking by pattern
         does not and is enough here. Their logo is not our business. */
      await send("Network.setBlockedURLs", {
        urls: ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp",
               "*.woff", "*.woff2", "*.ttf", "*.otf", "*.css", "*.mp4"],
      });

      const seen = [];
      /* THE FIRST MATCH IS NOT NECESSARILY THE ANSWER.
       *
       * This used to clearTimeout on the first matching response and reject if
       * its body would not read. Measured 2026-08-20: that lost Ag-Land FS and
       * Insight FS -- both `fscooperatives.com` -- to "the response matched but
       * its body never became readable", while `captureAll` had pulled 45,608
       * bytes off the very same Ag-Land page minutes earlier. The difference
       * was not the network. It was that captureAll records EVERY match and
       * prefers whichever one hands over a body, and this took the first and
       * gave up.
       *
       * A page can produce a match with no readable body for perfectly
       * ordinary reasons: a CORS preflight on the same origin and path, a 204,
       * a 304 off the cache, a response the renderer has already evicted. None
       * of those is the board, and each of them used to be fatal.
       *
       * So: a failed read is recorded and IGNORED, and we keep listening until
       * the real one arrives or the clock runs out. The timeout is cleared only
       * when a body is actually in hand. */
      let unreadable = 0;
      const hit = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(
          `no readable response matching ${target} within ${timeoutMs}ms. ` +
          (unreadable
            ? `${unreadable} response(s) DID match but no body could be read from them. `
            : "") +
          `The page did make ${seen.length} request(s): ` +
          `${seen.slice(0, 12).join(", ")}${seen.length > 12 ? " …" : ""}`)),
          timeoutMs);
        on("Network.responseReceived", async (params) => {
          const url = params?.response?.url;
          if (url && !url.startsWith("data:")) seen.push(shortUrl(url));
          if (!matchesTarget(url, target)) return;
          /* THERE IS NO SPECIAL CASE FOR 204 AND 304 HERE, AND THERE WAS.
             It short-circuited before the general rule below, which meant no
             test could reach that rule through a bodyless response -- three
             mutants survived against it because the fast path was doing all
             the work and hiding the slow one. Deleted rather than kept: the
             general rule handles it, and the only thing the special case
             bought was 1.8 seconds on a response nobody is waiting for. */
          const status = params.response.status;
          /* The body is not ready the instant the headers are. */
          let body = null;
          for (let i = 0; i < 12 && body === null; i++) {
            try { body = (await send("Network.getResponseBody", { requestId: params.requestId })).body; }
            catch { await new Promise((r) => setTimeout(r, 150)); }
          }
          if (body === null) { unreadable++; return; }
          clearTimeout(t);
          resolve({ body, url: redactUrl(url), status });
        });
      });

      await send("Page.navigate", { url: pageUrl });
      return await hit;
  });
}

/* THE LAUNCH, WRITTEN ONCE.
 *
 * `capture` and `captureAll` want the same browser on the same socket and
 * differ only in what they do with it. When this was inlined in `capture`,
 * adding the second reader meant copying thirty lines of spawn flags, port
 * arithmetic, stderr plumbing and the browser-socket-is-not-the-page-socket
 * lesson -- and a copy of that lesson is a copy that goes stale.
 *
 * It always kills the browser, and it always attaches what the browser said
 * to whatever went wrong, because a bare "socket never opened" is unactionable
 * and Chromium usually explained itself on stderr.
 */
async function withBrowser({ browser, timeoutMs = 45000, port = 0,
                             spawnFn = spawn, WS = WebSocket }, body) {
  const exe = browser ?? findBrowser();
  /* A fixed port would collide when two sources are read at once. Node's own
     high-resolution clock is the cheapest source of a distinct one, and 0 is
     not usable here because CDP's /json/version needs a port we can name. */
  const p = port || 9000 + Number(process.hrtime.bigint() % 900n);
  const child = spawnFn(exe, [
    "--headless=new", `--remote-debugging-port=${p}`, "--remote-debugging-address=127.0.0.1",
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    "--window-size=1280,900", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += String(d); if (stderr.length > 4000) stderr = stderr.slice(-4000); });

  try {
    await waitForPort(p, timeoutMs, () => child.exitCode);
    /* THE BROWSER SOCKET IS NOT THE PAGE SOCKET, and the difference costs an
       hour if you have not met it. /json/version hands back a browser-level
       endpoint, which knows about Target and Browser and answers
       "'Network.enable' wasn't found" to everything else. The Network and Page
       domains live on a PAGE target, so we ask /json/list for the tab Chromium
       already opened and talk to that. */
    const pageWs = await waitForPageTarget(p, timeoutMs);
    return await withSocket(pageWs, WS, timeoutMs, body);
  } catch (e) {
    const tail = stderr.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${e.message}${tail ? ` [browser said: ${tail}]` : ""}`);
  } finally {
    kill();
  }
}

/* Host and path only. The diagnostic list of "what the page did request" is
   printed on failure, and a query string is both noisy and the place a key
   lives. */
const shortUrl = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return redactUrl(String(u)).slice(0, 60); } };

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let saw = [];
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      saw = list.map((t) => t.type);
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* the endpoint is up but the tab is not yet listed */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the browser opened its port but never listed a page target (saw: ${saw.join(", ") || "nothing"})`);
}

async function waitForPort(port, timeoutMs, exitCode) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (exitCode() !== null) throw new Error(`the browser exited (code ${exitCode()}) before it opened port ${port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the browser never opened its debugging port ${port} (${last})`);
}

/** Open the socket, run `body(send, on)`, and always close it. */
async function withSocket(wsUrl, WS, timeoutMs, body) {
  const ws = new WS(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let id = 0;

  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : resolve(m.result ?? {});
      return;
    }
    for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the devtools socket never opened")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("the devtools socket errored")); }, { once: true });
  });

  try { return await body(send, on); }
  finally { try { ws.close(); } catch { /* already closed */ } }
}


/* WHAT FEEDS DOES THIS PAGE USE? — the question `capture` cannot ask.
 *
 * `capture` waits for ONE response whose URL you already know. That is right
 * for polling and exactly wrong for finding a board nobody has looked at: it
 * needs the DTN site id up front, so the site id has to come from somewhere
 * else first, and "somewhere else" was a human reading DevTools. Ag Partners
 * cost one screenshot. Ninety-two co-operatives cannot cost ninety-two.
 *
 * So this loads a page, lets it run, and reports EVERY response it made, with
 * the body of each one that could be a board. The site id stops being an input
 * and becomes an output.
 *
 * IT WAITS FOR QUIET, NOT FOR A MATCH. There is no target to match, so the end
 * condition is the network going idle -- `quietMs` with nothing new -- capped
 * by `timeoutMs`, because a page that polls its own board on a timer is never
 * quiet and would otherwise hold the batch until the job's own clock killed it.
 *
 * IT NEVER THROWS. A batch of thirty pages must not lose the twenty-nine that
 * worked because the thirtieth timed out, and what a failing page DID request
 * is usually the interesting part of why it failed.
 */
export async function captureAll({
  pageUrl, browser, timeoutMs = 45000, quietMs = 2500, maxBodyBytes = 400000,
  port = 0, spawnFn = spawn, WS = WebSocket, keep = looksLikeData,
} = {}) {
  const responses = [];
  try {
    return await withBrowser({ browser, timeoutMs, port, spawnFn, WS }, async (send, on) => {
      await send("Network.enable", {});
      await send("Page.enable", {});
      await send("Network.setBlockedURLs", {
        urls: ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp",
               "*.woff", "*.woff2", "*.ttf", "*.otf", "*.mp4"],
      });

      let last = Date.now();
      const bodies = [];
      on("Network.responseReceived", (params) => {
        const url = params?.response?.url;
        if (!url || url.startsWith("data:")) return;
        last = Date.now();
        const mime = params.response.mimeType ?? "";
        const rec = { url: redactUrl(url), status: params.response.status, mime, body: null };
        responses.push(rec);
        if (keep(url, mime)) bodies.push(readBody(send, params.requestId, rec, maxBodyBytes));
      });

      /* A PAGE THAT NEVER LOADED IS NOT A PAGE WITH NO BOARD.
       *
       * Both come back as zero recognised feeds, and across a batch of fifty-six
       * that is the difference between "this operator runs something we cannot
       * read yet" -- which is the queue -- and "their DNS is broken today",
       * which is a retry. Measured against a closed port: without this the
       * result was indistinguishable from a clean page with no feed on it.
       *
       * Page.navigate reports it in the reply, so it costs nothing to ask. */
      const nav = await send("Page.navigate", { url: pageUrl });
      const navError = nav?.errorText ?? null;

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && Date.now() - last < quietMs)
        await new Promise((r) => setTimeout(r, 100));

      await Promise.allSettled(bodies);
      return { pageUrl, responses, navError,
               quiet: Date.now() - last >= quietMs };
    });
  } catch (e) {
    return { pageUrl, responses, navError: null, quiet: false, error: e.message };
  }
}

/* The body is not ready the instant the headers are, and a body that never
   arrives must not take the page down with it -- it is recorded as null and
   the URL is still reported, which is itself the finding for a feed that
   answered 403. */
async function readBody(send, requestId, rec, maxBodyBytes) {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await send("Network.getResponseBody", { requestId });
      const text = r.base64Encoded
        ? Buffer.from(r.body, "base64").toString("utf8") : String(r.body);
      rec.body = text.slice(0, maxBodyBytes);
      rec.truncated = text.length > maxBodyBytes;
      return;
    } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
}

/* Could this response be a price board?
 *
 * BY MIME AND BY SHAPE, because each one alone misses a whole family. Several
 * of these feeds are served as text/html or text/plain out of a `.php` or a
 * `.cfm`, so mime alone misses them; and matching on "the URL says bids"
 * misses every feed that calls itself `component`, `markets`, `q` or
 * `cashgrid`. Either signal is enough to keep the body -- this is a net, and
 * the cost of a false keep is a few kilobytes in a log while the cost of a
 * false drop is not finding the board at all.
 */
export const looksLikeData = (url, mime = "") => {
  if (/^(image|font|video|audio)\//.test(mime)) return false;
  if (/javascript|css/.test(mime)) return false;
  if (/json|xml|csv|text\/plain/.test(mime)) return true;
  return /(bid|bids|cash|grain|market|quote|price|feed|api|ajax|component|cashgrid)/i
    .test(String(url).replace(/[?&#].*$/, ""));
};

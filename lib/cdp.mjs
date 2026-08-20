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
    return await withSocket(pageWs, WS, timeoutMs, async (send, on) => {
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
      const hit = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(
          `no response matching ${target} within ${timeoutMs}ms. The page did make ` +
          `${seen.length} request(s): ${seen.slice(0, 12).join(", ")}${seen.length > 12 ? " …" : ""}`)),
          timeoutMs);
        on("Network.responseReceived", async (params) => {
          const url = params?.response?.url;
          if (url && !url.startsWith("data:")) seen.push(shortUrl(url));
          if (!matchesTarget(url, target)) return;
          clearTimeout(t);
          try {
            /* The body is not ready the instant the headers are. One retry
               covers the gap without a sleep that is a guess. */
            let body = null;
            for (let i = 0; i < 12 && body === null; i++) {
              try { body = (await send("Network.getResponseBody", { requestId: params.requestId })).body; }
              catch { await new Promise((r) => setTimeout(r, 150)); }
            }
            if (body === null) throw new Error("the response matched but its body never became readable");
            resolve({ body, url: redactUrl(url), status: params.response.status });
          } catch (e) { reject(e); }
        });
      });

      await send("Page.navigate", { url: pageUrl });
      return await hit;
    });
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

/* Read and write one file in a GitHub repo through the contents API.
 *
 * This is the half of the Cloudflare Worker that the GitHub Action gets for
 * free from `actions/checkout` plus `git push`. Off a runner there is no
 * checkout, so a commit is: GET the file to learn its blob sha, PUT the new
 * content with that sha. The sha is the concurrency control — a PUT with a
 * stale sha is rejected with 409 rather than silently clobbering.
 *
 * THERE IS NO commit() HELPER HERE, DELIBERATELY.
 *
 * There was one, and it retried a 409 by re-reading the sha and re-PUTting the
 * body it had already computed. That is wrong, and it was worse than no retry:
 * losing the race means your decision was made against a file that no longer
 * exists. Reproduced before it shipped — two overlapping cron firings, the
 * loser re-PUT its stale body, the published price went BACKWARDS from 4.125
 * to 4.075, and `pricedAt` then asserted the board had shown nothing different
 * since midnight. The commit subject read "heartbeat, no change" and the cron
 * invocation was green.
 *
 * A conflict invalidates the decision, not just the sha. So the retry lives in
 * run() in index.js, where read -> decide -> write can be redone as a unit,
 * and this module exposes only the two primitives.
 *
 * `fetchImpl` is injectable so the tests exercise the encoding and the error
 * paths without a token or a network.
 */

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/* btoa() works on latin1, not UTF-8. The bid file is ASCII today, but the
   source note is free text on its way through two other systems, and a single
   smart quote landing in it would silently corrupt the commit. Encode
   properly. Chunked because String.fromCharCode(...bytes) blows the argument
   limit on a large enough file. */
export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function makeRepo({ owner, repo, branch, path, token, userAgent, fetchImpl = fetch }) {
  if (!owner || !repo || !path) throw new GitHubError("repo config incomplete");
  if (!token) throw new GitHubError("no token");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects API requests with no User-Agent.
    "User-Agent": userAgent || "bigriver-worker",
  };

  const url = `${API}/repos/${owner}/${repo}/contents/${path}`;

  /** @returns {{json: object|null, sha: string|null}} */
  async function read() {
    const res = await fetchImpl(`${url}?ref=${encodeURIComponent(branch)}`, {
      headers,
      // Their CDN will happily hand back a cached blob, and a stale sha turns
      // every write into a 409.
      cache: "no-store",
    });
    if (res.status === 404) return { json: null, sha: null, absent: true };  // first run
    if (!res.ok)
      throw new GitHubError(`GET ${path} -> HTTP ${res.status}`, res.status);

    let body;
    try {
      body = await res.json();
    } catch (e) {
      // A 200 that is not JSON is a maintenance page or a proxy, not an empty
      // repo. Escaping as a bare SyntaxError would get it filed as a bug here.
      throw new GitHubError(`GET ${path} -> HTTP 200 with a non-JSON body`, res.status);
    }

    /* "Absent" and "present but unreadable" are different facts and must not
       collapse. Both leave `json` null, but only the first may be written
       without a sha, and only the first means "first run". A 200 with no
       content field is a directory, or a response shape we do not know. */
    if (typeof body.content !== "string")
      throw new GitHubError(`GET ${path} -> HTTP 200 with no file content ` +
        `(is that path a directory?)`, res.status);

    let json = null;
    let unreadable = false;
    try {
      json = JSON.parse(b64decode(body.content));
    } catch {
      /* A file we cannot parse is treated as absent for the purpose of
         writing — the next write replaces it — but it is FLAGGED, because
         silently treating it as a first run resets pricedAt and republishes a
         three-day-old price as newly priced. */
      json = null;
      unreadable = true;
    }
    return { json, sha: body.sha ?? null, absent: false, unreadable };
  }

  async function write({ content, message, sha }) {
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: b64encode(content),
        branch,
        ...(sha ? { sha } : {}),
        committer: { name: "agsist-bot", email: "bot@agsist.com" },
      }),
    });
    if (res.status === 409 || res.status === 422)
      throw new GitHubError(
        `PUT ${path} -> HTTP ${res.status}` +
        (sha ? " (the sha we wrote against is no longer current)"
             : " (wrote without a sha, so the file already existed)"),
        res.status);
    if (!res.ok)
      throw new GitHubError(`PUT ${path} -> HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      // The write landed; only the receipt is unreadable. Not worth failing.
      return {};
    }
  }

  return { read, write };
}

/* Read and write one file in a GitHub repo through the contents API.
 *
 * This is the half of the Cloudflare Worker that the GitHub Action gets for
 * free from `actions/checkout` plus `git push`. Off a runner there is no
 * checkout, so a commit is: GET the file to learn its blob sha, PUT the new
 * content with that sha. The sha is the concurrency control — a PUT with a
 * stale sha is rejected with 409 rather than silently clobbering, which is
 * exactly the behaviour we want if two cron firings ever overlap.
 *
 * `fetchImpl` is injectable so the tests exercise the retry and the encoding
 * without a token or a network.
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
    if (res.status === 404) return { json: null, sha: null };   // first run
    if (!res.ok)
      throw new GitHubError(`GET ${path} -> HTTP ${res.status}`, res.status);
    const body = await res.json();
    let json = null;
    try {
      json = JSON.parse(b64decode(body.content || ""));
    } catch {
      /* A file we cannot parse is treated as absent rather than fatal: the
         next write replaces it. Refusing here would wedge the reader on a
         file only a human could clear. */
      json = null;
    }
    return { json, sha: body.sha ?? null };
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
      throw new GitHubError(`PUT ${path} -> HTTP ${res.status} (sha is stale)`, res.status);
    if (!res.ok)
      throw new GitHubError(`PUT ${path} -> HTTP ${res.status}`, res.status);
    return res.json();
  }

  /* One retry, and only for the stale-sha case. Two cron firings overlapping
     is the scenario; re-reading and re-writing is correct there. Anything
     else — a bad token, a deleted repo — is not improved by trying twice.
     
     `sha` is passed in by the caller, which has already read the file to
     decide whether to write at all. Re-reading it here would double the GET
     rate against the API on every poll for no information: about 3,300 extra
     calls a month to learn something we were told a moment ago. Omit it and
     this reads first, for callers that have not. */
  async function commit({ content, message, sha }) {
    const first = sha === undefined ? (await read()).sha : sha;
    try {
      return await write({ content, message, sha: first });
    } catch (e) {
      if (!(e instanceof GitHubError) || (e.status !== 409 && e.status !== 422)) throw e;
      const again = await read();
      return write({ content, message, sha: again.sha });
    }
  }

  return { read, write, commit };
}

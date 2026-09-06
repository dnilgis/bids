/* THE SAME ELEVATOR, WRITTEN TWICE.
 * ===========================================================================
 *
 *     node scripts/duplicate-sources.mjs            write the report
 *     node scripts/duplicate-sources.mjs --print    and print every group
 *
 * WHY
 *
 * 2026-09-05, the first `write` ON run of agricharts-sweep: 214 manifests
 * written, and among them AgMark's fifteen locations appear TWICE — once from
 * `www.agmarkllc.com` and once from `agmarkresp.agricharts.com`. FS Grain the
 * same, nine locations across `fsgrain.com` and `northerngrainmarketing.com`.
 *
 * One co-op, one board, two hosts. The sweep asks both, the operator name and
 * the location labels are identical on each, and `existingIds` cannot catch it
 * because the id is built from the HOST slug — `agmarkllc-clyde` and
 * `agmarkresp-clyde` are different ids for the same concrete elevator in
 * Clyde, Kansas.
 *
 * WHAT IT COSTS
 *
 * Every poll asks that elevator's board twice, so the same prices arrive under
 * two source ids, and anything downstream that counts sources or draws pins is
 * counting one yard as two. It is not a wrong number — both copies are right —
 * it is the SAME number twice, which is worse in a directory whose whole claim
 * is that it says what it knows.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not delete anything. Which of two copies to keep is a judgement —
 * one host may be the operator's own domain and the other the platform's, one
 * may carry a phone number the other lacks — and a script that deletes a
 * reviewed file in sources/ is a script that will one day delete the wrong
 * one. This reports; a person chooses.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRINT = process.argv.includes("--print");

const host = (u) => { try { return new URL(String(u)).host; } catch { return ""; } };
const norm = (v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");

const groups = new Map();
for (const f of readdirSync(ROOT + "sources")) {
  if (!f.endsWith(".json")) continue;
  let s; try { s = JSON.parse(readFileSync(ROOT + "sources/" + f, "utf8")); } catch { continue; }
  if (!s.operator || !s.location) continue;
  /* Operator + location + state. NOT the locationId: two hosts serving the
     same board give the same location different ids, which is exactly the
     case this exists to find. */
  const k = [norm(s.operator), norm(s.location), norm(s.state)].join("|");
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(s);
}

const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
const rows = [];
for (const [k, list] of dupes) {
  const [operator, location, state] = k.split("|");
  /* WHICH COPY LOOKS LIKE THE KEEPER, AND WHY — SAID, NOT DONE.
   *
   * I GOT THIS BACKWARDS FIRST, and the repository already knew better.
   * My first version scored the operator's own domain highest: it is the
   * address a farmer would find, so it seemed like the better record.
   *
   * test/agricharts-sweep.test.mjs, "the platform's own host is preferred
   * over the operator's marketing domain", says otherwise, and says why:
   *
   *     46 CoMark sources were written against ceagrain.com; six hours later
   *     the poll could not reach it at all — "fetch failed", not an HTTP
   *     answer, with the user-agent that had worked. ceagrain.agricharts.com
   *     served the identical board.
   *
   * A vanity domain is a marketing asset and it can be repointed, parked or
   * let lapse without anybody telling the co-op's grain desk. The platform
   * host is the one the board actually lives on. That is a measured lesson
   * costing 46 sources, not a preference, so the score follows it.
   *
   * This is a SUGGESTION column. Nothing is deleted, and where the rule
   * cannot tell two copies apart it says so rather than picking. */
  const score = (src) => {
    const h = host(src.url);
    if (!h) return -1;
    let n = 0;
    /* The platform host, for the reason above. */
    if (/\.agricharts\.com$|\.mobile\./.test(h)) n += 3;
    if (src.phone) n += 1;
    if (src.lat != null && src.lon != null) n += 1;
    return n;
  };
  const scored = list.map((s) => ({ s, n: score(s) }));
  const best = Math.max(...scored.map((x) => x.n));
  const tied = scored.filter((x) => x.n === best).length > 1;
  for (const { s, n } of scored)
    rows.push({
      operator, location, state, id: s.id, host: host(s.url),
      platform: s.platform || "", enabled: s.enabled === false ? "false" : "true",
      hasPhone: s.phone ? "yes" : "no", hasCoord: (s.lat != null && s.lon != null) ? "yes" : "no",
      copies: list.length,
      suggestion: tied ? "cannot tell these apart — look" : (n === best ? "KEEP" : "the other one looks better"),
    });
}
rows.sort((a, b) => b.copies - a.copies ||
  a.operator.localeCompare(b.operator) || a.location.localeCompare(b.location) ||
  a.id.localeCompare(b.id));

mkdirSync(ROOT + "data/gaps", { recursive: true });
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(ROOT + "data/gaps/duplicate-sources.csv",
  "operator,location,state,copies,id,host,platform,enabled,has_phone,has_coord,suggestion\n" +
  rows.map((r) => [r.operator, r.location, r.state, r.copies, r.id, r.host,
    r.platform, r.enabled, r.hasPhone, r.hasCoord, r.suggestion].map(q).join(",")).join("\n") + "\n");

const total = [...readdirSync(ROOT + "sources")].filter((f) => f.endsWith(".json")).length;
console.log("\nTHE SAME ELEVATOR UNDER MORE THAN ONE SOURCE ID");
console.log("  sources                    : " + total);
console.log("  duplicated elevators       : " + dupes.length);
console.log("  source files involved      : " + rows.length);
console.log("  redundant polls per cycle  : " + (rows.length - dupes.length));
console.log("\n  written: data/gaps/duplicate-sources.csv");
console.log("\n  NOTHING IS DELETED. Which copy to keep is a judgement a person makes.");

const byOp = new Map();
for (const [k] of dupes) {
  const op = k.split("|")[0];
  byOp.set(op, (byOp.get(op) || 0) + 1);
}
console.log("\n  " + "operator".padEnd(34) + "elevators duplicated");
for (const [op, n] of [...byOp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log("  " + op.slice(0, 33).padEnd(34) + String(n).padStart(6));

if (PRINT) {
  console.log("");
  let last = "";
  for (const r of rows) {
    const k = r.operator + "|" + r.location;
    if (k !== last) { console.log("\n  " + r.operator + " — " + r.location + ", " + r.state); last = k; }
    console.log("      " + r.id.padEnd(34) + r.host.padEnd(34) +
      r.suggestion);
  }
}

/* Retire the boards that have been missing from their operator's own feed for 30
 * days (lib/not-posted.mjs). Dry run unless --write. Prints ids only. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retireDue, retired, daysMissing, RETIRE_AFTER_DAYS } from "../lib/not-posted.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sources");
const write = process.argv.includes("--write");
const now = new Date();
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const all = files.map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8"))]);
const due = retireDue(all.map(([, s]) => s), now);
const waiting = all.filter(([, s]) => s.notPostedSince && s.enabled !== false && !due.includes(s));
for (const [, s] of waiting) console.log(`waiting ${s.id}: missing ${daysMissing(s.notPostedSince, now)} of ${RETIRE_AFTER_DAYS} days`);
for (const s of due) {
  console.log(`${write ? "retire " : "due    "} ${s.id}: missing since ${s.notPostedSince}`);
  if (write) writeFileSync(join(DIR, `${s.id}.json`), JSON.stringify(retired(s, now), null, 2) + "\n");
}
if (!due.length) console.log("nothing is due");

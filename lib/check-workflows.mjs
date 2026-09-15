/* Does this workflow file still parse as YAML?
 *
 * On 2026-08-20 a step was added to prices.yml whose command read
 *
 *     run: echo "dispatched by $FROM: $SOURCE moved"
 *
 * and both sites stopped building for seventeen hours. Every run went red
 * with no steps in it. Nothing was wrong with the tests, the scripts, the
 * token or the dispatch -- GitHub could not parse the file, so the job never
 * started, and a job that never starts cannot run the tests that would have
 * caught it.
 *
 * THE QUOTES IN THAT LINE ARE THE SHELL'S, NOT YAML'S. YAML only treats a
 * quote as a quote when it is the FIRST character of the value. This value
 * starts with `echo`, so the quotes are ordinary text and the `: ` inside
 * `$FROM: $SOURCE` reads as a nested mapping. Same trap, second form:
 *
 *     run: echo done  # note
 *
 * where ` #` opens a YAML comment and the rest of the command silently
 * disappears -- no error at all, just a command that is not the one written.
 *
 * These repositories install nothing, so this cannot use a YAML library. It
 * does not need one: it checks the two shapes that bite, and it is the shape
 * that bites rather than YAML in general.
 */

const KEY = /^(\s*)(?:-\s+)?[A-Za-z_][\w.-]*:(?:\s+(.*))?$/;

export function lintWorkflow(text) {
  const faults = [];
  let blockIndent = null;

  text.split(/\r?\n/).forEach((line, i) => {
    // Inside a `|` or `>` block everything is the shell's, not YAML's.
    if (blockIndent !== null) {
      if (line.trim() === "") return;
      if (indentOf(line) > blockIndent) return;
      blockIndent = null;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) return;

    const m = line.match(KEY);
    if (!m) return;
    const value = (m[2] ?? "").trim();

    // ONLY `|` AND `>` OPEN A BLOCK. A bare `key:` opens a nested MAPPING,
    // and its children are still YAML that still has to be checked. Treating
    // the two alike is how the first draft of this file skipped every line
    // after `jobs:` and reported a clean bill of health on the very file
    // whose broken line it was written to catch.
    if (value.startsWith("|") || value.startsWith(">")) {
      blockIndent = m[1].length;
      return;
    }
    if (value === "") return;
    // A value YAML is genuinely parsing as quoted or as flow.
    if (/^["'[{]/.test(value)) return;

    const at = { line: i + 1, text: line.trim() };
    if (value.includes(": ") || value.endsWith(":")) {
      faults.push({ ...at, why: "a plain value containing ': ' reads as a nested mapping" });
      return;
    }
    // ` #` opens a YAML comment, and on `contents: read  # it writes nothing`
    // that is exactly what the author meant. It is a fault only when the
    // marker lands INSIDE what the author was writing as a quoted string,
    // because then YAML cuts the value mid-quote and hands the shell an
    // unbalanced command. The first draft flagged the plain comments too and
    // would have failed three of this project's own healthy workflow files.
    const cut = value.split(/\s#/)[0];
    if (cut !== value && unbalanced(cut))
      faults.push({ ...at, why: "' #' opens a YAML comment inside a quoted string, cutting the value mid-quote" });
  });

  return faults;
}

const unbalanced = (v) =>
  (v.match(/"/g) ?? []).length % 2 === 1 || (v.match(/'/g) ?? []).length % 2 === 1;

const indentOf = (line) => line.length - line.trimStart().length;

/* ── WHAT A STEP CAN ACTUALLY READ FROM ITS OWN ENVIRONMENT ────────────────
 *
 * On 2026-09-15 the gradable manifests job died on its third step with
 *
 *     TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type
 *     string or an instance of Buffer or URL. Received undefined
 *
 * on a line that read a file the SAME STEP had just found with `[ -f ]` two
 * lines above. The step did this:
 *
 *     REPORT="data/gradable/$PARTNER-boards.json"
 *     echo "REPORT=$REPORT" >> "$GITHUB_ENV"
 *     node -e 'readFileSync(process.env.REPORT, "utf8")'
 *
 * and neither half of that reaches the child process. $GITHUB_ENV IS APPLIED
 * TO LATER STEPS, NEVER THE CURRENT ONE, and a plain shell assignment is not
 * exported. The guard tests all passed; the file existed; the path was
 * undefined anyway.
 *
 * Two other jobs in this repository read process.env.REPORT and are correct,
 * because they read it in a LATER step than the one that put it there. The
 * difference does not show line by line, so this is checked as a sequence of
 * steps and not as a set of lines.
 *
 * A name can reach a step three ways: the step's own `env:` mapping, a job or
 * workflow `env:` mapping above it, or an EARLIER step's $GITHUB_ENV write --
 * including one made from inside a script that step runs, which is how
 * gradable-boards.yml gets REPORT. Pass those in as `scriptsWriting`, keyed by
 * the path as the workflow spells it, or that job reads as a fault.
 */

const RUNNER_PROVIDED =
  /^(?:GITHUB|RUNNER|ACTIONS|INPUT|npm)_|^(?:HOME|PATH|PWD|CI|TMPDIR|TEMP|LANG|USER|SHELL|NODE_ENV|NODE_OPTIONS|TZ)$/;

/* Names this text puts into $GITHUB_ENV, in either shape used here: a shell
 * redirect, or an appendFileSync on process.env.GITHUB_ENV. Works on a YAML
 * step and on a .mjs script, because both shapes occur in both.
 */
export function envNamesWritten(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("GITHUB_ENV") || !line.includes(">>")) continue;
    const m = line.match(/["']?([A-Za-z_]\w*)=/);
    if (m) names.add(m[1]);
  }
  for (const m of text.matchAll(/GITHUB_ENV\s*,\s*`([^`]*)`/g))
    for (const part of m[1].split("\\n")) {
      const k = part.match(/^\s*([A-Za-z_]\w*)=/);
      if (k) names.add(k[1]);
    }
  return names;
}

/* The steps of every job, in file order, each tagged with the job it belongs
 * to so a name carried through $GITHUB_ENV is not carried across jobs -- it
 * is not: a second job is a second runner with a fresh environment.
 */
export function stepsOf(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];
  let job = -1, dash = null, cur = null, inSteps = false;

  const close = () => { if (cur) steps.push(cur); cur = null; };

  lines.forEach((line, i) => {
    if (/^\s*steps:\s*$/.test(line)) { close(); inSteps = true; dash = null; job += 1; return; }
    if (!inSteps) return;
    if (line.trim() === "") { if (cur) cur.lines.push(line); return; }

    const ind = indentOf(line);
    const item = /^\s*-\s/.test(line);
    if (dash === null) {
      if (!item) { inSteps = false; return; }
      dash = ind;
    }
    if (ind < dash) { close(); inSteps = false; return; }
    if (ind === dash && item) { close(); cur = { job, dash, line: i + 1, lines: [line] }; return; }
    if (cur) cur.lines.push(line);
  });
  close();

  return steps.map((s) => ({
    job: s.job,
    line: s.line,
    name: (s.lines[0].match(/-\s+name:\s*(.*)$/)?.[1] ?? "").trim(),
    text: s.lines.join("\n"),
    env: mappingKeys(s.lines, s.dash + 2),
  }));
}

/* The keys of an `env:` mapping written at exactly this indent. Exactly, so
 * the word `env:` appearing inside a run block -- which is at a deeper indent
 * and is the shell's, not YAML's -- is never mistaken for one.
 */
function mappingKeys(lines, indent) {
  const keys = new Set();
  let open = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const ind = indentOf(line);
    if (open && ind > indent) {
      const k = line.match(/^\s*([A-Za-z_]\w*)\s*:/);
      if (k) keys.add(k[1]);
      continue;
    }
    open = ind === indent && /^\s*env:\s*$/.test(line);
  }
  return keys;
}

/* Job and workflow level `env:` mappings -- anything shallower than a step. */
function outerEnv(text) {
  const lines = text.split(/\r?\n/);
  const keys = new Set();
  for (let indent = 0; indent <= 6; indent += 2)
    for (const k of mappingKeys(lines, indent)) keys.add(k);
  return keys;
}

/* A comment is not code. The comment explaining this very fault, written on
 * the line above the fixed call, names process.env.REPORT -- and the first
 * run of this guard accused the fixed file because of it. A commented-out
 * read is not a read, and a commented-out redirect does not write.
 */
const withoutComments = (text) =>
  text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");

export function envReadFaults(text, scriptsWriting = {}) {
  const faults = [];
  const outer = outerEnv(text);
  let job = null, carried = new Set();

  for (const step of stepsOf(text)) {
    if (step.job !== job) { job = step.job; carried = new Set(); }

    const body = withoutComments(step.text);
    const written = envNamesWritten(body);
    const where = step.name || `step at line ${step.line}`;

    for (const m of [
      ...body.matchAll(/process\.env\.([A-Za-z_]\w*)/g),
      ...body.matchAll(/process\.env\[\s*["']([A-Za-z_]\w*)["']\s*\]/g),
    ]) {
      const name = m[1];
      if (RUNNER_PROVIDED.test(name)) continue;
      if (step.env.has(name) || outer.has(name) || carried.has(name)) continue;
      const why = written.has(name)
        ? `this step writes ${name} to $GITHUB_ENV and reads it back in the same step; $GITHUB_ENV only reaches LATER steps`
        : `nothing gives this step ${name}: it is in no env: mapping and no earlier step wrote it to $GITHUB_ENV`;
      faults.push({ line: step.line, text: `${where}: process.env.${name}`, why });
    }

    for (const n of written) carried.add(n);
    for (const [path, names] of Object.entries(scriptsWriting))
      if (body.includes(path)) for (const n of names) carried.add(n);
  }

  return faults;
}

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

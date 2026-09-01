#!/usr/bin/env node
/* A DERIVED STATE MUST BE DERIVED, AND A BORDER TOWN MUST BE REFUSED.
 *
 * Sixteen manifests carried `state: null`, which the agsist coverage map draws
 * as a town with no state. Rule 1 forbids typing one in from memory, so
 * scripts/fill_states.mjs derives them from this repository's own labelled
 * points and refuses everything it cannot reach.
 *
 * The refusals are the part worth pinning. Superior East sits on the Kansas
 * line, and a nearest-neighbour fill with no unanimity test would have put a
 * Nebraska label on it — a wrong state on a real place, which is worse than no
 * state at all.
 *
 *     node --test test/fill-states.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const rd = (p) => JSON.parse(readFileSync(ROOT + p, "utf8"));
const out = execFileSync("node", [ROOT + "scripts/fill_states.mjs"], { encoding: "utf8" });

test("every state it filled says in the file how it was derived", () => {
  const idx = rd("data/index.json");
  const filled = ["auroracooperative-aurorasouth", "auroracooperative-keene",
                  "auroracooperative-murphy", "auroracooperative-sedan",
                  "farmerspridecoop-nelighoakdale", "chsag-absoluteenergy"];
  for (const id of filled) {
    const m = rd(`sources/${id}.json`);
    assert.ok(m.state, `${id} has no state`);
    assert.ok(m.stateDerivedBy && m.stateDerivedBy.length > 20,
      `${id} carries a state with no provenance — indistinguishable from a typed one`);
  }
});

test("A BORDER TOWN IS REFUSED. Superior East splits NE/KS and stays null", () => {
  assert.match(out, /superioreast\s+REFUSED — its nearest neighbours split/);
  assert.equal(rd("sources/auroracooperative-superioreast.json").state, null);
});

test("an operator that spans two states cannot fill by sibling", () => {
  assert.match(out, /premiercooperative-fairbanks\s+REFUSED — this operator spans/);
  assert.match(out, /auroracooperative-futuresmarkets\s+REFUSED — this operator spans/);
});

test("no coordinate and no agreeing sibling means no state, and it says so", () => {
  for (const id of ["chsbigsky-havre", "chsprimeland-chsprimeland"]) {
    assert.equal(rd(`sources/${id}.json`).state, null);
    assert.ok(out.includes(id + " ".repeat(Math.max(1, 45 - id.length)) + "REFUSED") ||
              new RegExp(id + "\\s+REFUSED").test(out), `${id} should be refused aloud`);
  }
});

test("the unanimity and distance rules are the ones the sweep supports", () => {
  const src = readFileSync(ROOT + "scripts/fill_states.mjs", "utf8");
  assert.match(src, /const NEIGHBOURS = 15;/);
  assert.match(src, /const MAX_MILES = 60;/);
});

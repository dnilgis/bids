#!/usr/bin/env node
/* A DERIVED STATE MUST BE DERIVED, AND A BORDER TOWN MUST BE REFUSED.
 *
 * Sixteen manifests carried `state: null`, which the agsist coverage map draws
 * as a town with no state. Rule 1 forbids typing one in from memory, so
 * scripts/fill_states.mjs derives them from this repository's own labelled
 * points and refuses everything it cannot reach.
 *
 * The refusals are the part worth pinning. Superior East sits on the Kansas
 * line, and a fill with no unanimity test would have put a Nebraska label on
 * it — a wrong state on a real place, which is worse than no state at all.
 * Which rule refuses it has changed once already; see the note further down.
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

test("A BORDER TOWN IS REFUSED. Superior East stays null", () => {
  assert.match(out, /superioreast\s+REFUSED/);
  assert.equal(rd("sources/auroracooperative-superioreast.json").state, null);
});

/* COVERAGE LOST HERE, ON PURPOSE. READ THIS BEFORE DELETING THE SPLIT BRANCH.
 *
 * Until 2026-09-22 this file pinned the exact refusal Superior East earned:
 * "REFUSED — its nearest neighbours split NE/KS". That reason needs a
 * coordinate, and the only coordinate Superior East ever had was a ZIP
 * centroid a geocode bot wrote onto a manifest whose own note says a centroid
 * derived from an unconfirmed town name is not a coordinate. Thirty manifests
 * were pinned that way; all thirty were reverted to null and the bot gated.
 *
 * Superior East is still refused and its state is still null — the sibling
 * rule catches it now, because Aurora Cooperative publishes in both NE and KS.
 * The outcome the reader sees is unchanged. What changed is the reason, so the
 * assertion above no longer names one.
 *
 * The consequence, stated rather than buried: ZERO sources now reach the
 * nearest-neighbours-split branch of scripts/fill_states.mjs. Measured on
 * 2026-09-22 — the sweep printed 18 refusals, 8 for no coordinate and no
 * sibling, 7 for IA/WI, 3 for NE/KS, and 0 for a split. That branch is live
 * code with no test coverage from real data. The test below is all that holds
 * it in place. If a street-level coordinate is ever confirmed for a border
 * town, restore a named-reason assertion here.
 */
test("the split branch still exists even though no source reaches it", () => {
  const src = readFileSync(ROOT + "scripts/fill_states.mjs", "utf8");
  assert.match(src, /REFUSED — its nearest neighbours split/,
    "the split refusal was deleted; a border town with a real coordinate would now be mislabelled");
  assert.equal((out.match(/nearest neighbours split/g) ?? []).length, 0,
    "a source reaches the split branch again — give it back its named assertion above");
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

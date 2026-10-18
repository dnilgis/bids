import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare } from "../scripts/regen-manifests.mjs";

test("regen writes new and changed manifests and never deletes one the generator dropped", () => {
  const gen = [{ id: "a", x: 1 }, { id: "b", x: 2 }, { id: "c", x: 3 }];
  const disk = [{ id: "b", x: 2 }, { id: "c", x: 9 }, { id: "d", x: 4 }];
  const { add, change, gone } = compare(gen, disk);
  assert.deepEqual(add.map((m) => m.id), ["a"]);
  assert.deepEqual(change.map((m) => m.id), ["c"]);
  assert.deepEqual(gone, ["d"]);
});

test("the jobs that rewrite the generators' inputs run regen before they commit", () => {
  for (const wf of ["sync_known.yml", "registries.yml"]) {
    const y = readFileSync(new URL(`../.github/workflows/${wf}`, import.meta.url), "utf8");
    assert.match(y, /node scripts\/regen-manifests\.mjs --write/, wf);
    assert.match(y, /git add[^\n]*\bsources\b/, `${wf} must commit the regenerated sources`);
  }
});

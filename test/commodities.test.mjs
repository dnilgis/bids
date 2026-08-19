/* "am I grabbing every commodity an elevator is buying?"  -- 2026-08-19.
 * The answer was NO, silently. `expect` was built from the source's own band
 * keys, so anything unbanded was filtered out before a single guard ran and
 * left no trace in the file: status ok, rows published, a whole commodity gone. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildFile, bandFor, DEFAULT_BANDS } from "../lib/board.mjs";
import { toConfig } from "../lib/sources.mjs";

const src = () => toConfig(JSON.parse(fs.readFileSync(new URL("../sources/boyceville.json", import.meta.url), "utf8")));
const base = fs.readFileSync(new URL("../fixtures/bigriver-2121-settled.html", import.meta.url), "utf8");
const corn = base.match(/<div class='cbCommodity'>[\s\S]*?<\/div>/)[0];

/** Append another commodity block to the Boyceville board. */
function withCommodity(name, { cash = "11.3725", basis = "-0.8500", fut = "1222-2s" } = {}) {
  const block = corn.replace(">CORN<", `>${name}<`)
    .replace(/<li class='c2'>[\d.]+<\/li>/g, `<li class='c2'>${cash}</li>`)
    .replace(/<li class='c3'>-?[\d.]*<\/li>/g, `<li class='c3'>${basis}</li>`)
    .replace(/<li class='c4'>[\d-]*s?<\/li>/g, `<li class='c4'>${fut}</li>`);
  return base.replace(corn, corn + block);
}
const build = (html) => buildFile(html, { now: new Date("2026-08-19T20:39:27Z"), sourceUrl: "t", source: src() });
const names = (file) => [...new Set(file.bids.map((b) => b.commodity))];

test("a second commodity publishes on a default band, with no source edit", () => {
  const { file, withheld } = build(withCommodity("SOYBEANS"));
  assert.deepEqual(names(file).sort(), ["Corn", "Soybeans"]);
  assert.equal(file.count, 14);
  assert.deepEqual(withheld, []);
});

test("the crops an elevator actually buys all have a default band", () => {
  // Sig: "oats, wheat, rye, barley, sunflower, corn, soy, etc, etc."
  for (const c of ["Corn", "Yellow Corn", "#2 US Yellow Corn", "Soybeans", "Beans",
    "Food Grade Soybeans", "Wheat", "Spring Wheat", "HRW Wheat", "Durum",
    "Oats", "Rye", "Barley", "Milo", "Grain Sorghum", "Sunflower", "Canola",
    "Flax", "Triticale", "Field Peas", "Lentils", "Buckwheat", "Millet"])
    assert.ok(bandFor({}, c), `${c} has no band and would be withheld`);
});

test("an UNKNOWN commodity is withheld and named, never dropped in silence", () => {
  // Not "SUNGOLD MILLET" -- matching is substring, so that hits the millet
  // default. The first version of this test did exactly that and failed,
  // which is the defaults doing their job.
  const { file, withheld } = build(withCommodity("ZORBLAX"));
  assert.deepEqual(names(file), ["Corn"], "the rest of the board still publishes");
  assert.equal(withheld.length, 1);
  assert.equal(withheld[0].rows, 7);
  assert.match(withheld[0].why, /no band configured/);
});

test("a per-ton product with no futures reference is withheld, not fatal", () => {
  // DDGS as a board posts it: a price, no basis, no futures cell.
  const { file, withheld } = build(withCommodity("DDGS", { cash: "178.5000", basis: "", fut: "" }));
  assert.deepEqual(names(file), ["Corn"]);
  assert.equal(withheld[0].commodity, "Ddgs");
  assert.ok(DEFAULT_BANDS.ddgs === undefined, "per-ton products are deliberately unbanded");
});

test("SOME rows outside a band their own commodity sits inside is REFUSED", () => {
  // The decimal-point case. One wrong number must never publish.
  const html = withCommodity("SOYBEANS").replace("<li class='c2'>11.3725</li>", "<li class='c2'>113.725</li>");
  assert.throws(() => build(html), /outside|fail cash - basis/);
});

test("ALL rows outside says the BAND is wrong, so only that commodity is withheld", () => {
  const s = { ...src(), bands: { corn: [2, 12], soybean: [6, 7] } };  // deliberately wrong band
  const { file, withheld } = buildFile(withCommodity("SOYBEANS"),
    { now: new Date("2026-08-19T20:39:27Z"), sourceUrl: "t", source: s });
  assert.deepEqual(names(file), ["Corn"], "the elevator is not taken down by one bad band");
  assert.equal(withheld.length, 1);
  assert.match(withheld[0].why, /wrong band or the wrong units/);
});

test("a source's own bands EXTEND the defaults, they do not restrict them", () => {
  // Deliberate: the point of this repo is every commodity an elevator buys, so
  // a new one must work without editing the source. Naming a band overrides
  // that one; it does not switch the others off.
  const s = { ...src(), bands: { somethingelse: [1, 2] } };
  const { file } = buildFile(base, { now: new Date("2026-08-19T20:39:27Z"), sourceUrl: "t", source: s });
  assert.equal(file.count, 7, "corn still publishes on the default band");
});

test("a board with nothing publishable is refused, not published empty", () => {
  const onlyUnknown = base.replace(">CORN<", ">ZORBLAX<");
  assert.throws(() => build(onlyUnknown), /nothing publishable/);
});

test("contact details reach the published file", () => {
  const { file } = build(base);
  assert.equal(file.source.contact.phone, "715-643-3133");
  assert.ok("email" in file.source.contact && "website" in file.source.contact);
  assert.ok(file.source.lat && file.source.lon, "and so do coordinates");
});

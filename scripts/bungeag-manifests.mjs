#!/usr/bin/env node
/* MANIFESTS FOR BUNGE'S OWN LOCATION PAGES (lib/adapters/bungeag.mjs).
 *
 *     node scripts/bungeag-manifests.mjs           report
 *     node scripts/bungeag-manifests.mjs --write   write sources/<id>.json (never overwrites)
 *
 * One page is one yard. Address, ZIP, phone and coordinate are Bunge's own:
 * copied from the location list bungeag.com prints into every page
 * (bungeservicesapi_vars.api_get_all_locations), read here from the Decatur,
 * IN fixture. Nothing is looked up or derived.
 *
 * WHICH PAGES. bungeag.com lists 85 locations. The 24 it tags "legacy-bunge"
 * carry a Cash Bids section; probe.yml read every one on 2026-10-13 (runs
 * 38446551000 for Decatur, 38447457500 and 38447696952 for the rest). These 17
 * post grain rows, and on the capture every row satisfied cash - basis =
 * futures to the cent. Not written, each for a reason:
 *   - Longview, WA; Rose Hill, NC; Morristown, IN - Grain elev: no Cash Bids section.
 *   - the four Winter Canola regions: a crop program, not a yard, and canola has
 *     no contract here.
 *   - the 61 "legacy-viterra" pages (Haw Creek at Ladoga, Roachdale, Terre Haute,
 *     Shelburn, Glenwood-Mauzy, ...): no Cash Bids section at all; probed and
 *     refused, see test/bungeag.test.mjs.
 *
 * REGISTRY. A yard that holds a state or federal licence names that row
 * (registryId, a list where two rolls name one yard under two Bunge companies),
 * so its grey pin is replaced by this one. A yard with no row names none. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { locationList, pageUrl } from "../lib/adapters/bungeag.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const LIST_FIXTURE = "fixtures/bungeag-decatur-in-2026-10-13.html";
const places = JSON.parse(readFileSync(ROOT + "geocodes/places.json", "utf8"));
const registry = places.registry ?? {};

/* rows: grain rows on the 2026-10-13 capture. crops: what those rows were. */
export const SITES = [
  { slug: "decatur-in", rows: 13, crops: "soybeans, high oleic soybeans, wheat",
    registry: ["IN|bungenorthamericaeastllc|decatur", "IN|bungenorthamericainc|decatur"],
    why: "Indiana's roll lists Bunge North America East, LLC at Decatur and USDA's lists Bunge North America, Inc. there (\"Bunge North America Soy Plant\"): the soybean plant this page is." },
  { slug: "indianapolis-in", rows: 2, crops: "soybeans",
    registry: ["IN|bungenorthamericaeastllc|indianapolis", "IN|bungenorthamericainc|indianapolis"],
    why: "Indiana's roll lists Bunge North America East, LLC at Indianapolis and USDA's lists the Bunge North America soy plant there." },
  { slug: "morristown-in-beanplant", rows: 7, crops: "soybeans",
    registry: ["IN|bungenorthamericaeastllc|morristown", "IN|bungenorthamericainc|morristown"],
    why: "Indiana's roll lists Bunge North America East, LLC at Morristown and USDA's lists the Bunge North America soy plant there: the bean plant. Bunge's Morristown grain elevator has its own page and posts no bids." },
  { slug: "delphos-oh", rows: 14, crops: "soybeans, high oleic soybeans",
    registry: ["OH|bungenorthamericaeastllc|delphos", "OH|bungenorthamericainc|delphos"],
    why: "Ohio's roll lists Bunge North America East, LLC at Delphos and USDA's lists Bunge North America, Inc. there." },
  { slug: "bellevue-oh", rows: 12, crops: "soybeans, high oleic soybeans",
    registry: ["OH|bungenorthamericaeastllc|bellevue", "OH|bungenorthamericainc|bellevue"],
    why: "Ohio's roll lists Bunge North America East, LLC at Bellevue and USDA's lists Bunge North America, Inc. there." },
  { slug: "councilbluffs-ia", rows: 10, crops: "soybeans",
    registry: ["IA|bungenorthamericainc|councilbluffs", "IA|bungenorthamericaopdwestinc|councilbluffs"],
    why: "Iowa's roll and USDA's list Bunge North America (Inc. and OPD West, Inc.) at Council Bluffs: the soybean plant. Bunge's grain transload terminal there has its own page and posts no bids." },
  { slug: "cairo-il", rows: 7, crops: "soybeans",
    registry: ["IL|bungechevronagrenewablesllc|cairo"],
    why: "USDA's list names Bunge Chevron Ag Renewables, LLC at Cairo, the company that runs the Cairo oilseed plant this page is (\"Cairo, IL - Oilseeds\")." },
  { slug: "griggsville-il", rows: 10, crops: "corn, soybeans",
    registry: ["IL|bungescfgrainllc|griggsville"],
    why: "Illinois's roll lists Bunge-SCF Grain, LLC at Griggsville." },
  { slug: "maschhoffs", rows: 5, crops: "corn", town: "Griggsville", st: "IL",
    registry: ["IL|bungescfgrainllc|maschoffsgriggsville"],
    why: "Illinois's roll lists Bunge-SCF Grain, LLC at \"Maschoffs (Griggsville)\"; Bunge's page gives the same Griggsville address." },
  { slug: "mcleansboro-il", rows: 20, crops: "corn, soybeans",
    registry: ["IL|bungescfgrainllc|mcleansboro"],
    why: "Illinois's roll lists Bunge-SCF Grain, LLC at McLeansboro." },
  { slug: "fairmontcity-il", rows: 29, crops: "corn, soybeans, wheat",
    registry: ["IL|bungescfgrainllc|fairmontcity"],
    why: "Illinois's roll lists Bunge-SCF Grain, LLC at 651 N. Front Street, Fairmont City." },
  { slug: "emporia-ks", rows: 4, crops: "soybeans",
    registry: ["KS|bungenorthamericaopdwestinc|emporia"],
    why: "USDA's list names Bunge North America (OPD West), Inc. at Emporia: the soybean plant." },
  { slug: "decatur-al", rows: 5, crops: "soybeans",
    registry: ["AL|bungenorthamericainc|decatur"],
    why: "USDA's list names Bunge North America, Inc. at Decatur, AL." },
  { slug: "tunis-mt", rows: 12, crops: "HRW and DNS wheat", registry: [],
    why: "No licence row in the directory for Bunge in Montana at Tunis; Bunge's own page gives a Carter, MT address." },
  { slug: "chester-mt", rows: 12, crops: "HRW and DNS wheat", registry: [],
    why: "No licence row in the directory for Bunge at Chester, MT." },
  { slug: "kintyreflats-mt", rows: 9, crops: "corn, soybeans, HRW and DNS wheat", registry: [],
    why: "No licence row in the directory for Bunge at Kintyre Flats; Bunge's own page gives a Nashua, MT address." },
  { slug: "sidney-mt", rows: 10, crops: "corn, soybeans, HRW and DNS wheat", registry: [],
    why: "No licence row in the directory for Bunge at Sidney, MT." },
];

export const idOf = (slug) => `bunge-${slug}`;
const digits = (s) => String(s ?? "").replace(/\D/g, "");

export function build() {
  const list = locationList(readFileSync(ROOT + LIST_FIXTURE, "utf8"));
  if (!list.length) throw new Error(`${LIST_FIXTURE} carries no location list`);
  return SITES.map((x) => {
    const url = pageUrl(x.slug);
    const me = list.find((l) => l.link === url);
    if (!me) throw new Error(`${x.slug}: ${url} is not in the location list in ${LIST_FIXTURE}`);
    if (me.source !== "legacy-bunge") throw new Error(`${x.slug}: ${me.source} page; only legacy-bunge pages post bids`);
    for (const r of x.registry)
      if (!registry[r]) throw new Error(`${x.slug}: registry["${r}"] is not in geocodes/places.json any more`);
    const [, town, state] = /^(.*?),\s*([A-Z]{2})\b/.exec(me.name) ?? [];
    const lat = me.geoCode?.lattitude, lon = me.geoCode?.longitude;
    const phone = (me.communicationMethods ?? []).find((c) => c.type === 1)?.value ?? null;
    return {
      id: idOf(x.slug), operator: "Bunge",
      location: x.town ?? town ?? me.name, state: x.st ?? state ?? me.address?.region,
      platform: "bungeag", url, locationId: x.slug,
      bands: { corn: [2, 12], soybean: [6, 32], wheat: [3, 20] },
      cadence: "grain-day", provenance: "scraped", enabled: true,
      note: `GENERATED by scripts/bungeag-manifests.mjs. Their own page ${url}, which Bunge's server renders with the bids in it: `
        + `Delivery Period, Symbol, Futures, Basis, Cash, all in dollars. On the 2026-10-13 capture (probe.yml) it posted ${x.rows} grain row(s) (${x.crops}), `
        + `every one with cash - basis = futures exactly. Meal and hulls are quoted per ton and are not read. `
        + `PLACE: \"${me.name}\" in the list bungeag.com prints on every page: ${me.address.street}, ${me.address.city}, ${me.address.postalCode}, `
        + `coordinate ${lat},${lon} as Bunge publishes it. REGISTRY: ${x.why}`,
      publicNote: "Their publicly posted cash bids, read from their own website. Cash and basis are their own commercial numbers. The futures price is printed on their page too and is carried only so a consumer can re-check cash minus basis.",
      address: me.address.street ?? null, zip: me.address.postalCode ?? null,
      ...(typeof lat === "number" && typeof lon === "number" ? { lat, lon, latPrecision: "street" } : { lat: null, lon: null }),
      phone: digits(phone).length === 10 ? digits(phone) : null, email: null,
      website: "https://www.bungeag.com/", inMerge: true,
      ...(x.registry.length ? { registryId: x.registry.length === 1 ? `reg:${x.registry[0]}` : x.registry.map((r) => `reg:${r}`) } : {}),
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const m of build()) {
    const p = `${ROOT}sources/${m.id}.json`;
    console.log(`  ${existsSync(p) ? "=" : "+"} ${m.id}  ${m.location}, ${m.state}  ${[].concat(m.registryId ?? "no registry row").join(" ")}`);
    if (process.argv.includes("--write") && !existsSync(p)) writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  }
}

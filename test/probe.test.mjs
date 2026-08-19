/* The probe never publishes a number, but it decides what we go and read, and a
 * recon tool that quietly misses the one string that matters wastes a whole
 * round trip through someone else's CI. The extractors are pure; test them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assetsOf, inlineConfig, endpointStrings, callSites } from "../scripts/probe.mjs";

/* The markup that matters, lifted from United Cooperative's markets page. */
const UNITED = `<div class="fr-view"><h3>Cash Grain Bids</h3></div>
<iframe src="https://stonehedge.stonex.com/component/bids?key=AILQAFBJPWG59NXDNV00QPRSFTUA0EEU&cols=date%2Cbasis%2Ccash%2Cmonth&locs=8TG9IQ1J6TGRFBUP1XH0%2CMY33N2HTBP5KB5I5NXBT&hideRows=true "
 width="600" height="800" frameborder="0"></iframe>
<script type="text/javascript" src="//unitedcooperative.websol.barchart.com/?module=futureMarketOverview&js=1"></script>
<script src="/Kentico/Scripts/jquery.colorbox-min.js"></script>
<script>
  $(function () { $('body').on('change', '#ddlChangeLocation', function () {
      $.post("/dtncashbidwidget/bindlocation?dropdownvalue=" + t, function (res) {});
  }) })
</script>`;

test("an iframe is found and resolved even with a trailing space in src", () => {
  const a = assetsOf(UNITED, "https://www.unitedcooperative.com/grain/markets");
  assert.equal(a.iframes.length, 1);
  assert.match(a.iframes[0], /^https:\/\/stonehedge\.stonex\.com\/component\/bids\?key=AILQAFBJPWG59NXDNV00QPRSFTUA0EEU/);
  assert.match(a.iframes[0], /locs=8TG9IQ1J6TGRFBUP1XH0/);
});

test("a protocol-relative script src is resolved against the page, not dropped", () => {
  /* `//host/path` is the shape half the ag-vendor widgets ship. Resolving it
     wrong means the probe silently never reads that bundle. */
  const a = assetsOf(UNITED, "https://www.unitedcooperative.com/grain/markets");
  assert.ok(a.scripts.includes("https://unitedcooperative.websol.barchart.com/?module=futureMarketOverview&js=1"),
    `got ${JSON.stringify(a.scripts)}`);
  assert.ok(a.scripts.includes("https://www.unitedcooperative.com/Kentico/Scripts/jquery.colorbox-min.js"));
});

test("a POST path built by string concatenation is still reported", () => {
  /* This is the second door on United Cooperative's own site: the widget path
     is never a full URL anywhere in the page, only a rooted path passed to
     $.post. A URL-only matcher misses it entirely. */
  const eps = endpointStrings(UNITED).map((e) => e.url);
  assert.ok(eps.includes("/dtncashbidwidget/bindlocation?dropdownvalue="),
    `got ${JSON.stringify(eps)}`);
});

test("assets and fonts are not reported as endpoints", () => {
  const noise = `a="https://cdn.example.com/app.css";b="https://cdn.example.com/logo.png";c="https://cdn.example.com/f.woff2";d="https://api.example.com/v1/bids"`;
  const eps = endpointStrings(noise).map((e) => e.url);
  assert.deepEqual(eps, ["https://api.example.com/v1/bids"]);
});

test("a minified bundle's endpoint survives with usable context", () => {
  const bundle = `function n(e){return fetch("https://api.stonehedge.example/v2/bids?key="+e.key+"&locs="+e.locs.join(","),{headers:{accept:"application/json"}}).then(t=>t.json())}`;
  const eps = endpointStrings(bundle, 40);
  const hit = eps.find((e) => e.url.startsWith("https://api.stonehedge.example"));
  assert.ok(hit, `got ${JSON.stringify(eps.map((e) => e.url))}`);
  assert.match(hit.ctx, /fetch\(/, "the context must show what the string is passed to");
  const cs = callSites(bundle, 40);
  assert.equal(cs.length, 1);
  assert.match(cs[0], /api\.stonehedge\.example/);
});

test("inline widget config is reported", () => {
  const html = `<script>window.dtnConfig = {token:"abc123",site:"fcs"}; var cid = "4043";</script>`;
  const cfg = inlineConfig(html);
  assert.ok(cfg.some((c) => c.startsWith("dtnConfig = {token:")), `got ${JSON.stringify(cfg)}`);
  assert.ok(cfg.some((c) => c.startsWith("cid = ")));
});

test("a script WITH src contributes no inline config", () => {
  /* The regex that reads inline blocks must not swallow `<script src=…></script>`
     -- doing so reports the page's own markup as configuration. */
  const html = `<script src="/x.js"></script><script>var a = 1</script>`;
  assert.deepEqual(inlineConfig(html), ["a = 1"]);
});

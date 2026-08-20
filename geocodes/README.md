# geocodes/ — coordinates that came from somewhere, and how far you may trust them

## `basis1st-list-2026-08-20.tsv`

Sig's own earlier **basis1st** project, pasted 2026-08-20. Operator, cash-bids
URL, sometimes a street address, and a coordinate.

### TWO POPULATIONS. ONE OF THEM IS WRONG.

The paste contained both of these, and they are not the same data:

| | precision | place column | verdict |
|---|---|---|---|
| **kept** | 7–9 decimals | real address, or `Town, ST` in the postal column | **facility-accurate** |
| **dropped** | 4 decimals | bare `Town` + `State` in two columns | **wrong, often by hundreds of km** |

The dropped rows are mostly ethanol plants and look like a bad join. Four of
them, verbatim from the paste:

```
Valero Renewable Fuels LLC   Welcome      Minnesota     -90.8939   32.3913
Tharaldson Ethanol           Casselton    North Dakota  -81.8645   40.21473
Big River Resources LLC      West Burlington  Iowa      -91.1634   42.4874
Adkins Energy LLC            Lena         Illinois      -88.8896   39.8635
```

Latitude 32.39 is Alabama, not Welcome, Minnesota. Longitude −81.86 is Ohio,
not Casselton, North Dakota. **None of the four-decimal rows are in this file
and none of them should be used for anything.**

### What the kept rows were checked against

Eight sampled 2026-08-20, each geocoded independently by the **US Census
geocoder** and the **ArcGIS World GeocodeServer** against the operator's own
published street address:

| location | distance from the operator's published address | verdict |
|---|---|---|
| Allied — Hixton | **37 m** | facility |
| Ag Partners — Goodhue | **15 m** | facility |
| River Country — Bloomer | **65 m** | facility |
| Allied — Auburndale | **123 m** | facility (East site) |
| Flash Grain — Thorp | **131 m** | facility |
| Big River — Boyceville | **137 m** | facility |
| United — Beaver Dam | **265 m** | facility (grain site, not the office) |
| Synergy — Rice Lake | 611 m, resolves to a park with no street address | **town only — recheck by hand** |

Seven of eight facility-accurate, median 123 m. Two cases prove the source was
geocoded **per facility and not per company**: the Auburndale point picks
Allied's East site over its West site 3.2 km away, and the Beaver Dam point
picks United's grain site over its corporate office 6.5 km away.

### It is better than what we had

`flashgrain-thorp` was pinned **6.5 km** from the yard and `boyceville`
**4.1 km** — both were the town, not the elevator. Corrected on 2026-08-20.
A pin six kilometres out is the difference between the right answer and the
wrong one when a farmer asks which elevator is nearest.

### Rules for using this file

1. **A row here is evidence, not a fact.** The population was sampled, not
   verified row by row. Anything that will be published should still be checked
   against the operator's own address.
2. **Synergy / Rice Lake is known bad.** Do not use it without a manual look.
3. **Never copy a coordinate out of the dropped population.** It is not in this
   file; if you find yourself reading the original paste, stop.
4. Operator-embedded map pins are NOT ground truth — Allied's own Hixton pin is
   about 700 m out, further off than the coordinate we are checking.

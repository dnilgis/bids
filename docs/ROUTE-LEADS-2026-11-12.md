# Route leads cross-check (Nov 12, 2026)

Input: an outside discovery inventory of elevator bid routes (Nov 9-10, not verified, 1,548 input rows). This note
checks its 68 `script_readable=yes` route records (66 distinct elevators) against `data/directory.json`,
`sources/` and `data/gaps/` as of Nov 12. Nothing was added: no new board passed, and the sandbox could not open any
operator site on Nov 12 (the egress proxy refuses outside hosts), so no table, date, terms page or robots file was
checked first-hand. A lead that is not opened is not added.

| Group | Elevators | What bids already has |
|---|---:|---|
| NEW Cooperative (newcoop.com/cash-bids) | 48 IA + 1 IL record | All 48 IA are manifests (`newcoop-*`, enabled) with status `down`, last priced Oct 22. The IL record (Villisca, id a00150) is the same Villisca, IA yard. The reader is stopped by the site's bot check (the research's HTTP 403 agrees). Not a new board: an access problem, no bypass. On the outreach list. |
| Already read, live Nov 12 | 6 | scoularview-grainton, cpicoop-fairmont, encompassgrain-delavan, forestrivercoop-forestriver, reddyagservice-stitzer, stanfordgrain-stanford |
| Same operator and board family already read, this location not a source | 4 | Deerfield Ag (Massillon; only Deerfield is read), North Prairie Ag (Munich, cashbidssingle-2553; Nekoma is read), Prinsburg Farmers Coop (Clara City / Maynard; Raymond is read), Rugby Farmers Union (Willow City; York is read). These use the platform bids already reads (cashbidssingle), so the existing board-sweep and capture jobs on Actions are the path. Each needs its page opened and its own row count, date and futures column checked before a manifest. Not done here. |
| Loaded in a browser Oct 2, no board read | 5 | Allied Grain, FAC Coop (AGP Manning), Gevo North Dakota, Red Trail Energy, Madison Farmer's Elevator (all in `data/gaps/board-not-read.csv`; rows injected by script or path closed to crawlers). The research marks them readable through its own fetch only. Re-check on Actions, not by guessing a path. |
| Held disabled, measured reason | 2 | eppichgrain-basincity (corn priced per ton, cash minus basis does not equal futures), qualityplusfeedinc-qualityplusfeeds (board prints no futures). Reasons are in each manifest's `_pending`. The research does not change either. |

Freshness: the research itself shows Ace Ethanol dated Sep 16. Bids withdraws a board by its own posted date
(`maxAgeH`), never by the day it was fetched. No lead here is shown as "today".

Skipped on purpose, per the standing rules: CFE (terms prohibit scraping without authorization), MFA (official board
needs sign-in), Cargill, Western Grain Marketing and any DTN or aghost-hosted page not already covered by bids' existing
aghost rule. Operators to ask for an authorized export are in the private notes repo (drafts/outreach-routes-nov12.md);
no message was sent.

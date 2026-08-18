# Three files into `dnilgis/bids`

```
lib/board.mjs             REPLACES
scripts/fetch.mjs         REPLACES
test/torn-read.test.mjs   NEW
```

**This is not yet in the repo** — I checked, `lib/board.mjs` there has no
`TornRead`. That is why you are still getting the old "Columns have moved."

---

## What the two failures actually say

18:56 and 21:00, and the numbers are **identical**:

```
August: 4.1125 - (-0.52) = 463.25c but the page quotes 463c, off by 0.25c
```

A random mid-update read does not repeat itself to the quarter cent two hours
apart. So there are two live hypotheses, and they need different answers:

1. **Their front-month futures cell lags its cash.** August and September sit
   on Sep 26, the month that moves most. A retry clears this.
2. **Their board drops the odd quarter cent when it prints.** 463.5 came
   through fine at 17:50 and 463.25 did not, twice. If that is it, no retry
   will ever clear it, and the honest fix is elsewhere — in how the quote is
   parsed, not in how much disagreement we tolerate.

**I have not guessed between them, and I have not widened the tolerance.**
Doing that would put a hole in the one guard that proves a number came out of
the right column, on the strength of a hunch.

## What these files do instead

**Tell the two failures apart by size.** A column shift is tens of cents;
cash, basis and a futures quote hold numbers of completely different
magnitudes. **A column shift cannot be a quarter of a cent.** So a tick-sized
disagreement is a `TornRead` and gets looked at again after twenty seconds,
up to three reads. A real shift is refused at once and still says *Columns
have moved.*

**The retry runs the same check at the same strictness.** The identity still
has to balance exactly before a single number is written. Nothing is
published either way.

**And the log now carries every failing row with its contract month**, not
one example:

```
  Every row that failed, so a pattern can be seen across runs:
      August     Sep 26     cash 4.1125  basis -0.52  ->  463.25c but quoted 463c  (+0.25c)
      September  Sep 26     cash 4.175   basis -0.46  ->  463.5c  but quoted 463c  (+0.5c)
  5 of 7 row(s) balanced.
```

That is the line that decides it. **If every failure is on the front month
and none on the deferred ones, it is hypothesis 1 and the retry handles it.
If deferred months fail too, it is hypothesis 2 and I will fix the parser.**

Send me the next failure log and it will tell us which.

## Nothing is being harmed meanwhile

Every failed run writes nothing and leaves the committed price exactly as it
was. Both sites are publishing correctly off the last good read — I checked
the whole chain an hour ago and every row balanced.

The cost of these failures is a red X and an email, not a wrong price. Worth
fixing because an alert that cries wolf gets ignored, which is how a real one
gets missed.

## Tests

68 in the repo, 9 of them on this. They drive it by editing the real
fixture's futures column: their board quotes eighths, so `459-4` is 459½¢, a
torn read is a `-2` drift and a column shift is `419-4`.

/* THE BOARD'S OWN ROUNDING SETTING, IN ONE PLACE -- 2026-10-27.
 *
 * An AgriCharts cashgrid page carries the operator's rounding setting as the
 * third writeBidCell argument and applies it to the price in cents before it
 * prints anything (verbatim from fixtures/agricharts-cashgrid-*.html):
 *
 *     var remainder = rounded - Math.floor(rounded);
 *     if (rounding > -1)
 *       rounded = remainder >= rounding ? Math.ceil(rounded) : Math.floor(rounded);
 *     document.write((rounded/100).toFixed(cashprice_decimals));
 *
 * 1 always rounds down, 0.75 rounds up only from three quarters, 0.5 is half
 * up, 0 always rounds up, -1 prints to the board's own decimals.
 *
 * The adapter uses this to print what the board prints. lib/board.mjs uses
 * the SAME function to check a row against the setting it carries: the
 * residual must be exactly the one the setting produces from the row's own
 * futures and basis, which is narrower than any rounding window, not wider. */
export function roundAsBoard(cents, rounding, decimals = 2) {
  let c = cents;
  if (Number.isFinite(rounding) && rounding > -1)
    c = (c - Math.floor(c)) >= rounding ? Math.ceil(c) : Math.floor(c);
  return Number((c / 100).toFixed(decimals));
}

/** True only when the row carries a board setting and its cash is exactly what
 *  that setting makes of quotedCents + basis. An identity failure row from
 *  lib/parse.mjs checkIdentity (cash and basis in dollars, quotedCents). */
export function explainedByBoardSetting(r) {
  if (r?.boardRounding == null || !Number.isFinite(r.boardRounding)) return false;
  if (r.cash == null || r.basis == null || r.quotedCents == null) return false;
  const raw = Number((r.quotedCents + r.basis * 100).toFixed(6));
  const expect = roundAsBoard(raw, r.boardRounding, r.boardDecimals ?? 2);
  return Math.abs(r.cash - expect) < 1e-9;
}

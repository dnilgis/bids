/* A reminder before the CBOT holiday list runs out. lib/quotes.mjs holds the
 * grain holidays by hand (CME Group calendar); past its last date every
 * session is read as a trading day, so nothing fails until the calendar is
 * wrong. This fails 60 days ahead of that date, and passes until then. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CBOT_CLOSED } from "../lib/quotes.mjs";

const DAY_MS = 864e5;

test("CBOT_CLOSED still covers more than 60 days from today", () => {
  const last = [...CBOT_CLOSED].sort().at(-1);
  const daysLeft = (Date.parse(`${last}T00:00:00Z`) - Date.now()) / DAY_MS;
  assert.ok(
    daysLeft > 60,
    `CBOT_CLOSED ends ${last}: add next year's CME grain holidays (cmegroup.com holiday calendar)`,
  );
});

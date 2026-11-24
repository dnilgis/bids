/* The month in Central time ("YYYY-MM"), the month agsist reads.
   From 18:00 CST (19:00 CDT) on a month's last day UTC is already the next month,
   so every reader of "the current month" uses this one function. */
export function centralMonth(d) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value, m = parts.find((p) => p.type === "month")?.value;
    if (y && m) return `${y}-${m}`;
  } catch { /* no time zone data: a fixed offset below */ }
  const c = new Date(d.getTime() - 6 * 3.6e6);
  return `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, "0")}`;
}

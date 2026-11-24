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

/* The wall clock in Central time: { y, m, d, H, M, dow } (dow 1 = Monday .. 7 = Sunday). */
export function centralParts(d) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
      .formatToParts(d);
    const v = (t) => parts.find((p) => p.type === t)?.value;
    const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(v("weekday")) + 1;
    if (v("year") && dow > 0)
      return { y: Number(v("year")), m: Number(v("month")), d: Number(v("day")),
               H: Number(v("hour")), M: Number(v("minute")), dow };
  } catch { /* no time zone data: a fixed offset below */ }
  const c = new Date(d.getTime() - 6 * 3.6e6);
  return { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate(), H: c.getUTCHours(),
           M: c.getUTCMinutes(), dow: ((c.getUTCDay() + 6) % 7) + 1 };
}

/* The Central calendar date ("YYYY-MM-DD") of an instant. */
export function centralDate(d) {
  const p = centralParts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/* A Central wall-clock time as the instant it names. The offset is read for
   that very date, so a time either side of a daylight-saving change is right. */
export function centralToUtc(y, m, d, H = 0, M = 0, S = 0) {
  const guess = Date.UTC(y, m - 1, d, H, M, S);
  let t = guess + 6 * 3.6e6;
  for (let i = 0; i < 2; i++) {
    const p = centralParts(new Date(t));
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, S);
    t += guess - shown;
  }
  return new Date(t);
}

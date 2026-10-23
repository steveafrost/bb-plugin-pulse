/**
 * Next fire time for a 5-field cron expression in server-local time, for the
 * panel's "next run" hint. Supports `*`, numbers, lists, ranges and `*\/n` steps,
 * which covers the Pulse schedules. Returns null when nothing matches in 8 days.
 */
function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range!.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepText ? max : lo;
    }
    // Free-form settings: a zero, negative or non-numeric step would never advance.
    if (!Number.isInteger(step) || step < 1 || !Number.isInteger(lo) || !Number.isInteger(hi)) return new Set();
    for (let v = Math.max(lo, min); v <= Math.min(hi, max); v += step) out.add(v);
  }
  return out;
}

export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  if (!dow) return null;
  const mins = field(m!, 0, 59), hours = field(h!, 0, 23), doms = field(dom!, 1, 31), mons = field(mon!, 1, 12);
  const dows = new Set([...field(dow, 0, 7)].map((d) => d % 7));
  const domAny = dom === "*", dowAny = dow === "*";
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++, t.setMinutes(t.getMinutes() + 1)) {
    if (!mins.has(t.getMinutes()) || !hours.has(t.getHours()) || !mons.has(t.getMonth() + 1)) continue;
    const dayOk = domAny && dowAny ? true : domAny ? dows.has(t.getDay()) : dowAny ? doms.has(t.getDate()) : doms.has(t.getDate()) || dows.has(t.getDay());
    if (dayOk) return new Date(t);
  }
  return null;
}

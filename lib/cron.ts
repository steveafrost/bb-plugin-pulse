/**
 * Cron expressions as bb's scheduler reads them (it uses cron-parser), in server-local time:
 * 5 fields, or 6 with seconds first; `*`, `?`, numbers, `jan`-`dec` / `sun`-`sat` names, lists,
 * ranges, `/n` steps, `L` (last day of month), `5L` (last Friday), `5#2` (second Friday), and the
 * `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily` and `@hourly` macros. Out-of-range values
 * are errors, as they are for bb, so the panel never shows a next run for a schedule bb refused.
 * (cron-parser's `H` hash fields are not supported here: the panel shows no next time for them. In
 * the repeated hour of a fall-back night this picks the first occurrence; bb may pick the second.)
 */
export interface CronSpec {
  sec: number[];
  min: number[];
  hour: number[];
  dom: Set<number>;
  domLast: boolean;
  mon: Set<number>;
  dow: Set<number>;
  /** Weekdays in `nL`: the last such weekday of the month. */
  dowLast: Set<number>;
  /** Weekday -> which occurrences (`5#2`). */
  dowNth: Map<number, Set<number>>;
  domAny: boolean;
  dowAny: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@hourly": "0 * * * *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SEARCH_DAYS = 366 * 5;

type Kind = "sec" | "min" | "hour" | "dom" | "mon" | "dow";
const RANGE: Record<Kind, [number, number]> = { sec: [0, 59], min: [0, 59], hour: [0, 23], dom: [1, 31], mon: [1, 12], dow: [0, 7] };
const LABEL: Record<Kind, string> = { sec: "second", min: "minute", hour: "hour", dom: "day of month", mon: "month", dow: "day of week" };

function value(tok: string, kind: Kind): number {
  if (/^\d+$/.test(tok)) return Number(tok);
  const names = kind === "mon" ? MONTHS : kind === "dow" ? DAYS : null;
  const i = names ? names.indexOf(tok.toLowerCase()) : -1;
  if (i < 0) throw new Error(`${LABEL[kind]}: "${tok}" is not a number${names ? " or name" : ""}`);
  return kind === "mon" ? i + 1 : i;
}

function field(spec: string, kind: Kind, out: { last?: boolean; dowLast?: Set<number>; dowNth?: Map<number, Set<number>> }): Set<number> {
  const [min, max] = RANGE[kind];
  const set = new Set<number>();
  const check = (v: number) => {
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${LABEL[kind]} ${v} is out of range ${min}-${max}`);
    return v;
  };
  for (const part of spec.split(",")) {
    if (!part) throw new Error(`${LABEL[kind]}: empty list entry in "${spec}"`);
    if (kind === "dom" && part.toUpperCase() === "L") { out.last = true; continue; }
    const lastDow = kind === "dow" ? /^(\w+?)L$/i.exec(part) : null;
    if (lastDow) { out.dowLast!.add(check(value(lastDow[1]!, kind)) % 7); continue; }
    const nth = kind === "dow" ? /^(\w+)#([1-5])$/.exec(part) : null;
    if (nth) {
      const d = check(value(nth[1]!, kind)) % 7;
      const set5 = out.dowNth!.get(d) ?? new Set<number>();
      set5.add(Number(nth[2]));
      out.dowNth!.set(d, set5);
      continue;
    }
    const pieces = part.split("/");
    if (pieces.length > 2) throw new Error(`${LABEL[kind]}: bad step in "${part}"`);
    const [range, stepText] = pieces as [string, string | undefined];
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`${LABEL[kind]}: step must be a whole number of at least 1 in "${part}"`);
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") { lo = min; hi = max; }
    else if (range.includes("-")) {
      const [a, b, extra] = range.split("-");
      if (extra !== undefined || !a || !b) throw new Error(`${LABEL[kind]}: bad range "${range}"`);
      lo = check(value(a, kind));
      hi = check(value(b, kind));
      if (lo > hi) throw new Error(`${LABEL[kind]}: range ${range} runs backwards`);
    } else {
      lo = check(value(range, kind));
      hi = stepText !== undefined ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) set.add(kind === "dow" ? v % 7 : v);
  }
  return set;
}

/** Parse a cron expression; throws an Error naming the problem. */
export function parseCron(expr: string): CronSpec {
  let text = expr.trim();
  if (text.startsWith("@")) {
    const macro = MACROS[text.toLowerCase()];
    if (!macro) throw new Error(`unknown macro ${text}`);
    text = macro;
  }
  const parts = text.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) throw new Error(`expected 5 fields (or 6 with seconds), got ${parts.length}`);
  const [s, m, h, dom, mon, dow] = parts.length === 6 ? parts : ["0", ...parts];
  const domOut: { last?: boolean } = {};
  const dowOut = { dowLast: new Set<number>(), dowNth: new Map<number, Set<number>>() };
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return {
    sec: sorted(field(s!, "sec", {})),
    min: sorted(field(m!, "min", {})),
    hour: sorted(field(h!, "hour", {})),
    dom: field(dom!, "dom", domOut),
    domLast: domOut.last === true,
    mon: field(mon!, "mon", {}),
    dow: field(dow!, "dow", dowOut),
    dowLast: dowOut.dowLast,
    dowNth: dowOut.dowNth,
    domAny: dom === "*" || dom === "?",
    dowAny: dow === "*" || dow === "?",
  };
}

/** The problem with an expression, or null when it parses. */
export function cronError(expr: string): string | null {
  try { parseCron(expr); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

function dayMatches(c: CronSpec, y: number, mo: number, d: number): boolean {
  if (!c.mon.has(mo + 1)) return false;
  const lastDay = new Date(y, mo + 1, 0).getDate();
  const wd = new Date(y, mo, d).getDay();
  const domOk = c.dom.has(d) || (c.domLast && d === lastDay);
  const dowOk = c.dow.has(wd) || (c.dowLast.has(wd) && d + 7 > lastDay) || (c.dowNth.get(wd)?.has(Math.ceil(d / 7)) ?? false);
  const domRestricted = !c.domAny;
  const dowRestricted = !c.dowAny;
  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

function search(expr: string, from: Date, dir: 1 | -1): Date | null {
  let c: CronSpec;
  try { c = parseCron(expr); } catch { return null; }
  const hours = dir === 1 ? c.hour : [...c.hour].reverse();
  const mins = dir === 1 ? c.min : [...c.min].reverse();
  const secs = dir === 1 ? c.sec : [...c.sec].reverse();
  const at = from.getTime();
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dir * i);
    const y = day.getFullYear(), mo = day.getMonth(), d = day.getDate();
    if (!dayMatches(c, y, mo, d)) continue;
    for (const h of hours) for (const m of mins) for (const s of secs) {
      // A time inside a spring-forward gap normalizes past it (02:15 -> 03:15), as bb fires it.
      const t = new Date(y, mo, d, h, m, s);
      if (dir === 1 ? t.getTime() > at : t.getTime() < at) return t;
    }
  }
  return null;
}

/** The next fire time strictly after `from`, or null when the expression is invalid or never fires. */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  return search(expr, from, 1);
}

/** The latest fire time strictly before `from`, or null. */
export function prevCronRun(expr: string, from: Date = new Date()): Date | null {
  return search(expr, from, -1);
}

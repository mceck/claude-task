// Five-field cron expressions evaluated in an IANA time zone (docs/specs/schedules.md).

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** When both day fields are restricted, a day matches if either does (as in Vixie cron). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseValue(text: string, names: string[] | null, nameBase: number): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const index = names?.indexOf(text.toLowerCase()) ?? -1;
  return index >= 0 ? index + nameBase : null;
}

function parseField(text: string, min: number, max: number, names: string[] | null, nameBase: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range, step, extra] = part.split('/');
    if (extra !== undefined || range === undefined || range === '') return null;
    let stepSize = 1;
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1) return null;
      stepSize = Number(step);
    }
    let from: number | null;
    let to: number | null;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) return null;
      from = parseValue(a!, names, nameBase);
      to = parseValue(b!, names, nameBase);
    } else {
      from = parseValue(range, names, nameBase);
      to = step !== undefined ? max : from;
    }
    if (from === null || to === null || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += stepSize) values.add(v);
  }
  return values;
}

/** The parsed expression, or null when it is malformed or can never run. */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((f) => f === '')) return null;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(m, 0, 59, null, 0);
  const hours = parseField(h, 0, 23, null, 0);
  const daysOfMonth = parseField(dom, 1, 31, null, 0);
  const months = parseField(mon, 1, 12, MONTH_NAMES, 1);
  const rawDow = parseField(dow, 0, 7, DAY_NAMES, 0);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDow) return null;
  const daysOfWeek = new Set([...rawDow].map((d) => d % 7));
  const domRestricted = !dom.startsWith('*');
  const dowRestricted = !dow.startsWith('*');
  if (domRestricted && !dowRestricted && ![...months].some((mo) => [...daysOfMonth].some((d) => d <= DAYS_IN_MONTH[mo - 1]!))) return null;
  return { minutes, hours, daysOfMonth, months, daysOfWeek, domRestricted, dowRestricted };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock of an instant in a time zone, as milliseconds of a UTC calendar. Throws on an unknown zone. */
function wallClock(instant: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
}

const offsetAt = (instant: number, timeZone: string) => wallClock(instant, timeZone) - Math.floor(instant / 60_000) * 60_000;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The instant of a wall-clock time: the first one when it happens twice, the end of the gap when it does not exist. */
function wallToInstant(wall: number, timeZone: string): number {
  const before = offsetAt(wall - 36 * 60 * MINUTE, timeZone);
  const after = offsetAt(wall + 36 * 60 * MINUTE, timeZone);
  const valid = [...new Set([wall - before, wall - after])].filter((c) => wallClock(c, timeZone) === wall);
  if (valid.length > 0) return Math.min(...valid);
  // The time falls in a gap: find the minute the offset changes.
  let lo = wall - 36 * 60 * MINUTE;
  let hi = wall + 36 * 60 * MINUTE;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

function nextWall(spec: CronSpec, start: number): number | null {
  let d = start;
  const limit = start + 9 * 366 * DAY;
  while (d <= limit) {
    const date = new Date(d);
    const month = date.getUTCMonth() + 1;
    if (!spec.months.has(month)) {
      d = Date.UTC(date.getUTCFullYear(), month, 1);
      continue;
    }
    const domMatch = spec.daysOfMonth.has(date.getUTCDate());
    const dowMatch = spec.daysOfWeek.has(date.getUTCDay());
    const dayMatch = spec.domRestricted && spec.dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) {
      d = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      continue;
    }
    if (!spec.hours.has(date.getUTCHours())) {
      d = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1);
      continue;
    }
    if (!spec.minutes.has(date.getUTCMinutes())) {
      d += MINUTE;
      continue;
    }
    return d;
  }
  return null;
}

/** The first run strictly after `after`, or null for an invalid expression or time zone. */
export function nextCronRun(expression: string, timeZone: string, after: Date): Date | null {
  const spec = parseCron(expression);
  if (!spec) return null;
  try {
    let start = wallClock(after.getTime(), timeZone) + MINUTE;
    for (let attempt = 0; attempt < 8; attempt++) {
      const wall = nextWall(spec, start);
      if (wall === null) return null;
      const instant = wallToInstant(wall, timeZone);
      if (instant > after.getTime()) return new Date(instant);
      start = wall + MINUTE;
    }
    return null;
  } catch {
    return null;
  }
}

export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

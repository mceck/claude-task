import { nextCronRun, parseCron } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';

const next = (expr: string, tz: string, after: string) => nextCronRun(expr, tz, new Date(after))?.toISOString();

describe('cron expressions', () => {
  it('finds the next run in UTC', () => {
    expect(next('0 9 * * *', 'UTC', '2026-03-10T08:59:00Z')).toBe('2026-03-10T09:00:00.000Z');
    expect(next('0 9 * * *', 'UTC', '2026-03-10T09:00:00Z')).toBe('2026-03-11T09:00:00.000Z');
    expect(next('*/15 * * * *', 'UTC', '2026-03-10T09:07:30Z')).toBe('2026-03-10T09:15:00.000Z');
    expect(next('30 2 1 * *', 'UTC', '2026-03-10T00:00:00Z')).toBe('2026-04-01T02:30:00.000Z');
    expect(next('0 0 29 2 *', 'UTC', '2026-03-10T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('supports lists, ranges, steps, names and Sunday as 0 or 7', () => {
    expect(next('0 9 * * 1-5', 'UTC', '2026-03-13T10:00:00Z')).toBe('2026-03-16T09:00:00.000Z');
    expect(next('0 9 * * mon,wed', 'UTC', '2026-03-10T10:00:00Z')).toBe('2026-03-11T09:00:00.000Z');
    expect(next('0 12 * jan-mar *', 'UTC', '2026-04-01T00:00:00Z')).toBe('2027-01-01T12:00:00.000Z');
    expect(next('0 8 * * 7', 'UTC', '2026-03-10T00:00:00Z')).toBe('2026-03-15T08:00:00.000Z');
    expect(next('0 8 * * 0', 'UTC', '2026-03-10T00:00:00Z')).toBe('2026-03-15T08:00:00.000Z');
    expect(next('10-20/5 3 * * *', 'UTC', '2026-03-10T03:11:00Z')).toBe('2026-03-10T03:15:00.000Z');
  });

  it('runs when the day of the month or the day of the week matches if both are restricted', () => {
    expect(next('0 0 15 * mon', 'UTC', '2026-03-10T00:00:00Z')).toBe('2026-03-15T00:00:00.000Z');
    expect(next('0 0 15 * mon', 'UTC', '2026-03-15T00:00:00Z')).toBe('2026-03-16T00:00:00.000Z');
  });

  it('reads the expression in the time zone', () => {
    // Rome is UTC+1 in winter and UTC+2 in summer.
    expect(next('0 9 * * *', 'Europe/Rome', '2026-01-10T00:00:00Z')).toBe('2026-01-10T08:00:00.000Z');
    expect(next('0 9 * * *', 'Europe/Rome', '2026-07-10T00:00:00Z')).toBe('2026-07-10T07:00:00.000Z');
    expect(next('0 23 * * *', 'America/New_York', '2026-01-10T00:00:00Z')).toBe('2026-01-10T04:00:00.000Z');
  });

  it('keeps the local hour across a daylight saving change', () => {
    // Europe/Rome moves to summer time on 2026-03-29 at 02:00 local.
    expect(next('0 9 * * *', 'Europe/Rome', '2026-03-28T09:00:00Z')).toBe('2026-03-29T07:00:00.000Z');
    // ... and back on 2026-10-25 at 03:00 local.
    expect(next('0 9 * * *', 'Europe/Rome', '2026-10-24T09:00:00Z')).toBe('2026-10-25T08:00:00.000Z');
  });

  it('runs a time inside the spring gap at the first valid minute after it, once', () => {
    // 02:30 does not exist in Rome on 2026-03-29: the clock goes from 02:00 to 03:00 (01:00Z).
    expect(next('30 2 * * *', 'Europe/Rome', '2026-03-28T12:00:00Z')).toBe('2026-03-29T01:00:00.000Z');
    expect(next('30 2 * * *', 'Europe/Rome', '2026-03-29T01:00:00Z')).toBe('2026-03-30T00:30:00.000Z');
  });

  it('runs a time that happens twice in the autumn overlap at its first occurrence only', () => {
    // 02:30 happens at 00:30Z and again at 01:30Z in Rome on 2026-10-25.
    expect(next('30 2 * * *', 'Europe/Rome', '2026-10-24T12:00:00Z')).toBe('2026-10-25T00:30:00.000Z');
    expect(next('30 2 * * *', 'Europe/Rome', '2026-10-25T00:30:00Z')).toBe('2026-10-26T01:30:00.000Z');
  });

  it('rejects invalid expressions and time zones', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '0 0 31 2 *'])
      expect(parseCron(bad), bad).toBeNull();
    expect(nextCronRun('0 9 * * *', 'Mars/Olympus', new Date())).toBeNull();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { buildCalendar, calendarDates, type Calendar } from '../../src/calendar/index.ts';
import { commands, main, resolveToday } from '../../src/cli.ts';
import { resolveConfig } from '../../src/config.ts';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe('cli', () => {
  it('prints help listing every command', async () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      const { io, out } = capture();
      expect(await main(argv, io)).toBe(0);
      const text = out.join('');
      for (const name of [
        'bootstrap',
        'update',
        'rebuild [--refetch]',
        'audit [--samples N]',
        'validate',
        'diff <from> <to>',
      ]) {
        expect(text).toContain(name);
      }
    }
  });

  it('rejects unknown commands, options and wrong arity', async () => {
    expect(await main(['nope'], capture().io)).toBe(1);
    expect(await main(['rebuild', '--bogus'], capture().io)).toBe(1);
    expect(await main(['diff', 'a'], capture().io)).toBe(1);
  });

  it('stubs report not implemented', async () => {
    const { io, err } = capture();
    expect(await main(['diff', 'a', 'b'], io)).toBe(2);
    expect(err.join('')).toContain('not implemented');
  });
});

describe('--today', () => {
  const bootstrap = (() => {
    const command = commands.bootstrap;
    if (command === undefined) throw new Error('bootstrap command missing');
    return command;
  })();
  const original = bootstrap.run;
  afterEach(() => {
    bootstrap.run = original;
  });

  /** Replaces `bootstrap` with a command that builds the calendar from the run context. */
  function captureCalendar(): { calendar: () => Calendar | undefined } {
    let calendar: Calendar | undefined;
    bootstrap.run = (ctx) => {
      calendar = buildCalendar({ start: ctx.config.dates.start, today: ctx.today, contributions: [] });
      expect(ctx.config.dates.today).toBe(ctx.today);
      return Promise.resolve(0);
    };
    return { calendar: () => calendar };
  }

  const clock = () => '2026-10-01';

  it('reaches the calendar builder', async () => {
    const probe = captureCalendar();
    expect(await main(['bootstrap', '--today', '2025-12-31'], capture().io, resolveConfig(), clock)).toBe(0);
    const calendar = probe.calendar();
    expect(calendar?.today).toBe('2025-12-31');
    expect(calendar && calendarDates(calendar)).toEqual(['1861-03-17', '1927-01-12', '1948-01-01', '2025-12-31']);
    expect(calendar?.dates.get('2025-12-31')).toEqual(['today']);
  });

  it('falls back to dates.today, then to the clock at the CLI boundary', async () => {
    const probe = captureCalendar();
    await main(['bootstrap'], capture().io, resolveConfig({ dates: { today: '2024-01-22' } }), clock);
    expect(probe.calendar()?.today).toBe('2024-01-22');
    await main(['bootstrap'], capture().io, resolveConfig(), clock);
    expect(probe.calendar()?.today).toBe('2026-10-01');
    await main(
      ['bootstrap', '--today', '2020-02-29'],
      capture().io,
      resolveConfig({ dates: { today: '2024-01-22' } }),
      clock,
    );
    expect(probe.calendar()?.today).toBe('2020-02-29');
  });

  it('rejects invalid dates and dates before the dataset start', async () => {
    for (const value of ['2026-02-30', '01/10/2026', '1861-03-16']) {
      const { io, err } = capture();
      expect(await main(['bootstrap', '--today', value], io, resolveConfig(), clock)).toBe(1);
      expect(err.join('')).toContain('--today');
    }
    expect(() => resolveToday(undefined, resolveConfig(), () => 'x')).toThrow(RangeError);
  });

  it('is listed in the help', async () => {
    const { io, out } = capture();
    await main(['--help'], io);
    expect(out.join('')).toContain('--today YYYY-MM-DD');
  });
});

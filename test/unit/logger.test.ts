import { describe, expect, it } from 'vitest';
import { commands, main } from '../../src/cli.ts';
import { resolveConfig } from '../../src/config.ts';
import { ResponseValidationError, type HttpRequest } from '../../src/http/index.ts';
import { createLogger, logHttpEvents } from '../../src/logger.ts';

const NOW = Date.UTC(2026, 9, 1, 10);

function capture(verbose = false) {
  const lines: string[] = [];
  const logger = createLogger({ write: (l) => lines.push(l), verbose, now: () => NOW });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, parsed };
}

const REQUEST: HttpRequest = { method: 'GET', url: 'https://situas-servizi.istat.it/publish/reportspooljson?pfun=61' };

describe('logger', () => {
  it('writes one JSON object per line with time, level and message', () => {
    const { logger, lines, parsed } = capture();
    logger.info('snapshot round', { round: 1 });
    logger.error('failed', { error: new TypeError('boom') });
    expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    expect(parsed()).toEqual([
      { time: '2026-10-01T10:00:00.000Z', level: 'info', msg: 'snapshot round', round: 1 },
      {
        time: '2026-10-01T10:00:00.000Z',
        level: 'error',
        msg: 'failed',
        error: { name: 'TypeError', message: 'boom' },
      },
    ]);
  });

  it('writes debug lines only when verbose', () => {
    const quiet = capture();
    quiet.logger.debug('hidden');
    quiet.logger.warn('shown');
    expect(quiet.parsed().map((l) => l.level)).toEqual(['warn']);
    const verbose = capture(true);
    verbose.logger.debug('shown');
    expect(verbose.parsed().map((l) => l.level)).toEqual(['debug']);
  });

  it('logs every HTTP client notification', () => {
    const { logger, parsed } = capture(true);
    const onEvent = logHttpEvents(logger);
    onEvent({
      type: 'retry',
      endpoint: 'snapshot:pfun-61',
      request: REQUEST,
      attempt: 2,
      reason: 'HTTP 503',
      delayMs: 800,
    });
    onEvent({ type: 'concurrency', host: 'situas-servizi.istat.it', limit: 2 });
    onEvent({ type: 'circuit-open', family: 'situas-internal', reason: '10 consecutive failures' });
    onEvent({
      type: 'validation-error',
      endpoint: 'snapshot:pfun-61',
      request: REQUEST,
      error: new ResponseValidationError('bad rows', [{ index: 3, message: 'COD_UTS missing', row: {} }]),
    });
    onEvent({
      type: 'changed',
      endpoint: 'snapshot:pfun-61',
      request: REQUEST,
      key: 'k',
      previousContentHash: 'a',
      contentHash: 'b',
    });
    onEvent({
      type: 'degraded',
      endpoint: 'r5:uts-events',
      request: {
        method: 'POST',
        url: 'https://situas.istat.it/x',
        body: { url: 'var_get_ua_uts_lov_rs?&uts=Sassari' },
      },
      fetchedAt: '2026-09-30',
      reason: 'circuit open',
    });
    const lines = parsed();
    expect(lines.map((l) => [l.event, l.level])).toEqual([
      ['retry', 'info'],
      ['concurrency', 'debug'],
      ['circuit-open', 'error'],
      ['validation-error', 'error'],
      ['changed', 'warn'],
      ['degraded', 'warn'],
    ]);
    expect(lines[0]).toMatchObject({ url: REQUEST.url, attempt: 2, delay_ms: 800 });
    expect(lines[3]).toMatchObject({ error: 'bad rows', issues: [{ index: 3, message: 'COD_UTS missing' }] });
    expect(lines[5]).toMatchObject({ body: { url: 'var_get_ua_uts_lov_rs?&uts=Sassari' }, fetched_at: '2026-09-30' });
  });
});

describe('--verbose', () => {
  it('is accepted by every command and enables debug lines on stderr', async () => {
    const command = commands.validate;
    if (command === undefined) throw new Error('validate command missing');
    const original = command.run;
    try {
      command.run = (ctx) => {
        ctx.logger.debug('probe');
        return Promise.resolve(0);
      };
      for (const [argv, expected] of [
        [['validate'], 0],
        [['validate', '--verbose'], 1],
      ] as const) {
        const err: string[] = [];
        const io = { out: () => undefined, err: (t: string) => err.push(t) };
        expect(await main([...argv], io, resolveConfig(), () => '2026-10-01')).toBe(0);
        expect(err.filter((l) => l.includes('"probe"'))).toHaveLength(expected);
      }
    } finally {
      command.run = original;
    }
  });
});

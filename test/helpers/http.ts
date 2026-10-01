/** Test doubles for the HTTP client: virtual clock, settings, temporary cache directories. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveConfig, type ConfigInput } from '../../src/config.ts';
import type { HttpSettings } from '../../src/http/client.ts';
import type { Clock } from '../../src/http/clock.ts';
import { CONTENT_TYPES, jsonRowsDecoder, type Endpoint } from '../../src/http/decode.ts';
import type { HttpResponse } from '../../src/http/transport.ts';

export interface FakeClock {
  clock: Clock;
  /** Every delay passed to `sleep`, in order. */
  sleeps: number[];
  advance: (ms: number) => void;
}

/** Virtual time: `sleep` advances `now` instantly. Starts on 2026-10-01 at noon in Rome. */
export function fakeClock(start = Date.UTC(2026, 9, 1, 10)): FakeClock {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += Math.max(0, ms);
        return Promise.resolve();
      },
    },
    sleeps,
    advance: (ms) => {
      now += ms;
    },
  };
}

/** Plan defaults with no rate limiting worth waiting for and short backoff. */
export function httpSettings(overrides: NonNullable<ConfigInput['http']> = {}): HttpSettings {
  return resolveConfig({
    http: { requestsPerSecond: 1_000_000, backoffBaseMs: 100, backoffMaxMs: 10_000, ...overrides },
  }).http;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'it-http-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export const rowSchema = z.object({ CODE: z.string().regex(/^\d{3}$/) });

/** A public-API style endpoint returning `{ resultset: [{ CODE }] }`. */
export function publicEndpoint(
  options: Partial<Pick<Endpoint<unknown>, 'family' | 'timeoutClass'>> & { nonEmpty?: boolean } = {},
): Endpoint<z.output<typeof rowSchema>[]> {
  return {
    id: 'snapshot:pfun-64',
    family: options.family ?? 'situas-public-snapshots',
    timeoutClass: options.timeoutClass ?? 'default',
    decode: jsonRowsDecoder({
      contentTypes: CONTENT_TYPES.situasPublic,
      envelope: 'resultset',
      nonEmpty: options.nonEmpty ?? true,
      row: rowSchema,
    }),
  };
}

export const ok = (codes: string[] = ['090']): HttpResponse => json({ resultset: codes.map((CODE) => ({ CODE })) });

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { UNIFICATION_DATE } from './dates/index.ts';
import { isoDateSchema as isoDate } from './model/public.ts';

const MAX_CONCURRENCY = 8;

const pathsSchema = z
  .object({
    /** Base directory; relative paths below are resolved against it. */
    root: z.string().default('.'),
    /** HTTP response cache (§6.1). */
    httpCache: z.string().default('.cache/http'),
    /** Content-addressed snapshot store and event caches (§6.3). */
    store: z.string().default('.cache/store'),
    registry: z.string().default('registry'),
    overrides: z.string().default('overrides'),
    dist: z.string().default('dist'),
  })
  .prefault({});

const httpSchema = z
  .object({
    /** Initial worker count, per host (§6.1). */
    concurrency: z.int().min(1).max(MAX_CONCURRENCY).default(4),
    /** Upper bound for adaptive (AIMD) growth, per host. */
    maxConcurrency: z.int().min(1).max(MAX_CONCURRENCY).default(MAX_CONCURRENCY),
    /** Consecutive fast successes before adding a worker. */
    aimdIncreaseAfter: z.int().min(1).default(20),
    /** A success is fast when its latency is at most this fraction of its endpoint-class timeout. */
    aimdFastFraction: z.number().gt(0).max(1).default(0.25),
    /** Token-bucket rate limit, per host. */
    requestsPerSecond: z.number().positive().default(5),
    maxAttempts: z.int().min(1).default(6),
    /** Extra attempts allowed for transient validation failures, inside `maxAttempts` (§6.1). */
    transientValidationRetries: z.int().min(0).default(2),
    /** Full-jitter exponential backoff: delay ∈ [0, min(backoffMaxMs, backoffBaseMs · 2^(retry−1))). */
    backoffBaseMs: z.int().min(0).default(1000),
    backoffMaxMs: z.int().min(0).default(60_000),
    /** Upper bound applied to a server-provided `Retry-After`. */
    retryAfterMaxMs: z.int().min(0).default(300_000),
    timeouts: z
      .object({
        /** Municipality snapshots (endpoint class `snapshot`). */
        snapshotMs: z.int().positive().default(120_000),
        defaultMs: z.int().positive().default(30_000),
      })
      .prefault({}),
    /** Consecutive failed attempts on a family before its circuit opens (§6.1). */
    circuitBreakerThreshold: z.int().min(1).default(10),
    userAgent: z
      .string()
      .min(1)
      .default('italian-territories-generator (+https://github.com/andreacolzani/italian-territories)'),
  })
  .prefault({})
  .refine((http) => http.concurrency <= http.maxConcurrency, {
    message: 'concurrency must not exceed maxConcurrency',
    path: ['concurrency'],
  });

const sourcesSchema = z
  .object({
    situasPublicBaseUrl: z.url().default('https://situas-servizi.istat.it/publish'),
    situasInternalReportUrl: z.url().default('https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl'),
    anprCsvUrl: z.url().default('https://www.anagrafenazionale.interno.it/wp-content/uploads/ANPR_archivio_comuni.csv'),
  })
  .prefault({});

const datesSchema = z
  .object({
    /** Unification: lower bound of the dataset (§1.2). */
    start: isoDate.default(UNIFICATION_DATE),
    /** Reference "today"; `null` means the current date at run time. */
    today: isoDate.nullable().default(null),
  })
  .prefault({});

const updateSchema = z
  .object({
    /** Event lists are re-fetched from the previous run date minus this many days (§10.2). */
    lookbackDays: z.int().min(0).default(365),
    /** Random historical dates checked by `audit` during an update (§10.2). */
    auditSamples: z.int().min(0).default(50),
  })
  .prefault({});

export const configSchema = z.object({
  paths: pathsSchema,
  http: httpSchema,
  sources: sourcesSchema,
  dates: datesSchema,
  update: updateSchema,
});

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

/**
 * Builds a validated configuration from partial overrides. Relative paths are resolved
 * against `paths.root`, which is itself resolved against the process working directory.
 */
export function resolveConfig(input: ConfigInput = {}): Config {
  const config = configSchema.parse(input);
  const root = resolve(config.paths.root);
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(root, p));
  return {
    ...config,
    paths: {
      root,
      httpCache: abs(config.paths.httpCache),
      store: abs(config.paths.store),
      registry: abs(config.paths.registry),
      overrides: abs(config.paths.overrides),
      dist: abs(config.paths.dist),
    },
  };
}

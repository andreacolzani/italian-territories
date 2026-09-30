import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/** ISO calendar date `YYYY-MM-DD` (full validation lives in the date library, §4.1). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

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
    /** Initial worker count (§6.1). */
    concurrency: z.int().min(1).max(MAX_CONCURRENCY).default(4),
    /** Upper bound for adaptive (AIMD) growth. */
    maxConcurrency: z.int().min(1).max(MAX_CONCURRENCY).default(MAX_CONCURRENCY),
    /** Consecutive fast successes before adding a worker. */
    aimdIncreaseAfter: z.int().min(1).default(20),
    /** Token-bucket rate limit. */
    requestsPerSecond: z.number().positive().default(4),
    maxAttempts: z.int().min(1).default(6),
    timeouts: z
      .object({
        snapshotMs: z.int().positive().default(120_000),
        defaultMs: z.int().positive().default(30_000),
      })
      .prefault({}),
    /** Consecutive failures on an endpoint family before its circuit opens. */
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
    start: isoDate.default('1861-03-17'),
    /** First days of the 1927 and 1948 snapshot regimes (§2, §3.2). */
    regimeBoundaries: z.array(isoDate).default(['1927-01-12', '1948-01-01']),
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

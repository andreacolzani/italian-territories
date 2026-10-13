/**
 * Run summary (§10.4): `.cache/last-run.json`, written at the end of every run, including runs
 * that failed, for the workflows and the maintainer. It describes the run, not the data: it holds
 * wall-clock timings and is never published.
 *
 * Besides the outcome it carries the measures of the complete run: the time of the
 * offline build, of I12 and of `sourceSummaries`, the I12 abbreviations left uncompared, the count
 * of every anomaly code (ANPR included, with the items of the aggregated `info` anomalies) and the
 * golden-14 count (suppressed municipalities absent from ANPR).
 */
import { z } from 'zod';
import type { IsoDate } from '../dates/index.ts';
import type { InvariantReport } from '../invariants/index.ts';
import type { Anomaly } from '../model/internal.ts';
import type { Changes } from '../model/reports.ts';
import { isoDateSchema } from '../model/public.ts';
import { toJsonDocument, writeFileAtomic } from '../store/index.ts';
import type { ExitCode } from './exit-codes.ts';

const count = z.int().nonnegative();
const ms = z.number().nonnegative();

const changeCountsSchema = z.strictObject({ added: count, updated: count, removed: count, retroactive: count });

export const runSummarySchema = z.strictObject({
  command: z.string(),
  today: isoDateSchema.nullable(),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  /** 0–3 (§10.4); 130 / 143 when interrupted by SIGINT / SIGTERM. */
  exit_code: z.union([z.int().min(0).max(3), z.literal(130), z.literal(143)]),
  outcome: z.enum(['success', 'blocking', 'retroactive', 'unavailable', 'error', 'interrupted']),
  /** The signal that interrupted the run. */
  signal: z.enum(['SIGINT', 'SIGTERM']).nullable(),
  message: z.string().nullable(),
  release: z
    .strictObject({
      kind: z.enum(['unchanged', 'schemas', 'data']),
      data_version: z.string().nullable(),
      changes: changeCountsSchema.nullable(),
    })
    .nullable(),
  retroactive: z.strictObject({ value: z.boolean(), reasons: z.array(z.string()) }),
  anomalies: z.strictObject({
    blocking: count,
    warning: count,
    info: count,
    /** Per code: level, number of anomalies and, for aggregated ones, the sum of `context.count`. */
    by_code: z.record(z.string(), z.strictObject({ level: z.string(), anomalies: count, items: count })),
  }),
  invariants: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(['passed', 'failed', 'skipped']),
      violations: count,
      duration_ms: ms.nullable(),
      reason: z.string().nullable(),
      uncompared: z.unknown().nullable(),
    }),
  ),
  timings_ms: z.strictObject({
    stages: z.record(z.string(), ms),
    /** Identity resolution to emit, from the stored sources (no network). */
    build: ms.nullable(),
    i12: ms.nullable(),
    source_summaries: ms.nullable(),
  }),
  golden14: z.strictObject({
    /** Municipalities absent from ANPR (`anpr-missing-entity` items). */
    anpr_missing_entity: count.nullable(),
    /** Of those, the suppressed ones (§11.3 golden-14). */
    anpr_missing_suppressed: count.nullable(),
  }),
  /** `split_into` successor links per level (D44): for the maintainer's review. */
  derived: z.record(z.string(), z.strictObject({ split_into: count })),
  event_lists: z.array(
    z.strictObject({
      pfun: z.int(),
      from: isoDateSchema,
      to: isoDateSchema,
      outcome: z.string(),
      added: count,
      removed: count,
    }),
  ),
  snapshots: z
    .strictObject({ fetched: count, from_store: count, inferred: count, removed: count, failures: count })
    .nullable(),
  /** Stored snapshots refreshed after late events or audit discrepancies (update). */
  refreshed_snapshots: count.nullable(),
  audit: z
    .strictObject({
      samples: z.array(isoDateSchema),
      discrepancies: z.array(
        z.strictObject({ date: isoDateSchema, level: z.string(), kind: z.enum(['changed', 'inferred']) }),
      ),
      failures: count,
    })
    .nullable(),
  http: z.record(z.string(), count),
  /** Endpoints disabled by a permanent validation error, with the requests refused afterwards. */
  disabled_endpoints: z.array(z.strictObject({ endpoint: z.string(), cause: z.string(), refused: count })),
  /**
   * The `today` of the last pipeline run ended with exit 0 or 2, this one included
   * (`last-complete-update.json` in the store, §10.4); `null` when none is recorded.
   */
  last_complete_update: isoDateSchema.nullable(),
  error: z.strictObject({ name: z.string(), message: z.string(), stack: z.string().nullable() }).nullable(),
});

export type RunSummary = z.output<typeof runSummarySchema>;

export type InterruptSignal = 'SIGINT' | 'SIGTERM';

/** Conventional exit codes of a process ended by a signal (128 + signal number). */
export const INTERRUPT_EXIT_CODES: Record<InterruptSignal, 130 | 143> = { SIGINT: 130, SIGTERM: 143 };

/** Collects the parts of the summary while the run goes on. */
export class SummaryBuilder {
  readonly #command: string;
  readonly #startedAt: string;
  today: IsoDate | null = null;
  release: RunSummary['release'] = null;
  retroactiveReasons: string[] = [];
  invariants: InvariantReport | null = null;
  invariantDurations = new Map<string, number>();
  readonly stages: Record<string, number> = {};
  build: number | null = null;
  i12: number | null = null;
  sourceSummaries: number | null = null;
  golden14: RunSummary['golden14'] = { anpr_missing_entity: null, anpr_missing_suppressed: null };
  derived: RunSummary['derived'] = {};
  readonly eventLists: RunSummary['event_lists'] = [];
  snapshots: RunSummary['snapshots'] = null;
  audit: RunSummary['audit'] = null;
  refreshedSnapshots: number | null = null;
  readonly http: Record<string, number> = {};
  disabledEndpoints: RunSummary['disabled_endpoints'] = [];
  lastCompleteUpdate: IsoDate | null = null;
  message: string | null = null;

  constructor(command: string, startedAt: string) {
    this.#command = command;
    this.#startedAt = startedAt;
  }

  countHttp(type: string): void {
    this.http[type] = (this.http[type] ?? 0) + 1;
  }

  finish(options: {
    exitCode: ExitCode | null;
    anomalies: readonly Anomaly[];
    finishedAt: string;
    error?: unknown;
    signal?: InterruptSignal;
  }): RunSummary {
    const { exitCode, anomalies, error, signal } = options;
    const byCode: RunSummary['anomalies']['by_code'] = {};
    for (const a of [...anomalies].sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0))) {
      const entry = (byCode[a.code] ??= { level: a.level, anomalies: 0, items: 0 });
      entry.anomalies++;
      const items = (a.context as { count?: unknown }).count;
      entry.items += typeof items === 'number' && Number.isInteger(items) && items >= 0 ? items : 1;
    }
    const level = (l: Anomaly['level']) => anomalies.filter((a) => a.level === l).length;
    const code = signal !== undefined ? INTERRUPT_EXIT_CODES[signal] : error === undefined ? (exitCode ?? 1) : 1;
    const outcome =
      signal !== undefined
        ? 'interrupted'
        : error !== undefined
          ? 'error'
          : (['success', 'blocking', 'retroactive', 'unavailable'] as const)[exitCode ?? 1];
    return runSummarySchema.parse({
      command: this.#command,
      today: this.today,
      started_at: this.#startedAt,
      finished_at: options.finishedAt,
      exit_code: code,
      outcome,
      signal: signal ?? null,
      message: this.message,
      release: this.release,
      retroactive: { value: this.retroactiveReasons.length > 0, reasons: [...this.retroactiveReasons] },
      anomalies: { blocking: level('blocking'), warning: level('warning'), info: level('info'), by_code: byCode },
      invariants: (this.invariants?.results ?? []).map((r) => ({
        id: r.id,
        status: r.status,
        violations: r.violations,
        duration_ms: this.invariantDurations.get(r.id) ?? null,
        reason: r.reason ?? null,
        uncompared: r.uncompared ?? null,
      })),
      timings_ms: {
        stages: { ...this.stages },
        build: this.build,
        i12: this.i12,
        source_summaries: this.sourceSummaries,
      },
      golden14: this.golden14,
      derived: this.derived,
      event_lists: [...this.eventLists],
      snapshots: this.snapshots,
      refreshed_snapshots: this.refreshedSnapshots,
      audit: this.audit,
      http: { ...this.http },
      disabled_endpoints: [...this.disabledEndpoints],
      last_complete_update: this.lastCompleteUpdate,
      error:
        error === undefined
          ? null
          : error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack ?? null }
            : { name: 'Error', message: JSON.stringify(error), stack: null },
    });
  }
}

/** Counts of a `changes.json`. */
export function changeCounts(changes: Changes): z.output<typeof changeCountsSchema> {
  const sets = [
    changes.regions.entities,
    changes.regions.versions,
    changes.provinces.entities,
    changes.provinces.versions,
    changes.municipalities.entities,
    changes.municipalities.versions,
    changes.variations,
  ];
  const items = sets.flatMap((s) => [...s.added, ...s.updated, ...s.removed]);
  return {
    added: sets.reduce((n, s) => n + s.added.length, 0),
    updated: sets.reduce((n, s) => n + s.updated.length, 0),
    removed: sets.reduce((n, s) => n + s.removed.length, 0),
    retroactive: items.filter((i) => i.retroactive).length,
  };
}

export async function writeRunSummary(path: string, summary: RunSummary): Promise<void> {
  await writeFileAtomic(path, toJsonDocument(summary));
}

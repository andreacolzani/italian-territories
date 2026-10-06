/**
 * What a data command runs with (Step 17): configuration, reference date, logger, and the runtime
 * the CLI provides (transport, wall clock for `generated_at` and for timings). Build code never
 * reads the clock (§12.0): the runtime's clocks are read only for timestamps and timings, which
 * describe the run, not the data.
 */
import { AnomalyCollector } from '../anomalies.ts';
import type { Config } from '../config.ts';
import type { IsoDate } from '../dates/index.ts';
import { HttpClient, type Clock, type Transport } from '../http/index.ts';
import { logHttpEvents, type Logger } from '../logger.ts';
import { stageProgress, type Scheduler, type StageProgress } from '../progress.ts';
import { createSources, type Sources } from '../sources/index.ts';
import { Store } from '../store/index.ts';
import { SummaryBuilder } from './summary.ts';

export interface Runtime {
  /** Default: the `fetch` transport. */
  transport?: Transport;
  /** Clock of the HTTP client (backoff, `fetched_at`); default the system clock. */
  httpClock?: Clock;
  /** Uniform in `[0, 1)`, for the backoff jitter. */
  random?: () => number;
  /** Monotonic milliseconds, for timings only. */
  now: () => number;
  /** Current time, ISO 8601 UTC: `generated_at` and the run summary. */
  wallClock: () => string;
  /** Timer of the progress lines (default `setInterval`, every 30 s). */
  schedule?: Scheduler;
  /**
   * The process the run belongs to: signals and fatal errors end the run with a summary written
   * first. Absent (e.g. in unit tests): no handlers are installed.
   */
  process?: RunProcess;
}

export type RunProcessEvent = 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection';

export interface RunProcess {
  on: (event: RunProcessEvent, listener: (value?: unknown) => void) => void;
  off: (event: RunProcessEvent, listener: (value?: unknown) => void) => void;
  exit: (code: number) => void;
}

export interface RunContext {
  config: Config;
  today: IsoDate;
  logger: Logger;
  runtime: Runtime;
  store: Store;
  sources: Sources;
  client: HttpClient;
  anomalies: AnomalyCollector;
  summary: SummaryBuilder;
}

export function createRunContext(options: {
  command: string;
  config: Config;
  today: IsoDate;
  logger: Logger;
  runtime: Runtime;
}): RunContext {
  const { config, logger, runtime } = options;
  const summary = new SummaryBuilder(options.command, runtime.wallClock());
  summary.today = options.today;
  const log = logHttpEvents(logger);
  const client = new HttpClient({
    http: config.http,
    cacheDir: config.paths.httpCache,
    ...(runtime.transport === undefined ? {} : { transport: runtime.transport }),
    ...(runtime.httpClock === undefined ? {} : { clock: runtime.httpClock }),
    ...(runtime.random === undefined ? {} : { random: runtime.random }),
    onEvent: (event) => {
      summary.countHttp(event.type);
      log(event);
    },
  });
  return {
    config,
    today: options.today,
    logger,
    runtime,
    store: new Store(config.paths.store),
    sources: createSources(client, config),
    client,
    anomalies: new AnomalyCollector(),
    summary,
  };
}

/**
 * Runs `task` and records its duration (ms) under `name` in the summary's stage timings. The task gets
 * the stage's progress: counted work is logged every `PROGRESS_INTERVAL_MS` and in the final line.
 */
export async function timed<T>(
  ctx: RunContext,
  name: string,
  task: (progress: StageProgress) => Promise<T>,
): Promise<T> {
  const start = ctx.runtime.now();
  ctx.logger.info('stage start', { stage: name });
  const progress = stageProgress(name, {
    logger: ctx.logger,
    ...(ctx.runtime.schedule === undefined ? {} : { schedule: ctx.runtime.schedule }),
  });
  try {
    return await task(progress);
  } finally {
    progress.finish();
    const elapsed = ctx.runtime.now() - start;
    ctx.summary.stages[name] = (ctx.summary.stages[name] ?? 0) + elapsed;
    const counts = progress.counts();
    ctx.logger.info('stage done', { stage: name, ms: Math.round(elapsed), ...(counts.total > 0 ? counts : {}) });
  }
}

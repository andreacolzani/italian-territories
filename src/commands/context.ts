/**
 * Build code never reads the clock (§12): the runtime's clocks are read only for timestamps and
 * timings, which describe the run, not the data.
 */
import { AnomalyCollector } from '../anomalies.ts';
import type { Config } from '../config.ts';
import type { IsoDate } from '../dates/index.ts';
import { HttpClient, type Clock, type HttpRequest, type Transport } from '../http/index.ts';
import { logHttpEvents, type Logger } from '../logger.ts';
import { stageProgress, type Scheduler, type StageProgress } from '../progress.ts';
import { createSources, type Sources } from '../sources/index.ts';
import { Store } from '../store/index.ts';
import { SummaryBuilder } from './summary.ts';

export interface Runtime {
  transport?: Transport;
  httpClock?: Clock;
  /** Uniform in `[0, 1)`, for the backoff jitter. */
  random?: () => number;
  /** Monotonic milliseconds, for timings only. */
  now: () => number;
  /** Current time, ISO 8601 UTC: `generated_at` and the run summary. */
  wallClock: () => string;
  schedule?: Scheduler;
  /** Signals and fatal errors end the run with the summary written first; absent in unit tests. */
  process?: RunProcess;
}

export type RunProcessEvent = 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection';

export interface RunProcess {
  on: (event: RunProcessEvent, listener: (value?: unknown) => void) => void;
  off: (event: RunProcessEvent, listener: (value?: unknown) => void) => void;
  exit: (code: number) => void;
}

/** A bug: offline stages read only the store. Not a `NetworkError`, so the client neither retries nor degrades. */
export class OfflineRequestError extends Error {
  constructor(request: HttpRequest) {
    super(`offline run: request to ${request.url} refused (offline stages must read only the store)`);
    this.name = 'OfflineRequestError';
  }
}

const offlineTransport: Transport = (request) => Promise.reject(new OfflineRequestError(request));

export interface RunContext {
  offline: boolean;
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
  offline?: boolean;
}): RunContext {
  const { config, logger, runtime } = options;
  const offline = options.offline ?? false;
  const transport = offline ? offlineTransport : runtime.transport;
  const summary = new SummaryBuilder(options.command, runtime.wallClock());
  summary.today = options.today;
  const log = logHttpEvents(logger);
  const client = new HttpClient({
    http: config.http,
    cacheDir: config.paths.httpCache,
    ...(transport === undefined ? {} : { transport }),
    ...(runtime.httpClock === undefined ? {} : { clock: runtime.httpClock }),
    ...(runtime.random === undefined ? {} : { random: runtime.random }),
    onEvent: (event) => {
      summary.countHttp(event.type);
      log(event);
    },
  });
  return {
    offline,
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

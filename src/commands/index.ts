import type { Config } from '../config.ts';
import type { IsoDate } from '../dates/index.ts';
import type { Logger } from '../logger.ts';
import { loadLastCompleteUpdate, recordCompleteUpdate } from './complete-update.ts';
import { createRunContext, type RunContext, type RunProcessEvent, type Runtime } from './context.ts';
import { EXIT_CODES, type ExitCode } from './exit-codes.ts';
import { INTERRUPT_EXIT_CODES, writeRunSummary, type InterruptSignal } from './summary.ts';

export { sampleDates } from './audit.ts';
export { COMPLETE_UPDATE_FILE, loadLastCompleteUpdate } from './complete-update.ts';
export { createRunContext, OfflineRequestError, type RunContext, type RunProcess, type Runtime } from './context.ts';
export * from './exit-codes.ts';
export { runAuditCommand, runPipeline } from './pipeline.ts';
export { runDiff, runValidate } from './published.ts';
export { runSummarySchema, type RunSummary } from './summary.ts';

const MAX_LOGGED_BLOCKING = 50;

/** The summary is written however the run ends, signals and fatal errors included (§10.4). */
export async function runDataCommand(options: {
  command: string;
  config: Config;
  today: IsoDate;
  logger: Logger;
  runtime: Runtime;
  offline?: boolean;
  completeUpdate?: boolean;
  run: (ctx: RunContext) => Promise<ExitCode>;
}): Promise<ExitCode> {
  const { logger, runtime } = options;
  const ctx = createRunContext(options);
  /** Set once the summary is being written: a later ending never overwrites it. */
  let ending: Promise<unknown> | null = null;

  const end = (outcome: { exitCode: ExitCode; error?: unknown; signal?: InterruptSignal }) => {
    ending ??= finish(ctx, options, outcome);
    return ending;
  };
  const onSignal = (signal: InterruptSignal) => () => {
    logger.warn('run interrupted', { signal });
    void end({ exitCode: EXIT_CODES.blocking, signal }).finally(() =>
      runtime.process?.exit(INTERRUPT_EXIT_CODES[signal]),
    );
  };
  const onFatal = (error: unknown) => {
    logger.error('uncaught error', { error: error instanceof Error ? error : String(error) });
    void end({ exitCode: EXIT_CODES.blocking, error }).finally(() => runtime.process?.exit(EXIT_CODES.blocking));
  };
  const handlers: [RunProcessEvent, (value?: unknown) => void][] = [
    ['SIGINT', onSignal('SIGINT')],
    ['SIGTERM', onSignal('SIGTERM')],
    ['uncaughtException', onFatal],
    ['unhandledRejection', onFatal],
  ];
  for (const [event, listener] of handlers) runtime.process?.on(event, listener);

  let exitCode: ExitCode = EXIT_CODES.blocking;
  let error: unknown;
  try {
    exitCode = await options.run(ctx);
  } catch (caught) {
    error = caught;
    logger.error('run failed', { error: caught instanceof Error ? caught.message : String(caught) });
  } finally {
    await end({ exitCode, ...(error === undefined ? {} : { error }) });
    for (const [event, listener] of handlers) runtime.process?.off(event, listener);
  }
  if (error !== undefined) throw error instanceof Error ? error : new Error('non-Error thrown', { cause: error });
  return exitCode;
}

async function finish(
  ctx: RunContext,
  options: {
    command: string;
    config: Config;
    today: IsoDate;
    logger: Logger;
    runtime: Runtime;
    completeUpdate?: boolean;
  },
  outcome: { exitCode: ExitCode; error?: unknown; signal?: InterruptSignal },
): Promise<void> {
  const { logger } = options;
  const storeDir = options.config.paths.store;
  const complete =
    options.completeUpdate === true &&
    outcome.error === undefined &&
    outcome.signal === undefined &&
    (outcome.exitCode === EXIT_CODES.success || outcome.exitCode === EXIT_CODES.retroactive);
  try {
    ctx.summary.lastCompleteUpdate = complete
      ? await recordCompleteUpdate(storeDir, options.today)
      : await loadLastCompleteUpdate(storeDir);
  } catch (error) {
    // The summary is written anyway; the workflows treat a missing date as stale.
    logger.error('last complete update unreadable', { error: error instanceof Error ? error.message : String(error) });
  }
  ctx.summary.disabledEndpoints = ctx.client.disabledEndpoints();
  for (const { endpoint, cause, refused } of ctx.summary.disabledEndpoints) {
    logger.warn('requests refused by a disabled endpoint', { endpoint, cause, refused });
  }
  const summary = ctx.summary.finish({
    exitCode: outcome.exitCode,
    anomalies: ctx.anomalies.list(),
    finishedAt: options.runtime.wallClock(),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
  });
  await writeRunSummary(options.config.paths.runSummary, summary);
  const blocking = ctx.anomalies.list('blocking');
  for (const anomaly of blocking.slice(0, MAX_LOGGED_BLOCKING)) {
    // The cause decides the exit code of some codes (`internal-data-required`): logged with it.
    const { cause } = anomaly.context;
    logger.error(anomaly.message, { code: anomaly.code, ...(typeof cause === 'string' ? { cause } : {}) });
  }
  if (blocking.length > MAX_LOGGED_BLOCKING) {
    logger.error(`${blocking.length - MAX_LOGGED_BLOCKING} more blocking anomalies (see the run summary)`);
  }
  logger.info('run done', {
    command: options.command,
    exit_code: summary.exit_code,
    outcome: summary.outcome,
    message: summary.message,
    anomalies: {
      blocking: summary.anomalies.blocking,
      warning: summary.anomalies.warning,
      info: summary.anomalies.info,
    },
  });
}

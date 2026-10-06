/**
 * Progress of long stages (Step 17): every `intervalMs` (default 30 s) while a stage is running, one
 * log line with the requests completed, the total known so far and the errors (only when the stage
 * counts requests) and the current sub-step (when the stage names one); the caller logs the
 * final counts when the stage ends. The interval is a timer, so a stage stalled on retries still reports.
 *
 * Stages only count (`add`, `done`); they never read the clock (§12.0). The timer is injected so
 * tests drive it.
 */
import type { Logger } from './logger.ts';

export interface StageProgress {
  /** More work is known (e.g. a bisection round, the details of the crawled events). */
  add: (count: number) => void;
  /** One unit of work completed, `error` when it failed. */
  done: (error?: boolean) => void;
  /** The sub-step the stage is in, for stages that count no requests (e.g. the build). */
  step: (name: string) => void;
  /** The stage is over: the timer stops (the caller logs the final counts). */
  finish: () => void;
  counts: () => ProgressCounts;
}

export interface ProgressCounts {
  completed: number;
  total: number;
  errors: number;
}

export type Scheduler = (task: () => void, ms: number) => () => void;

export interface ProgressOptions {
  logger: Logger;
  intervalMs?: number;
  /** Repeats `task` every `ms` until the returned function is called; default `setInterval`. */
  schedule?: Scheduler;
}

export const PROGRESS_INTERVAL_MS = 30_000;

const intervalScheduler: Scheduler = (task, ms) => {
  const timer = setInterval(task, ms);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};

export function stageProgress(stage: string, options: ProgressOptions): StageProgress {
  const { logger } = options;
  let total = 0;
  let completed = 0;
  let errors = 0;
  let current: string | null = null;
  // Counts only when the stage counted something; the current sub-step when it has one.
  const report = (msg: string) => {
    logger.info(msg, {
      stage,
      ...(current === null ? {} : { step: current }),
      ...(total > 0 ? { completed, total, errors } : {}),
    });
  };
  const stop = (options.schedule ?? intervalScheduler)(() => {
    report('progress');
  }, options.intervalMs ?? PROGRESS_INTERVAL_MS);
  let finished = false;
  return {
    add: (count) => {
      total += count;
    },
    done: (error = false) => {
      completed++;
      if (error) errors++;
    },
    step: (name) => {
      current = name;
    },
    finish: () => {
      if (finished) return;
      finished = true;
      stop();
    },
    counts: () => ({ completed, total, errors }),
  };
}

/** A progress that reports nothing (tests, short stages). */
export const silentProgress: StageProgress = {
  add: () => undefined,
  done: () => undefined,
  step: () => undefined,
  finish: () => undefined,
  counts: () => ({ completed: 0, total: 0, errors: 0 }),
};

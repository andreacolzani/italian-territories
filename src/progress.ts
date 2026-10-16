/**
 * §10.4. The lines come from a timer, so a stage stalled on retries still reports; stages only count
 * and never read the clock (§12).
 */
import type { Logger } from './logger.ts';

export interface StageProgress {
  add: (count: number) => void;
  done: (error?: boolean) => void;
  /** For stages that count no requests (e.g. the build). */
  step: (name: string) => void;
  /** The caller logs the final counts. */
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
  schedule?: Scheduler;
}

const PROGRESS_INTERVAL_MS = 30_000;

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

export const silentProgress: StageProgress = {
  add: () => undefined,
  done: () => undefined,
  step: () => undefined,
  finish: () => undefined,
  counts: () => ({ completed: 0, total: 0, errors: 0 }),
};

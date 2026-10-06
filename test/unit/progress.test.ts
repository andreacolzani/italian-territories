import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.ts';
import { stageProgress } from '../../src/progress.ts';
import { fakeScheduler } from '../helpers/commands.ts';

describe('stage progress', () => {
  it('logs completed, total and errors at every interval until the stage finishes', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l) => lines.push(l), now: () => 0 });
    const scheduler = fakeScheduler();
    const progress = stageProgress('snapshots', { logger, schedule: scheduler.schedule });
    progress.add(10);
    progress.done();
    progress.done(true);
    scheduler.tick();
    progress.add(5);
    scheduler.tick();
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ msg: 'progress', stage: 'snapshots', completed: 2, total: 10, errors: 1 }),
      expect.objectContaining({ msg: 'progress', stage: 'snapshots', completed: 2, total: 15, errors: 1 }),
    ]);
    progress.finish();
    expect(scheduler.active()).toBe(0);
    expect(progress.counts()).toEqual({ completed: 2, total: 15, errors: 1 });
  });

  it('reports the current sub-step, without counts, for a stage that counts no requests', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l) => lines.push(l), now: () => 0 });
    const scheduler = fakeScheduler();
    const progress = stageProgress('build', { logger, schedule: scheduler.schedule });
    scheduler.tick();
    progress.step('invariants');
    scheduler.tick();
    progress.finish();
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((l) => [l.stage, l.step, l.total])).toEqual([
      ['build', undefined, undefined],
      ['build', 'invariants', undefined],
    ]);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { runSummarySchema, type RunProcess, type RunSummary } from '../../src/commands/index.ts';
import type { RunProcessEvent } from '../../src/commands/context.ts';
import type { Scheduler } from '../../src/progress.ts';
import { resolveConfig, type Config, type ConfigInput } from '../../src/config.ts';
import { fakeClock, type FakeClock } from './http.ts';
import { worldTransport, type World, type WorldTransport } from './world.ts';

/** The process of a sandboxed run: signals and fatal errors are emitted by the test. */
export interface FakeProcess extends RunProcess {
  emit: (event: RunProcessEvent, value?: unknown) => void;
  listeners: (event: RunProcessEvent) => number;
  exits: number[];
}

function fakeProcess(): FakeProcess {
  const listeners = new Map<RunProcessEvent, ((value?: unknown) => void)[]>();
  const exits: number[] = [];
  return {
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    off: (event, listener) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      ),
    exit: (code) => exits.push(code),
    emit: (event, value) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    listeners: (event) => listeners.get(event)?.length ?? 0,
    exits,
  };
}

/** Timers of the progress lines, fired by the test (`tick`). */
export interface FakeScheduler {
  schedule: Scheduler;
  tick: () => void;
  active: () => number;
}

export function fakeScheduler(): FakeScheduler {
  const tasks = new Set<() => void>();
  return {
    schedule: (task) => {
      tasks.add(task);
      return () => tasks.delete(task);
    },
    tick: () => {
      for (const task of [...tasks]) task();
    },
    active: () => tasks.size,
  };
}

export interface Sandbox {
  dir: string;
  config: Config;
  world: WorldTransport;
  /** Virtual clock of the HTTP client: its date stamps the cached responses. */
  clock: FakeClock;
  process: FakeProcess;
  scheduler: FakeScheduler;
  live: string[];
  run: (...argv: string[]) => Promise<number>;
  out: string;
  err: string;
  summary: () => Promise<RunSummary>;
  dispose: () => Promise<void>;
}

/** Nuoro's abbreviation, reported by SITUAS as a full name (cf. `uts-801-abbreviation`). */
const TEST_OVERRIDES = [
  {
    key: 'uts-091-abbreviation',
    target: { level: 'province', istat_code: '091', date_from: '2000-01-01', date_to: null },
    field: 'abbreviation',
    value: 'NU',
    reason: 'Test world: SITUAS reports the full name.',
    source: 'test',
    source_url: null,
  },
];

export async function sandbox(world: World, input: Pick<ConfigInput, 'update' | 'http'> = {}): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), 'it-commands-'));
  const overrides = join(dir, 'overrides');
  await mkdir(overrides, { recursive: true });
  await writeFile(join(overrides, 'abbreviations.json'), `${JSON.stringify(TEST_OVERRIDES, null, 2)}\n`);
  const config = resolveConfig({
    ...input,
    paths: { root: dir },
    dates: { start: world.start },
    http: {
      requestsPerSecond: 1_000_000,
      backoffBaseMs: 1,
      backoffMaxMs: 10,
      maxAttempts: 2,
      circuitBreakerThreshold: 1000,
      ...input.http,
    },
  });
  const transport = worldTransport(world);
  const clock = fakeClock();
  let tick = 0;
  const box: Sandbox = {
    dir,
    config,
    world: transport,
    clock,
    process: fakeProcess(),
    scheduler: fakeScheduler(),
    live: [],
    out: '',
    err: '',
    run: async (...argv) => {
      const out: string[] = [];
      const err: string[] = [];
      box.live = err;
      const code = await main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }, config, () => '2026-10-05', {
        transport: transport.transport,
        httpClock: clock.clock,
        random: () => 0,
        now: () => (tick += 1),
        wallClock: () => '2026-10-05T04:00:00.000Z',
        process: box.process,
        schedule: box.scheduler.schedule,
      });
      box.out = out.join('');
      box.err = err.join('');
      return code;
    },
    summary: async () => runSummarySchema.parse(JSON.parse(await readFile(config.paths.runSummary, 'utf8'))),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
  return box;
}

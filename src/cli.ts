#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { loadCalendar } from './calendar/index.ts';
import {
  runAuditCommand,
  runDataCommand,
  runDiff,
  runPipeline,
  runValidate,
  type ExitCode,
  type RunContext,
  type Runtime,
} from './commands/index.ts';
import { resolveConfig, type Config } from './config.ts';
import { currentDate, isAfter, isIsoDate, type IsoDate } from './dates/index.ts';
import { createLogger, type Logger } from './logger.ts';

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

interface CommandContext {
  /** `dates.today` is always set: the flag, the configured value or the current date. */
  config: Config;
  /** Reference date of the run (§12.0 Determinism); build code never reads the clock. */
  today: IsoDate;
  io: CliIo;
  /** NDJSON logger on stderr; `debug` only with `--verbose` (§12.0 Logging). */
  logger: Logger;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  runtime: Runtime;
}

interface Command {
  usage: string;
  summary: string;
  options: ParseArgsOptionsConfig;
  positionals: number;
  /**
   * Reference date when `--today` is not given, before the configured and the current date (e.g.
   * the `today` of the stored calendar for an offline `rebuild`).
   */
  defaultToday?: (values: CommandContext['values'], config: Config) => Promise<IsoDate | undefined>;
  run: (ctx: CommandContext) => Promise<number>;
}

const PROGRAM = 'italian-territories';

/** Options accepted by every command. */
const GLOBAL_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  today: { type: 'string' },
  verbose: { type: 'boolean' },
} as const satisfies ParseArgsOptionsConfig;

/** A data command: the run summary is always written (`paths.runSummary`). */
function dataCommand(name: string, run: (ctx: RunContext, command: CommandContext) => Promise<ExitCode>) {
  return (command: CommandContext): Promise<number> =>
    runDataCommand({
      command: name,
      config: command.config,
      today: command.today,
      logger: command.logger,
      runtime: command.runtime,
      run: (ctx) => run(ctx, command),
    });
}

/** `--samples N`, or the configured default; `undefined` when malformed. */
function parseSamples(value: string | boolean | undefined, fallback: number): number | undefined {
  if (typeof value !== 'string') return fallback;
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Commands of §10.1. */
export const commands: Record<string, Command> = {
  bootstrap: {
    usage: 'bootstrap',
    summary: 'Full fetch and build from scratch.',
    options: {},
    positionals: 0,
    run: dataCommand('bootstrap', (ctx) => runPipeline(ctx, 'bootstrap')),
  },
  update: {
    usage: 'update',
    summary: 'Incremental update.',
    options: {},
    positionals: 0,
    run: dataCommand('update', (ctx) => runPipeline(ctx, 'update')),
  },
  rebuild: {
    usage: 'rebuild [--refetch]',
    summary:
      'Full rebuild from the store, offline, for the date of the last run; --refetch refreshes all sources (current date).',
    options: { refetch: { type: 'boolean' } },
    positionals: 0,
    defaultToday: async (values, config) =>
      values.refetch === true ? undefined : (await loadCalendar(config.paths.store))?.today,
    run: dataCommand('rebuild', (ctx, command) =>
      runPipeline(ctx, command.values.refetch === true ? 'rebuild-refetch' : 'rebuild'),
    ),
  },
  audit: {
    usage: 'audit [--samples N]',
    summary: 'Compare N random historical dates with fresh SITUAS snapshots.',
    options: { samples: { type: 'string' } },
    positionals: 0,
    run: (command) => {
      const samples = parseSamples(command.values.samples, command.config.update.auditSamples);
      if (samples === undefined) {
        command.io.err(`${PROGRAM} audit: --samples must be a non-negative integer\n`);
        return Promise.resolve(1);
      }
      return dataCommand('audit', (ctx) => runAuditCommand(ctx, samples))(command);
    },
  },
  validate: {
    usage: 'validate',
    summary: 'Run all invariants on dist/.',
    options: {},
    positionals: 0,
    run: async (ctx) => (await runValidate(ctx.config.paths.dist, ctx.config.dates.start, ctx.io)).exitCode,
  },
  diff: {
    usage: 'diff <from> <to> [--out FILE]',
    summary: 'Produce changes.json between two published datasets (directories); stdout or --out.',
    options: { out: { type: 'string' } },
    positionals: 2,
    run: (ctx) => {
      const [from = '', to = ''] = ctx.positionals;
      const out = ctx.values.out;
      return runDiff(from, to, typeof out === 'string' ? out : undefined, ctx.io);
    },
  },
};

export function helpText(): string {
  const width = Math.max(...Object.values(commands).map((c) => c.usage.length));
  const lines = Object.values(commands).map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
  return [
    `Usage: ${PROGRAM} <command> [options]`,
    '',
    'Commands:',
    ...lines,
    '',
    'Options:',
    '  --today YYYY-MM-DD  Reference date of the run (default: current date in Europe/Rome).',
    '  --verbose           Also log debug lines (NDJSON on stderr).',
    '  -h, --help          Show this help.',
    '',
  ].join('\n');
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * Reference date of the run: `--today`, else the configured `dates.today`, else the current date
 * in Europe/Rome. The only place where the build reads the clock (§12.0 Determinism).
 */
export function resolveToday(flag: string | undefined, config: Config, clock: () => IsoDate = currentDate): IsoDate {
  const today = flag ?? config.dates.today ?? clock();
  const invalid = `--today must be a YYYY-MM-DD date, got '${today}'`;
  if (!isIsoDate(today)) throw new RangeError(invalid);
  if (isAfter(config.dates.start, today)) {
    throw new RangeError(`--today ${today} is before the dataset start ${config.dates.start}`);
  }
  return today;
}

/** The real runtime: `fetch` transport, system clocks. The only place they are chosen. */
export const defaultRuntime: Runtime = {
  now: () => performance.now(),
  wallClock: () => new Date().toISOString(),
  process: {
    on: (event, listener) => process.on(event, listener),
    off: (event, listener) => process.off(event, listener),
    exit: (code) => process.exit(code),
  },
};

export async function main(
  argv: string[],
  io: CliIo = defaultIo,
  config: Config = resolveConfig(),
  clock: () => IsoDate = currentDate,
  runtime: Runtime = defaultRuntime,
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
    io.out(helpText());
    return 0;
  }
  const command = commands[name];
  if (command === undefined) {
    io.err(`${PROGRAM}: unknown command '${name}'.\n\n${helpText()}`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...command.options, ...GLOBAL_OPTIONS },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.err(`${PROGRAM} ${name}: ${(error as Error).message}\nUsage: ${PROGRAM} ${command.usage}\n`);
    return 1;
  }
  if (parsed.values.help === true) {
    io.out(`Usage: ${PROGRAM} ${command.usage}\n\n${command.summary}\n`);
    return 0;
  }
  if (parsed.positionals.length !== command.positionals) {
    io.err(`${PROGRAM} ${name}: expected ${command.positionals} argument(s).\nUsage: ${PROGRAM} ${command.usage}\n`);
    return 1;
  }
  const flag = parsed.values.today;
  let today: IsoDate;
  try {
    const fallback = typeof flag === 'string' ? undefined : await command.defaultToday?.(parsed.values, config);
    today = resolveToday(typeof flag === 'string' ? flag : fallback, config, clock);
  } catch (error) {
    io.err(`${PROGRAM} ${name}: ${(error as Error).message}
`);
    return 1;
  }
  try {
    return await command.run({
      config: { ...config, dates: { ...config.dates, today } },
      today,
      io,
      logger: createLogger({ write: io.err, verbose: parsed.values.verbose === true }),
      values: parsed.values,
      positionals: parsed.positionals,
      runtime,
    });
  } catch (error) {
    io.err(`${PROGRAM} ${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}

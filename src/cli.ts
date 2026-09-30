#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { resolveConfig, type Config } from './config.ts';

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

interface CommandContext {
  config: Config;
  io: CliIo;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

interface Command {
  usage: string;
  summary: string;
  options: ParseArgsOptionsConfig;
  positionals: number;
  run: (ctx: CommandContext) => Promise<number>;
}

const PROGRAM = 'italian-territories';

function notImplemented(name: string) {
  return (ctx: CommandContext): Promise<number> => {
    ctx.io.err(`${PROGRAM}: command '${name}' is not implemented yet.\n`);
    return Promise.resolve(2);
  };
}

/** Commands of §10.1. */
export const commands: Record<string, Command> = {
  bootstrap: {
    usage: 'bootstrap',
    summary: 'Full fetch and build from scratch.',
    options: {},
    positionals: 0,
    run: notImplemented('bootstrap'),
  },
  update: {
    usage: 'update',
    summary: 'Incremental update.',
    options: {},
    positionals: 0,
    run: notImplemented('update'),
  },
  rebuild: {
    usage: 'rebuild [--refetch]',
    summary: 'Full rebuild from the store; --refetch refreshes all sources.',
    options: { refetch: { type: 'boolean' } },
    positionals: 0,
    run: notImplemented('rebuild'),
  },
  audit: {
    usage: 'audit [--samples N]',
    summary: 'Compare N random historical dates with fresh SITUAS snapshots.',
    options: { samples: { type: 'string' } },
    positionals: 0,
    run: notImplemented('audit'),
  },
  validate: {
    usage: 'validate',
    summary: 'Run all invariants on dist/.',
    options: {},
    positionals: 0,
    run: notImplemented('validate'),
  },
  diff: {
    usage: 'diff <from> <to>',
    summary: 'Produce changes.json between two builds.',
    options: {},
    positionals: 2,
    run: notImplemented('diff'),
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
    '  -h, --help  Show this help.',
    '',
  ].join('\n');
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export async function main(argv: string[], io: CliIo = defaultIo, config: Config = resolveConfig()): Promise<number> {
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
      options: { ...command.options, help: { type: 'boolean', short: 'h' } },
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
  return command.run({ config, io, values: parsed.values, positionals: parsed.positionals });
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

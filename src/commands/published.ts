/**
 * Commands on releases (§10.1): `validate` runs the invariants on a release (`dist/` and
 * `reports/variations.json`), `diff` computes `changes.json` between two releases. Neither reads a
 * source.
 */
import { join } from 'node:path';
import type { IsoDate } from '../dates/index.ts';
import {
  computeChanges,
  dataVersionDate,
  loadPublishedDataset,
  parseReleaseFile,
  serialize,
  toInternalData,
  type ReleaseDirs,
} from '../emit/index.ts';
import { checkInvariants, type InvariantReport } from '../invariants/index.ts';
import { writeFileAtomic } from '../store/index.ts';
import { EXIT_CODES, type ExitCode } from './exit-codes.ts';

export interface PublishedIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * `validate`: the release (public files and variation report) read back into the internal model
 * and checked with every invariant. I2, I7, I12, I13 and I14 need data a release does not hold
 * (snapshot existence, historical UTS codes, snapshots, counts, event accounts) and are reported as
 * `skipped`, never as passed.
 */
export async function runValidate(
  dirs: ReleaseDirs,
  start: IsoDate,
  io: PublishedIo,
): Promise<{ exitCode: ExitCode; report: InvariantReport | null }> {
  const dataset = await loadPublishedDataset(dirs);
  if (dataset === null) {
    io.err(`validate: no release in ${dirs.dist} and ${dirs.reports} (reports/meta.json missing)\n`);
    return { exitCode: EXIT_CODES.blocking, report: null };
  }
  const { entities, variations } = toInternalData(dataset);
  const report = await checkInvariants({
    start,
    today: dataVersionDate(dataset.meta.data_version),
    entities,
    variations,
  });
  const lines = report.results.map((r) =>
    r.status === 'skipped'
      ? `${r.id} skipped: ${r.reason ?? ''}`
      : `${r.id} ${r.status}${r.violations > 0 ? ` (${r.violations} violations)` : ''}`,
  );
  io.out(`${lines.join('\n')}\n`);
  const violations = report.anomalies.filter((a) => a.level === 'blocking');
  for (const a of violations.slice(0, 50)) io.err(`${a.code}: ${a.message}\n`);
  if (violations.length > 50) io.err(`… ${violations.length - 50} more violations\n`);
  const failed = report.results.some((r) => r.status === 'failed');
  return { exitCode: failed ? EXIT_CODES.blocking : EXIT_CODES.success, report };
}

/** The release of a directory holding `dist/` and `reports/` (e.g. a checkout). */
function releaseIn(dir: string): ReleaseDirs {
  return { dist: join(dir, 'dist'), reports: join(dir, 'reports') };
}

/**
 * `diff <from> <to>`: `changes.json` from the release in `from` to the one in `to`, each a
 * directory holding `dist/` and `reports/`.
 */
export async function runDiff(from: string, to: string, out: string | undefined, io: PublishedIo): Promise<ExitCode> {
  const [previous, current] = await Promise.all([
    loadPublishedDataset(releaseIn(from)),
    loadPublishedDataset(releaseIn(to)),
  ]);
  for (const [dir, dataset] of [
    [from, previous],
    [to, current],
  ] as const) {
    if (dataset === null) {
      io.err(`diff: no release in ${dir} (reports/meta.json missing)\n`);
      return EXIT_CODES.blocking;
    }
  }
  if (previous === null || current === null) return EXIT_CODES.blocking;
  const changes = parseReleaseFile(
    'changes',
    computeChanges(previous, current, {
      data_version: current.meta.data_version,
      generated_at: current.meta.generated_at,
    }),
  );
  const text = serialize(changes);
  if (out === undefined) io.out(text);
  else await writeFileAtomic(out, text);
  return EXIT_CODES.success;
}

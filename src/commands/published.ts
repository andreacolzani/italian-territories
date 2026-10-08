/**
 * Commands on published datasets (§10.1): `validate` runs the invariants on `dist/`, `diff`
 * computes `changes.json` between two published datasets. Neither reads a source.
 */
import type { IsoDate } from '../dates/index.ts';
import {
  computeChanges,
  dataVersionDate,
  loadPublishedDataset,
  parsePublicFile,
  serialize,
  toInternalData,
} from '../emit/index.ts';
import { checkInvariants, type InvariantReport } from '../invariants/index.ts';
import { writeFileAtomic } from '../store/index.ts';
import { EXIT_CODES, type ExitCode } from './exit-codes.ts';

export interface PublishedIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * `validate`: the published files read back into the internal model and checked with every
 * invariant. I2, I7, I12, I13 and I14 need unpublished data (snapshot existence, historical UTS
 * codes, snapshots, counts, event accounts) and are reported as `skipped`, never as passed.
 */
export async function runValidate(
  dist: string,
  start: IsoDate,
  io: PublishedIo,
): Promise<{ exitCode: ExitCode; report: InvariantReport | null }> {
  const dataset = await loadPublishedDataset(dist);
  if (dataset === null) {
    io.err(`validate: no release in ${dist} (meta.json missing)\n`);
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

/** `diff <from> <to>`: `changes.json` from the release in `from` to the one in `to` (directories). */
export async function runDiff(from: string, to: string, out: string | undefined, io: PublishedIo): Promise<ExitCode> {
  const [previous, current] = await Promise.all([loadPublishedDataset(from), loadPublishedDataset(to)]);
  for (const [dir, dataset] of [
    [from, previous],
    [to, current],
  ] as const) {
    if (dataset === null) {
      io.err(`diff: no release in ${dir} (meta.json missing)\n`);
      return EXIT_CODES.blocking;
    }
  }
  if (previous === null || current === null) return EXIT_CODES.blocking;
  const changes = parsePublicFile(
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

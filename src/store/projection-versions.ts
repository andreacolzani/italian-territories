/**
 * Version of every projection kept in the store (§6.3): snapshots per level, event lists per
 * endpoint, internal reports per report, counts and the ANPR archive.
 *
 * Bump an entry whenever its adapter changes what it projects (fields added, removed, renamed or
 * normalised differently). Manifests written under another version are ignored by the build and
 * are not compared with new content (no `history` entry, no change): the store must be refilled
 * with `rebuild --refetch`, which is never a retroactive change.
 */
import type { Level } from '../model/common.ts';
import type { InternalReportNumber } from '../sources/situas-internal/index.ts';
import type { EventListPfun } from '../sources/situas-public/index.ts';

export interface ProjectionVersions {
  snapshot: Record<Level, number>;
  events: Record<EventListPfun, number>;
  internal: Record<InternalReportNumber, number>;
  /** Snapshot counts (`reportspooljsoncount`, I13). */
  counts: number;
  /** The ANPR archive (cross-check, §6.11). */
  anpr: number;
}

export const PROJECTION_VERSIONS: ProjectionVersions = {
  snapshot: { region: 1, province: 1, municipality: 1 },
  events: { 98: 1, 100: 1, 103: 1, 104: 1, 105: 1, 106: 1, 107: 1, 108: 1, 112: 1, 113: 1, 114: 1 },
  internal: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1 },
  counts: 1,
  anpr: 1,
};

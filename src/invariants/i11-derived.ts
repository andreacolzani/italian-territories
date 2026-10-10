/**
 * Invariant I11 (§8.1): the derived fields (§7) are consistent with the versions and the
 * variations. The expected values are recomputed from the entities' versions and the variations
 * (`deriveFields`) and every field of every entity is compared: a stale or tampered `status`,
 * `predecessors`, `successors` (the `split_into` kind included), `current_successors`,
 * or `is_former_italian` is a violation, one per entity and field. Moreover, a
 * suppressed municipality that is not former Italian must have a non-empty `current_successors`;
 * regions and provinces have none (D46).
 */
import { AnomalyCollector } from '../anomalies.ts';
import { deriveFields } from '../derive/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import type { Anomaly, EntityLink, Variation } from '../model/internal.ts';
import { violation } from './anomaly.ts';
import type { InvariantEntities, InvariantEntity } from './world.ts';

const linkKey = (l: EntityLink): string => `${l.id}|${l.kind}|${l.date}`;

export function checkI11(options: { entities: InvariantEntities; variations: readonly Variation[] }): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const level of LEVELS) {
    const actual = options.entities[level] as readonly InvariantEntity<Level>[];
    const expected = new Map(
      deriveFields({
        level,
        entities: actual,
        variations: options.variations,
        // Cycles are the derive stage's anomaly.
        anomalies: new AnomalyCollector(),
      }).map((e) => [e.id, e]),
    );
    for (const entity of actual) {
      const wanted = expected.get(entity.id);
      if (wanted === undefined) continue;
      const mismatch = (field: string, got: unknown, want: unknown): void => {
        anomalies.push(
          violation(
            'I11',
            `${level} entity ${entity.id}: ${field} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
            {
              level,
              entityId: entity.id,
              field,
              actual: got,
              expected: want,
            },
          ),
        );
      };
      if (entity.status !== wanted.status) mismatch('status', entity.status, wanted.status);
      if (entity.isFormerItalian !== wanted.isFormerItalian) {
        mismatch('isFormerItalian', entity.isFormerItalian, wanted.isFormerItalian);
      }
      for (const field of ['predecessors', 'successors'] as const) {
        const got = entity[field].map(linkKey);
        const want = wanted[field].map(linkKey);
        if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
          mismatch(field, entity[field], wanted[field]);
        }
      }
      const got = entity.currentSuccessors;
      const want = wanted.currentSuccessors;
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatch('currentSuccessors', got, want);
      if (
        level === 'municipality' &&
        entity.status === 'suppressed' &&
        !entity.isFormerItalian &&
        (entity.currentSuccessors ?? []).length === 0
      ) {
        anomalies.push(
          violation(
            'I11',
            `${level} entity ${entity.id} is suppressed and not former Italian but has no current successors`,
            { level, entityId: entity.id, field: 'currentSuccessors', problem: 'suppressed-without-successors' },
          ),
        );
      }
    }
  }
  return anomalies;
}

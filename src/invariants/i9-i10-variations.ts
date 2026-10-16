/**
 * §8.1. Versions starting on the first calendar date open no variation (`PV`). `role: null`
 * participants are the no-effect ones the emitter drops (§6.12).
 */
import { LEVELS, participantRoleViolations, type EntityId, type Level } from '../model/common.ts';
import type { Anomaly, Entity, Participant, Variation } from '../model/internal.ts';
import { violation } from './anomaly.ts';
import type { InvariantEntities } from './world.ts';
import type { IsoDate } from '../dates/index.ts';

type Index = Map<EntityId, Entity>;

function indexByLevel(entities: InvariantEntities): Record<Level, Index> {
  return {
    region: new Map(entities.region.map((e) => [e.id, e])),
    province: new Map(entities.province.map((e) => [e.id, e])),
    municipality: new Map(entities.municipality.map((e) => [e.id, e])),
  };
}

export function checkI9(options: {
  entities: InvariantEntities;
  variations: readonly Variation[];
  start: IsoDate;
}): Anomaly[] {
  const { entities, variations, start } = options;
  const anomalies: Anomaly[] = [];
  const index = indexByLevel(entities);
  const referenced = new Set<string>();
  const ref = (level: Level, entityId: EntityId, side: 'before' | 'after', validFrom: IsoDate): string =>
    `${level}|${entityId}|${side}|${validFrom}`;

  for (const variation of variations) {
    const context = { variationId: variation.id, date: variation.date };
    for (const p of variation.participants) {
      const entity = index[p.level].get(p.entityId);
      if (entity === undefined) {
        anomalies.push(
          violation('I9', `variation ${variation.id}: ${p.level} entity ${p.entityId} does not exist`, {
            ...context,
            level: p.level,
            entityId: p.entityId,
          }),
        );
        continue;
      }
      if (p.role === null) continue;
      for (const [side, id] of [
        ['before', p.versionBefore],
        ['after', p.versionAfter],
      ] as const) {
        if (id === null) continue;
        const version = entity.versions.find((v) => v.validFrom === id);
        const boundary = version === undefined ? undefined : side === 'before' ? version.validTo : version.validFrom;
        if (version === undefined || boundary !== variation.date) {
          anomalies.push(
            violation(
              'I9',
              version === undefined
                ? `variation ${variation.id}: ${p.level} entity ${p.entityId} has no version from ${id}`
                : `variation ${variation.id}: ${p.level} version from ${id} does not ${side === 'before' ? 'end' : 'start'} on ${variation.date}`,
              { ...context, level: p.level, entityId: p.entityId, side, versionFrom: id },
            ),
          );
          continue;
        }
        referenced.add(ref(p.level, p.entityId, side, id));
      }
    }
    for (const link of variation.links) {
      for (const end of ['from', 'to'] as const) {
        if (index[link.level].has(link[end])) continue;
        anomalies.push(
          violation('I9', `variation ${variation.id}: link ${end} ${link.level} entity ${link[end]} does not exist`, {
            ...context,
            level: link.level,
            entityId: link[end],
            link,
          }),
        );
      }
    }
  }

  for (const level of LEVELS) {
    for (const entity of entities[level] as readonly Entity[]) {
      for (const version of entity.versions) {
        const context = { level, entityId: entity.id, versionFrom: version.validFrom };
        if (version.validFrom !== start && !referenced.has(ref(level, entity.id, 'after', version.validFrom))) {
          anomalies.push(
            violation(
              'I9',
              `${level} entity ${entity.id}: version from ${version.validFrom} is opened by no variation`,
              {
                ...context,
                side: 'after',
                date: version.validFrom,
              },
            ),
          );
        }
        if (version.validTo !== null && !referenced.has(ref(level, entity.id, 'before', version.validFrom))) {
          anomalies.push(
            violation(
              'I9',
              `${level} entity ${entity.id}: version from ${version.validFrom} ending on ${version.validTo} is closed by no variation`,
              {
                ...context,
                side: 'before',
                date: version.validTo,
              },
            ),
          );
        }
      }
    }
  }
  return anomalies;
}

export function checkI10(options: { entities: InvariantEntities; variations: readonly Variation[] }): Anomaly[] {
  const { entities, variations } = options;
  const anomalies: Anomaly[] = [];
  for (const level of LEVELS) {
    for (const entity of entities[level] as readonly Entity[]) {
      for (const version of entity.versions) {
        if (version.validFrom !== version.validTo) continue;
        anomalies.push(
          violation('I10', `${level} entity ${entity.id}: version from ${version.validFrom} has zero length`, {
            level,
            entityId: entity.id,
            versionFrom: version.validFrom,
            date: version.validFrom,
          }),
        );
      }
    }
  }
  for (const variation of variations) {
    let effects = 0;
    for (const p of variation.participants) {
      if (p.role === null) continue;
      effects += 1;
      const problems = participantRoleViolations({ ...p, role: p.role });
      if (problems.length === 0) continue;
      anomalies.push(
        violation(
          'I10',
          `variation ${variation.id}: ${p.level} participant ${p.entityId} is inconsistent with its role: ${problems.join('; ')}`,
          participantContext(variation, p, problems),
        ),
      );
    }
    if (effects === 0) {
      anomalies.push(
        violation('I10', `variation ${variation.id} (${variation.date}) has no participation with effect`, {
          variationId: variation.id,
          date: variation.date,
        }),
      );
    }
  }
  return anomalies;
}

function participantContext(variation: Variation, p: Participant, problems: string[]): Record<string, unknown> {
  return {
    variationId: variation.id,
    date: variation.date,
    level: p.level,
    entityId: p.entityId,
    role: p.role,
    istatEvents: p.istatEvents,
    versionBefore: p.versionBefore,
    versionAfter: p.versionAfter,
    problems,
  };
}

import { DROP_REASONS, type EventAccount } from '../build/index.ts';
import { containsDate, type IsoDate } from '../dates/index.ts';
import { ABROAD_EVENT_CODES, LEVELS, type Level } from '../model/common.ts';
import type { Anomaly, Entity, Variation } from '../model/internal.ts';
import { violation } from './anomaly.ts';
import type { InvariantEntities } from './world.ts';

export function checkI13(options: {
  entities: InvariantEntities;
  today: IsoDate;
  counts: Record<Level, number>;
}): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const level of LEVELS) {
    const reconstructed = (options.entities[level] as readonly Entity[]).reduce(
      (n, entity) => n + entity.versions.filter((v) => containsDate(v, options.today)).length,
      0,
    );
    const expected = options.counts[level];
    if (reconstructed === expected) continue;
    anomalies.push(
      violation('I13', `${level}: ${reconstructed} versions valid on ${options.today}, SITUAS counts ${expected}`, {
        level,
        date: options.today,
        reconstructed,
        expected,
      }),
    );
  }
  return anomalies;
}

export function checkI14(options: {
  accounts: readonly EventAccount[];
  variations: readonly Variation[];
  variationIdOf: (key: string) => number | undefined;
}): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const ids = new Set(options.variations.map((v) => v.id));
  for (const account of options.accounts) {
    const context = {
      source: account.source,
      index: account.index,
      level: account.level,
      event: account.event,
      date: account.date,
      variation: account.variation,
      dropped: account.dropped,
    };
    const row = `${account.source} row ${account.index} (${account.event} of ${account.date})`;
    if ((account.variation === null) === (account.dropped === null)) {
      anomalies.push(
        violation(
          'I14',
          account.variation === null
            ? `${row} is neither represented in a variation nor dropped`
            : `${row} is both represented in a variation and dropped`,
          context,
        ),
      );
    } else if (account.variation !== null) {
      const id = options.variationIdOf(account.variation);
      if (id === undefined || !ids.has(id)) {
        anomalies.push(
          violation('I14', `${row} refers to the variation ${account.variation}, which does not exist`, context),
        );
      }
    } else if (!(DROP_REASONS as readonly string[]).includes(account.dropped ?? '')) {
      anomalies.push(violation('I14', `${row} is dropped for an unknown reason (${String(account.dropped)})`, context));
    }
  }
  return anomalies;
}

export function checkI15(variations: readonly Variation[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const variation of variations) {
    for (const p of variation.participants) {
      if (p.role === null) continue;
      const hasAbroadEvent = p.istatEvents.some((e) => (ABROAD_EVENT_CODES as readonly string[]).includes(e));
      const context = {
        variationId: variation.id,
        date: variation.date,
        level: p.level,
        entityId: p.entityId,
        role: p.role,
        istatEvents: p.istatEvents,
        abroad: p.abroad,
      };
      if ((p.role === 'ceded' || p.role === 'annexed') && !p.abroad) {
        anomalies.push(
          violation(
            'I15',
            `variation ${variation.id}: ${p.level} participant ${p.entityId} is ${p.role} but not abroad`,
            context,
          ),
        );
      }
      if (p.abroad && !hasAbroadEvent) {
        anomalies.push(
          violation(
            'I15',
            `variation ${variation.id}: ${p.level} participant ${p.entityId} is abroad without an ${ABROAD_EVENT_CODES.join(', ')} event`,
            context,
          ),
        );
      }
    }
  }
  return anomalies;
}

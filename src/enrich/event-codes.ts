/**
 * Checked against the event rules (§4.3, D27). It describes the build, not the sources, so it is
 * written to `<paths.reports>`, never into the store.
 */
import { join } from 'node:path';
import { ISTAT_EVENT_CODES, LEVELS, type IstatEventCode, type Level } from '../model/common.ts';
import { toJsonDocument, writeFileAtomic } from '../store/index.ts';

export type EventCodeSummary = Partial<Record<Level, Partial<Record<IstatEventCode, number>>>>;

const EVENT_CODES_FILE = 'event-codes.json';

export function summariseEventCodes(
  crawls: Partial<
    Record<
      Level,
      { graph: { components: readonly { events: readonly { event: { event: IstatEventCode } }[] }[] } } | null
    >
  >,
): EventCodeSummary {
  const summary: EventCodeSummary = {};
  for (const level of LEVELS) {
    const crawl = crawls[level];
    if (crawl === undefined || crawl === null) continue;
    const counts = new Map<IstatEventCode, number>();
    for (const component of crawl.graph.components) {
      for (const { event } of component.events) counts.set(event.event, (counts.get(event.event) ?? 0) + 1);
    }
    summary[level] = Object.fromEntries(
      ISTAT_EVENT_CODES.flatMap((code) => (counts.has(code) ? [[code, counts.get(code)]] : [])),
    );
  }
  return summary;
}

export async function saveEventCodeSummary(reportsDir: string, summary: EventCodeSummary): Promise<string> {
  const path = join(reportsDir, EVENT_CODES_FILE);
  await writeFileAtomic(path, toJsonDocument(summary));
  return path;
}

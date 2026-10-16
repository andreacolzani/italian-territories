/**
 * It travels with the store, so it survives across CI runs; the workflows fail a run whose sources
 * stay unavailable too long (§10.4).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { compareDates, type IsoDate } from '../dates/index.ts';
import { isoDateSchema } from '../model/public.ts';
import { readTextIfExists, toJsonDocument, writeFileAtomic } from '../store/index.ts';

export const COMPLETE_UPDATE_FILE = 'last-complete-update.json';

const completeUpdateSchema = z.strictObject({ today: isoDateSchema });

function completeUpdatePath(storeDir: string): string {
  return join(storeDir, COMPLETE_UPDATE_FILE);
}

export async function loadLastCompleteUpdate(storeDir: string): Promise<IsoDate | null> {
  const text = await readTextIfExists(completeUpdatePath(storeDir));
  return text === undefined ? null : completeUpdateSchema.parse(JSON.parse(text)).today;
}

/** Never moved back by a rebuild with an earlier `--today`. */
export async function recordCompleteUpdate(storeDir: string, today: IsoDate): Promise<IsoDate> {
  const previous = await loadLastCompleteUpdate(storeDir);
  if (previous !== null && compareDates(previous, today) >= 0) return previous;
  await writeFileAtomic(completeUpdatePath(storeDir), toJsonDocument({ today }));
  return today;
}

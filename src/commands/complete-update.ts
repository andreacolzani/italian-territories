/**
 * The last complete update (Step 18): `last-complete-update.json` in the store, the `today` of the
 * last pipeline run (`bootstrap`, `update`, `rebuild`) that ended with exit 0 or 2. The workflows
 * read it from the run summary to fail a run whose sources have been unavailable (exit 3) for too
 * long. It travels with the store, so it survives across CI runs.
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

/** The `today` of the last complete update, or `null` when none is recorded. */
export async function loadLastCompleteUpdate(storeDir: string): Promise<IsoDate | null> {
  const text = await readTextIfExists(completeUpdatePath(storeDir));
  return text === undefined ? null : completeUpdateSchema.parse(JSON.parse(text)).today;
}

/**
 * Records `today` as the last complete update, unless a later date is already recorded (a rebuild
 * with an earlier `--today` never moves it back). Returns the recorded date.
 */
export async function recordCompleteUpdate(storeDir: string, today: IsoDate): Promise<IsoDate> {
  const previous = await loadLastCompleteUpdate(storeDir);
  if (previous !== null && compareDates(previous, today) >= 0) return previous;
  await writeFileAtomic(completeUpdatePath(storeDir), toJsonDocument({ today }));
  return today;
}

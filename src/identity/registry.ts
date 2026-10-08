/**
 * Id registry (§5.3): stable ids for entities and variations, keyed by natural keys and committed
 * in `registry/`. Ids are assigned on first appearance and never reused for another key. New keys
 * of one call get ids in a total, deterministic order that does not depend on the order of the
 * input: entities by first `validFrom`, then first ISTAT code, then natural key; variations by
 * date, then natural key. Versions have no id (D40).
 *
 * - Entity ids (D42) are `<prefix>-<code>`: the code is a 30-bit window of the SHA-256 of
 *   `<level>|<natural key>` (the key with which the entity first enters the registry) in Crockford
 *   base32; window 0, or the next one when the id is already held in the level's registry by
 *   another key. The id is stored and never recomputed: it survives remaps.
 * - Variation ids are positive integers from a `next_id` counter.
 *
 * One file per kind, entries sorted by key:
 * - entities (`regions.json`, `provinces.json`, `municipalities.json`): `{ kind, entries }`, entries
 *   `{ id, members }`, the ISTAT ids of the identity component (§5.1), ascending; empty for `nk:`
 *   keys;
 * - variations (`variations.json`): `{ kind, next_id, entries }`, entries `{ id }`.
 *
 * A key that changes keeps its id, the entry moves to the new key and the correspondence is
 * appended to `remaps.json` (`{ kind, from_key, to_key, id, reason, recorded_on }`; the remaps of
 * one run sorted by kind, then by `from_key`):
 * - `origin-id-available`: an `nk:` entity gains its ISTAT origin id (`istat:<root>`). Not
 *   retroactive: no published field changes.
 * - `root-changed`: an identity component changes root but shares members with an entity already
 *   registered whose key disappeared. Retroactive (`warning`).
 *
 * Re-keying goes from `nk:` to `istat:` only, never back: a registered `istat:` entity whose key
 * disappears while none of its members is in any entity of the run has lost its internal history
 * (e.g. an r6 missing from the store in an offline `rebuild`). That is `internal-data-required`
 * (`blocking`, one per level, every such entity in `context`), never a new `nk:` key with a new id:
 * the blocking anomaly keeps `registry/` and `dist/` unwritten.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, type IsoDate } from '../dates/index.ts';
import { ENTITY_ID_PATTERN, ENTITY_ID_PREFIXES, LEVELS, type EntityId, type Level } from '../model/common.ts';
import { isoDateSchema } from '../model/public.ts';
import { readTextIfExists, toJsonDocument, writeFileAtomic } from '../store/fs.ts';
import { ENTITY_ANOMALIES, type InternalDataCause } from './entities.ts';

export const REGISTRY_KINDS = ['region', 'province', 'municipality', 'variation'] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export const REGISTRY_FILES: Readonly<Record<RegistryKind, string>> = {
  region: 'regions.json',
  province: 'provinces.json',
  municipality: 'municipalities.json',
  variation: 'variations.json',
};
export const REMAPS_FILE = 'remaps.json';

export const REMAP_REASONS = ['origin-id-available', 'root-changed'] as const;
export type RemapReason = (typeof REMAP_REASONS)[number];

const intId = z.int().positive();
const entityIdSchema = z.string().regex(ENTITY_ID_PATTERN);
const entityEntry = z.strictObject({
  id: entityIdSchema,
  members: z.array(intId).refine((m) => m.every((v, i) => i === 0 || (m[i - 1] ?? 0) < v), 'members must ascend'),
});
const variationEntry = z.strictObject({ id: intId });

export type EntityEntry = z.output<typeof entityEntry>;
export type VariationEntry = z.output<typeof variationEntry>;
type Entry = EntityEntry | VariationEntry;
/** The fields of an entry besides its id (none for variations). */
type EntryData = Partial<Pick<EntityEntry, 'members'>>;

function isEntityKind(kind: RegistryKind): kind is Level {
  return (LEVELS as readonly string[]).includes(kind);
}

function uniqueIds(entries: Readonly<Record<string, Entry>>, ctx: z.RefinementCtx): void {
  const seen = new Map<number | string, string>();
  for (const [key, entry] of Object.entries(entries)) {
    const other = seen.get(entry.id);
    if (other !== undefined) ctx.addIssue({ code: 'custom', message: `id ${entry.id} of ${other} and ${key}` });
    seen.set(entry.id, key);
  }
}

function fileSchema(kind: RegistryKind): z.ZodType<{ next_id?: number; entries: Record<string, Entry> }> {
  if (isEntityKind(kind)) {
    const prefix = `${ENTITY_ID_PREFIXES[kind]}-`;
    return z
      .strictObject({ kind: z.literal(kind), entries: z.record(z.string().min(1), entityEntry) })
      .superRefine((file, ctx) => {
        uniqueIds(file.entries, ctx);
        for (const [key, entry] of Object.entries(file.entries)) {
          if (!entry.id.startsWith(prefix)) ctx.addIssue({ code: 'custom', message: `id ${entry.id} of ${key}` });
        }
      });
  }
  return z
    .strictObject({ kind: z.literal(kind), next_id: intId, entries: z.record(z.string().min(1), variationEntry) })
    .superRefine((file, ctx) => {
      uniqueIds(file.entries, ctx);
      for (const [key, entry] of Object.entries(file.entries)) {
        if (entry.id >= file.next_id) ctx.addIssue({ code: 'custom', message: `id ${entry.id} of ${key} ≥ next_id` });
      }
    });
}

const remapSchema = z.strictObject({
  kind: z.enum(REGISTRY_KINDS),
  from_key: z.string().min(1),
  to_key: z.string().min(1),
  id: z.union([entityIdSchema, intId]),
  reason: z.enum(REMAP_REASONS),
  recorded_on: isoDateSchema,
});
export type Remap = z.output<typeof remapSchema>;

/** A remap recorded by this run, with its classification (§10.2). */
export interface RunRemap extends Remap {
  retroactive: boolean;
}

/** Crockford base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const WINDOW_BITS = 30;
/** Number of whole 30-bit windows in a SHA-256 digest. */
export const ID_WINDOWS = Math.floor(256 / WINDOW_BITS);

/**
 * The candidate entity id of `key` at `level` in `window` (§5.3, D42): bits
 * `[30·window, 30·window + 30)` of the SHA-256 of `<level>|<key>`, most significant bit first,
 * as 6 Crockford base32 characters after the level's prefix.
 */
export function candidateEntityId(level: Level, key: string, window: number): EntityId {
  if (!Number.isInteger(window) || window < 0 || window >= ID_WINDOWS) throw new RangeError(`window ${window}`);
  const digest = createHash('sha256').update(`${level}|${key}`, 'utf8').digest();
  let code = '';
  for (let c = 0; c < WINDOW_BITS / 5; c++) {
    let value = 0;
    for (let b = 0; b < 5; b++) {
      const bit = window * WINDOW_BITS + c * 5 + b;
      value = (value << 1) | (((digest[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    }
    code += CROCKFORD.charAt(value);
  }
  return `${ENTITY_ID_PREFIXES[level]}-${code}`;
}

export interface Assignment<Id extends number | string = number | string> {
  /** Natural key → id, for every key given. */
  ids: Map<string, Id>;
  /** Keys that changed in this call. */
  remaps: RunRemap[];
  retroactive: boolean;
}

export interface AssignOptions {
  /** Date of the run (`dates.today`), recorded in `remaps.json`. */
  recordedOn: IsoDate;
  anomalies: AnomalyCollector;
  /** Why the level's internal data is incomplete, for `internal-data-required` (default `absent`). */
  internalCause?: InternalDataCause;
}

/** An entity to register (a resolved entity, §6.7). */
export interface EntityKeyInput {
  key: string;
  /** `nk:` key of the entity, equal to `key` when it has no ISTAT origin id. */
  fallbackKey: string;
  members: readonly number[];
  /** Start and ISTAT code of the entity's first interval (assignment order). */
  firstValidFrom: IsoDate;
  firstCode: string;
}

/** A variation to register: its natural key and date (assignment order). */
export interface VariationKeyInput {
  key: string;
  date: IsoDate;
}

export const REGISTRY_ANOMALIES = {
  rootChanged: 'registry-root-changed',
  originIdAvailable: 'registry-origin-id-available',
} as const;

/** The registry on disk is unreadable or inconsistent. */
export class RegistryError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (${path})`);
    this.name = 'RegistryError';
    this.path = path;
  }
}

export function entityKind(level: Level): RegistryKind {
  return level;
}

interface RegistryFile {
  /** Variations only: the next integer id. */
  next_id: number;
  entries: Map<string, Entry>;
}

export class Registry {
  readonly #dir: string;
  readonly #files: Map<RegistryKind, RegistryFile>;
  readonly #remaps: Remap[];
  readonly #pending: RunRemap[] = [];

  private constructor(dir: string, files: Map<RegistryKind, RegistryFile>, remaps: Remap[]) {
    this.#dir = dir;
    this.#files = files;
    this.#remaps = remaps;
  }

  static async load(dir: string): Promise<Registry> {
    const files = new Map<RegistryKind, RegistryFile>();
    for (const kind of REGISTRY_KINDS) {
      const path = join(dir, REGISTRY_FILES[kind]);
      const text = await readTextIfExists(path);
      if (text === undefined) continue;
      const parsed = fileSchema(kind).safeParse(parseJson(text, path));
      if (!parsed.success) throw new RegistryError(z.prettifyError(parsed.error), path);
      files.set(kind, { next_id: parsed.data.next_id ?? 1, entries: new Map(Object.entries(parsed.data.entries)) });
    }
    const remapsPath = join(dir, REMAPS_FILE);
    const remapsText = await readTextIfExists(remapsPath);
    let remaps: Remap[] = [];
    if (remapsText !== undefined) {
      const parsed = z.array(remapSchema).safeParse(parseJson(remapsText, remapsPath));
      if (!parsed.success) throw new RegistryError(z.prettifyError(parsed.error), remapsPath);
      remaps = parsed.data;
    }
    return new Registry(dir, files, remaps);
  }

  /** Every recorded remap, those of this run included (appended on save). */
  get remaps(): readonly Remap[] {
    return [...this.#remaps, ...sortRemaps(this.#pending)];
  }

  /** Remaps recorded by this run. */
  get runRemaps(): readonly RunRemap[] {
    return sortRemaps(this.#pending);
  }

  /** Whether this run changed a key retroactively (§10.2). */
  get retroactive(): boolean {
    return this.#pending.some((r) => r.retroactive);
  }

  /** The id of an entity key of `level`, if registered. */
  entityId(level: Level, key: string): EntityId | undefined {
    const id = this.#files.get(level)?.entries.get(key)?.id;
    return typeof id === 'string' ? id : undefined;
  }

  /** The id of a variation key, if registered. */
  variationId(key: string): number | undefined {
    const id = this.#files.get('variation')?.entries.get(key)?.id;
    return typeof id === 'number' ? id : undefined;
  }

  /** Ids of the entities of `level` (§5.3: `istat:<root>`, fallback `nk:…`). */
  assignEntities(level: Level, entities: readonly EntityKeyInput[], options: AssignOptions): Assignment<EntityId> {
    const kind = entityKind(level);
    const file = this.#file(kind);
    const produced = new Set(entities.map((e) => e.key));
    const run = this.#run(kind, options);
    const fresh: EntityKeyInput[] = [];
    for (const e of unique(entities, (e) => e.key).sort(compareEntityInputs)) {
      if (file.entries.has(e.key)) run.keep(e.key, { members: sortedMembers(e.members) });
      else fresh.push(e);
    }
    for (const e of fresh) {
      const members = sortedMembers(e.members);
      const available = (key: string): boolean => file.entries.has(key) && !produced.has(key) && !run.claimed(key);
      if (e.key !== e.fallbackKey && available(e.fallbackKey)) {
        run.move(e.fallbackKey, e.key, { members }, 'origin-id-available', false);
        continue;
      }
      const previous = e.key.startsWith('istat:')
        ? [...file.entries]
            .filter(([key, entry]) => key.startsWith('istat:') && available(key) && sharesMember(entry, members))
            .sort(([a], [b]) => compareStrings(a, b))
        : [];
      const [match] = previous;
      if (match === undefined) run.create(e.key, { members });
      else run.move(match[0], e.key, { members }, 'root-changed', true, { candidates: previous.map(([k]) => k) });
    }
    this.#reportLostHistories(level, file.entries, entities, run, options);
    return run.result() as Assignment<EntityId>;
  }

  /** Registered `istat:` entities of `level` with no member in any entity of the run (see above). */
  #reportLostHistories(
    level: Level,
    entries: ReadonlyMap<string, Entry>,
    entities: readonly EntityKeyInput[],
    run: { claimed: (key: string) => boolean },
    { anomalies, internalCause = 'absent' }: AssignOptions,
  ): void {
    const produced = new Set(entities.map((e) => e.key));
    const members = new Set(entities.flatMap((e) => e.members));
    const lost = [...entries]
      .flatMap(([key, entry]) => {
        if (!key.startsWith('istat:') || produced.has(key) || run.claimed(key)) return [];
        const { id, members: registered } = entry as EntityEntry;
        return registered.some((m) => members.has(m)) ? [] : [{ key, id, members: registered }];
      })
      .sort((a, b) => compareStrings(a.key, b.key));
    if (lost.length === 0) return;
    anomalies.add({
      level: 'blocking',
      code: ENTITY_ANOMALIES.internalDataRequired,
      message:
        `${lost.length} registered ${level} entities have no internal history in this run ` +
        `(${lost
          .slice(0, 5)
          .map((l) => `${l.key} id ${l.id}`)
          .join(', ')}${lost.length > 5 ? ', …' : ''}): ` +
        'their ids cannot be kept without it',
      context: { level, cause: internalCause, count: lost.length, entities: lost },
    });
  }

  /** Ids of variations (§5.3: `act:…`, `nk:…`, `inferred:…`). */
  assignVariations(variations: readonly VariationKeyInput[], options: AssignOptions): Assignment<number> {
    const file = this.#file('variation');
    const run = this.#run('variation', options);
    const sorted = unique(variations, (v) => v.key).sort(
      (a, b) => compareDates(a.date, b.date) || compareStrings(a.key, b.key),
    );
    for (const { key } of sorted) {
      if (file.entries.has(key)) run.keep(key, {});
      else run.create(key, {});
    }
    return run.result() as Assignment<number>;
  }

  /** Writes every kind in use and appends this run's remaps; same content, same bytes. */
  async save(): Promise<void> {
    for (const kind of REGISTRY_KINDS) {
      const file = this.#files.get(kind);
      if (file === undefined) continue;
      const entries = Object.fromEntries(
        [...file.entries].sort(([a], [b]) => compareStrings(a, b)).map(([key, entry]) => [key, entry]),
      );
      await writeFileAtomic(
        join(this.#dir, REGISTRY_FILES[kind]),
        toJsonDocument(isEntityKind(kind) ? { kind, entries } : { kind, next_id: file.next_id, entries }),
      );
    }
    if (this.#pending.length > 0) {
      this.#remaps.push(...sortRemaps(this.#pending).map(withoutClassification));
      this.#pending.length = 0;
    }
    if (this.#remaps.length > 0) await writeFileAtomic(join(this.#dir, REMAPS_FILE), toJsonDocument(this.#remaps));
  }

  #file(kind: RegistryKind): RegistryFile {
    let file = this.#files.get(kind);
    if (file === undefined) {
      file = { next_id: 1, entries: new Map() };
      this.#files.set(kind, file);
    }
    return file;
  }

  #run(kind: RegistryKind, options: AssignOptions): Run {
    return new Run(kind, this.#file(kind), options, (remap) => this.#pending.push(remap));
  }
}

/** One assignment call: entries kept, moved or created, and the remaps it produced. */
class Run {
  readonly #onRemap: (remap: RunRemap) => void;
  readonly #kind: RegistryKind;
  readonly #file: RegistryFile;
  readonly #options: AssignOptions;
  readonly #ids = new Map<string, number | string>();
  readonly #claimed = new Set<string>();
  readonly #remaps: RunRemap[] = [];

  constructor(kind: RegistryKind, file: RegistryFile, options: AssignOptions, onRemap: (remap: RunRemap) => void) {
    this.#onRemap = onRemap;
    this.#kind = kind;
    this.#file = file;
    this.#options = options;
  }

  claimed(key: string): boolean {
    return this.#claimed.has(key);
  }

  keep(key: string, data: EntryData): void {
    const entry = this.#file.entries.get(key);
    if (entry === undefined) throw new Error(`${key} is not registered`);
    this.#file.entries.set(key, { id: entry.id, ...data } as Entry);
    this.#ids.set(key, entry.id);
  }

  create(key: string, data: EntryData): void {
    const id = isEntityKind(this.#kind) ? this.#freshEntityId(this.#kind, key) : this.#file.next_id++;
    this.#file.entries.set(key, { id, ...data } as Entry);
    this.#ids.set(key, id);
  }

  /** The first window of the key's hash whose id no other entry of the level holds (D42). */
  #freshEntityId(level: Level, key: string): EntityId {
    const taken = new Set([...this.#file.entries.values()].map((e) => e.id));
    for (let window = 0; window < ID_WINDOWS; window++) {
      const id = candidateEntityId(level, key, window);
      if (!taken.has(id)) return id;
    }
    throw new RegistryError(`every id window of ${level} key ${key} is taken`, REGISTRY_FILES[level]);
  }

  move(
    from: string,
    to: string,
    data: EntryData,
    reason: RemapReason,
    retroactive: boolean,
    context: Record<string, unknown> = {},
  ): void {
    const entry = this.#file.entries.get(from);
    if (entry === undefined) throw new Error(`${from} is not registered`);
    this.#file.entries.delete(from);
    this.#file.entries.set(to, { id: entry.id, ...data } as Entry);
    this.#claimed.add(from);
    this.#ids.set(to, entry.id);
    const remap: RunRemap = {
      kind: this.#kind,
      from_key: from,
      to_key: to,
      id: entry.id,
      reason,
      recorded_on: this.#options.recordedOn,
      retroactive,
    };
    this.#remaps.push(remap);
    this.#onRemap(remap);
    this.#options.anomalies.add({
      level: retroactive ? 'warning' : 'info',
      code: reason === 'root-changed' ? REGISTRY_ANOMALIES.rootChanged : REGISTRY_ANOMALIES.originIdAvailable,
      message: `${this.#kind} ${from} → ${to} keeps id ${entry.id} (${reason})`,
      context: { kind: this.#kind, from_key: from, to_key: to, id: entry.id, reason, retroactive, ...context },
    });
  }

  result(): Assignment {
    return { ids: this.#ids, remaps: this.#remaps, retroactive: this.#remaps.some((r) => r.retroactive) };
  }
}

/** The input without duplicate keys; a duplicate natural key in one call is a bug of the caller. */
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) throw new Error(`duplicate natural key ${k}`);
    seen.add(k);
  }
  return [...items];
}

function compareEntityInputs(a: EntityKeyInput, b: EntityKeyInput): number {
  return (
    compareDates(a.firstValidFrom, b.firstValidFrom) ||
    compareStrings(a.firstCode, b.firstCode) ||
    compareStrings(a.key, b.key)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function withoutClassification(remap: RunRemap): Remap {
  const { kind, from_key, to_key, id, reason, recorded_on } = remap;
  return { kind, from_key, to_key, id, reason, recorded_on };
}

function sortedMembers(members: readonly number[]): number[] {
  return [...new Set(members)].sort((a, b) => a - b);
}

function sharesMember(entry: Entry, members: readonly number[]): boolean {
  return 'members' in entry && entry.members.some((m) => members.includes(m));
}

function sortRemaps<R extends Remap>(remaps: readonly R[]): R[] {
  return [...remaps].sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.from_key, b.from_key));
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RegistryError(`invalid JSON: ${(error as Error).message}`, path);
  }
}

/**
 * Id registry (§5.3): stable integer ids for entities, versions and variations, keyed by natural
 * keys and committed in `registry/`. Ids are assigned on first appearance and never reused for
 * another key. New keys of one call get ids in a total, deterministic order that does not depend
 * on the order of the input: entities by first `validFrom`, then first ISTAT code, then natural
 * key; versions by `validFrom`, then entity id; variations by date, then natural key.
 *
 * One file per kind, `{ kind, next_id, entries }`, entries sorted by key:
 * - entities (`regions.json`, `provinces.json`, `municipalities.json`): `{ id, members }`, the ISTAT
 *   ids of the identity component (§5.1), ascending; empty for `nk:` keys;
 * - versions (`<level>-versions.json`): `{ id, valid_to }`, the half-open end of the version;
 * - variations (`variations.json`): `{ id }`.
 *
 * A key that changes keeps its id, the entry moves to the new key and the correspondence is
 * appended to `remaps.json` (`{ kind, from_key, to_key, id, reason, recorded_on }`; the remaps of
 * one run sorted by kind, then by `from_key`):
 * - `origin-id-available`: an `nk:` entity gains its ISTAT origin id (`istat:<root>`). Not
 *   retroactive: only `istat_origin_id` changes, which is not a dated field.
 * - `root-changed`: an identity component changes root but shares members with an entity already
 *   registered whose key disappeared. Retroactive (`warning`).
 * - `key-moved`: a version key disappears and the same entity gets a new key whose interval
 *   overlaps it. Retroactive (`warning`).
 */
import { join } from 'node:path';
import { z } from 'zod';
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, overlaps, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type { Level } from '../model/common.ts';
import { isoDateSchema } from '../model/public.ts';
import { readTextIfExists, toJsonDocument, writeFileAtomic } from '../store/fs.ts';

export const REGISTRY_KINDS = [
  'region',
  'province',
  'municipality',
  'region-version',
  'province-version',
  'municipality-version',
  'variation',
] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export const REGISTRY_FILES: Readonly<Record<RegistryKind, string>> = {
  region: 'regions.json',
  province: 'provinces.json',
  municipality: 'municipalities.json',
  'region-version': 'region-versions.json',
  'province-version': 'province-versions.json',
  'municipality-version': 'municipality-versions.json',
  variation: 'variations.json',
};
export const REMAPS_FILE = 'remaps.json';

export const REMAP_REASONS = ['origin-id-available', 'root-changed', 'key-moved'] as const;
export type RemapReason = (typeof REMAP_REASONS)[number];

const id = z.int().positive();
const entityEntry = z.strictObject({
  id,
  members: z.array(id).refine((m) => m.every((v, i) => i === 0 || (m[i - 1] ?? 0) < v), 'members must ascend'),
});
const versionEntry = z.strictObject({ id, valid_to: isoDateSchema.nullable() });
const variationEntry = z.strictObject({ id });

export type EntityEntry = z.output<typeof entityEntry>;
export type VersionEntry = z.output<typeof versionEntry>;
export type VariationEntry = z.output<typeof variationEntry>;
type Entry = EntityEntry | VersionEntry | VariationEntry;
/** The fields of an entry besides its id (none for variations). */
type EntryData = Partial<Pick<EntityEntry, 'members'> & Pick<VersionEntry, 'valid_to'>>;

function entrySchema(kind: RegistryKind): z.ZodType<Entry> {
  if (kind === 'variation') return variationEntry;
  return kind.endsWith('-version') ? versionEntry : entityEntry;
}

function fileSchema(kind: RegistryKind) {
  return z
    .strictObject({ kind: z.literal(kind), next_id: id, entries: z.record(z.string().min(1), entrySchema(kind)) })
    .superRefine((file, ctx) => {
      const seen = new Map<number, string>();
      for (const [key, entry] of Object.entries(file.entries)) {
        const other = seen.get(entry.id);
        if (other !== undefined) ctx.addIssue({ code: 'custom', message: `id ${entry.id} of ${other} and ${key}` });
        seen.set(entry.id, key);
        if (entry.id >= file.next_id) ctx.addIssue({ code: 'custom', message: `id ${entry.id} of ${key} ≥ next_id` });
      }
    });
}

const remapSchema = z.strictObject({
  kind: z.enum(REGISTRY_KINDS),
  from_key: z.string().min(1),
  to_key: z.string().min(1),
  id,
  reason: z.enum(REMAP_REASONS),
  recorded_on: isoDateSchema,
});
export type Remap = z.output<typeof remapSchema>;

/** A remap recorded by this run, with its classification (§10.2). */
export interface RunRemap extends Remap {
  retroactive: boolean;
}

export interface Assignment {
  /** Natural key → id, for every key given. */
  ids: Map<string, number>;
  /** Keys that changed in this call. */
  remaps: RunRemap[];
  retroactive: boolean;
}

export interface AssignOptions {
  /** Date of the run (`dates.today`), recorded in `remaps.json`. */
  recordedOn: IsoDate;
  anomalies: AnomalyCollector;
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

export interface VersionKeyInput extends HalfOpenInterval {
  entityId: number;
}

export const REGISTRY_ANOMALIES = {
  rootChanged: 'registry-root-changed',
  keyMoved: 'registry-key-moved',
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

export function versionKey(entityId: number, validFrom: IsoDate): string {
  return `${entityId}:${validFrom}`;
}

export function entityKind(level: Level): RegistryKind {
  return level;
}

export function versionKind(level: Level): RegistryKind {
  return `${level}-version`;
}

interface RegistryFile {
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
      files.set(kind, { next_id: parsed.data.next_id, entries: new Map(Object.entries(parsed.data.entries)) });
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

  /** The id of a key, if registered. */
  get(kind: RegistryKind, key: string): number | undefined {
    return this.#files.get(kind)?.entries.get(key)?.id;
  }

  /** Ids of the entities of `level` (§5.3: `istat:<root>`, fallback `nk:…`). */
  assignEntities(level: Level, entities: readonly EntityKeyInput[], options: AssignOptions): Assignment {
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
            .sort(([, a], [, b]) => a.id - b.id)
        : [];
      const [match] = previous;
      if (match === undefined) run.create(e.key, { members });
      else run.move(match[0], e.key, { members }, 'root-changed', true, { candidates: previous.map(([k]) => k) });
    }
    return run.result();
  }

  /** Ids of the versions of `level` (§5.3: `<entity id>:<validFrom>`), with the moved-key rule. */
  assignVersions(level: Level, versions: readonly VersionKeyInput[], options: AssignOptions): Assignment {
    const kind = versionKind(level);
    const file = this.#file(kind);
    const keyed = unique(
      versions.map((v) => ({ ...v, key: versionKey(v.entityId, v.validFrom) })),
      (v) => v.key,
    ).sort((a, b) => compareDates(a.validFrom, b.validFrom) || a.entityId - b.entityId);
    const produced = new Set(keyed.map((v) => v.key));
    const run = this.#run(kind, options);
    const fresh: typeof keyed = [];
    for (const v of keyed) {
      if (file.entries.has(v.key)) run.keep(v.key, { valid_to: v.validTo });
      else fresh.push(v);
    }
    for (const v of fresh) {
      const prefix = `${v.entityId}:`;
      const candidates = [...file.entries]
        .flatMap(([key, entry]) => {
          if (!key.startsWith(prefix) || produced.has(key) || run.claimed(key)) return [];
          const old = { validFrom: key.slice(prefix.length), validTo: (entry as VersionEntry).valid_to };
          return overlaps(old, v) ? [{ key, validFrom: old.validFrom }] : [];
        })
        .sort((a, b) => compareDates(a.validFrom, b.validFrom));
      const [match] = candidates;
      if (match === undefined) run.create(v.key, { valid_to: v.validTo });
      else run.move(match.key, v.key, { valid_to: v.validTo }, 'key-moved', true);
    }
    return run.result();
  }

  /** Ids of variations (§5.3: `act:…`, `nk:…`, `inferred:…`). */
  assignVariations(variations: readonly VariationKeyInput[], options: AssignOptions): Assignment {
    const file = this.#file('variation');
    const run = this.#run('variation', options);
    const sorted = unique(variations, (v) => v.key).sort(
      (a, b) => compareDates(a.date, b.date) || compareStrings(a.key, b.key),
    );
    for (const { key } of sorted) {
      if (file.entries.has(key)) run.keep(key, {});
      else run.create(key, {});
    }
    return run.result();
  }

  /** Writes every kind in use and appends this run's remaps; same content, same bytes. */
  async save(): Promise<void> {
    for (const kind of REGISTRY_KINDS) {
      const file = this.#files.get(kind);
      if (file === undefined) continue;
      const entries = Object.fromEntries(
        [...file.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, entry]),
      );
      await writeFileAtomic(
        join(this.#dir, REGISTRY_FILES[kind]),
        toJsonDocument({ kind, next_id: file.next_id, entries }),
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
  readonly #ids = new Map<string, number>();
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
    this.#file.entries.set(key, { id: entry.id, ...data });
    this.#ids.set(key, entry.id);
  }

  create(key: string, data: EntryData): void {
    const id = this.#file.next_id++;
    this.#file.entries.set(key, { id, ...data });
    this.#ids.set(key, id);
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
    this.#file.entries.set(to, { id: entry.id, ...data });
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
    const code =
      reason === 'key-moved'
        ? REGISTRY_ANOMALIES.keyMoved
        : reason === 'root-changed'
          ? REGISTRY_ANOMALIES.rootChanged
          : REGISTRY_ANOMALIES.originIdAvailable;
    this.#options.anomalies.add({
      level: retroactive ? 'warning' : 'info',
      code,
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

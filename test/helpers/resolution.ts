/**
 * The resolution to the current territory of §7 (D45), computed from the public files only: what a
 * user of the dataset does with a stored reference to an entity.
 */

interface PublicEntity {
  id: string;
  status: string;
  is_former_italian: boolean;
  successors: readonly { id: string }[];
  current_successors: readonly string[];
}

export type Resolution =
  | { kind: 'current'; id: string }
  | { kind: 'automatic'; id: string }
  | { kind: 'supervision'; reason: 'former-italian' | 'several-current-successors' | 'former-italian-successor' };

/**
 * `current` for an active entity; `automatic` only with exactly one current successor and no
 * former Italian successor, direct or indirect; `supervision` otherwise.
 */
export function resolve(entities: readonly PublicEntity[], id: string): Resolution {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const entity = byId.get(id);
  if (entity === undefined) throw new Error(`no entity ${id}`);
  if (entity.status === 'active') return { kind: 'current', id };
  if (entity.is_former_italian) return { kind: 'supervision', reason: 'former-italian' };
  const [only, ...others] = entity.current_successors;
  if (only === undefined || others.length > 0) return { kind: 'supervision', reason: 'several-current-successors' };
  const seen = new Set<string>([id]);
  const queue = entity.successors.map((l) => l.id);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    const successor = byId.get(next);
    if (successor === undefined) continue;
    if (successor.is_former_italian) return { kind: 'supervision', reason: 'former-italian-successor' };
    queue.push(...successor.successors.map((l) => l.id));
  }
  return { kind: 'automatic', id: only };
}

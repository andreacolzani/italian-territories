/** Invariants (§8.1): independent checks returning their violations as `blocking` anomalies. */
export { INVARIANT_IDS, invariantCode, type InvariantId } from './anomaly.ts';
export * from './check.ts';
export * from './errors.ts';
export * from './i1-i3-versions.ts';
export * from './i4-i5-parents.ts';
export * from './i6-uniqueness.ts';
export * from './i7-code-prefix.ts';
export * from './i8-abbreviation.ts';
export * from './i9-i10-variations.ts';
export * from './i11-derived.ts';
export * from './i12-reconstruction.ts';
export * from './i13-i15.ts';
export * from './snapshot-sets.ts';
export * from './world.ts';

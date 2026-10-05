/**
 * Deterministic formatting of the published files (§6.12): keys in the order the objects are built
 * (the order of the public models), 2-space indentation, trailing newline; written as UTF-8 without
 * BOM.
 */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

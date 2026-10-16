export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

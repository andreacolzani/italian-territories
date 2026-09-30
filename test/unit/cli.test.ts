import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe('cli', () => {
  it('prints help listing every command', async () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      const { io, out } = capture();
      expect(await main(argv, io)).toBe(0);
      const text = out.join('');
      for (const name of [
        'bootstrap',
        'update',
        'rebuild [--refetch]',
        'audit [--samples N]',
        'validate',
        'diff <from> <to>',
      ]) {
        expect(text).toContain(name);
      }
    }
  });

  it('rejects unknown commands, options and wrong arity', async () => {
    expect(await main(['nope'], capture().io)).toBe(1);
    expect(await main(['rebuild', '--bogus'], capture().io)).toBe(1);
    expect(await main(['diff', 'a'], capture().io)).toBe(1);
  });

  it('stubs report not implemented', async () => {
    const { io, err } = capture();
    expect(await main(['diff', 'a', 'b'], io)).toBe(2);
    expect(err.join('')).toContain('not implemented');
  });
});

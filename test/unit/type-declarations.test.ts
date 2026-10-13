/**
 * TypeScript declarations of the published files (§9), generated from the JSON Schemas for the
 * npm package: they must describe exactly the public zod models.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateJsonSchema, PUBLIC_FILE_MODELS, type PublicFileName } from '../../src/model/json-schema.ts';
import { TypeDeclarationError, typeDeclarations } from '../../src/model/typescript.ts';
import { NODE_NEXT, typeErrors } from '../helpers/typescript.ts';

const PUBLIC = join(import.meta.dirname, '..', '..', 'src', 'model', 'public.ts');
const NAMES = Object.keys(PUBLIC_FILE_MODELS) as PublicFileName[];

/** Generated type → the public model type it must equal (`P` is `src/model/public.ts`). */
const ALIGNED: Record<PublicFileName, Record<string, string>> = {
  regions: { Regions: 'P.Region[]', Region: 'P.Region', RegionVersion: 'P.RegionVersion', Link: 'P.EntityLink' },
  provinces: {
    Provinces: 'P.Province[]',
    Province: 'P.Province',
    ProvinceVersion: 'P.ProvinceVersion',
    Link: 'P.EntityLink',
  },
  municipalities: {
    Municipalities: 'P.Municipality[]',
    Municipality: 'P.Municipality',
    MunicipalityVersion: 'P.MunicipalityVersion',
    Link: 'P.EntityLink',
  },
};

const EQUAL = 'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;';

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe('type declarations of the published files', () => {
  it('are exactly the public models, for import (.d.mts) and require (.d.cts)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'it-types-'));
    dirs.push(dir);
    const relativePublic = relative(dir, PUBLIC).split(sep).join('/');
    const publicModule = isAbsolute(relativePublic) ? relativePublic : `./${relativePublic}`;
    const esm = [`import type * as P from '${publicModule}';`, EQUAL];
    const cjs = [`import type * as P from '${publicModule}';`, EQUAL];
    for (const name of NAMES) {
      const schema = generateJsonSchema(name);
      await writeFile(join(dir, `${name}.d.mts`), typeDeclarations(name, schema, 'esm'));
      await writeFile(join(dir, `${name}.d.cts`), typeDeclarations(name, schema, 'cjs'));
      const [fileType, fileModel] = Object.entries(ALIGNED[name])[0] ?? ['', ''];
      esm.push(
        `import type * as ${name}Types from './${name}.mjs';`,
        `import type ${name} from './${name}.mjs';`,
        `export const ${name}Value: Equal<typeof ${name}, ${fileModel}> = true;`,
      );
      cjs.push(
        `import ${name} = require('./${name}.cjs');`,
        `export const ${name}Value: Equal<typeof ${name}, ${name}.${fileType}> = true;`,
      );
      for (const [type, model] of Object.entries(ALIGNED[name])) {
        esm.push(`export const ${name}${type}: Equal<${name}Types.${type}, ${model}> = true;`);
        cjs.push(`export const ${name}${type}: Equal<${name}.${type}, ${model}> = true;`);
      }
    }
    await writeFile(join(dir, 'check.mts'), [...esm, ''].join('\n'));
    await writeFile(join(dir, 'check.cts'), [...cjs, ''].join('\n'));
    const files = [join(dir, 'check.mts'), join(dir, 'check.cts')];
    expect(typeErrors(files, { ...NODE_NEXT, allowImportingTsExtensions: true })).toEqual([]);
  });

  it('detect a declaration that differs from the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'it-types-'));
    dirs.push(dir);
    const relativePublic = relative(dir, PUBLIC).split(sep).join('/');
    const publicModule = isAbsolute(relativePublic) ? relativePublic : `./${relativePublic}`;
    const text = typeDeclarations('regions', generateJsonSchema('regions'), 'esm');
    await writeFile(join(dir, 'regions.d.mts'), text.replace('valid_until: string | null;', 'valid_until: string;'));
    await writeFile(
      join(dir, 'check.mts'),
      [
        `import type * as P from '${publicModule}';`,
        `import type * as R from './regions.mjs';`,
        EQUAL,
        'export const version: Equal<R.RegionVersion, P.RegionVersion> = true;',
        '',
      ].join('\n'),
    );
    expect(typeErrors([join(dir, 'check.mts')], { ...NODE_NEXT, allowImportingTsExtensions: true })).not.toEqual([]);
  });

  it('describe each definition with its documentation', () => {
    const text = typeDeclarations('municipalities', generateJsonSchema('municipalities'), 'esm');
    expect(text).toContain('export interface MunicipalityVersion {');
    expect(text).toContain('  valid_until: string | null;');
    expect(text).toContain('Last day the version is valid (inclusive); null if current.');
    expect(text).toContain('  kind: "merged_into" | "split_into" | "detached_into";');
    expect(text).toMatch(/declare const municipalities: Municipalities;\nexport default municipalities;\n$/);
    const cjs = typeDeclarations('municipalities', generateJsonSchema('municipalities'), 'cjs');
    expect(cjs).toMatch(/declare const municipalities: municipalities\.Municipalities;\nexport = municipalities;\n$/);
  });

  it('refuse schema constructs they do not know', () => {
    const schema = { type: 'array', title: 'Things', items: { $ref: '#/$defs/Thing' } };
    const thing = (property: object) => ({
      ...schema,
      $defs: { Thing: { type: 'object', properties: { x: property }, required: ['x'] } },
    });
    expect(typeDeclarations('things', thing({ type: 'string' }), 'esm')).toContain('  x: string;');
    expect(() => typeDeclarations('things', thing({ type: 'integer' }), 'esm')).toThrow(TypeDeclarationError);
    expect(() => typeDeclarations('things', thing({ type: 'string', const: 'a' }), 'esm')).toThrow(/const/);
    expect(() => typeDeclarations('things', thing({ oneOf: [] }), 'esm')).toThrow(TypeDeclarationError);
    expect(() => typeDeclarations('things', { ...schema, type: 'object' }, 'esm')).toThrow(/array/);
  });
});

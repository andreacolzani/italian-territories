/**
 * Declarations for `import` (`.d.mts`, default export) and `require` (`.d.cts`, `export =`), mapped by
 * the `types` condition of the package's `exports`. Only the constructs the published schemas use are
 * supported: anything else throws, so a schema change cannot silently produce wrong declarations.
 */
import type { JsonSchema } from './json-schema.ts';

const DEF_REF = /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const VALUE_KEYWORDS = new Set([
  'description',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'additionalProperties',
  'required',
  'title',
]);

export class TypeDeclarationError extends Error {
  override name = 'TypeDeclarationError';
}

export type DeclarationFlavour = 'esm' | 'cjs';

/** `name` without extension. */
export function typeDeclarations(name: string, schema: JsonSchema, flavour: DeclarationFlavour): string {
  const title = stringOf(schema.title, `${name}: title`);
  if (!IDENTIFIER.test(title)) throw new TypeDeclarationError(`${name}: title ${title} is not a valid type name`);
  const items = record(schema.items, `${name}: items`);
  if (schema.type !== 'array') throw new TypeDeclarationError(`${name}: the file schema must be an array`);
  const defs = record(schema.$defs ?? {}, `${name}: $defs`);
  const variable = camelCase(name);
  const types = [
    ...Object.entries(defs).flatMap(([def, body]) => [...declaration(def, record(body, def)), '']),
    `/** The content of \`${name}.json\`. */`,
    `export type ${title} = ${arrayOf(typeOf(items, `${name}: items`))};`,
  ];
  const header = [`// Generated from schema/${name}.schema.json by italian-territories: do not edit.`, ''];
  const lines =
    flavour === 'esm'
      ? [...header, ...types, '', `declare const ${variable}: ${title};`, `export default ${variable};`]
      : [
          ...header,
          `declare namespace ${variable} {`,
          ...types.flatMap((block) => block.split('\n')).map((line) => (line === '' ? '' : `  ${line}`)),
          '}',
          '',
          `declare const ${variable}: ${variable}.${title};`,
          `export = ${variable};`,
        ];
  return `${lines.join('\n')}\n`;
}

function declaration(name: string, schema: JsonSchema): string[] {
  if (!IDENTIFIER.test(name)) throw new TypeDeclarationError(`${name}: not a valid type name`);
  const doc = docComment(schema, '');
  if (schema.type !== 'object') return [...doc, `export type ${name} = ${typeOf(schema, name)};`];
  return [...doc, `export interface ${name} ${objectBody(schema, name, '')}`];
}

function objectBody(schema: JsonSchema, path: string, indent: string): string {
  checkKeywords(schema, path, ['type', 'properties']);
  const properties = record(schema.properties ?? {}, `${path}: properties`);
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const inner = `${indent}  `;
  const members = Object.entries(properties).flatMap(([key, value]) => {
    if (!IDENTIFIER.test(key)) throw new TypeDeclarationError(`${path}.${key}: not a valid property name`);
    const property = record(value, `${path}.${key}`);
    const optional = required.has(key) ? '' : '?';
    return [...docComment(property, inner), `${inner}${key}${optional}: ${typeOf(property, `${path}.${key}`, inner)};`];
  });
  return members.length === 0 ? '{}' : `{\n${members.join('\n')}\n${indent}}`;
}

function typeOf(schema: JsonSchema, path: string, indent = ''): string {
  if (typeof schema.$ref === 'string') {
    checkKeywords(schema, path, ['$ref']);
    const match = DEF_REF.exec(schema.$ref);
    if (match?.[1] === undefined) throw new TypeDeclarationError(`${path}: unsupported $ref ${schema.$ref}`);
    return match[1];
  }
  if (Array.isArray(schema.anyOf)) {
    checkKeywords(schema, path, ['anyOf']);
    return schema.anyOf
      .map((member, i) => typeOf(record(member, `${path}[${i}]`), `${path}[${i}]`, indent))
      .join(' | ');
  }
  switch (schema.type) {
    case 'string':
      if (Array.isArray(schema.enum)) {
        checkKeywords(schema, path, ['type', 'enum']);
        return schema.enum.map((v) => JSON.stringify(stringOf(v, `${path}: enum`))).join(' | ');
      }
      checkKeywords(schema, path, ['type']);
      return 'string';
    case 'boolean':
    case 'null':
      checkKeywords(schema, path, ['type']);
      return schema.type;
    case 'array':
      checkKeywords(schema, path, ['type', 'items']);
      return arrayOf(typeOf(record(schema.items, `${path}: items`), `${path}[]`, indent));
    case 'object':
      return objectBody(schema, path, indent);
    default:
      throw new TypeDeclarationError(`${path}: unsupported schema ${JSON.stringify(schema)}`);
  }
}

function arrayOf(type: string): string {
  return /^[A-Za-z0-9_$]+$/.test(type) ? `${type}[]` : `(${type})[]`;
}

/** The `pattern` too, which types cannot express. */
function docComment(schema: JsonSchema, indent: string): string[] {
  const lines: string[] = [];
  if (typeof schema.description === 'string') lines.push(schema.description);
  const pattern = typeof schema.pattern === 'string' ? schema.pattern : patternOfAnyOf(schema);
  if (pattern !== null) lines.push(`Pattern: \`${pattern}\``);
  if (lines.length === 0) return [];
  const safe = lines.map((l) => l.replaceAll('*/', '*\\/'));
  if (safe.length === 1) return [`${indent}/** ${safe[0]} */`];
  return [`${indent}/**`, ...safe.map((l) => `${indent} * ${l}`), `${indent} */`];
}

function patternOfAnyOf(schema: JsonSchema): string | null {
  if (!Array.isArray(schema.anyOf)) return null;
  const patterns = schema.anyOf.flatMap((m) => {
    const member = m as JsonSchema;
    return typeof member.pattern === 'string' ? [member.pattern] : [];
  });
  return patterns.length === 1 ? (patterns[0] ?? null) : null;
}

function checkKeywords(schema: JsonSchema, path: string, structural: readonly string[]): void {
  for (const key of Object.keys(schema)) {
    if (!structural.includes(key) && !VALUE_KEYWORDS.has(key)) {
      throw new TypeDeclarationError(`${path}: unsupported keyword ${key}`);
    }
  }
}

function record(value: unknown, path: string): JsonSchema {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeDeclarationError(`${path}: expected an object`);
  }
  return value as JsonSchema;
}

function stringOf(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeDeclarationError(`${path}: expected a string`);
  return value;
}

function camelCase(name: string): string {
  return name.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Ajv is a dev dependency, tests only. The formats follow the generator's own date rules. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { isIsoDate } from '../../src/dates/index.ts';
import { PUBLIC_FILE_MODELS, schemaFileName, type PublicFileName } from '../../src/model/json-schema.ts';

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export async function publishedSchemaViolations(dir: string): Promise<string[]> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('date', isIsoDate);
  ajv.addFormat('date-time', (value: string) => isIsoDate(DATE_TIME.exec(value)?.[1]));
  const violations: string[] = [];
  for (const name of Object.keys(PUBLIC_FILE_MODELS) as PublicFileName[]) {
    const schema = JSON.parse(await readFile(join(dir, 'schema', schemaFileName(name)), 'utf8')) as object;
    const data = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as unknown;
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      for (const error of (validate.errors ?? []).slice(0, 20)) {
        violations.push(`${name}.json${error.instancePath}: ${error.message ?? error.keyword}`);
      }
    }
  }
  return violations;
}

/** `{ "resultset": [ { "NUM_ROWS": n } ] }`: exactly one row, and zero is a valid count. */
import { z } from 'zod';
import { CONTENT_TYPES, jsonRowsDecoder, ResponseValidationError, type Endpoint } from '../../http/index.ts';
import { integer } from '../normalise.ts';
import type { EventListPfun, SnapshotPfun } from './pfun.ts';

const countRow = z.object({ NUM_ROWS: integer.pipe(z.int().nonnegative()) });

const endpoints = new Map<number, Endpoint<number>>();

export function countEndpoint(pfun: SnapshotPfun | EventListPfun): Endpoint<number> {
  let endpoint = endpoints.get(pfun);
  if (endpoint === undefined) {
    const decodeRows = jsonRowsDecoder({
      contentTypes: CONTENT_TYPES.situasPublic,
      envelope: 'resultset',
      nonEmpty: true,
      row: countRow,
    });
    endpoint = {
      id: `count:pfun-${pfun}`,
      family: 'situas-public-reports',
      timeoutClass: 'default',
      decode: (response) => {
        const rows = decodeRows(response);
        const [row] = rows;
        if (row === undefined || rows.length !== 1) {
          throw new ResponseValidationError(`expected exactly one count row, got ${rows.length}`);
        }
        return row.NUM_ROWS;
      },
    };
    endpoints.set(pfun, endpoint);
  }
  return endpoint;
}

/**
 * Field names differ by regime: `COD_COMP`/`COD_PROV`/`SIGLA_UTS` up to 1947, `COD_REG`/`COD_UTS`/
 * `SIGLA_AUTOMOBILISTICA` from 1948. Unknown fields are ignored (§3.5 item 2).
 */
import { z } from 'zod';
import { CONTENT_TYPES, jsonRowsDecoder, type Endpoint } from '../../http/index.ts';
import type { Level } from '../../model/common.ts';
import type { SnapshotRowByLevel } from '../../model/internal.ts';
import { cadastralCode, optionalCode, optionalText, requiredCode, requiredText, utsType } from '../normalise.ts';
import { describeSnapshotPfun, SNAPSHOT_PFUNS, type SnapshotPfun } from './pfun.ts';

export interface SnapshotRows<L extends Level = Level> {
  rows: SnapshotRowByLevel[L][];
  /** SITUAS omitted `COD_PROV_STORICO`, so the UTS code stands in (§3.5 item 16); not in the projection. */
  historicalCodeFallbacks: number;
  /** The row's own `COD_UTS`. */
  historicalCodeFallbackUtsCodes: string[];
}

interface Projected<L extends Level> {
  row: SnapshotRowByLevel[L];
  /** `COD_UTS` when it stands in for a missing `COD_PROV_STORICO` (§3.5 item 16), else null. */
  fallback: string | null;
}

const regionBefore1948 = z
  .object({ COD_COMP: requiredCode(2), DEN_COMP: requiredText })
  .transform((r): Projected<'region'> => ({
    row: { code: r.COD_COMP, name: r.DEN_COMP, type: 'compartment' },
    fallback: null,
  }));

const regionFrom1948 = z
  .object({ COD_REG: requiredCode(2), DEN_REG: requiredText })
  .transform((r): Projected<'region'> => ({
    row: { code: r.COD_REG, name: r.DEN_REG, type: 'region' },
    fallback: null,
  }));

const utsBefore1948 = z
  .object({ COD_PROV: requiredCode(3), DEN_PROV: requiredText, COD_COMP: requiredCode(2) })
  .transform((r): Projected<'province'> => ({
    row: {
      code: r.COD_PROV,
      name: r.DEN_PROV,
      regionCode: r.COD_COMP,
      type: 'province',
      abbreviation: null,
      historicalCode: r.COD_PROV,
    },
    fallback: null,
  }));

const utsFrom1948 = z
  .object({
    COD_UTS: requiredCode(3),
    DEN_UTS: requiredText,
    COD_REG: requiredCode(2),
    TIPO_UTS: utsType,
    SIGLA_AUTOMOBILISTICA: optionalText,
    COD_PROV_STORICO: optionalCode(3),
  })
  .transform((r): Projected<'province'> => ({
    row: {
      code: r.COD_UTS,
      name: r.DEN_UTS,
      regionCode: r.COD_REG,
      type: r.TIPO_UTS,
      abbreviation: r.SIGLA_AUTOMOBILISTICA,
      historicalCode: r.COD_PROV_STORICO ?? r.COD_UTS,
    },
    fallback: r.COD_PROV_STORICO === null ? r.COD_UTS : null,
  }));

const municipalityNames = {
  PRO_COM_T: requiredCode(6),
  COMUNE: requiredText,
  COMUNE_IT: requiredText,
  COMUNE_A: optionalText,
  COD_CATASTO: cadastralCode,
};

const municipalityBefore1948 = z
  .object({ ...municipalityNames, COD_PROV: requiredCode(3), COD_COMP: requiredCode(2), SIGLA_UTS: optionalText })
  .transform((r): Projected<'municipality'> => ({
    row: {
      code: r.PRO_COM_T,
      officialName: r.COMUNE,
      italianName: r.COMUNE_IT,
      foreignName: r.COMUNE_A,
      cadastralCode: r.COD_CATASTO,
      utsCode: r.COD_PROV,
      regionCode: r.COD_COMP,
      utsAbbreviation: r.SIGLA_UTS,
      historicalUtsCode: r.COD_PROV,
    },
    fallback: null,
  }));

const municipalityFrom1948 = z
  .object({
    ...municipalityNames,
    COD_UTS: requiredCode(3),
    COD_REG: requiredCode(2),
    SIGLA_AUTOMOBILISTICA: optionalText,
    COD_PROV_STORICO: optionalCode(3),
  })
  .transform((r): Projected<'municipality'> => ({
    row: {
      code: r.PRO_COM_T,
      officialName: r.COMUNE,
      italianName: r.COMUNE_IT,
      foreignName: r.COMUNE_A,
      cadastralCode: r.COD_CATASTO,
      utsCode: r.COD_UTS,
      regionCode: r.COD_REG,
      utsAbbreviation: r.SIGLA_AUTOMOBILISTICA,
      historicalUtsCode: r.COD_PROV_STORICO ?? r.COD_UTS,
    },
    fallback: r.COD_PROV_STORICO === null ? r.COD_UTS : null,
  }));

const ROW_SCHEMAS: { [L in Level]: readonly z.ZodType<Projected<L>>[] } = {
  region: [regionBefore1948, regionBefore1948, regionFrom1948],
  province: [utsBefore1948, utsBefore1948, utsFrom1948],
  municipality: [municipalityBefore1948, municipalityBefore1948, municipalityFrom1948],
};

function rowSchema(pfun: SnapshotPfun): { level: Level; schema: z.ZodType<Projected<Level>> } {
  const described = describeSnapshotPfun(pfun);
  if (described === undefined) throw new RangeError(`pfun ${pfun} is not a snapshot report`);
  const schema = ROW_SCHEMAS[described.level][described.regime];
  if (schema === undefined) throw new RangeError(`no row schema for pfun ${pfun}`);
  return { level: described.level, schema: schema as z.ZodType<Projected<Level>> };
}

const endpoints = new Map<SnapshotPfun, Endpoint<SnapshotRows>>();

export function snapshotEndpoint<L extends Level>(pfun: (typeof SNAPSHOT_PFUNS)[L][number]): Endpoint<SnapshotRows<L>>;
export function snapshotEndpoint(pfun: SnapshotPfun): Endpoint<SnapshotRows>;
export function snapshotEndpoint(pfun: SnapshotPfun): Endpoint<SnapshotRows> {
  let endpoint = endpoints.get(pfun);
  if (endpoint === undefined) {
    const { level, schema } = rowSchema(pfun);
    const decodeRows = jsonRowsDecoder({
      contentTypes: CONTENT_TYPES.situasPublic,
      envelope: 'resultset',
      nonEmpty: true,
      row: schema,
    });
    endpoint = {
      id: `snapshot:pfun-${pfun}`,
      family: 'situas-public-snapshots',
      timeoutClass: level === 'municipality' ? 'snapshot' : 'default',
      decode: (response) => {
        const projected = decodeRows(response);
        const fallbacks = projected.flatMap((p) => (p.fallback === null ? [] : [p.fallback]));
        return {
          rows: projected.map((p) => p.row),
          historicalCodeFallbacks: fallbacks.length,
          historicalCodeFallbackUtsCodes: [...new Set(fallbacks)].sort(),
        };
      },
    };
    endpoints.set(pfun, endpoint);
  }
  return endpoint;
}

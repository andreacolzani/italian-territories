/**
 * ANPR adapter (§3.4, §6.11): the municipality archive CSV, cross-check only (D2). Dates are
 * converted to the internal half-open convention here (D22): `validFrom = DATAISTITUZIONE`,
 * `validTo = DATACESSAZIONE + 1 day`, or `null` when `DATACESSAZIONE = 9999-12-31`.
 *
 * ANPR is a non-blocking source: malformed rows are dropped and returned as issues (`info`);
 * a structurally broken file (unparseable CSV, missing columns) raises `AnprFormatError`, which
 * is neither retried nor cached and never becomes a `ResponseValidationError`.
 */
import { CsvError, parse } from 'csv-parse/sync';
import { isIsoDate, nextDay, compareDates, type IsoDate } from '../../dates/index.ts';
import {
  canonicalJson,
  CONTENT_TYPES,
  textDecoder,
  type ClientResult,
  type Endpoint,
  type HttpClient,
  type HttpRequest,
  type RequestOptions,
} from '../../http/index.ts';
import { CADASTRAL_CODE_PATTERN, ISTAT_CODE_PATTERNS } from '../../model/common.ts';
import { cleanText } from '../normalise.ts';

/** Columns read from the CSV (§3.4); any other column is ignored. */
const ANPR_COLUMNS = [
  'DATAISTITUZIONE',
  'DATACESSAZIONE',
  'CODISTAT',
  'CODCATASTALE',
  'DENOMINAZIONE_IT',
  'ALTRADENOMINAZIONE',
  'IDPROVINCIAISTAT',
  'IDREGIONE',
  'SIGLAPROVINCIA',
  'STATO',
] as const;

type AnprColumn = (typeof ANPR_COLUMNS)[number];

/** `DATACESSAZIONE` of rows still valid. */
const OPEN_END = '9999-12-31';

export interface AnprRow {
  /** 1-based line of the record in the CSV (header is line 1). */
  line: number;
  validFrom: IsoDate;
  /** Half-open end; `null` if still valid. */
  validTo: IsoDate | null;
  istatCode: string;
  /** `null` for `ND`. */
  cadastralCode: string | null;
  italianName: string;
  /** `ALTRADENOMINAZIONE`, `null` if empty. */
  otherName: string | null;
  provinceCode: string;
  /** Two digits, or `EX` for former Italian territories. */
  regionCode: string;
  provinceAbbreviation: string | null;
  /** `A` active, `C` ceased. */
  status: 'A' | 'C';
}

/**
 * An ANPR row as stored (§6.3) and cross-checked: without the CSV `line`, which would change the
 * hash of every following row at each insertion in the file.
 */
export type AnprRecord = Omit<AnprRow, 'line'>;

/** The stored row of an adapter row (any extra field, such as `line`, is left out). */
export function anprRecord(row: AnprRecord): AnprRecord {
  return {
    validFrom: row.validFrom,
    validTo: row.validTo,
    istatCode: row.istatCode,
    cadastralCode: row.cadastralCode,
    italianName: row.italianName,
    otherName: row.otherName,
    provinceCode: row.provinceCode,
    regionCode: row.regionCode,
    provinceAbbreviation: row.provinceAbbreviation,
    status: row.status,
  };
}

/**
 * Stable order of ANPR records, independent of the file: cadastral code (rows without one last),
 * ISTAT code, `validFrom`, then the canonical JSON of the record.
 */
export function compareAnprRecords(a: AnprRecord, b: AnprRecord): number {
  const cadastral = (r: AnprRecord) => (r.cadastralCode === null ? 1 : 0);
  return (
    cadastral(a) - cadastral(b) ||
    compareText(a.cadastralCode ?? '', b.cadastralCode ?? '') ||
    compareText(a.istatCode, b.istatCode) ||
    compareText(a.validFrom, b.validFrom) ||
    compareText(canonicalJson(a), canonicalJson(b))
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface AnprIssue {
  line: number;
  message: string;
  record: Partial<Record<AnprColumn, string>> | string[];
}

export interface AnprData {
  rows: AnprRow[];
  issues: AnprIssue[];
}

/** The CSV cannot be used at all: the cross-check is skipped for the run (§6.11). */
export class AnprFormatError extends Error {
  override name = 'AnprFormatError';
}

const REGION_CODE = /^(\d{2}|EX)$/;

function rowOf(line: number, record: Record<AnprColumn, string>): AnprRow | string {
  const from = record.DATAISTITUZIONE.trim();
  const until = record.DATACESSAZIONE.trim();
  if (!isIsoDate(from)) return `invalid DATAISTITUZIONE '${record.DATAISTITUZIONE}'`;
  if (!isIsoDate(until)) return `invalid DATACESSAZIONE '${record.DATACESSAZIONE}'`;
  const validTo = until === OPEN_END ? null : nextDay(until);
  if (validTo !== null && compareDates(until, from) < 0)
    return `DATACESSAZIONE ${until} before DATAISTITUZIONE ${from}`;

  const istatCode = record.CODISTAT.trim();
  if (!ISTAT_CODE_PATTERNS.municipality.test(istatCode)) return `invalid CODISTAT '${istatCode}'`;
  const cadastralCode = cleanText(record.CODCATASTALE);
  if (cadastralCode !== null && !CADASTRAL_CODE_PATTERN.test(cadastralCode)) {
    return `invalid CODCATASTALE '${cadastralCode}'`;
  }
  const italianName = cleanText(record.DENOMINAZIONE_IT);
  if (italianName === null) return 'missing DENOMINAZIONE_IT';
  const provinceCode = record.IDPROVINCIAISTAT.trim();
  if (!ISTAT_CODE_PATTERNS.province.test(provinceCode)) return `invalid IDPROVINCIAISTAT '${provinceCode}'`;
  const regionCode = record.IDREGIONE.trim();
  if (!REGION_CODE.test(regionCode)) return `invalid IDREGIONE '${regionCode}'`;
  const status = record.STATO.trim();
  if (status !== 'A' && status !== 'C') return `invalid STATO '${status}'`;

  return {
    line,
    validFrom: from,
    validTo,
    istatCode,
    cadastralCode,
    italianName,
    otherName: cleanText(record.ALTRADENOMINAZIONE),
    provinceCode,
    regionCode,
    provinceAbbreviation: cleanText(record.SIGLAPROVINCIA),
    status,
  };
}

/** Parses the archive CSV. Throws `AnprFormatError` only for structural problems. */
export function parseAnprCsv(text: string): AnprData {
  let records: string[][];
  try {
    records = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
  } catch (error) {
    if (error instanceof CsvError) throw new AnprFormatError(`unparseable CSV: ${error.message}`, { cause: error });
    throw error;
  }
  const [header, ...body] = records;
  if (header === undefined) throw new AnprFormatError('empty CSV');
  const index = new Map(header.map((name, i) => [name.trim(), i]));
  const missing = ANPR_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) throw new AnprFormatError(`missing columns: ${missing.join(', ')}`);

  const rows: AnprRow[] = [];
  const issues: AnprIssue[] = [];
  body.forEach((fields, i) => {
    const line = i + 2;
    if (fields.length !== header.length) {
      issues.push({ line, message: `expected ${header.length} fields, got ${fields.length}`, record: fields });
      return;
    }
    const record = Object.fromEntries(ANPR_COLUMNS.map((c) => [c, fields[index.get(c) ?? -1] ?? ''])) as Record<
      AnprColumn,
      string
    >;
    const row = rowOf(line, record);
    if (typeof row === 'string') issues.push({ line, message: row, record });
    else rows.push(row);
  });
  return { rows, issues };
}

const decodeText = textDecoder({ contentTypes: CONTENT_TYPES.anpr, nonEmpty: true });

/** Endpoint `anpr:archivio-comuni`. */
export const ANPR_ENDPOINT: Endpoint<AnprData> = {
  id: 'anpr:archivio-comuni',
  family: 'anpr',
  timeoutClass: 'default',
  decode: (response) => parseAnprCsv(decodeText(response)),
};

function anprRequest(csvUrl: string): HttpRequest {
  return { method: 'GET', url: csvUrl };
}

export class AnprSource {
  readonly #client: HttpClient;
  readonly #csvUrl: string;

  constructor(client: HttpClient, csvUrl: string) {
    this.#client = client;
    this.#csvUrl = csvUrl;
  }

  /** Rows with half-open dates and the row-level issues (§6.11). */
  fetchAnpr(options?: RequestOptions): Promise<ClientResult<AnprData>> {
    return this.#client.request(ANPR_ENDPOINT, anprRequest(this.#csvUrl), options);
  }
}

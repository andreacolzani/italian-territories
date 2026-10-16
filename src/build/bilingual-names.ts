/**
 * §4.2, D7. Names with `/` come from a closed table, never from splitting: the decomposition rule
 * (`-` separates territories, `/` the languages of one territory) is only a check, and a table that
 * disagrees with it is a defect of the repository, so the module refuses to load.
 */

export interface RegionalNames {
  officialName: string;
  italianName: string | null;
  foreignName: string | null;
}

export interface BilingualNameEntry {
  officialName: string;
  italianName: string;
  foreignName: string;
  source: string;
}

export const BILINGUAL_NAMES: readonly BilingualNameEntry[] = [
  {
    officialName: 'Trentino-Alto Adige/Südtirol',
    italianName: 'Trentino-Alto Adige',
    foreignName: 'Trentino-Südtirol',
    source: 'Statuto speciale per il Trentino-Alto Adige (D.P.R. 31 agosto 1972, n. 670)',
  },
  {
    officialName: "Valle d'Aosta/Vallée d'Aoste",
    italianName: "Valle d'Aosta",
    foreignName: "Vallée d'Aoste",
    source: 'ISTAT official denomination',
  },
  {
    officialName: 'Bolzano/Bozen',
    italianName: 'Bolzano',
    foreignName: 'Bozen',
    source: 'ISTAT official denomination',
  },
];

export class BilingualNameTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BilingualNameTableError';
  }
}

export function decomposeBilingual(name: string): { italianName: string; foreignName: string } | null {
  if (!name.includes('/')) return null;
  const italian: string[] = [];
  const foreign: string[] = [];
  for (const territory of name.split('-')) {
    const forms = territory.split('/').map((f) => f.trim());
    if (forms.length > 2 || forms.some((f) => f === '')) return null;
    italian.push(forms[0] ?? '');
    foreign.push(forms[forms.length - 1] ?? '');
  }
  return { italianName: italian.join('-'), foreignName: foreign.join('-') };
}

function loadTable(entries: readonly BilingualNameEntry[]): ReadonlyMap<string, BilingualNameEntry> {
  const table = new Map<string, BilingualNameEntry>();
  for (const entry of entries) {
    if (table.has(entry.officialName)) throw new BilingualNameTableError(`duplicate entry ${entry.officialName}`);
    const rule = decomposeBilingual(entry.officialName);
    if (rule?.italianName !== entry.italianName || rule.foreignName !== entry.foreignName) {
      throw new BilingualNameTableError(
        `${entry.officialName}: the table gives ${entry.italianName} / ${entry.foreignName}, ` +
          `the decomposition rule ${rule === null ? 'nothing' : `${rule.italianName} / ${rule.foreignName}`}`,
      );
    }
    if (entry.source.trim() === '') throw new BilingualNameTableError(`${entry.officialName}: no source`);
    table.set(entry.officialName, entry);
  }
  return table;
}

const TABLE = loadTable(BILINGUAL_NAMES);

/** Exported for tests. */
export function checkBilingualTable(entries: readonly BilingualNameEntry[]): void {
  loadTable(entries);
}

export function regionalNames(name: string): RegionalNames {
  if (!name.includes('/')) return { officialName: name, italianName: name, foreignName: null };
  const entry = TABLE.get(name);
  if (entry === undefined) return { officialName: name, italianName: null, foreignName: null };
  return { officialName: name, italianName: entry.italianName, foreignName: entry.foreignName };
}

export function isUnknownBilingual(name: string): boolean {
  return name.includes('/') && !TABLE.has(name);
}

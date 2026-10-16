import type { Config } from '../config.ts';
import type { HttpClient } from '../http/index.ts';
import { AnprSource } from './anpr/index.ts';
import { SituasInternalSource } from './situas-internal/index.ts';
import { SituasPublicSource } from './situas-public/index.ts';

export interface Sources {
  situasPublic: SituasPublicSource;
  situasInternal: SituasInternalSource;
  anpr: AnprSource;
}

export function createSources(client: HttpClient, config: Pick<Config, 'sources'>): Sources {
  return {
    situasPublic: new SituasPublicSource(client, config.sources.situasPublicBaseUrl),
    situasInternal: new SituasInternalSource(client, config.sources.situasInternalReportUrl),
    anpr: new AnprSource(client, config.sources.anprCsvUrl),
  };
}

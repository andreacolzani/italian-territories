/** Source adapters (§3, §6.2), wired to the configured URLs. */
import type { Config } from '../config.ts';
import type { HttpClient } from '../http/index.ts';
import { AnprSource } from './anpr/index.ts';
import { SituasInternalSource } from './situas-internal/index.ts';
import { SituasPublicSource } from './situas-public/index.ts';

export { AnprSource } from './anpr/index.ts';
export { SituasInternalSource } from './situas-internal/index.ts';
export { SituasPublicSource } from './situas-public/index.ts';

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

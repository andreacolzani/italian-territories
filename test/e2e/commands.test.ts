/**
 * The commands end to end (Step 17) on the declarative world of `test/helpers/world.ts`: the real
 * CLI, store, registry and `dist/` in a temporary directory, the sources answered by the world
 * transport. The scenarios change the world (or make requests fail) between two runs.
 */
import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCalendar } from '../../src/calendar/index.ts';
import { loadPublishedDataset, type PublishedDataset } from '../../src/emit/index.ts';
import { INVARIANT_IDS } from '../../src/invariants/index.ts';
import { reportUrls } from '../../src/sources/situas-internal/index.ts';
import { internalReportKey } from '../../src/store/index.ts';
import { reportOf } from '../helpers/internal.ts';
import { sandbox, type Sandbox } from '../helpers/commands.ts';
import { publishedSchemaViolations } from '../helpers/json-schema.ts';
import { baseWorld, withSettevilleFusion, withSilentCadastralChange } from '../helpers/world.ts';

const DAY = 86_400_000;

let boxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(boxes.map((b) => b.dispose()));
  boxes = [];
});

async function fresh(...args: Parameters<typeof sandbox>): Promise<Sandbox> {
  const box = await sandbox(...args);
  boxes.push(box);
  return box;
}

async function bootstrapped(...args: Parameters<typeof sandbox>): Promise<Sandbox> {
  const box = await fresh(...args);
  expect(await box.run('bootstrap', '--today', '2026-10-01')).toBe(0);
  return box;
}

/** Every file of a directory with its modification time and content. */
async function files(dir: string): Promise<Map<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const result = new Map<string, string>();
  for (const e of entries.filter((x) => x.isFile())) {
    const path = join(e.parentPath, e.name);
    result.set(path, `${(await stat(path)).mtimeMs}|${await readFile(path, 'utf8')}`);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function published(box: Sandbox): Promise<PublishedDataset> {
  const dataset = await loadPublishedDataset(box.config.paths.dist);
  if (dataset === null) throw new Error('nothing published');
  return dataset;
}

function municipality(dataset: PublishedDataset, code: string) {
  const found = dataset.municipalities.find((m) => m.versions.some((v) => v.istat_code === code));
  if (found === undefined) throw new Error(`no municipality ${code}`);
  return found;
}

describe('bootstrap', () => {
  it('publishes a valid dataset and a complete run summary', async () => {
    const box = await bootstrapped(baseWorld());
    expect(await publishedSchemaViolations(box.config.paths.dist)).toEqual([]);
    const dataset = await published(box);
    expect(dataset.meta).toMatchObject({ data_version: '2026.10.01', generated_at: '2026-10-05T04:00:00Z' });
    expect(Object.values(dataset.meta.sources).every((s) => s !== null)).toBe(true);
    // The override replaces the full name SITUAS reports.
    expect(dataset.provinces.find((p) => p.versions[0]?.istat_code === '091')?.versions[0]?.abbreviation).toBe('NU');
    expect(municipality(dataset, '025070').predecessors.map((l) => l.kind)).toEqual(['merged_into', 'merged_into']);
    expect(municipality(dataset, '091099').versions[0]?.cadastral_code).toBeNull();
    expect(municipality(dataset, '028001').versions.map((v) => v.official_name)).toEqual(['Abano', 'Abano Terme']);

    const summary = await box.summary();
    expect(summary).toMatchObject({
      command: 'bootstrap',
      today: '2026-10-01',
      exit_code: 0,
      outcome: 'success',
      release: { kind: 'data', data_version: '2026.10.01' },
      retroactive: { value: false, reasons: [] },
      anomalies: { blocking: 0 },
      golden14: { anpr_missing_entity: 0, anpr_missing_suppressed: 0 },
      error: null,
    });
    expect(summary.invariants.map((i) => [i.id, i.status])).toEqual(INVARIANT_IDS.map((id) => [id, 'passed']));
    expect(summary.invariants.every((i) => i.duration_ms !== null)).toBe(true);
    expect(summary.timings_ms.build).not.toBeNull();
    expect(summary.timings_ms.i12).not.toBeNull();
    expect(summary.timings_ms.source_summaries).not.toBeNull();
    expect(summary.event_lists).toHaveLength(11);
  });

  it('leaves dist/ untouched when nothing changed (no commit)', async () => {
    const box = await bootstrapped(baseWorld());
    const before = await files(box.config.paths.dist);
    expect(await box.run('update', '--today', '2026-10-08')).toBe(0);
    expect(await files(box.config.paths.dist)).toEqual(before);
    expect(await box.summary()).toMatchObject({ exit_code: 0, release: { kind: 'unchanged', changes: null } });
  });
});

describe('update', () => {
  it('publishes a fusion after the previous release as an additive change (exit 0)', async () => {
    const box = await bootstrapped(baseWorld());
    box.world.world = withSettevilleFusion(box.world.world, '2026-10-10');
    expect(await box.run('update', '--today', '2026-10-15')).toBe(0);
    const dataset = await published(box);
    expect(dataset.changes.retroactive).toBe(false);
    expect(dataset.meta.data_version).toBe('2026.10.15');
    expect(municipality(dataset, '025075').predecessors.map((l) => l.date)).toEqual(['2026-10-10', '2026-10-10']);
    expect(municipality(dataset, '025070').versions.at(-1)?.valid_until).toBe('2026-10-09');
    expect(await box.summary()).toMatchObject({
      exit_code: 0,
      release: { kind: 'data' },
      retroactive: { value: false },
    });
  });

  it('classifies an event published late as retroactive (exit 2), refreshing the stored snapshots', async () => {
    const box = await bootstrapped(baseWorld());
    box.world.world = withSettevilleFusion(box.world.world, '2026-06-01');
    expect(await box.run('update', '--today', '2026-10-08')).toBe(2);
    const summary = await box.summary();
    expect(summary).toMatchObject({ exit_code: 2, outcome: 'retroactive', retroactive: { value: true } });
    expect(summary.retroactive.reasons).toContain('changes');
    expect(summary.refreshed_snapshots).toBeGreaterThan(0);
    // dist/ and registry/ are written, for the PR.
    const dataset = await published(box);
    expect(dataset.meta.data_version).toBe('2026.10.08');
    expect(municipality(dataset, '025070').versions.at(-1)?.valid_until).toBe('2026-05-31');
  });

  it('blocks when the stored snapshots to refresh exceed the limit (exit 1)', async () => {
    const box = await bootstrapped(baseWorld(), { update: { maxRefreshSnapshots: 0 } });
    box.world.world = withSettevilleFusion(box.world.world, '2026-06-01');
    const before = await files(box.config.paths.dist);
    const registry = await files(box.config.paths.registry);
    expect(await box.run('update', '--today', '2026-10-08')).toBe(1);
    expect((await box.summary()).anomalies.by_code['refresh-too-large']).toMatchObject({ level: 'blocking' });
    expect(box.err).toContain('rebuild --refetch');
    expect(await files(box.config.paths.dist)).toEqual(before);
    expect(await files(box.config.paths.registry)).toEqual(registry);
  });

  it('needs the state of a previous run and never bootstraps on its own (exit 1)', async () => {
    const box = await fresh(baseWorld());
    expect(await box.run('update', '--today', '2026-10-08')).toBe(1);
    expect((await box.summary()).message).toContain('run bootstrap, which resumes from the cache');
    expect(box.world.requests).toEqual([]);
  });
});

describe('lost internal history', () => {
  it('every request succeeded but the history of a registered entity is absent: exit 1, no id change', async () => {
    const box = await bootstrapped(baseWorld());
    const dist = await files(box.config.paths.dist);
    const registry = await files(box.config.paths.registry);
    // ISTAT no longer lists Alghero in r3, and no stored history covers it.
    const url = reportUrls.municipalityEvents({ code: '090003', name: 'Alghero' });
    await rm(join(box.config.paths.store, 'internal', 'reports', 'r6', `${internalReportKey(6, url)}.json`));
    box.world.patch = (response, request) => {
      if (reportOf(request) !== 3 || !response.body.includes('Alghero')) return response;
      const { items } = JSON.parse(JSON.parse(response.body) as string) as { items: { comune: string }[] };
      const kept = items.filter((i) => i.comune !== 'Alghero');
      return { ...response, body: JSON.stringify(JSON.stringify({ items: kept })) };
    };
    expect(await box.run('update', '--today', '2026-10-02')).toBe(1);
    const summary = await box.summary();
    expect(summary.anomalies.by_code['internal-data-required']).toMatchObject({ level: 'blocking', anomalies: 1 });
    expect(summary.anomalies.by_code['internal-data-unavailable']).toBeUndefined();
    expect(box.err).toMatch(/"code":"internal-data-required","cause":"absent"/);
    expect(await files(box.config.paths.dist)).toEqual(dist);
    expect(await files(box.config.paths.registry)).toEqual(registry);
  });
});

describe('rebuild', () => {
  it('without --refetch is offline: same data from the store, I13 and ANPR included (exit 0)', async () => {
    const box = await bootstrapped(baseWorld());
    const before = await files(box.config.paths.dist);
    // The network works: the run still sends nothing.
    const sent = box.world.requests.length;
    expect(await box.run('rebuild')).toBe(0);
    expect(box.world.requests.length).toBe(sent);
    expect(await files(box.config.paths.dist)).toEqual(before);
    const summary = await box.summary();
    expect(summary).toMatchObject({ today: '2026-10-01', release: { kind: 'unchanged' }, anomalies: { blocking: 0 } });
    expect(summary.invariants.every((i) => i.status === 'passed')).toBe(true);
    expect(summary.anomalies.by_code['anpr-unavailable']).toBeUndefined();
  });

  it('without --refetch never fetches a missing internal report, and never re-keys the entity (exit 3)', async () => {
    const box = await bootstrapped(baseWorld());
    const dist = await files(box.config.paths.dist);
    const registry = await files(box.config.paths.registry);
    const url = reportUrls.municipalityEvents({ code: '090003', name: 'Alghero' });
    await rm(join(box.config.paths.store, 'internal', 'reports', 'r6', `${internalReportKey(6, url)}.json`));
    const sent = box.world.requests.length;
    // Without its history Alghero would get an nk: key and a new id: blocking instead (§5.3), and
    // the history is missing because the report could not be obtained: an unavailability.
    expect(await box.run('rebuild')).toBe(3);
    expect(box.err).toMatch(/"code":"internal-data-required","cause":"unavailable"/);
    expect(box.world.requests.length).toBe(sent);
    const summary = await box.summary();
    expect(summary.anomalies.by_code['internal-data-unavailable']).toMatchObject({ level: 'warning', anomalies: 1 });
    expect(summary.anomalies.by_code['internal-data-required']).toMatchObject({ level: 'blocking', anomalies: 1 });
    expect(box.err).toContain('run update or rebuild --refetch');
    expect(await files(box.config.paths.dist)).toEqual(dist);
    expect(await files(box.config.paths.registry)).toEqual(registry);
  });

  it('without --refetch never fetches a missing snapshot: snapshot-unavailable (exit 3)', async () => {
    const box = await bootstrapped(baseWorld());
    const dir = join(box.config.paths.store, 'snapshots', 'region');
    const [manifest] = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    if (manifest === undefined) throw new Error('no stored region snapshot');
    await rm(join(dir, manifest));
    const sent = box.world.requests.length;
    expect(await box.run('rebuild')).toBe(3);
    expect(box.world.requests.length).toBe(sent);
    expect((await box.summary()).anomalies.by_code['snapshot-unavailable']).toMatchObject({ level: 'blocking' });
    expect(box.err).toContain('run update or rebuild --refetch');
  });

  it('without stored counts asks for update or rebuild --refetch (exit 3)', async () => {
    const box = await bootstrapped(baseWorld());
    await rm(join(box.config.paths.store, 'counts'), { recursive: true });
    box.world.failing = () => true;
    expect(await box.run('rebuild')).toBe(3);
    expect((await box.summary()).anomalies.by_code['count-unavailable']).toMatchObject({
      level: 'blocking',
      anomalies: 3,
    });
    expect(box.err).toContain('run update or rebuild --refetch');
  });

  it('--refetch drops an inferred breakpoint no longer confirmed: versions merge, retroactive (exit 2)', async () => {
    const box = await bootstrapped(withSilentCadastralChange(baseWorld(), '028060', '2015-05-01', 'G225'));
    expect((await box.summary()).anomalies.by_code['inferred-breakpoint']).toMatchObject({ level: 'warning' });
    expect(municipality(await published(box), '028060').versions).toHaveLength(2);
    expect((await loadCalendar(box.config.paths.store))?.dates.get('2015-05-01')).toEqual(['inferred']);

    box.world.world = baseWorld();
    // A refetch accepts what was downloaded from its today on: the next day, everything is fetched.
    box.clock.advance(DAY);
    expect(await box.run('rebuild', '--refetch', '--today', '2026-10-02')).toBe(2);
    expect((await box.summary()).anomalies.by_code['inferred-breakpoint-removed']).toMatchObject({ level: 'info' });
    expect((await loadCalendar(box.config.paths.store))?.dates.has('2015-05-01')).toBe(false);
    const padova = municipality(await published(box), '028060');
    expect(padova.versions.map((v) => [v.valid_from, v.valid_until, v.cadastral_code])).toEqual([
      ['2000-01-01', null, 'G224'],
    ]);
  });

  it('--refetch refreshes the stored snapshots with bounded concurrency', async () => {
    const box = await bootstrapped(baseWorld());
    const inRefresh = () => {
      const stage = box.live.findLast((l) => l.includes('"msg":"stage '));
      return stage?.includes('"stage start","stage":"refresh"') === true;
    };
    let active = 0;
    let peak = 0;
    let refreshRequests = 0;
    box.world.hold = () => {
      if (!inRefresh()) return null;
      refreshRequests++;
      peak = Math.max(peak, ++active);
      return new Promise<void>((resolve) => setImmediate(resolve)).finally(() => active--);
    };
    box.clock.advance(DAY);
    expect(await box.run('rebuild', '--refetch', '--today', '2026-10-02')).toBe(0);
    expect(refreshRequests).toBeGreaterThan(box.config.http.maxConcurrency);
    // Above one: the stage no longer waits for each snapshot; the HTTP client's AIMD limit caps it.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(box.config.http.maxConcurrency);
    expect((await box.summary()).refreshed_snapshots).toBe(refreshRequests);
  });

  it('an outage of 45 s during a refetch loses no request (exit 0)', async () => {
    // Plan timings for the circuit breaker (threshold 10, 60 s); retries cycle every 10 s.
    const box = await bootstrapped(baseWorld(), {
      http: { circuitBreakerThreshold: 10, backoffBaseMs: 100, backoffMaxMs: 10_000 },
    });
    box.clock.advance(DAY);
    // Every request fails for 45 s from the first snapshot request (e.g. DNS down).
    let start: number | undefined;
    box.world.failing = (request) => {
      const now = box.clock.clock.now();
      if (start === undefined && request.url.includes('/reportspooljson?pfun=')) start = now;
      return start !== undefined && now - start < 45_000;
    };
    expect(await box.run('rebuild', '--refetch', '--today', '2026-10-02')).toBe(0);
    expect(box.err).toContain('"msg":"http request held"');
    expect(box.err).not.toContain('circuit');
    expect((await box.summary()).anomalies.blocking).toBe(0);
  });

  it('--refetch interrupted and run again the same day sends no request twice', async () => {
    const box = await bootstrapped(baseWorld());
    box.clock.advance(DAY);
    const served: string[] = [];
    box.world.patch = (response, request) => {
      served.push(`${request.method} ${request.url} ${JSON.stringify(request.body ?? null)}`);
      return response;
    };
    // The snapshots stop answering midway: the first run ends unavailable (exit 3).
    let snapshots = 0;
    box.world.failing = (request) => request.url.includes('/reportspooljson?') && ++snapshots > 10;
    expect(await box.run('rebuild', '--refetch', '--today', '2026-10-02')).toBe(3);
    const first = served.length;
    expect(first).toBeGreaterThan(0);

    box.world.failing = null;
    expect(await box.run('rebuild', '--refetch', '--today', '2026-10-02')).toBe(0);
    expect(served.length).toBeGreaterThan(first);
    expect(served.filter((r, i) => served.indexOf(r) !== i)).toEqual([]);
  });
});

describe('failures', () => {
  it('a snapshot unavailable stops before identity: exit 3, nothing published, summary written', async () => {
    const box = await fresh(baseWorld());
    box.world.failing = (r) => r.url.includes('pfun=61&pdata=');
    expect(await box.run('bootstrap', '--today', '2026-10-01')).toBe(3);
    expect(await exists(join(box.config.paths.dist, 'meta.json'))).toBe(false);
    expect(await exists(box.config.paths.registry)).toBe(false);
    expect(await loadCalendar(box.config.paths.store)).toBeDefined();
    const summary = await box.summary();
    expect(summary).toMatchObject({ exit_code: 3, outcome: 'unavailable', release: null });
    expect(summary.anomalies.by_code['snapshot-unavailable']).toMatchObject({ level: 'blocking' });
  });

  it('an internal list unavailable with no copy is exit 3', async () => {
    const box = await fresh(baseWorld());
    box.world.failing = (r) => JSON.stringify(r.body ?? '').includes('var_get_ua_uts_lov_diffusione');
    expect(await box.run('bootstrap', '--today', '2026-10-01')).toBe(3);
    expect((await box.summary()).anomalies.by_code['internal-list-unavailable']).toMatchObject({ level: 'blocking' });
  });

  it('a snapshot schema violation is exit 1', async () => {
    const box = await fresh(baseWorld());
    box.world.patch = (response, request) =>
      request.url.includes('pfun=64&pdata=')
        ? { ...response, body: response.body.replaceAll('"COD_UTS"', '"X"') }
        : response;
    expect(await box.run('bootstrap', '--today', '2026-10-01')).toBe(1);
    expect((await box.summary()).anomalies.by_code['snapshot-schema-violation']).toMatchObject({ level: 'blocking' });
    expect(await exists(join(box.config.paths.dist, 'meta.json'))).toBe(false);
  });

  it('an event list unavailable is exit 3, a rejected one exit 1', async () => {
    const unavailable = await fresh(baseWorld());
    unavailable.world.failing = (r) => r.url.includes('pfun=98&');
    expect(await unavailable.run('bootstrap', '--today', '2026-10-01')).toBe(3);
    expect((await unavailable.summary()).anomalies.by_code['event-list-unavailable']).toBeDefined();

    const rejected = await fresh(baseWorld());
    rejected.world.patch = (response, request) =>
      request.url.includes('pfun=98&') ? { status: 404, headers: {}, body: 'not found' } : response;
    expect(await rejected.run('bootstrap', '--today', '2026-10-01')).toBe(1);
    expect((await rejected.summary()).anomalies.by_code['event-list-request-rejected']).toBeDefined();
  });
});

describe('audit', () => {
  it('reports discrepancies without publishing (exit 2); the next update builds on them', async () => {
    const box = await bootstrapped(baseWorld());
    const before = await files(box.config.paths.dist);
    box.world.world = withSilentCadastralChange(baseWorld(), '028060', '2015-05-01', 'G225');
    expect(await box.run('audit', '--samples', '30', '--today', '2026-10-08')).toBe(2);
    expect(await files(box.config.paths.dist)).toEqual(before);
    const summary = await box.summary();
    expect(summary.audit?.samples).toHaveLength(30);
    // The hidden change is placed on its own date by a fresh bisection, not on the sampled dates.
    expect(summary.audit?.discrepancies).toEqual([{ date: '2015-05-01', level: 'municipality', kind: 'inferred' }]);
    expect(summary.audit?.samples).not.toContain('2015-05-01');
    expect(summary.refreshed_snapshots).toBeGreaterThan(0);
    const calendar = await loadCalendar(box.config.paths.store);
    const inferred = [...(calendar?.dates ?? [])].filter(([, sources]) => sources.includes('inferred'));
    expect(inferred.map(([date]) => date)).toEqual(['2015-05-01']);

    // The next update builds on it: the release is retroactive.
    expect(await box.run('update', '--today', '2026-10-08')).toBe(2);
    const padova = municipality(await published(box), '028060');
    expect(padova.versions.map((v) => v.valid_from)).toEqual(['2000-01-01', '2015-05-01']);
  });

  it('draws the same samples for the same today', async () => {
    const box = await bootstrapped(baseWorld());
    expect(await box.run('audit', '--samples', '5', '--today', '2026-10-08')).toBe(0);
    const first = (await box.summary()).audit?.samples;
    expect(await box.run('audit', '--samples', '5', '--today', '2026-10-08')).toBe(0);
    expect((await box.summary()).audit?.samples).toEqual(first);
  });
});

describe('validate and diff', () => {
  it('validate runs the invariants on dist/, skipping those that need unpublished data', async () => {
    const box = await bootstrapped(baseWorld());
    expect(await box.run('validate')).toBe(0);
    for (const id of ['I2', 'I7', 'I12', 'I13', 'I14']) expect(box.out).toMatch(new RegExp(`^${id} skipped`, 'm'));
    for (const id of ['I1', 'I3', 'I9', 'I11', 'I15']) expect(box.out).toMatch(new RegExp(`^${id} passed$`, 'm'));
  });

  it('diff computes changes.json between two published directories', async () => {
    const box = await bootstrapped(baseWorld());
    const previous = join(box.dir, 'previous');
    await cp(box.config.paths.dist, previous, { recursive: true });
    box.world.world = withSettevilleFusion(box.world.world, '2026-10-10');
    expect(await box.run('update', '--today', '2026-10-15')).toBe(0);
    const changes = await readFile(join(box.config.paths.dist, 'changes.json'), 'utf8');
    expect(await box.run('diff', previous, box.config.paths.dist)).toBe(0);
    expect(box.out).toBe(changes);
    const out = join(box.dir, 'diff.json');
    expect(await box.run('diff', previous, box.config.paths.dist, '--out', out)).toBe(0);
    expect(await readFile(out, 'utf8')).toBe(changes);
    expect(await box.run('diff', join(box.dir, 'missing'), box.config.paths.dist)).toBe(1);
  });
});

/** Holds the first request `matches` accepts until `release`; `reached` settles when it arrives. */
function holdFirst(box: Sandbox, matches: (body: string) => boolean) {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const released = new Promise<void>((r) => (release = r));
  let held = false;
  box.world.hold = (request) => {
    if (held || !matches(JSON.stringify(request.body ?? request.url))) return null;
    held = true;
    reach();
    return released;
  };
  return { reached, release };
}

const isR6 = (body: string) => body.includes('var_get_ua_comuni_lov_rs?');

describe('long runs', () => {
  it('logs progress while a stage runs, and its counts when it ends', async () => {
    const box = await fresh(baseWorld());
    const { reached, release } = holdFirst(box, isR6);
    const run = box.run('bootstrap', '--today', '2026-10-01');
    await reached;
    box.scheduler.tick();
    const progress = box.live.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'progress');
    expect(progress).toEqual([expect.objectContaining({ level: 'info', stage: 'internal-crawl', errors: 0 })]);
    expect(progress[0]?.completed).toBeLessThan(progress[0]?.total as number);
    release();
    expect(await run).toBe(0);
    expect(box.scheduler.active()).toBe(0);
    const done = box.err
      .split('\n')
      .filter((l) => l.includes('"stage done"') && l.includes('"snapshots"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(done).toEqual([
      expect.objectContaining({
        errors: 0,
        completed: expect.any(Number) as number,
        total: expect.any(Number) as number,
      }),
    ]);
  });

  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    it(`writes the run summary as interrupted on ${signal} before exiting with ${code}`, async () => {
      const box = await fresh(baseWorld());
      const { reached, release } = holdFirst(box, isR6);
      const run = box.run('bootstrap', '--today', '2026-10-01');
      await reached;
      expect(box.process.listeners(signal)).toBe(1);
      box.process.emit(signal);
      await expect.poll(() => box.process.exits).toEqual([code]);
      const summary = await box.summary();
      expect(summary).toMatchObject({ outcome: 'interrupted', exit_code: code, signal });
      expect(summary.timings_ms.stages['event-lists']).toBeDefined();
      // The run, released, ends without overwriting the summary and removes its handlers.
      release();
      await run;
      expect(await box.summary()).toMatchObject({ outcome: 'interrupted', signal });
      expect(box.process.listeners(signal)).toBe(0);
    });
  }

  it('writes the run summary on an uncaught exception before exiting with 1', async () => {
    const box = await fresh(baseWorld());
    const { reached, release } = holdFirst(box, isR6);
    const run = box.run('bootstrap', '--today', '2026-10-01');
    await reached;
    box.process.emit('uncaughtException', new TypeError('boom from a timer'));
    await expect.poll(() => box.process.exits).toEqual([1]);
    expect(await box.summary()).toMatchObject({
      outcome: 'error',
      exit_code: 1,
      error: { name: 'TypeError', message: 'boom from a timer' },
    });
    release();
    await run;
    expect(box.process.listeners('uncaughtException')).toBe(0);
  });

  it('a thrown error also writes the summary (exit 1)', async () => {
    const box = await fresh(baseWorld());
    box.world.hold = (request) =>
      isR6(JSON.stringify(request.body ?? '')) ? Promise.reject(new Error('bug in a stage')) : null;
    expect(await box.run('bootstrap', '--today', '2026-10-01')).toBe(1);
    expect(await box.summary()).toMatchObject({ outcome: 'error', error: { message: 'bug in a stage' } });
  });

  it('logs one line when an endpoint is disabled and a final count of the refused requests', async () => {
    const box = await fresh(baseWorld());
    box.world.patch = (response, request) =>
      isR6(JSON.stringify(request.body ?? ''))
        ? { ...response, body: response.body.replaceAll('data evento', 'x') }
        : response;
    expect(await box.run('bootstrap', '--today', '2026-10-01')).toBe(1);
    const lines = box.err
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.msg === 'http endpoint disabled')).toHaveLength(1);
    expect(lines.filter((l) => l.msg === 'internal request failed')).toEqual([]);
    const summary = await box.summary();
    const [disabled] = summary.disabled_endpoints;
    expect(disabled).toMatchObject({ endpoint: 'r6:municipality-events' });
    expect(disabled?.refused).toBeGreaterThan(0);
    expect(lines.filter((l) => l.msg === 'requests refused by a disabled endpoint')).toEqual([
      expect.objectContaining({ endpoint: 'r6:municipality-events', refused: disabled?.refused }),
    ]);
  });
});

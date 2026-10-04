# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A generator that builds a day-accurate historical dataset of Italian regions, UTS/provinces and municipalities from 1861-03-17 to today, from ISTAT SITUAS (source of truth) and ANPR (cross-check only), and keeps it updated via GitHub Actions. A Laravel consumer package is a separate project.

**`docs/GENERATOR_IMPLEMENTATION_PLAN.md` is the specification and the roadmap.** Read the relevant sections before any change:

- Implement the steps of §12 **in order**; a step starts only when the previous one meets its acceptance criteria. When a step meets its acceptance criteria, mark its heading in §12 with `— DONE` (e.g. `### Step 1 — Scaffolding — DONE`).
- §1–§11 are the spec. If the implementation reveals a contradiction or an uncovered case, **stop and ask** instead of improvising. The decisions in §13 must not be changed without discussion.
- Invariants (§8) must be enforced by code, not by convention.

## Commands

```sh
npm run typecheck                 # tsc on src + test (noEmit)
npm test                          # vitest run
npx vitest run test/unit/cli.test.ts   # single file
npx vitest run -t "fixture manifest"   # by test name
npm run lint                      # eslint (type-checked) + prettier --check
npm run format                    # prettier --write
npm run build                     # tsc -p tsconfig.build.json → lib/
npm run cli -- <command>          # runs src/cli.ts directly with Node (no build)
```

Node ≥ 22.18 runs `.ts` files natively (type stripping), so no transpiler is used.

## Workflow and commits

- When asked for an implementation, **run `git pull` on the current branch before reading any code**, so you work on the up-to-date version.
- Every implementation happens on a **feature branch** created from `main` (never commit directly to `main`).
- When a step is finished, **ask the user before committing**.
- Before every commit that touches `docs/GENERATOR_IMPLEMENTATION_PLAN.md`, **show the user the full diff of the plan** (`git diff docs/GENERATOR_IMPLEMENTATION_PLAN.md`) and wait for approval. Paste the diff into the reply text as a `diff` block: tool output is not visible to the user.
- After finishing a step, remind the user to **start a new session** instead of continuing in the current one.
- Commit messages describe what was done (e.g. "Project scaffolding: …"), **never** the plan step (no "Step 1", "complete step N").

## Conventions that are not obvious

- **ESM + native TS**: relative imports use the `.ts` extension (`./config.ts`); `tsc` rewrites them to `.js` in `lib/` (`rewriteRelativeImportExtensions`). `erasableSyntaxOnly` is on: no `enum`, `namespace` or parameter properties.
- **`dist/` is the published dataset** (committed); compiled code goes to `lib/` (ignored). Never point build output at `dist/`.
- **Dates**: ISO `YYYY-MM-DD` strings, pure calendar arithmetic (no `Date` timezone logic). Internally half-open `[validFrom, validTo)`; the public JSON uses an inclusive `valid_until` — conversion only in the emitter (§4.1).
- **Line endings**: LF everywhere (`.gitattributes`, `.editorconfig`), except `test/fixtures/**`, which is `-text` and must stay byte-identical to the real API responses (the ANPR CSV is CRLF).
- Configuration lives in `src/config.ts` (zod schema with defaults from the plan; nested objects use `.prefault({})` so partial overrides still get inner defaults). `resolveConfig()` returns absolute paths.

## Architecture

Pipeline (§6): fetch → normalise → snapshot store → breakpoint calendar → snapshots + completeness bisection → internal crawl + identity graph → identity resolution → versions → variations & links → overrides → derived fields → ANPR cross-check → invariants → emit → changes. Each stage has its own directory under `src/` (layout in §14; empty directories hold a `.gitkeep` until their step is implemented).

- `src/cli.ts`: the §10.1 commands (`bootstrap`, `update`, `rebuild`, `audit`, `validate`, `diff`), currently stubs returning exit code 2. `main(argv, io, config, clock)` is exported and testable; commands are declared in the `commands` table. The global `--today` flag is resolved here (flag → `dates.today` → current date in Europe/Rome) and passed to commands as `ctx.today` (and `ctx.config.dates.today`): build code never reads the clock. `test/unit/clock-usage.test.ts` enforces this (only `dates/calendar-date.ts`, `cli.ts`, the HTTP client/clock and `logger.ts` may read it).
- `src/http/` (§6.1): `transport.ts` is the `Transport` contract (unencoded URLs/bodies; connection failures must be thrown as `NetworkError`, anything else is treated as a bug and not retried). `fetch-transport.ts` is the real one and the only place requests are encoded (`encode.ts`, strict RFC 3986, including the report URL inside internal API bodies). `client.ts` (`HttpClient`) composes `adaptive-limiter.ts` (AIMD pool) and `token-bucket.ts` (both per host, derived from the URL), `backoff.ts`, `circuit-breaker.ts` (per family: `situas-public-snapshots`, `situas-public-reports`, `situas-internal`, `anpr`; open for the whole run) and `cache.ts` (one atomic file per request; per-call policy `prefer` | `refresh` | `{ maxAgeDays }`, optional `staleFallback`). Time comes from an injectable `Clock`; tests use the virtual clock of `test/helpers/http.ts`. Adapters declare an `Endpoint` (`id`, `family`, `timeoutClass`, `decode`); `decode.ts` has the decoders, which throw `TransientResponseError` (retried, at most 2 extra attempts) or `ResponseValidationError` (permanent, disables that endpoint id for the run: later requests throw `EndpointDisabledError`). Permanent validation errors never touch AIMD or the circuit breaker and never trigger `staleFallback` (D26). The client reports through `onEvent` (`retry`, `changed`, `degraded`, …) and never decides anomaly severity.
- Internal API quirk: non-empty results are a JSON string containing the JSON (double-encoded); empty ones are `text/plain`. Always parse with `parseJsonBody`.
- `src/sources/` (§3, §6.2): `SituasPublicSource` (`fetchSnapshot`, `fetchEventList`, `fetchCount`; regime → `pfun` table and event code vocabularies in `situas-public/pfun.ts`), `SituasInternalSource` (r1–r9) and `AnprSource` (`fetchAnpr`, half-open dates, row issues, `AnprFormatError` for structural problems), wired by `createSources(client, config)`. Each endpoint's zod row schema normalises while validating (`normalise.ts`), so bad rows become `ResponseValidationError`. Field names are mapped explicitly per endpoint, never with generic fallbacks (D29; e.g. pfun 100 uses `COD_VARIAZIONE_M`). A `Stato estero` counterpart (only `AS`/`AN`/`CE`) becomes `abroad: true` with `related: null`, never a territory to resolve (D31).
- `scripts/fixtures-fetch.ts` (`npm run fixtures:fetch [-- <fixture path>...]`): downloads the §11.2 fixtures through the client and writes bodies exactly as served plus their manifest entries. With paths, only those are recorded (a full run re-records the event lists and counts at the download date, i.e. new files).
- `src/store/` (§6.3): `Store` (snapshots, event lists, internal reports). Rows go to append-only, content-addressed `RowLog`s (`row-log.ts`, row hash = SHA-256 of `canonicalJson`); each stored response has a zod-validated manifest (`manifest.ts`) with sorted `row_hashes`, `content_hash` (of the row hashes only), `adapter_stats` (outside the hash), `history` and `projection_version` (`projection-versions.ts`: bump an entry whenever an adapter changes its projection; manifests of another version are ignored, D32). Same content → no write. Event list puts return the semantic `added`/`removed` rows against everything the store knows in that range. Internal manifests are keyed by SHA-256 of the normalised unencoded report URL.
- `src/calendar/` (§6.4): pure `buildCalendar({ start, today, contributions })`, contributions built by `eventListContribution`, `internalEventsContribution` (r4–r6), `anprContributions`; regime boundaries and today are always added; `calendar.json` in the store keeps the sources of each date.
- `src/completeness/` (§6.5): `runSnapshots({ calendar, provider, anomalies, concurrency })` fetches every `(level, date)` of the calendar (memoised, bounded concurrency) and bisects each interval whose `S(d_i) ≠ S(d_{i+1} − 1)` (equality = manifest `content_hash`); inferred dates go into the global calendar (source `inferred`) and are verified for every level in later rounds. `storeSnapshotProvider` reads the store manifest first and fetches + stores only when missing or when `mustRefresh(level, date)`. Fetch failures become blocking anomalies by cause (`snapshot-unavailable` for network/5xx/429/open circuit, `snapshot-request-rejected` for non-retryable 4xx, `snapshot-schema-violation`, plus `completeness-unverified`), the run continues and the result is `blocked`; non-source errors propagate. Inferred dates carried over from `calendar.json` are dropped when no level changes on them any more (`info`); every inferred date left gets an `inferred-breakpoint` warning per changing level; `buildCalendar` drops `inferred` when a published event (public list or r4–r6) covers the date. `COD_PROV_STORICO` fallbacks become one `info` anomaly per level, from `adapter_stats`.
- `src/enrich/` (§6.8): `crawlInternal({ source, store, anomalies, concurrency, mustRefresh })` crawls r1/r2 → r4/r5 for every listed record → r7/r8 for every distinct event except `PV`/`CD`/`RN` (queried with the event row's own origin id and type), and r3 → r6 per pair (sorted; stored histories read first; pairs mentioned by a history are skipped). `obtainInternalReport` is store-first; a mandatory refresh that fails for unavailability falls back to the stored copy (or the HTTP cache), never for validation errors or 4xx. A fresh history replaces the stored ones of the same ids (`preferFresh`). Anomalies are aggregated per report (`internal-data-stale`/`internal-data-unavailable` warnings, `internal-request-rejected`/`internal-schema-violation` blocking) plus `listed-record-without-events` per record. `summariseEventCodes`/`saveEventCodeSummary` write `<paths.reports>/event-codes.json` (never the store).
- `src/identity/identity-graph.ts` (§5.1): `buildIdentityGraph` is a pure union-find over the `id → id_origine` pointers only; components carry `root` (unique chain end, checked against the oldest record), `ids`, typed `records` and the merged, deduplicated `events` (sorted by date, then canonical JSON). Root or record inconsistencies are blocking anomalies.
- `src/resolve/` (§6.6): `loadIntervalIndex(store, level, calendarDates, anomalies)` builds an `IntervalIndex` (code → maximal `[validFrom, validTo)` intervals of the same row hash; the last calendar date is open; a code duplicated in one snapshot → `snapshot-duplicate-code`, left out of that date). `CodeResolver.resolve({ level, code, date, side, cadastralCode? })` returns `{ intervalKey: "<code>@<validFrom>", interval, path }`: a snapshot interval, never an entity (Step 9 maps them). Order: direct on `date` (successor) or `date − 1` (predecessor), same-day aliases of `date` (chains, towards the side), cadastral code (municipalities only); not found or ambiguous → `ResolutionError`, `resolveOrReport` turns it into `code-unresolved` (blocking). Aliases: `municipalityAliases` (pfun 105: `code` = code of `D − 1`, `related.code` = code of `D`) and `internalAliases(graph, view, source)` (UTS/regions: `RN` old code from the same record's last earlier event; `ESCT` ↔ `CSCT` codes of a component on the same day).
- `src/anomalies.ts` (`AnomalyCollector`, anomalies are data) and `src/logger.ts` (NDJSON on stderr, `--verbose` enables `debug`; `logHttpEvents` maps the client's `onEvent`). The CLI passes `ctx.logger` to commands.
- `src/dates/`: all date handling goes through it. `calendar-date.ts` (ISO validation, day-number arithmetic, `DD/MM/YYYY` and `…T00:00:00Z` source formats, `currentDate()` in Europe/Rome, the only place a `Date` is read) and `interval.ts` (`HalfOpenInterval` internal ↔ `InclusiveInterval` public, membership, overlap, coverage, contiguity).
- `src/model/`: `common.ts` holds the shared vocabulary (levels, event codes, types, roles, code patterns, `PARTICIPANT_ROLE_RULES`), with each `as const` list feeding both the TS union and the zod enum. `internal.ts` has the camelCase pipeline types (snapshot projections, entities/versions with half-open intervals, variations whose `role: null` means no-effect). `public.ts` has the strict zod models of the emitted files (snake_case, keys in published order, per-record checks only; cross-record rules belong to the invariants). `json-schema.ts` generates `dist/schema/*.schema.json` from those models.

## Test fixtures (§11.1)

- `test/fixtures/` holds real SITUAS/ANPR responses at a path **derived from the request**; each file has exactly one entry in `test/fixtures/manifest.json` (`used_by` must reference a golden case `golden-<n>` of §11 or a quirk `quirk-<n>` of §3.5).
- `test/helpers/fixtures.ts`: `fixturePath`/`describeRequest` (request → path/source/endpoint), the manifest zod schema, and `createFixtureTransport()`, which serves only `full` fixtures and throws on anything unknown.
- `test/unit/fixtures-manifest.test.ts` enforces these rules (including parsing the plan to check `used_by`). Adding a fixture means adding its manifest entry with the conventional path; subsets are named `<base>__subset-<description>.<ext>` and must never be treated as complete.

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

- Every implementation happens on a **feature branch** created from `main` (never commit directly to `main`).
- When a step is finished, **ask the user before committing**.
- After finishing a step, remind the user to **start a new session** instead of continuing in the current one.
- Commit messages describe what was done (e.g. "Project scaffolding: …"), **never** the plan step (no "Step 1", "complete step N").

## Conventions that are not obvious

- **ESM + native TS**: relative imports use the `.ts` extension (`./config.ts`); `tsc` rewrites them to `.js` in `lib/` (`rewriteRelativeImportExtensions`). `erasableSyntaxOnly` is on: no `enum`, `namespace` or parameter properties.
- **`dist/` is the published dataset** (committed); compiled code goes to `lib/` (ignored). Never point build output at `dist/`.
- **Dates**: ISO `YYYY-MM-DD` strings, pure calendar arithmetic (no `Date` timezone logic). Internally half-open `[validFrom, validTo)`; the public JSON uses an inclusive `valid_until` — conversion only in the emitter (§4.1).
- **Line endings**: LF everywhere (`.gitattributes`, `.editorconfig`), except `test/fixtures/**`, which is `-text` and must stay byte-identical to the real API responses (the ANPR CSV is CRLF).
- Configuration lives in `src/config.ts` (zod schema with defaults from the plan; nested objects use `.prefault({})` so partial overrides still get inner defaults). `resolveConfig()` returns absolute paths.

## Architecture

Pipeline (§6): fetch → normalise → snapshot store → breakpoint calendar → snapshots + completeness bisection → identity resolution → versions → variations & links → internal enrichment → overrides → derived fields → ANPR cross-check → invariants → emit → changes. Each stage has its own directory under `src/` (layout in §14; empty directories hold a `.gitkeep` until their step is implemented).

- `src/cli.ts`: the §10.1 commands (`bootstrap`, `update`, `rebuild`, `audit`, `validate`, `diff`), currently stubs returning exit code 2. `main(argv, io, config)` is exported and testable; commands are declared in the `commands` table.
- `src/http/` (§6.1): `transport.ts` is the `Transport` contract (unencoded URLs/bodies; connection failures must be thrown as `NetworkError`, anything else is treated as a bug and not retried). `fetch-transport.ts` is the real one and the only place requests are encoded (`encode.ts`, strict RFC 3986, including the report URL inside internal API bodies). `client.ts` (`HttpClient`) composes `adaptive-limiter.ts` (AIMD pool), `token-bucket.ts`, `backoff.ts`, `circuit-breaker.ts` (per family = source, open for the whole run) and `cache.ts` (one atomic file per request; per-call policy `prefer` | `refresh` | `{ maxAgeDays }`, optional `staleFallback`). Time comes from an injectable `Clock`; tests use the virtual clock of `test/helpers/http.ts`. Adapters declare an `Endpoint` (`id`, `family`, `timeoutClass`, `decode`); `decode.ts` has the decoders, which throw `TransientResponseError` (retried, at most 2 extra attempts) or `ResponseValidationError` (permanent, opens the family circuit). The client reports through `onEvent` (`retry`, `changed`, `degraded`, …) and never decides anomaly severity.
- Internal API quirk: non-empty results are a JSON string containing the JSON (double-encoded); empty ones are `text/plain`. Always parse with `parseJsonBody`.
- `src/dates/`: all date handling goes through it. `calendar-date.ts` (ISO validation, day-number arithmetic, `DD/MM/YYYY` and `…T00:00:00Z` source formats, `currentDate()` in Europe/Rome, the only place a `Date` is read) and `interval.ts` (`HalfOpenInterval` internal ↔ `InclusiveInterval` public, membership, overlap, coverage, contiguity).
- `src/model/`: `common.ts` holds the shared vocabulary (levels, event codes, types, roles, code patterns, `PARTICIPANT_ROLE_RULES`), with each `as const` list feeding both the TS union and the zod enum. `internal.ts` has the camelCase pipeline types (snapshot projections, entities/versions with half-open intervals, variations whose `role: null` means no-effect). `public.ts` has the strict zod models of the emitted files (snake_case, keys in published order, per-record checks only; cross-record rules belong to the invariants). `json-schema.ts` generates `dist/schema/*.schema.json` from those models.

## Test fixtures (§11.1)

- `test/fixtures/` holds real SITUAS/ANPR responses at a path **derived from the request**; each file has exactly one entry in `test/fixtures/manifest.json` (`used_by` must reference a golden case `golden-<n>` of §11 or a quirk `quirk-<n>` of §3.5).
- `test/helpers/fixtures.ts`: `fixturePath`/`describeRequest` (request → path/source/endpoint), the manifest zod schema, and `createFixtureTransport()`, which serves only `full` fixtures and throws on anything unknown.
- `test/unit/fixtures-manifest.test.ts` enforces these rules (including parsing the plan to check `used_by`). Adding a fixture means adding its manifest entry with the conventional path; subsets are named `<base>__subset-<description>.<ext>` and must never be treated as complete.

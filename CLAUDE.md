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

## Commits

Commit messages describe what was done (e.g. "Project scaffolding: …"), **never** the plan step (no "Step 1", "complete step N").

## Conventions that are not obvious

- **ESM + native TS**: relative imports use the `.ts` extension (`./config.ts`); `tsc` rewrites them to `.js` in `lib/` (`rewriteRelativeImportExtensions`). `erasableSyntaxOnly` is on: no `enum`, `namespace` or parameter properties.
- **`dist/` is the published dataset** (committed); compiled code goes to `lib/` (ignored). Never point build output at `dist/`.
- **Dates**: ISO `YYYY-MM-DD` strings, pure calendar arithmetic (no `Date` timezone logic). Internally half-open `[validFrom, validTo)`; the public JSON uses an inclusive `valid_until` — conversion only in the emitter (§4.1).
- **Line endings**: LF everywhere (`.gitattributes`, `.editorconfig`), except `test/fixtures/**`, which is `-text` and must stay byte-identical to the real API responses (the ANPR CSV is CRLF).
- Configuration lives in `src/config.ts` (zod schema with defaults from the plan; nested objects use `.prefault({})` so partial overrides still get inner defaults). `resolveConfig()` returns absolute paths.

## Architecture

Pipeline (§6): fetch → normalise → snapshot store → breakpoint calendar → snapshots + completeness bisection → identity resolution → versions → variations & links → internal enrichment → overrides → derived fields → ANPR cross-check → invariants → emit → changes. Each stage has its own directory under `src/` (layout in §14; empty directories hold a `.gitkeep` until their step is implemented).

- `src/cli.ts`: the §10.1 commands (`bootstrap`, `update`, `rebuild`, `audit`, `validate`, `diff`), currently stubs returning exit code 2. `main(argv, io, config)` is exported and testable; commands are declared in the `commands` table.
- `src/http/transport.ts`: the `Transport` contract (unencoded URLs/bodies; the client encodes). The real client (step 3) and the test fixture transport both implement it.

## Test fixtures (§11.1)

- `test/fixtures/` holds real SITUAS/ANPR responses at a path **derived from the request**; each file has exactly one entry in `test/fixtures/manifest.json` (`used_by` must reference a golden case `golden-<n>` of §11 or a quirk `quirk-<n>` of §3.5).
- `test/helpers/fixtures.ts`: `fixturePath`/`describeRequest` (request → path/source/endpoint), the manifest zod schema, and `createFixtureTransport()`, which serves only `full` fixtures and throws on anything unknown.
- `test/unit/fixtures-manifest.test.ts` enforces these rules (including parsing the plan to check `used_by`). Adding a fixture means adding its manifest entry with the conventional path; subsets are named `<base>__subset-<description>.<ext>` and must never be treated as complete.

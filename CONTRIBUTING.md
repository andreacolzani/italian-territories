# Contributing

The generator is specified by [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md): read the sections a change touches before making it. The decisions of its §13 are not changed without discussion: open an issue first.

## Development

Node.js ≥ 22.18 runs the TypeScript sources directly (no build step needed to run them).

```sh
npm ci
npm run typecheck
npm test
npm run lint                  # ESLint + Prettier check (npm run format fixes the formatting)
npm run knip                  # unused files, exports and dependencies
npm run cli -- <command>      # bootstrap | update | rebuild [--refetch] | audit | validate | diff
```

Work on a branch created from `main` and open a pull request; `test.yml` runs the type check, the tests, `validate` on the published files and `release -- check`.

## Adding an override

Overrides are curated corrections of a published field, used only when ISTAT data are wrong or missing and a source documents the right value. They live in `overrides/`, one JSON file per topic, each an array of entries (§6.10 of the specification):

```json
{
  "key": "uts-059-abbreviation",
  "target": { "level": "province", "istat_code": "059", "date_from": "1934-10-26", "date_to": "1934-11-05" },
  "field": "abbreviation",
  "value": "LT",
  "reason": "SIGLA_UTS is missing from the ISTAT responses of that period; ISTAT reports LT for the same province from 1934-11-06",
  "source": "ISTAT",
  "source_url": "https://situas-servizi.istat.it/publish/reportspooljson?pfun=50&pdata=06%2F11%2F1934"
}
```

- `key`: kebab-case, unique across all the files.
- `target`: the UTS code and the period (inclusive, like the public files; `date_to: null` means no end). Overrides of the same field and code must not overlap.
- `field` and `value`: a closed set. Today only the UTS `abbreviation` (two uppercase letters) can be overridden; adding a field means extending the schema (`src/overrides/schema.ts`) and the applier, which needs discussion.
- `reason`, `source`, `source_url` (or `null`): why the value is right and where it comes from.

An invalid file, a duplicate key or an overlap stops the build (`OverrideFileError`). An override is applied to every day before versions are built: it may remove a version boundary, never create one (`override-creates-boundary` blocks the build). Every run checks that each override is still needed: one that matches no day, or whose days already hold its value, is reported as `override-obsolete` and should be removed.

After adding an override, rebuild offline from the store (`npm run cli -- rebuild`), check that the anomalies it fixed are gone, and add the CHANGELOG entry if `dist/` changed (below).

## Adding a test fixture

Fixtures are real SITUAS and ANPR responses in `test/fixtures/`, byte-identical to what the servers returned (the directory is `-text` in `.gitattributes`: never let an editor or git change their line endings). The rules are in §11.1 of the specification and enforced by `test/unit/fixtures-manifest.test.ts`:

1. The **path is derived from the request** (table of §11.1, e.g. `situas-public/snapshots/provinces/pfun-64_2026-01-01.json`); `test/helpers/fixtures.ts` (`fixturePath`) computes it.
2. Every file has **exactly one entry** in `test/fixtures/manifest.json`: path, source, endpoint, the unencoded request, `fetched_at`, `completeness` (`full` or `subset`), a note and `used_by`.
3. `used_by` references the golden cases (`golden-<n>`, §11 of the specification) or the source quirks (`quirk-<n>`, §3.5) the fixture documents: a new case is added to the specification first.
4. A file that is not the whole response is a **subset**: named `<base>__subset-<description>.<ext>` and declared `subset`; tests never treat it as a complete source.

To record a fixture, add its request to `scripts/fixtures-fetch.ts` (with its `used_by`) and download only it:

```sh
npm run fixtures:fetch -- situas-public/snapshots/provinces/pfun-64_2026-01-01.json
```

The script downloads through the generator's HTTP client, writes the body exactly as served and adds or replaces the manifest entry. Without paths it records every fixture again, and the event lists and counts get new files dated on the download day.

## Changelog

`CHANGELOG.md` has **one entry per release**, and a release happens only when the public files (`dist/`) change. Entries are not written by hand: `npm run release -- changelog` writes the entry of the release described by `reports/meta.json` and `reports/changes.json` (version `MAJOR.YYYYMMDD.PATCH`, change counts per level, retroactive flag) and updates the date between the `data-version` markers of the README.

- The weekly update writes it together with the data, in the same commit or pull request.
- A change of the generator that alters `dist/` (for example after `npm run cli -- rebuild`) must include it: run `npm run release -- changelog` before committing. `test.yml` runs `npm run release -- check`, which fails when the first entry or the README date do not match `reports/meta.json`.
- Changes that do not alter `dist/` (code, tests, documentation, `reports/` or `registry/` alone) get no entry.

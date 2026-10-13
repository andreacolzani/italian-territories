# italian-territories

A day-accurate historical dataset of the Italian **regions**, **provinces** (supra-municipal territorial units, UTS) and **municipalities**, from the Unification of Italy (**1861-03-17**) to today, reconstructed from ISTAT [SITUAS](https://situas.istat.it/) and kept up to date automatically.

**Data last changed: <!-- data-version -->2026-10-07<!-- /data-version -->**

The data are checked against ISTAT every week; this date changes only when the data change (a weekly check that finds nothing new leaves it, and the published files, as they are). It is the reference date of the build that produced the current files, and the `YYYYMMDD` of the npm version.

For every territory the dataset gives the full list of its versions (names, codes, memberships and their validity dates) and how it ceased into, or was born from, other territories. It answers questions such as _which municipalities existed on 1 January 1930, in which province?_ and _which municipality is today the territory of a birthplace recorded in 1920?_

- [Installation](#installation)
- [What is published](#what-is-published)
- [Conventions](#conventions)
- [Field reference](#field-reference)
- [Identity, versions and links](#identity-versions-and-links)
- [Resolution to the current territory](#resolution-to-the-current-territory)
- [Updates and versioning](#updates-and-versioning)
- [Licences](#licences)
- [The generator](#the-generator)

## Installation

```sh
npm install italian-territories
```

The package contains only data (JSON files) and type declarations: no executable code. Each file has its own entry point:

| Entry point                                     | Content                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `italian-territories/regions.json`              | Regions (with TypeScript types)                                                            |
| `italian-territories/provinces.json`            | Provinces (UTS) (with TypeScript types)                                                    |
| `italian-territories/municipalities.json`       | Municipalities (with TypeScript types)                                                     |
| `italian-territories/schema/<file>.schema.json` | JSON Schemas: `regions.schema.json`, `provinces.schema.json`, `municipalities.schema.json` |
| `italian-territories/package.json`              | The package manifest, whose `version` carries the date of the data                         |

```js
import municipalities from 'italian-territories/municipalities.json' with { type: 'json' };
import pkg from 'italian-territories/package.json' with { type: 'json' };

// The version is MAJOR.YYYYMMDD.PATCH: YYYYMMDD is the date the data last changed.
const [, yyyymmdd] = pkg.version.split('.');
const dataDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}`;
```

With CommonJS: `const municipalities = require('italian-territories/municipalities.json');`.

The same files are attached to every [GitHub Release](https://github.com/andreacolzani/italian-territories/releases) and committed in the repository's `dist/` directory.

### TypeScript

The package declares the type of each file, generated from its JSON Schema: importing a JSON file gives a typed array, and the same module exports the types of its records (`Region`, `RegionVersion`, `Province`, `ProvinceVersion`, `Municipality`, `MunicipalityVersion`, `Link`, and the array types `Regions`, `Provinces`, `Municipalities`). They work with `moduleResolution` `node16`, `nodenext` or `bundler` (resolution through the package `exports`).

```ts
import municipalities from 'italian-territories/municipalities.json' with { type: 'json' };
import type { Municipality, MunicipalityVersion } from 'italian-territories/municipalities.json';

/** The version of a municipality valid on `date`, if any. */
function versionOn(entity: Municipality, date: string): MunicipalityVersion | undefined {
  return entity.versions.find((v) => v.valid_from <= date && (v.valid_until === null || v.valid_until >= date));
}

const active: Municipality[] = municipalities.filter((m) => m.status === 'active');
```

With CommonJS (`require`), the types are in the namespace of the module: `import municipalities = require('italian-territories/municipalities.json')` and `municipalities.Municipality`.

The types describe the shape of the records; the patterns of the strings (ids, codes, dates) are in their documentation comments and in the JSON Schemas. The package has no functions: a JavaScript/TypeScript API on top of the data, if ever, will be a separate package.

## What is published

| File (repository and package)                                                            | Content                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dist/regions.json`                                                                      | Array of region entities (regions since 1948, _compartimenti_ before)                                                           |
| `dist/provinces.json`                                                                    | Array of UTS entities: provinces, autonomous provinces, metropolitan cities, free municipal consortia, non-administrative units |
| `dist/municipalities.json`                                                               | Array of municipality entities                                                                                                  |
| `dist/schema/regions.schema.json`, `provinces.schema.json`, `municipalities.schema.json` | JSON Schemas (draft 2020-12) of the three files                                                                                 |

The npm package adds the TypeScript declarations generated from the schemas (`types/`).

That is all. The dataset is **self-contained** and makes no assumption about how it is used or stored: it describes the territories only. In particular it does **not** contain:

- the ISTAT history itself: acts, variations, events and ISTAT internal identifiers (origin ids, act ids);
- synchronisation files (diffs between releases, lists of changes);
- a date or any other metadata inside the data files (the date of the data is in this README and in the npm version, see [Updates and versioning](#updates-and-versioning)).

**Scope.** Exactly the territories modelled by ISTAT SITUAS: regions (including the pre-1948 _compartimenti_), every type of UTS, municipalities. Not covered: _circondari_ and _distretti_ (before 1927), macro-areas (_ripartizioni_), capital-city flags, statutes, NUTS codes, boundaries or geometries, _frazioni_, territories never documented by SITUAS.

**Partial cessions are not represented.** The files describe which territories existed and how one ceased into others, not the flows of territory between entities that continue to exist. When an entity gives part of its territory to another existing entity, or abroad, and survives (Gorizia and Trieste in 1947, parts of territory passed between municipalities), nothing in the public files records it.

## Conventions

- **De iure dates.** Dates are the administrative (legal) validity dates of ISTAT, not the de facto ones.
- **Up to the date of the data.** The files describe the territories up to the date of the data (at the top of this page): the versions with `valid_until: null` are those in force on that day, and the weekly checks confirm them until a change is recorded. A change ISTAT has already recorded with a later effective date (e.g. a merger from the next 1 January) is not in the files until that date arrives: it enters with the first update on or after its effective date. The data never describe the future.
- **Dates** are ISO calendar dates `YYYY-MM-DD`, with no time and no timezone.
- **Inclusive end.** A version is valid from `valid_from` to `valid_until`, **both included**; `valid_until` is `null` for the current version. A version is valid on day D when `valid_from <= D` and (`valid_until` is `null` or `valid_until >= D`). One-day versions exist (`valid_from == valid_until`). Since ISO dates sort as strings, the comparison can be done on the strings.
- **Link dates** are the first day of the new state: the day after `valid_until` of the closed version, and `valid_from` of the opened one.
- **Strings** are Unicode NFC and trimmed; the ISTAT casing is preserved.
- **Order.** Versions are sorted by `valid_from`; links by `id`, then `kind`. The order of the entities in the files is stable (the same data always come in the same order), but it is not part of the contract: do not rely on it.

```js
// Municipalities that existed on 1930-01-01, with the version valid on that day.
const on = (date) => (v) => v.valid_from <= date && (v.valid_until === null || v.valid_until >= date);
const existing = municipalities
  .map((m) => ({ id: m.id, version: m.versions.find(on('1930-01-01')) }))
  .filter((m) => m.version !== undefined);
```

## Field reference

### Entity fields

Every entity of the three files has these fields, in this order (`current_successors` only in `municipalities.json`).

| Field                | Type                         | Semantics                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string                       | Stable id of the entity: `reg-`, `prv-` or `mun-` and 6 Crockford base32 characters (pattern `^(reg\|prv\|mun)-[0-9A-HJKMNP-TV-Z]{6}$`), e.g. `mun-J5RTK7`. Unique in the whole dataset, never changed, never reused. See [Identity](#identity-versions-and-links).                                                                       |
| `status`             | `"active"` \| `"suppressed"` | `active` when the last version is current (`valid_until` is `null`), `suppressed` otherwise.                                                                                                                                                                                                                                              |
| `is_former_italian`  | boolean                      | `true` when the entity ceased to exist because it was ceded abroad, directly or because **all** its successors were (e.g. it merged into a municipality later ceded to Yugoslavia). It does not measure losses of territory: partial cessions of entities that continue to exist are not represented. Always `false` for active entities. |
| `predecessors`       | Link[]                       | The entities this entity was born from, linked on the day of its first `valid_from`. Empty when it was not born from other entities of the same level (e.g. it exists since 1861-03-17, or it was annexed).                                                                                                                               |
| `successors`         | Link[]                       | The entities this entity ceased into, linked on the day after the `valid_until` of its last version. Empty for active entities, also when they had a gap (an entity suppressed and later reconstituted with the same identity has no successors). Empty for a suppressed entity whose territory went entirely abroad.                     |
| `current_successors` | string[]                     | **Municipalities only.** Ids of the currently active municipalities reached by following `successors` transitively (through every link kind); sorted, without duplicates. Empty for active municipalities. See [Resolution](#resolution-to-the-current-territory).                                                                        |
| `versions`           | Version[]                    | The versions of the entity, at least one, sorted by `valid_from`, non-overlapping. Consecutive versions are either contiguous or separated by a gap in which the entity did not exist.                                                                                                                                                    |

### Link

| Field  | Type                                                   | Semantics                                                                                                                                                                                  |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`   | string                                                 | The linked entity, always of the same level.                                                                                                                                               |
| `kind` | `"merged_into"` \| `"split_into"` \| `"detached_into"` | How territory flowed from the origin (the entity in whose `successors` the link appears, or the linked entity of a `predecessors` link) to the destination. See [Link kinds](#link-kinds). |
| `date` | string (date)                                          | First day of the new state.                                                                                                                                                                |

### Version fields (all levels)

| Field           | Type                  | Semantics                                                                                                                                                                                                                                                                                               |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid_from`    | string (date)         | First day the version is valid. With the entity id it identifies the version.                                                                                                                                                                                                                           |
| `valid_until`   | string (date) \| null | Last day the version is valid (inclusive); `null` for the current version.                                                                                                                                                                                                                              |
| `istat_code`    | string                | ISTAT code during the version, zero-padded: 2 digits for regions, 3 for UTS, 6 for municipalities (the first 3 are the code of the UTS, with the exception below). Codes change over time and are reused by different entities at different times: they identify a territory only together with a date. |
| `official_name` | string                | Official denomination, as published by ISTAT; for bilingual territories both forms (`Bolzano/Bozen`, `Valle d'Aosta/Vallée d'Aoste`, or the municipality's official bilingual name).                                                                                                                    |
| `italian_name`  | string                | Italian denomination. Equal to `official_name` for territories with a single-language name.                                                                                                                                                                                                             |
| `foreign_name`  | string \| null        | Denomination in the other official language (German, French, Slovenian, …), `null` when there is none.                                                                                                                                                                                                  |

**Bilingual names of regions and UTS.** ISTAT publishes a single denomination with `/` between the languages. The dataset splits it with a closed table, valid at every level where the denomination is used; any other denomination with `/` would stop the build instead of being split by guesswork.

| `official_name`                | `italian_name`        | `foreign_name`      | Source                                              |
| ------------------------------ | --------------------- | ------------------- | --------------------------------------------------- |
| `Trentino-Alto Adige/Südtirol` | `Trentino-Alto Adige` | `Trentino-Südtirol` | Statute of autonomy (D.P.R. 31 August 1972, n. 670) |
| `Valle d'Aosta/Vallée d'Aoste` | `Valle d'Aosta`       | `Vallée d'Aoste`    | ISTAT official denomination                         |
| `Bolzano/Bozen`                | `Bolzano`             | `Bozen`             | ISTAT official denomination                         |

Municipality names are never split: `official_name`, `italian_name` and `foreign_name` are those ISTAT publishes for the municipality.

### Region version fields

| Field  | Type                          | Semantics                                                                                                                                                                                             |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type` | `"compartment"` \| `"region"` | `compartment` (_compartimento_, statistical division) until 1947-12-31, `region` from 1948-01-01. A compartment and the region that follows it are the same entity, with a new version on 1948-01-01. |

### Province (UTS) version fields

| Field          | Type                                                                                                                             | Semantics                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | `"province"` \| `"autonomous_province"` \| `"metropolitan_city"` \| `"free_municipal_consortium"` \| `"non_administrative_unit"` | Type of UTS (ISTAT types 1 to 5): province; autonomous province (Bolzano/Bozen, Trento); metropolitan city; free consortium of municipalities (Sicily); non-administrative unit (the former provinces of Friuli-Venezia Giulia since 2017–2018). A change of type is a new version of the same entity (e.g. the province of Milano becoming a metropolitan city). |
| `abbreviation` | string                                                                                                                           | Two uppercase letters (`^[A-Z]{2}$`), never null: the abbreviation of the UTS (as on vehicle plates). Unique among the UTS existing on a date, reused over time. Before 1948 it is derived from the municipality data (ISTAT does not publish it), with a few curated corrections.                                                                                |
| `region_id`    | string                                                                                                                           | Id of the region entity the UTS belonged to during the version.                                                                                                                                                                                                                                                                                                   |

### Municipality version fields

| Field            | Type           | Semantics                                                                                                                                                                                                            |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cadastral_code` | string \| null | Cadastral (Belfiore) code, one letter and three digits (`^[A-Z]\d{3}$`), e.g. `H501`; `null` when ISTAT has none for the period. Unique among the municipalities existing on a date. It may change within an entity. |
| `province_id`    | string         | Id of the UTS entity the municipality belonged to during the version.                                                                                                                                                |
| `region_id`      | string         | Id of the region entity, always equal to the `region_id` of the province over the whole version (denormalised for convenience).                                                                                      |

**Codes with suffix 800 or above.** ISTAT assigns codes such as `095809` retroactively to municipalities suppressed long ago. Their first three digits do **not** indicate the province of the municipality: they may be the code of a province created later or of an earlier one. E.g. `095809` is the code of the former municipality of Siamanna, in the province of Cagliari, merged into Villaurbana in 1928 (last day 1928-05-03): `095` is the code of Oristano, a province created only in 1974. (That Siamanna is a different entity from the current Siamanna of the [example below](#versions), born in 1947 as Siamanna-Siapiccia.) For versions with a 6-digit `istat_code` whose last three digits are `800` or more, never derive the province from the code: use `province_id`.

## Identity, versions and links

### Entities and ids

An **entity** is a line of administrative continuity, as ISTAT records it. It survives renames, new codes, changes of province or region and changes of type (a province becoming a metropolitan city, a compartment becoming a region). A municipality reconstituted by ISTAT with its original identity is the same entity, with a gap between its versions; a province reconstituted by ISTAT as a new unit is a new entity. Identity is never guessed from names or codes.

Entity ids (`reg-…`, `prv-…`, `mun-…`) are assigned once, when the entity first enters the dataset, and **never change and are never reused**, also when ISTAT renumbers the territory or corrects its history. They do not encode any ISTAT number: do not parse them. No ISTAT identifier is published.

### Versions

A **version** is a maximal period during which every published field of the entity is constant: a new version starts whenever any of its fields changes, `province_id` and `region_id` included. Changes of the parent itself (a province renamed, renumbered or given a new abbreviation) do not create versions of its municipalities: the parent's id does not change.

Versions have no id of their own: a version is identified by **(entity id, `valid_from`)**. The dataset prescribes no database structure: choose your own keys.

Example (`municipalities.json`, the current Siamanna, born in 1947 as Siamanna-Siapiccia from the territory of Villaurbana):

```json
{
  "id": "mun-J5RTK7",
  "status": "active",
  "is_former_italian": false,
  "predecessors": [{ "id": "mun-ZMV2F9", "kind": "detached_into", "date": "1947-11-28" }],
  "successors": [],
  "current_successors": [],
  "versions": [
    {
      "valid_from": "1947-11-28",
      "valid_until": "1974-08-19",
      "istat_code": "092128",
      "cadastral_code": "I719",
      "official_name": "Siamanna-Siapiccia",
      "italian_name": "Siamanna-Siapiccia",
      "foreign_name": null,
      "province_id": "prv-KFWWV0",
      "region_id": "reg-MYRFEY"
    },
    {
      "valid_from": "1974-08-20",
      "valid_until": "1974-09-12",
      "istat_code": "095057",
      "cadastral_code": "I719",
      "official_name": "Siamanna-Siapiccia",
      "italian_name": "Siamanna-Siapiccia",
      "foreign_name": null,
      "province_id": "prv-4M2T0N",
      "region_id": "reg-MYRFEY"
    },
    {
      "valid_from": "1974-09-13",
      "valid_until": "2025-12-31",
      "istat_code": "095057",
      "cadastral_code": "I718",
      "official_name": "Siamanna",
      "italian_name": "Siamanna",
      "foreign_name": null,
      "province_id": "prv-4M2T0N",
      "region_id": "reg-MYRFEY"
    },
    {
      "valid_from": "2026-01-01",
      "valid_until": null,
      "istat_code": "115064",
      "cadastral_code": "I718",
      "official_name": "Siamanna",
      "italian_name": "Siamanna",
      "foreign_name": null,
      "province_id": "prv-4M2T0N",
      "region_id": "reg-MYRFEY"
    }
  ]
}
```

In 1974 the municipality moved to the new province of Oristano (`province_id` changes); on 2026-01-01 only its `istat_code` changes, because the province of Oristano was renumbered: `province_id` stays the same.

### Link kinds

`predecessors` and `successors` link entities of the same level. A link appears in the `successors` of its origin and in the `predecessors` of its destination, with the same `kind` and `date`.

| Kind            | Meaning                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `merged_into`   | The origin ceased to exist and its territory went to **one** destination (new or existing). E.g. a municipality merged into another.                                                                                                                               |
| `split_into`    | The origin ceased to exist and its territory went to **several** destinations on the same date: one `split_into` link per destination. E.g. the province of Sud Sardegna in 2026; Tenda in 1947 (the part that stayed Italian, to Briga Alta and Limone Piemonte). |
| `detached_into` | The origin **continued to exist** and gave part of its territory to a **new** entity. E.g. Villaurbana → Siamanna-Siapiccia in 1947.                                                                                                                               |

Transfers of part of a territory between entities that both continue to exist, and cessions to or annexations from foreign states, produce no link (see [Partial cessions](#what-is-published)). An entity annexed from abroad has no predecessors; an entity whose territory went entirely abroad has no successors and `is_former_italian: true`. An entity ceded abroad except for some parts that went to Italian entities on the same day (Tenda in 1947) has those links as successors and is still `is_former_italian: true`.

## Resolution to the current territory

**Municipalities.** To move a stored reference to a municipality (an address, a birthplace) to the territory that exists today:

1. if the entity is `active`, its current version (the one with `valid_until: null`) is the answer;
2. if it is suppressed, the reference can be moved **automatically only** when `is_former_italian` is `false`, `current_successors` has **exactly one** element, and **no** successor of the entity, direct or indirect (following `successors` transitively), has `is_former_italian: true`: the answer is that single element;
3. otherwise the case needs **human supervision**: a former Italian entity (its `current_successors`, if any, are only the parts of its territory that stayed Italian), an entity with several current successors, or one with a former Italian entity somewhere along its successors. E.g. Occisla-Clanzo, suppressed in 1923: its only current successor is San Dorligo della Valle-Dolina, but Erpelle-Cosina, ceded in 1947, is also among its successors.

```js
const byId = new Map(municipalities.map((m) => [m.id, m]));

/** The current municipality id of `id`, or null when the case needs supervision. */
function currentMunicipality(id) {
  const entity = byId.get(id);
  if (entity.status === 'active') return id;
  if (entity.is_former_italian || entity.current_successors.length !== 1) return null;
  const seen = new Set([id]);
  const queue = entity.successors.map((l) => l.id);
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    const successor = byId.get(next);
    if (successor.is_former_italian) return null;
    queue.push(...successor.successors.map((l) => l.id));
  }
  return entity.current_successors[0];
}
```

**Provinces and regions** have no such rule and no `current_successors`: when a province is reorganised its territory spreads over several provinces, and the closure of its links would not say where a given place went. Their `predecessors`, `successors` and `is_former_italian` describe their own history. A reference to a province or region is resolved **through the municipalities**: every municipality version carries its `province_id` and `region_id`, so the current province and region of a place are those of the current version of its (resolved) municipality.

## Updates and versioning

- **Cadence.** The data are checked against ISTAT every week (Monday, 04:00 UTC). A new release is published only when the public files change. Changes that alter days already published (ISTAT often publishes events late, or corrects its history) are reviewed by the maintainer before release.
- **Date of the data.** The date at the top of this README ("Data last changed") is the reference date of the build that produced the current files. It changes only when the data change, not at every weekly check.
- **npm version** `MAJOR.YYYYMMDD.PATCH`: `YYYYMMDD` is the date of the data; `MAJOR` changes with incompatible changes of the file format (JSON Schemas); `PATCH` counts further releases with the same data date (e.g. new JSON Schemas with the same data). Each release has a git tag `v<version>` and a GitHub Release.
- **Changelog.** [`CHANGELOG.md`](CHANGELOG.md) has one entry per release, with the number of entities and versions added, updated and removed per level, and whether the release changed days already published.

The repository also holds, for reviewers of the data, the internal reports of each release in `reports/` (the variations and ISTAT acts the links are derived from, the anomalies found while building, the changes against the previous release, the sources' metadata). They are part of the repository, not of the dataset: they are not in the npm package nor in the GitHub Releases, and their format may change at any time.

## Licences

- **Data** (`dist/`): [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0), see [`LICENSE-DATA`](LICENSE-DATA) (the `LICENSE` of the npm package). The data are an **elaboration of ISTAT data** (SITUAS): reconstructed, normalised and given their own identifiers by this generator. They are not ISTAT data as published, and ISTAT does not endorse them. Attribution: _italian-territories, elaboration of ISTAT – SITUAS data_.
- **Generator** (the code of this repository): MIT, see [`LICENSE`](LICENSE).

## The generator

This repository also contains the generator that builds the dataset (Node.js ≥ 22.18, TypeScript run natively): it downloads the territorial snapshots and the history of ISTAT SITUAS, verifies their completeness day by day, reconstructs entities, versions and links, cross-checks the municipalities with the ANPR archive, checks a set of invariants (a build with any violation is never published) and writes `dist/`. It runs weekly on GitHub Actions.

```sh
npm ci
npm test
npm run cli -- validate    # checks the invariants on the published files
```

The specification is [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md); how to contribute (overrides, test fixtures, changelog) is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

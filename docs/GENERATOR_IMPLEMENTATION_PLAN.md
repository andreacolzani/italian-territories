# Italian Territories History — Generator: Implementation Plan

> **Audience:** Claude Code (and human maintainers).
> **Purpose:** complete specification and step-by-step plan to implement the *generator* package, which builds a historically complete, day-accurate dataset of Italian regions, supra-municipal territorial units (UTS/provinces) and municipalities from 17 March 1861 to today, and keeps it up to date through GitHub Actions.
> The Laravel consumer package is **out of scope** here; this document only defines the data contract it will consume.

---

## 0. How to use this document

- Implement the steps in **§12** in order. Each step lists deliverables and acceptance criteria. Do not start a step before the previous one passes its acceptance criteria. 
- Sections §1–§11 are the **specification**. When a step references a rule, the rule lives there. If implementation reveals a contradiction or a case not covered, **stop and ask** instead of improvising: the decisions in §13 were reached after analysing real SITUAS/ANPR data and must not be silently changed.
- Every behaviour described as an *invariant* (§8) must be enforced by code, not by convention.
- Real API responses used during design are listed in **§11 (golden cases)**. Store them as test fixtures.

---

## 1. Goals and scope

### 1.1 Goals

1. For each territorial level (region, UTS/province, municipality), produce the full history of every entity as a list of **versions** with validity dates, so that a consumer can answer: *which regions / provinces / municipalities existed on date D, with which names, codes and memberships?*
2. Link entities through **variations** (suppressions, establishments, mergers, splits, territory transfers, cessions abroad, annexations) so that a consumer can move a stored reference (e.g. an address or a birthplace) to the **currently valid** entity.
3. Guarantee **consistency and completeness** through machine-checked invariants.
4. Keep the dataset **up to date automatically** (weekly), fetching only what changed, while detecting retroactive corrections made by ISTAT.

### 1.2 Scope

- Levels: regions (including pre-1948 *compartimenti*), UTS/provinces (all UTS types), municipalities.
- Period: **1861-03-17** (Unification) → today.
- Perimeter: exactly the one modelled by ISTAT SITUAS. Territories never documented by SITUAS are out of scope and must not be mentioned (e.g. 1941–1943 occupations).
- Legal view: data is **de iure** (administrative validity dates), not de facto.
- Out of scope for v1: *circondari/distretti* (pre-1927), macro-areas (*ripartizioni*), capital-city flags, region/province statutes, NUTS codes. The design must not prevent adding them later.

### 1.3 Non-goals

- No geometry/boundaries.
- No street-level or *frazione*-level data.
- No Laravel/DB code (separate package).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Entity** | A line of administrative continuity (ISTAT "origin" identity). Survives renames, renumbering, change of parent, change of type (e.g. province → metropolitan city, compartment → region). |
| **Version** | A maximal period during which *all* published attributes of an entity are constant. |
| **Variation** | An ISTAT act (*provvedimento*) applied on a given date, with N participants and M links. |
| **Participant** | An entity affected by a variation, with the ISTAT event codes it received and the versions it closed/opened. |
| **Link** | A territory flow between two entities of the same level inside a variation (`merged_into`, `detached_into`, `transferred_to`). |
| **Snapshot** | The complete list of territories of one level existing on one date, as returned by SITUAS public "existing at date" APIs. |
| **Breakpoint** | A date on which at least one snapshot may differ from the previous day. |
| **Regime** | A period for which SITUAS exposes a specific snapshot function (`pfun`): ≤1927-01-11, 1927-01-12…1947-12-31, ≥1948-01-01. |
| **UTS** | *Unità territoriale sovracomunale*: province, autonomous province, metropolitan city, free consortium of municipalities, non-administrative unit. |
| **Same-day alias** | A code assigned to an entity on day D by a code-change event, when on the same day D the entity is also suppressed (or the code otherwise never appears in any snapshot). |

ISTAT event codes: `PV` first validity, `CS` establishment, `CSCT` establishment by type change, `AN` annexation from foreign state, `AQES` acquisition by extinction, `AQ` territory acquisition, `CE` territory cession, `CECS` cession for establishment of a new unit, `CD` rename, `AP` change of parent, `CDAP` rename + change of parent, `RN` renumbering, `RNAPUTS` renumbering after UTS change (undocumented by ISTAT), `VACST` change of statute type, `ES` extinction, `ESCT` extinction by type change, `AS` cession to foreign state.

---

## 3. Sources

### 3.1 Summary of roles

| Source | Role |
|---|---|
| SITUAS public **snapshot** APIs | **Source of truth** for existence, codes, names, cadastral codes, membership, types, abbreviations. |
| SITUAS public **event list** APIs | Breakpoint calendar; municipality variations and links (complete by event type for municipalities). |
| SITUAS **internal** APIs | Identity (`*_origine` ids) for all levels; events + details for UTS and regions (required: public lists miss UTS `RN`, `AP`, territorial events); ISTAT act ids for municipalities. |
| ANPR CSV | **Cross-check only.** Never writes data into the output. |
| ISTAT current municipalities xlsx | **Not used** (redundant with snapshot APIs at today's date). |

### 3.2 SITUAS public APIs

Base: `GET https://situas-servizi.istat.it/publish/reportspooljson?pfun=<id>&<params>`
Count variant: same URL with `reportspooljsoncount` instead of `reportspooljson`.
Date parameters use `DD/MM/YYYY`. Responses: `{ "resultset": [ ... ] }`.

**Snapshots** (param `pdata`):

| Level | 1861-03-17 … 1927-01-11 | 1927-01-12 … 1947-12-31 | 1948-01-01 … today |
|---|---|---|---|
| Regions / compartments | `pfun=44` | `pfun=46` | `pfun=68` |
| UTS / provinces | `pfun=48` | `pfun=49` | `pfun=64` |
| Municipalities | `pfun=51` | `pfun=50` | `pfun=61` |

Relevant fields (others must be ignored):

- Regions: `COD_COMP`/`COD_REG`, `DEN_COMP`/`DEN_REG`. Post-1948 `TIPO_REG` is a statute type and is **not** published.
- UTS pre-1948: `COD_PROV`, `DEN_PROV`, `COD_COMP`. No type (always `province`), **no abbreviation** (derive it, §6.9).
- UTS post-1948: `COD_UTS`, `DEN_UTS`, `COD_REG`, `TIPO_UTS` (1..5), `SIGLA_AUTOMOBILISTICA`, `COD_PROV_STORICO` (internal use only, §5.5), `COD_PROV_FISCALE` (auxiliary matching signal only, §6.7).
- Municipalities: `PRO_COM_T`, `COMUNE` (official), `COMUNE_IT`, `COMUNE_A` (may be absent), `COD_CATASTO`, parent code (`COD_PROV` pre-1948, `COD_UTS` post-1948), region code (`COD_COMP` / `COD_REG`), `SIGLA_UTS` / `SIGLA_AUTOMOBILISTICA`, `COD_PROV_STORICO` (post-1948).

Snapshot semantics (verified: Setteville absent on 2024-01-21, present on 2024-01-22): **the snapshot on date D includes every event whose administrative date is ≤ D.**

Observed sizes: municipalities 7,000–9,200 rows per snapshot; UTS ≤ ~110; regions ≤ ~25.

**Event lists** (params `pdatada=17/03/1861&pdataa=<today>`):

| Level | Suppressed / ceded | Established / annexed | Renamed | Other |
|---|---|---|---|---|
| Regions | `106` (ES, ESCT, AS) | `107` (CS, CSCT, AN) | `108` (CD) | — |
| UTS | `112` (ES, ESCT, AS) | `113` (CS, CSCT, AN) | `114` (CD) | — |
| Municipalities | `98` (ES, AS) | `100` (CS, AN) | `104` (CD) | `105` (RN, AP, CDAP, RNAPUTS), `103` (AQES, CE, AQ, CECS) |

Dates come as `YYYY-MM-DDT00:00:00Z` in `DATA_INIZIO_AMMINISTRATIVA`. `*_REL` fields identify the related territory. `FLAG_ES_SCORPORO` marks multi-successor rows (one row per successor). Public lists **do not** carry ISTAT act ids.

Observed full-range sizes: 98 → 3,618; 100 → 4,291; 103 → 5,927; 104 → 2,765; 105 → 4,761; 112 → 48; 113 → 108; 114 → 31; 106 → 31; 107 → 35; 108 → 2.

### 3.3 SITUAS internal APIs

`POST https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl`
Headers: `Content-Type: application/json`, `Accept: application/json`.
Body: `{ "url": "<report url>" }` — the report URL must be built with properly URL-encoded parameter values (names contain accents and apostrophes, e.g. `Agliè`, `Valle d'Aosta`).
Responses: `{ "items": [ ... ] }`. Dates as `DD/MM/YYYY`.

| # | Report URL | Returns |
|---|---|---|
| 1 | `var_get_ua_reg_lov_diffusione?reg=` | All regions ever: `cod_regione`, `denominazione regione`, `tipo regione` (1 compartment, 2 region), `id_regione_origine`. |
| 2 | `var_get_ua_uts_lov_diffusione?uts=` | All UTS ever: `cod_uts`, `denominazione_uts`, `tipo uts` (1..5), `id_uts_origine`. |
| 3 | `var_get_ua_comuni_lov_diffusione?com=` | All municipalities ever: `pro_com_t`, `comune` (no id). |
| 4 | `var_get_ua_reg_lov_rs?&codreg=<code>&reg=<name>&reg_tipo=<type>` | Events of a region. |
| 5 | `var_get_ua_uts_lov_rs?&uts=<name>&coduts=<code>&uts_tipo=<type>` | Events of **one typed UTS record** (`id_uts`, `id_uts_origine`). A type change creates a new `id_uts`: querying the metropolitan city returns only its own events (from `CSCT` on), querying the former province returns the province's events. |
| 6 | `var_get_ua_comuni_lov_rs?procom=<code>&com=<name>` | Events of a municipality (`id_comune_origine`, `identificativo provvedimento`). Any historical (code, name) pair of the entity returns the same full history. |
| 7 | `var_get_ua_reg_lov_rs_dett_ass?&reg_tipo=<t>&idprovv=<act>&mcrvar=<event>&id_regione_origine=<id>` | Associated regions of one event. |
| 8 | `var_get_ua_uts_lov_rs_dett_ass?&id_uts_origine=<id>&idprovv=<act>&uts_tipo=<t>&mcrvar=<event>` | Associated UTS of one event. |
| 9 | `var_get_ua_comuni_lov_rs_dett_ass?idcomuneorig=<id>&mcrvar=<event>&idprovv=<act>` | Associated municipalities of one event (optional in v1; public REL fields suffice). |

Event rows contain: event code (`tipo variazione`), date (`data evento`), code and name **at the time of the event** (`codice Istat`, `denominazione`), act id (`identificativo provvedimento`), origin id.

The internal API is undocumented and may change or become unavailable: see §6.1 (degradation).

### 3.4 ANPR

`GET https://www.anagrafenazionale.interno.it/wp-content/uploads/ANPR_archivio_comuni.csv` (UTF-8, CRLF, quoted).
Columns used: `DATAISTITUZIONE`, `DATACESSAZIONE` (**inclusive**, `9999-12-31` = open), `CODISTAT`, `CODCATASTALE` (`ND` = unknown), `DENOMINAZIONE_IT`, `ALTRADENOMINAZIONE`, `IDPROVINCIAISTAT`, `IDREGIONE` (`EX` = former Italian territory), `SIGLAPROVINCIA`, `STATO` (`A`/`C`).

Known ANPR problems (all verified): rows split by territorial events with identical attributes; anachronistic historical provinces (e.g. Trentino 1920–23 assigned to province 022); lags behind reorganisations (Sardinia 2026 not applied as of June 2026); off-by-one cessation dates on some suppressed municipalities; 489 of 3,309 suppressed municipalities entirely missing (mostly 1866–1873 and 1924); a few overlaps and `IDREGIONE = 00` rows.

### 3.5 Data quirks the implementation must handle (all verified on real data)

1. **Inconsistent types**: `TIPO_UTS` is a number in snapshots and a string in event lists; flags are numbers or strings. Normalise.
2. **Unstable field sets**: some fields carry a year suffix (`COD_NUTS3_2024`) and are missing for new entities. Adapters read only the fields they need, ignore unknown ones, and fail only when a *required* field is missing.
3. **Missing values**: `""`, `" "`, `"ND"` → `null`. Pre-1930 suppressed municipalities often have no cadastral code (both SITUAS and ANPR report `ND`).
4. **Code reuse**: ISTAT codes of suppressed municipalities are later reassigned to different municipalities. Never match entities across time by code alone; match only across consecutive snapshots with event support.
5. **Name reuse**: a new entity may have the same name as a suppressed one (2024: new *Sovizzo*, code 024128, cadastral M436, replaces old *Sovizzo* 024103/I879). Never infer identity from names.
6. **REL code side**: in event rows and details, a related territory that is a **successor** is identified by its code **on date D**; a related territory that is a **predecessor** is identified by its code **on D−1** (e.g. Sud Sardegna ES → Nuoro `114`, but Ogliastra CS ← Nuoro `091`).
7. **Same-day aliases**: 20 suppressions carry a code assigned the same day (17 on 1927-01-12, e.g. Finalborgo/Finale Marina/Finale Pia moved to the new province of Savona and merged into Finale Ligure the same day; 2 on 1923-02-08; 1 on 1936-06-04, Cantonale). In 15 suppressions the *absorbing* municipality's REL code is also a same-day new code. All resolvable through pfun 105 (§6.6).
8. **UTS renumbering is invisible in public lists** (2026: Nuoro 091→114, Oristano 095→115, Cagliari metropolitan city 292→318). Only internal API 5 records it (`RN`, same `id_uts`).
9. **Municipality code prefix ≠ UTS code** for metropolitan cities: the prefix is `COD_PROV_STORICO` (Milano 215 → 015; Sassari 312 → 112; Cagliari 318 → 118).
10. **Identity asymmetry** (ISTAT): reconstituted municipalities keep their origin id (Sassofeltrio, id 4450, suppressed 1929, reconstituted 1947); reconstituted provinces get new ids (Ogliastra 2026 id 146 and Medio Campidano 2026 id 144 are new entities, not the 2005–2016 ones).
11. **Abbreviations are reused over time** (SU: Sud Sardegna until 2025-12-31, Sulcis Iglesiente from 2026-01-01; OT, VS, OG reused in 2026). Uniqueness holds only per date.
12. **Venezia Giulia (UTS 801, 1920–1923)**: ISTAT abbreviation is the full name `Venezia Giulia`; the published abbreviation is `VG` (override, §6.10).
13. **Bilingual names**: ISTAT names are chronological and consistent across snapshots, internal API and pfun 104 (checked: 1,725/1,725 municipalities in the 1921 snapshot match the last preceding rename). South Tyrol municipalities are bilingual since annexation (Italian part changes, e.g. 1923 Italianisation); Slovene bilingual names were mostly introduced by renames on 2009-01-29. Follow ISTAT as-is.
14. **`id_uts` vs `id_uts_origine`**: `id_uts` identifies a *typed* UTS record and changes on every type change (`ESCT`/`CSCT`); `RN` keeps it. `id_uts_origine` on the new record points to the record it continues. Verified: Milano CM `id_uts` 119 → origin 9 (the province); Cagliari CM `id_uts` 127 → origin 59 (2016), renumbered 292 → 318 in 2026 with the same `id_uts` 127; Sassari CM `id_uts` 143 → origin 58 (2026). Entity identity is therefore the **transitive closure** of `id_uts ↔ id_uts_origine` links (§5.1), never `id_uts` alone.

---

## 4. Data model

### 4.1 Interval convention

- **Internally** (whole generator): half-open intervals `[validFrom, validTo)`; `validTo` is the first day the version is no longer valid, `null` if current.
- **Publicly** (emitted JSON): closed intervals with **inclusive** end: `valid_from` … `valid_until`, where `valid_until` is the **last day the version is valid**, `null` if current. Conversion happens only in the emitter: `valid_until = validTo − 1 day`.
- Public query semantics: a version is valid on D iff `valid_from <= D AND (valid_until IS NULL OR valid_until >= D)`.
- A variation's `date` is the **first day of the new state**: it equals `valid_from` of opened versions and `valid_until + 1 day` of closed versions.
- Dates are ISO `YYYY-MM-DD` strings with no time or timezone. All date arithmetic uses a pure calendar-date implementation (no `Date` timezone pitfalls).
- One-day versions are allowed (`valid_from == valid_until`); zero-length versions cannot exist.

### 4.2 Entities and versions

Common entity fields:

| Field | Type | Notes |
|---|---|---|
| `id` | positive integer | Our stable id, per level, from the registry (§5). Never reused. |
| `istat_origin_id` | integer \| null | ISTAT `id_regione_origine` / `id_uts_origine` / `id_comune_origine`. |
| `status` | `"active"` \| `"suppressed"` | Derived: `active` iff the last version has `valid_until = null`. |
| `is_former_italian` | boolean | Derived, §7. |
| `predecessors` | Link[] | Derived, §7. |
| `successors` | Link[] | Derived, §7. |
| `current_successors` | integer[] | Derived, §7. Ids of currently active entities of the same level. |
| `versions` | Version[] | Sorted by `valid_from`. |

`Link = { "id": <entity id>, "kind": "merged_into" | "detached_into" | "transferred_to", "date": "YYYY-MM-DD", "variation_id": <int> }`

Common version fields: `id` (stable integer, per level), `valid_from`, `valid_until`, `istat_code`, `official_name`, `italian_name`, `foreign_name` (nullable).

Level-specific version fields:

| Level | Fields |
|---|---|
| Region | `type`: `"compartment"` \| `"region"` |
| UTS | `type`: `"province"` \| `"autonomous_province"` \| `"metropolitan_city"` \| `"free_municipal_consortium"` \| `"non_administrative_unit"` (ISTAT 1..5); `abbreviation`: string matching `^[A-Z]{2}$` (never null); `region_id` |
| Municipality | `cadastral_code`: string \| null; `province_id`; `region_id` (denormalised, must equal the province's region) |

**Version split rule** (all levels): a new version starts whenever **any** published version field changes, including `province_id`/`region_id` (entity references). Attribute changes of a parent (rename, abbreviation, type, code of the province) do **not** split child versions. Consecutive identical states are always collapsed (maximal versions).

Names:
- Municipalities: `official_name` ← `COMUNE`, `italian_name` ← `COMUNE_IT`, `foreign_name` ← `COMUNE_A` (null if absent). Never split strings.
- Regions and UTS: `official_name` ← denomination; if it contains `/`, `italian_name` is the part before and `foreign_name` the part after (e.g. `Valle d'Aosta/Vallée d'Aoste`, `Trentino-Alto Adige/Südtirol`, `Bolzano/Bozen`); otherwise `italian_name = official_name`, `foreign_name = null`. Never split on `-`.
- All strings are Unicode NFC, trimmed, ISTAT casing preserved.

### 4.3 Variations

```jsonc
{
  "id": 1843,                       // stable integer from registry
  "date": "2026-01-01",             // first day of the new state
  "istat_act_id": 6151,             // null if unknown / inferred
  "origin": "istat",                // "istat" | "inferred" | "override"
  "description": "ISTITUITE LA CITTA' METROPOLITANA DI SASSARI ...",  // ISTAT text, nullable
  "participants": [
    { "level": "province", "territory_id": 95, "istat_events": ["RN", "AQES", "CECS"],
      "role": "changed", "version_before_id": 812, "version_after_id": 813 },
    { "level": "province", "territory_id": 146, "istat_events": ["CS"],
      "role": "established", "version_before_id": null, "version_after_id": 901 },
    { "level": "municipality", "territory_id": 10704, "istat_events": ["RN"],
      "role": "changed", "version_before_id": 3, "version_after_id": 4 }
  ],
  "links": [
    { "level": "province", "from": 126, "to": 146, "kind": "merged_into" }
  ]
}
```

Participant `role` is derived from the participant's **effect**, not from event codes alone:

| Role | Condition |
|---|---|
| `established` | `version_before_id = null`, `version_after_id ≠ null`, own event `CS`/`CSCT` |
| `annexed` | as above, own event `AN` |
| `suppressed` | `version_before_id ≠ null`, `version_after_id = null`, own event `ES`/`ESCT` |
| `ceded` | as above, own event `AS` |
| `changed` | both non-null, entity has own events |
| `territory_changed` | both null; only territorial events (`AQ`, `CE`, `AQES`, `CECS`) and no attribute change |
| `indirect` | both non-null, **no own event**: the version changed because of another participant (e.g. municipalities whose province changed region) |

Participations with **no effect** (no version change, no link, not territorial) are dropped from public output and logged at `info` level (e.g. the same-day `AP` of a municipality suppressed on that day).

Link kinds (same level only; each link appears once even if ISTAT reports it from both sides):

| Kind | Meaning | Typical ISTAT source |
|---|---|---|
| `merged_into` | `from` ceases; its territory (or part of it) goes to `to` (new or existing) | ES with REL; AQES (from REL to subject); CS whose REL predecessor is suppressed the same day |
| `detached_into` | `from` survives and gives part of its territory to a **new** `to` | CECS; CS with a surviving REL predecessor; ESCT with scorporo when the subject continues (Sassari → Gallura) |
| `transferred_to` | `from` survives and gives part of its territory to an **existing** `to` | CE (subject → REL); AQ (REL → subject) |

Cessions abroad and annexations are expressed by roles (`ceded`, `annexed`) and have no link.

Grouping: one variation per `(istat_act_id, date)`. When the act id is unknown (public-only data), group by `(date, level, subject entity)` and set `istat_act_id = null`. `PV` never produces a variation: versions starting on 1861-03-17 with `PV` have no opening variation.

### 4.4 Published example (abridged)

```jsonc
// municipalities.json — current Siamanna (born 1947 as Siamanna-Siapiccia)
{
  "id": 10704, "istat_origin_id": 10704, "status": "active", "is_former_italian": false,
  "predecessors": [ { "id": 11020, "kind": "detached_into", "date": "1947-11-28", "variation_id": 5856 } ],
  "successors": [], "current_successors": [],
  "versions": [
    { "id": 1, "valid_from": "1947-11-28", "valid_until": "1974-08-19", "istat_code": "092128", "cadastral_code": "I719",
      "official_name": "Siamanna-Siapiccia", "italian_name": "Siamanna-Siapiccia", "foreign_name": null,
      "province_id": 92, "region_id": 20 },
    { "id": 2, "valid_from": "1974-08-20", "valid_until": "1974-09-12", "istat_code": "095057", "cadastral_code": "I719",
      "official_name": "Siamanna-Siapiccia", "italian_name": "Siamanna-Siapiccia", "foreign_name": null,
      "province_id": 95, "region_id": 20 },
    { "id": 3, "valid_from": "1974-09-13", "valid_until": "2025-12-31", "istat_code": "095057", "cadastral_code": "I718",
      "official_name": "Siamanna", "italian_name": "Siamanna", "foreign_name": null,
      "province_id": 95, "region_id": 20 },
    { "id": 4, "valid_from": "2026-01-01", "valid_until": null, "istat_code": "115064", "cadastral_code": "I718",
      "official_name": "Siamanna", "italian_name": "Siamanna", "foreign_name": null,
      "province_id": 95, "region_id": 20 }
  ]
}
```

(Ids are illustrative. Note version 4: only `istat_code` changes because the Oristano province entity was renumbered; `province_id` is unchanged.)

---

## 5. Identity and id registry

### 5.1 Entity identity

- **Regions**: entity = `id_regione_origine` (compartment and region with the same origin id are the same entity; e.g. Piemonte, id 14).
- **UTS**: entity = connected component of the graph whose nodes are `id_uts` values and whose edges are `id_uts → id_uts_origine` (union-find over all internal event rows). The entity's canonical ISTAT id (`istat_origin_id`) is the **root** of the chain, i.e. the `id_uts` of the oldest record (Milano: 9; Cagliari: 59; Sassari: 58). A type change (`ESCT`/`CSCT`) creates a new `id_uts` within the same entity; `RN` keeps the same `id_uts`. Reconstituted provinces with new, unlinked ISTAT ids are **new entities** (Ogliastra 146, Medio Campidano 144).
- The same union-find approach is applied to regions (`id_regione_origine`) and municipalities (`id_comune_origine`) for uniformity, even where ISTAT currently exposes a single id per entity.
- **Municipalities**: entity = `id_comune_origine`. Reconstituted municipalities with the same id are the **same entity** with a gap (Sassofeltrio). The cadastral code is a version attribute (it can change inside an entity: Siamanna I719 → I718 on 1974-09-13).
- Identity is **never** inferred from names, abbreviations or codes across non-consecutive snapshots.

### 5.2 Public-only identity path (municipalities)

Municipality structure (versions, links) is buildable from public data alone (§6.7). Internal ids are attached afterwards (§6.8). If the public path and internal ids disagree (e.g. public path creates a new entity where ISTAT keeps the origin id), **ISTAT ids win** and the discrepancy is logged at `warning` level.

### 5.3 Registry

Files committed in `registry/`: `regions.json`, `provinces.json`, `municipalities.json`, `variations.json`. Each maps a **natural key** to a stable integer id, plus a `next_id` counter per kind.

| Object | Natural key |
|---|---|
| Entity | `istat:<root origin id>` (root of the union-find chain, §5.1); fallback `nk:<level>:<first istat_code>:<first valid_from>` when no origin id is available yet (re-keyed when it becomes available) |
| Version | `<entity id>:<validFrom>` |
| Variation | `act:<istat_act_id>:<date>`; fallback `nk:<date>:<level>:<entity id>`; inferred `inferred:<date>:<level>:<entity id>` |

Rules:
- Ids are assigned on first appearance and **never reused or renumbered**.
- If a retroactive correction changes a natural key (e.g. a `validFrom` moves), the build does not silently create a new id: it produces a **remap proposal** (old key → new key) that goes into a PR for human approval (§10).
- Registry changes are part of the data commit and are reviewed like data.

### 5.4 Ids and database friendliness

All public ids are positive integers, unique per level (entities, versions) and globally unique for variations. Consumers can use them as primary keys.

### 5.5 Internal-only fields

`COD_PROV_STORICO` (UTS "historical code", i.e. the municipality code prefix) is kept in the internal model only and used by invariant I7. It is **not** published.

---

## 6. Pipeline

```
fetch ─► normalise ─► snapshot store ─► calendar ─► snapshots + completeness (bisection)
      ─► identity resolution ─► versions ─► variations & links ─► internal enrichment
      ─► overrides ─► derived fields ─► ANPR cross-check ─► invariants ─► emit ─► changes
```

### 6.1 HTTP client (parallel, polite, resumable)

- Single client used by every adapter. Worker pool with **configurable concurrency** (default 4, max 8).
- **Adaptive concurrency (AIMD)**: +1 worker after K consecutive fast successes (up to max); halve on 429, 5xx, timeout or connection reset.
- Token-bucket rate limit (configurable requests/second).
- Retries: up to 6 attempts, exponential backoff with full jitter; respect `Retry-After`.
- Timeouts: configurable per endpoint class (snapshots of municipalities are large; default 120 s; event/detail calls 30 s).
- **Circuit breaker**: after N consecutive failures on an endpoint family, stop that family and report instead of hammering the server.
- `User-Agent` identifying the project with a contact URL.
- **Response cache** keyed by `sha256(method + normalised URL + body)`. Completed responses are written as soon as they arrive, so an interrupted run resumes without extra logic.
- Every response is validated by an endpoint-specific runtime schema (e.g. zod) that checks only required fields.
- **Degradation**: if the internal API family is unavailable, the run uses the last cached internal data and logs a `warning`. It becomes `blocking` only when a decision actually needs missing internal data (a new UTS/region entity, a municipality reconstitution, an unexplained UTS code change).

### 6.2 Normalisation

Per adapter, producing typed internal rows:
- Codes as zero-padded strings (region 2, UTS 3, municipality 6 chars).
- Numeric enums coerced from number-or-string.
- Dates from `DD/MM/YYYY` or `YYYY-MM-DDT00:00:00Z` → `YYYY-MM-DD`.
- `""`, `" "`, `"ND"` → `null`; strings trimmed and NFC-normalised.
- Snapshot rows are reduced to a **projection** containing only the fields relevant to the model (§3.2). Volatile or unused fields (NUTS, circondari, capital flags, fiscal codes) never take part in equality checks.

### 6.3 Snapshot store

- Content-addressed: each normalised projected row is stored once, keyed by its hash; a snapshot is a manifest `(level, date) → sorted list of row hashes`.
- Layout: `rows/<level>.ndjson` (append-only) and `snapshots/<level>/<YYYY-MM-DD>.json`.
- Persisted on an orphan branch `data-cache` (or as a compressed release asset). Also cached: normalised event lists and internal API responses.
- A full rebuild must be possible from the store without network access (`rebuild` without `--refetch`).

### 6.4 Breakpoint calendar

Union of:
- all event dates from public lists (§3.2) and internal event lists (UTS, regions, municipalities if crawled);
- ANPR `DATAISTITUZIONE` and `DATACESSAZIONE + 1` (hints only);
- regime boundaries `1861-03-17`, `1927-01-12`, `1948-01-01`;
- today.

Dates outside `[1861-03-17, today]` are discarded. A single calendar is used for all three levels.

### 6.5 Snapshots and completeness verification

For each level and each calendar date `d_i`, fetch `S(d_i)` using the right `pfun` for the regime.

**Completeness invariant**: for consecutive breakpoints `d_i < d_{i+1}`, `S(d_i) == S(d_{i+1} − 1)` (projection equality). If not, **binary-search** `(d_i, d_{i+1})` for the first date where the snapshot differs from `S(d_i)`, add it to the calendar, and record an `inferred` breakpoint (`warning`). Repeat until the invariant holds.

- In bootstrap, verification runs on every interval.
- In incremental updates, only new or changed intervals are verified; historical intervals are covered by random sampling (§10).

Estimated bootstrap cost: ~2,500 breakpoints × 3 levels × 2 (verification) ≈ 15k calls, of which ~5k heavy municipality snapshots. At concurrency 4 this is roughly one hour; the resumable cache allows splitting across runs.

### 6.6 Code resolver

`resolve(level, code, date, side)` returns the entity (and version) identified by an ISTAT code:

1. `side = successor` → look up the code on `date`; `side = predecessor` → on `date − 1`.
2. If not found, apply **same-day aliases**: code-change events on `date` (pfun 105 for municipalities; internal `RN`/type changes for UTS) mapping old code ↔ new code; follow the chain.
3. For municipalities, fall back to the **cadastral code** (when present on both sides).
4. If still unresolved → `blocking` anomaly with full context.

Verified on real data: all 20 same-day suppressions and 15 same-day absorbing codes resolve; one case needs the cadastral fallback.

### 6.7 Identity resolution between consecutive snapshots

For each level and each transition `S(d−1) → S(d)`:

**Municipalities** (key per date: `PRO_COM_T`, asserted unique):
1. Same code in both snapshots → same entity, unless events on `d` suppress that code and establish a new one with the same code (code reuse on the same day).
2. Code changes on `d` from pfun 105 (`RN`, `AP`, `CDAP`, `RNAPUTS`) → same entity.
3. Remaining disappeared rows must be explained by `ES`/`AS` on `d` (pfun 98, resolved via §6.6).
4. Remaining appeared rows must be explained by `CS`/`AN` on `d` (pfun 100). If the establishment is a reconstitution with an existing origin id (§6.8), reuse that entity; otherwise create a new one.
5. Anything unexplained: if a row disappears and another appears with the same non-null cadastral code and no events, treat it as the same entity, create an `inferred` variation and log a `warning`; otherwise `blocking`.

**UTS** (key per date: UTS code): continuity through internal events: `RN` (same `id_uts`), `ESCT`/`CSCT` pairs (same origin), `CS`/`ES`/`AN`/`AS`. Public lists 112/113/114 are used as cross-checks. `COD_PROV_FISCALE` equality is an auxiliary signal only, never decisive.

**Regions**: same approach with internal events and public 106/107/108.

**Name changes** between snapshots must correspond to a `CD`/`CDAP` event (pfun 104/105 for municipalities, 114/108 or internal for UTS/regions) or to a new entity; otherwise `warning` (known ISTAT inconsistencies exist, e.g. *Pettoranello del Molise* vs *di Molise*).

### 6.8 Internal enrichment

- **Regions and UTS** (hundreds of calls, required): lists 1–2, events 4–5 for **every** listed `(code, name, type)` record (each typed record returns only its own events; the entity history is the union over all records of the same union-find component), details 7–8 for every event that can carry associated territories. Gives origin ids, `RN`/`AP`/territorial events, act ids and links.
- **Municipalities** (one-time crawl of ~10k light calls, then only new entities): list 3, then report 6 for each `(pro_com_t, comune)`; deduplicate by `id_comune_origine` (any historical pair returns the same history). Gives origin ids and act ids. Match internal events to public rows by `(date, code at that date, event code)`.
- Report 9 (municipality details) is optional in v1 and used only to verify public REL links when enabled by a flag.

### 6.9 Version and attribute building

- Build versions per entity by collapsing consecutive days with identical published attributes (internally half-open).
- Parent references: municipality → UTS via `COD_PROV` (pre-1948) / `COD_UTS` (post-1948) resolved to entity ids on that date; UTS → region via `COD_COMP`/`COD_REG`; municipality `region_id` from its own region code, checked against the UTS region (I5).
- UTS type pre-1948 is always `province`.
- UTS abbreviation: post-1948 `SIGLA_AUTOMOBILISTICA`; pre-1948 derived from `SIGLA_UTS` of the UTS's municipalities on that date (must be unanimous; otherwise `blocking`). Values not matching `^[A-Z]{2}$` must be covered by an override (§6.10), otherwise `blocking`.

### 6.10 Overrides (curated corrections)

Directory `overrides/`, one JSON file per topic. Entry:

```jsonc
{
  "key": "uts-801-abbreviation",
  "target": { "level": "province", "istat_code": "801", "date_from": "1920-01-01", "date_to": "1923-12-31" },
  "field": "abbreviation",
  "value": "VG",
  "reason": "ISTAT reports the full name 'Venezia Giulia'; ANPR uses 'VG' for the provisional province.",
  "source": "ANPR",
  "source_url": "https://www.anagrafenazionale.interno.it/wp-content/uploads/ANPR_archivio_comuni.csv"
}
```

- Applied after building, before derived fields and invariants.
- Each run checks whether every override is still needed; an override whose target already has the corrected value (ISTAT fixed it) or no longer matches anything is reported as **obsolete** (`warning`).
- Override-driven variations use `origin: "override"`.
- The only override known at design time is the `VG` abbreviation above.

### 6.11 ANPR cross-check

Join ANPR rows to municipality versions by cadastral code plus date overlap (ANPR end dates converted from inclusive). Classify discrepancies (never blocking):

| Level | Cases |
|---|---|
| `info` | ANPR missing the entity or period; one-day date differences; ANPR rows split without attribute change |
| `warning` | Divergent ISTAT code, name or province on periods ANPR covers; ANPR `EX` region vs our `is_former_italian` disagreement |

### 6.12 Emit

- Convert to the public model (§4): inclusive `valid_until`, drop internal-only fields, drop no-effect participations.
- Deterministic output: entities sorted by `id`, versions by `valid_from`, participants by `(level, territory_id)`, links by `(level, from, to)`; fixed key order; 2-space indentation; trailing newline; UTF-8 without BOM.

---

## 7. Derived fields

Computed after overrides, per level:

- **`status`**: `active` iff the last version is open.
- **`predecessors`**: links whose `to` is this entity, taken from the variation that opened the entity's **first** version.
- **`successors`**: links whose `from` is this entity, taken from the variation that closed the entity's **last** version. Empty for active entities. Intermediate closures (gaps such as Sassofeltrio 1929–1947) are ignored: an entity that is active again has no successors.
- **`current_successors`**: transitive closure over `successors` (following `merged_into` and `detached_into`) until reaching **active** entities of the same level; ids sorted ascending; cycle-safe. Empty for active entities.
  - Example: Quero (1866–2013) → Quero Vas (2013–2024) → Setteville ⇒ Quero's `current_successors = [Setteville]`.
- **`is_former_italian`**: `true` iff the entity is suppressed, `current_successors` is empty, and every terminal path of its successor graph ends with a `ceded` role (cession abroad). Partial cessions of surviving entities do not count.

Consumer contract (for the Laravel package): moving a stored reference to the current territory is
- the entity's current version if `status = active`;
- the only element of `current_successors` if it has exactly one;
- ambiguous (user supervision required) if it has more than one;
- impossible if `is_former_italian = true`.

For provinces, consumers should prefer resolving through the municipality, whose current version carries the current `province_id`.

---

## 8. Invariants and anomalies

### 8.1 Blocking invariants (build fails)

- **I1** Versions of an entity are sorted, non-overlapping, and `valid_from <= valid_until`.
- **I2** Consecutive versions are either contiguous (`next.valid_from = prev.valid_until + 1`) or separated by a gap in which the entity does not exist in any snapshot.
- **I3** Contiguous consecutive versions differ in at least one published field (maximal collapse).
- **I4** Every `province_id`/`region_id` references an entity that has versions covering the **entire** interval of the referencing version.
- **I5** For every municipality version, `region_id` equals the `region_id` of its province over the whole interval.
- **I6** Per-date uniqueness within a level: `istat_code`; non-null `cadastral_code` among municipalities; `abbreviation` among UTS.
- **I7** The municipality `istat_code` prefix equals the internal historical code of its UTS on the same dates (pre-1948: the UTS code).
- **I8** `abbreviation` matches `^[A-Z]{2}$`.
- **I9** Every version boundary is referenced by at least one participant of a variation with the matching date: `version_after_id` for opened versions, `version_before_id` for closed ones. The only exception is versions starting on `1861-03-17` via `PV`. Every referenced version and entity exists and dates are coherent.
- **I10** No zero-length versions; no published participation without effect.
- **I11** Derived fields are consistent with versions and variations. A suppressed entity that is not former Italian has a non-empty `current_successors`.
- **I12** Reconstruction equals SITUAS: for every snapshot in the store (and every audit sample), the set of versions valid on that date, projected, equals the snapshot projection (after applying overrides).
- **I13** Today's reconstructed counts equal the SITUAS count endpoints for the three levels.
- **I14** Every event row from public lists and internal events is either represented in a variation or explicitly classified as dropped (no-effect), with a reason.

### 8.2 Anomaly levels

Anomalies go to `anomalies.json` with `level`, `code` (stable machine identifier), `message`, `context` (entity/version/variation ids, codes, dates, source rows).

| Level | Examples |
|---|---|
| `blocking` | Any invariant violation; unresolved code (§6.6); unexplained snapshot transition; missing internal data needed for a decision |
| `warning` | Inferred breakpoint; cadastral-based continuity without events; public/internal identity disagreement; name change without event; obsolete override; relevant ANPR divergences |
| `info` | Dropped no-effect participations; ANPR gaps and off-by-one dates; use of cached internal data |

A run with any `blocking` anomaly never publishes and never commits data to `main`.

---

## 9. Published outputs

| File | Content |
|---|---|
| `dist/regions.json` | Array of region entities |
| `dist/provinces.json` | Array of UTS entities |
| `dist/municipalities.json` | Array of municipality entities |
| `dist/variations.json` | Array of variations |
| `dist/anomalies.json` | Non-blocking anomalies of the build that produced this release |
| `dist/changes.json` | Diff vs the previous release: added/updated/removed entities, versions and variations by id, each flagged `retroactive: true` when it touches dates before the previous release's generation date |
| `dist/meta.json` | `schema_version` (semver), `data_version` (`YYYY.MM.DD`), `generated_at`, per-source fetch time and content hash, counts per level, anomaly counts per level |
| `dist/schema/*.schema.json` | JSON Schemas of all files above |

Releases:
- git tag `data-YYYY.MM.DD`;
- GitHub Release with the `dist/` files attached;
- npm package with `dist/` (version `MAJOR.YYYYMMDD.PATCH`, where MAJOR follows `schema_version`).

---

## 10. Update strategy and GitHub Actions

### 10.1 CLI commands

| Command | Action |
|---|---|
| `bootstrap` | Full fetch and build from scratch. |
| `update` | Incremental update (below). |
| `rebuild [--refetch]` | Full rebuild from the store; `--refetch` refreshes all sources. |
| `audit --samples N` | Compare N random historical dates with fresh SITUAS snapshots. |
| `validate` | Run all invariants on `dist/`. |
| `diff <from> <to>` | Produce `changes.json` between two builds. |

### 10.2 Incremental update

1. Fetch today's snapshots for the three levels and compare them with the reconstructed state for today.
2. Fetch public event lists with `pdatada` = previous run date **minus 365 days** (ISTAT often publishes past-dated events late) and diff them against the cached lists. Refresh internal events for affected UTS/regions and for new municipalities.
3. Check the ANPR CSV hash (cross-check only).
4. If nothing changed → exit successfully without commits.
5. Otherwise add new breakpoints, fetch snapshots, verify completeness on new intervals, rebuild, validate.
6. Run `audit` on ~50 random historical dates (catches retroactive ISTAT corrections over time).
7. Classify the result:
   - **additive** (only new versions/variations after the previous generation date, closing of open versions, new entities) → commit and publish;
   - **retroactive** (anything touching earlier dates, registry remaps, audit mismatches) → open a PR, **no publish** until merged.

### 10.3 Workflows

| Workflow | Trigger | Behaviour |
|---|---|---|
| `ci.yml` | push, PR | typecheck, lint, unit and integration tests, schema validation of `dist/`, `validate` |
| `weekly-update.yml` | cron weekly (e.g. Monday 04:00 UTC) + manual | restore `data-cache` → `update` → commit + release, or PR per §10.2 → push updated cache |
| `rebuild.yml` | manual + quarterly cron | `rebuild` (optionally `--refetch`) → always a PR |
| `release.yml` | push to `main` touching `dist/` | tag, GitHub Release, npm publish |

Secrets: npm token only. Concurrency groups prevent overlapping data runs. Jobs must stay well under the 6-hour runner limit; bootstrap can resume across runs thanks to the cache.

---

## 11. Golden cases (test fixtures and expected results)

Store the listed real responses under `test/fixtures/` following §11.1 and write golden tests asserting these outcomes. Where an expectation depends on data not yet fetched, fetch it once, store it as a fixture (with its manifest entry) and then assert.

### 11.1 Fixture conventions

**Path derived from the request.** One folder per source and call type; the file name encodes the request parameters. Lowercase ASCII, no spaces or accents, ISO dates (`YYYY-MM-DD`), words separated by `-`, parameter groups separated by `_`.

| Call | Path (relative to `test/fixtures/`) |
|---|---|
| Public snapshot | `situas-public/snapshots/<level>/pfun-<id>_<pdata>.json` |
| Public event list | `situas-public/events/<level>/pfun-<id>_<pdatada>_<pdataa>.json` |
| Internal report 1–3 (lists) | `situas-internal/r1-region-list/all.json`, `situas-internal/r2-uts-list/all.json`, `situas-internal/r3-municipality-list/all.json` |
| Internal report 4 | `situas-internal/r4-region-events/<codreg>_<reg_tipo>_<slug>.json` |
| Internal report 5 | `situas-internal/r5-uts-events/<coduts>_<uts_tipo>_<slug>.json` |
| Internal report 6 | `situas-internal/r6-municipality-events/<procom>_<slug>.json` |
| Internal report 7 | `situas-internal/r7-region-event-details/<id_regione_origine>_<mcrvar>_<idprovv>.json` |
| Internal report 8 | `situas-internal/r8-uts-event-details/<id_uts_origine>_<mcrvar>_<idprovv>.json` |
| Internal report 9 | `situas-internal/r9-municipality-event-details/<idcomuneorig>_<mcrvar>_<idprovv>.json` |
| ANPR | `anpr/anpr-archivio-comuni_<download date>.csv` |

`<level>` is `regions`, `provinces` or `municipalities`; `<slug>` is the queried name slugified (`Bolzano/Bozen` → `bolzano-bozen`). Report numbers and `pfun` ids are those of §3.2–§3.3. Codes and types in names are those **of the request**, not of the response. ISTAT event codes (`<mcrvar>`) keep their original uppercase (`4450_ES_4928.json`), the only exception to the lowercase rule. The ANPR `<download date>` is the fixture's `fetched_at`.

**Subsets are explicit.** A file that does not contain the full response is named `<base>__subset-<description>.json` (e.g. `pfun-98__subset-first-100-rows.json`) and declared as `subset` in the manifest. Tests must never treat a subset as a complete source.

**Manifest.** `test/fixtures/manifest.json` has one entry per file:

```jsonc
{
  "path": "situas-internal/r5-uts-events/312_3_sassari.json",
  "source": "situas-internal",                 // situas-public | situas-internal | anpr
  "endpoint": "r5:uts-events",                 // or "snapshot:pfun-64", "events:pfun-98", "anpr:archivio-comuni"
  "request": { "method": "POST", "url": "…", "headers": { … }, "body": { "url": "var_get_ua_uts_lov_rs?&uts=Sassari&coduts=312&uts_tipo=3" } },
  "fetched_at": "2026-09-30",
  "completeness": "full",                      // full | subset
  "note": null,
  "used_by": ["golden-4"]                      // golden-<n> (§11) or quirk-<n> (§3.5)
}
```

Request URLs and bodies are stored unencoded; the HTTP client encodes parameter values.

**Test helpers.** `test/helpers/fixtures.ts` exposes `fixturePath(request)`, a pure function mapping a request to its conventional path, and a mock transport for the HTTP client that serves fixtures by that mapping (unknown requests fail loudly). A test validates the manifest:
- every file in `test/fixtures/` has exactly one entry and vice versa;
- `fixturePath(entry.request)` equals `entry.path`, except for subsets, whose base name must match;
- every `used_by` reference exists in this document.

Fixtures fetched later (by tests or by a `fixtures:fetch` script) must follow the same conventions and add their manifest entry.

API documentation notes written during design live in `docs/sources/` and are not fixtures.

1. **Snapshot inclusivity**: pfun 61 on 2024-01-21 contains Quero Vas (025070, M332) and Alano di Piave (025002, A121) and not Setteville; on 2024-01-22 it contains Setteville (025075, M437) and not the other two. On the same day the new Sovizzo (024128, M436) replaces old Sovizzo (024103, I879) + Gambugliano, and Santa Caterina d'Este (028108, M438) replaces Carceri + Vighizzolo d'Este.
   - Expect: Quero Vas last `valid_until = 2024-01-21`; one variation dated `2024-01-22` with `merged_into` links to Setteville; new Sovizzo is a **different entity** from old Sovizzo.
2. **Sassofeltrio** (`id_comune_origine` 4450; internal 6 and 9 responses).
   - One entity with versions `1861-03-17 … 1929-05-13` (041060, I460), gap, `1947-11-25 … 2021-06-16` (041060), `2021-06-17 … null` (099031, province Rimini, region Emilia-Romagna).
   - 1929 ES links `merged_into` Monte Grimano (041035) and Piandicastello (041026). 1947 CS links `detached_into` from Monte Grimano and from the entity that is Piandicastello renamed Mercatino Conca (same code 041026).
   - `successors` empty (active).
3. **Siamanna** (`id_comune_origine` 10704; internal 6). Expect exactly the four versions of §4.4. The 1861–1928 Siamanna (095809, cadastral `null`) is a **different** entity. The SITUAS start date (1947-11-28) wins over ANPR (1947-12-13) → `warning`.
4. **Sardinia 2026** (pfun 64 on 2025-12-31 and 2026-01-01; pfun 112/113 for 2026; internal 5 for Sud Sardegna, Sulcis Iglesiente, Nuoro, Ogliastra, Medio Campidano; pfun 105 RNAPUTS rows):
   - Sud Sardegna (origin 126, 111, SU): suppressed, last `valid_until = 2025-12-31`, successors Nuoro, Ogliastra (146), Medio Campidano (144), Sulcis Iglesiente (145), Cagliari metropolitan city.
   - Nuoro (origin 95): same entity, new version `114` from 2026-01-01 (internal `RN`).
   - Cagliari: one entity (root 59) with versions province `092` … 2016-04-27, metropolitan city `292` from 2016-04-28 (`CSCT`, `id_uts` 127), metropolitan city `318` from 2026-01-01 (`RN`, same `id_uts` 127).
   - Oristano 095 → 115 and Cagliari metropolitan city 292 → 318: same entities, new versions (renumbering detected by snapshot diff, confirmed by internal data).
   - Sassari: one entity (root 58): province `090` until 2025-12-31, metropolitan city `312` from 2026-01-01 (`CSCT`, `id_uts` 143 → origin 58), with Gallura Nord-Est Sardegna (113, OT) as `detached_into`. The test must also fetch internal 5 for the Sassari province record (type 1) and assert its `id_uts` is 58.
   - Ogliastra and Medio Campidano 2026 are new entities, distinct from the 2005–2016 homonyms.
   - Alghero 090003 → 112001 (RNAPUTS, full pfun 105 fixture) is a new municipality version with the same `province_id` (Sassari entity).
   - Siamanna 095057 → 115064 is a new version.
   - Sant'Andrea Frius (I271): current version's province is the Cagliari metropolitan city.
   - Abbreviation `SU` belongs to Sud Sardegna until 2025-12-31 and to Sulcis Iglesiente from 2026-01-01 (I6 passes).
   - I7: prefix of Alghero `112001` equals the historical code of UTS 312 (`112`).
5. **Milano 2015**: province 015 (`id_uts` 9) and metropolitan city 215 (`id_uts` 119, origin 9) are one entity (root 9) with a type change on 2015-01-01; Milano municipalities keep codes `015xxx` and get **no** new version.
6. **Same-day suppression (1927-01-12)**: Finalborgo (009813 → same-day alias 010877), Finale Marina (009814 → 010878), Finale Pia (009815 → 010879): last versions in the province of Genova ending 1927-01-11; `merged_into` Finale Ligure; no version in Savona; the same-day `AP` participations are dropped (info). Also Lucinico (031804 ← alias 030876) into Gorizia; Cantonale (1936-06-04, 018816 ← 015992) into Chignolo Po.
7. **Venezia Giulia 1921** (pfun 51 on 1921-06-01): UTS 801 abbreviation published as `VG` via override; Zara (801256, M149) belongs to UTS 801 in 1921; Venezia Tridentina (802) abbreviation `TN` as ISTAT reports.
8. **WWII-era annexations absent** (pfun 50 on 1942-06-01): province of Fiume has 13 municipalities, Zara 2. No additional territories are produced.
9. **Fiume** (D620, 701706): role `ceded` on 1947-09-16, last `valid_until = 1947-09-15`, `is_former_italian = true`, `current_successors = []`. All 107 `AS` rows share the date 1947-09-16.
10. **Courmayeur** (internal 6): names Courmayeur → Cormaiore (1939-10-21) → Courmayeur (1946-01-30): three versions, only names change.
11. **Bolzano/Bozen** (internal 6): `official_name = "Bolzano/Bozen"`, `italian_name = "Bolzano"`, `foreign_name = "Bozen"` from 1920-10-16 (`AN`, code 802039).
12. **Bilingual chronology**: rename rows from 2009-01-29 (e.g. Duino Aurisina → Duino Aurisina-Devin Nabrežina, `COMUNE_A_REL` Devin Nabrežina) produce new versions with `foreign_name` set from that date.
13. **Name/snapshot consistency**: the 1921 snapshot agrees with the last preceding pfun 104 rename for all 1,725 matched municipalities.
14. **ANPR classification**: of 3,309 distinct suppressions, ~489 are absent from ANPR → `info`, never blocking.

---

## 12. Implementation steps

Stack: Node ≥ 22 LTS, TypeScript (strict), ESM, `vitest`, runtime validation with `zod`, JSON Schemas generated from the zod models, no framework. Keep dependencies minimal. Rename the package placeholder `italian-territories` as needed.

### Step 1 — Scaffolding — DONE

- **Deliverables**: repository layout (§14), fixtures moved to the §11.1 layout with `manifest.json`, `test/helpers/fixtures.ts` (`fixturePath`, mock transport) and the manifest validation test, `package.json` scripts (`build`, `test`, `lint`, `typecheck`), `tsconfig` (strict), ESLint + Prettier, `vitest`, CLI entry (`src/cli.ts`) with the commands of §10.1 as stubs, config module (concurrency, timeouts, rate limit, paths, dates, lookback days).
- **Acceptance**: `npm run typecheck && npm test` pass (including manifest validation); CLI prints help.

### Step 2 — Calendar-date utilities and domain types — DONE

- **Deliverables**: pure date library (parse/format ISO, add/subtract days, compare, half-open ↔ inclusive conversion, `DD/MM/YYYY` conversion); internal domain types; public zod models of §4; JSON Schema generation.
- **Acceptance**: exhaustive unit tests including leap years, 1861-03-17 lower bound, conversion round-trips.

### Step 3 — HTTP client

- **Deliverables**: client per §6.1 (pool, AIMD, token bucket, retries, timeouts, circuit breaker, UA, response cache).
- **Acceptance**: tests with a mocked server covering 429/5xx/timeouts, `Retry-After`, concurrency limits, cache hits, resume after interruption.

### Step 4 — Source adapters and normalisation

- **Deliverables**: adapters for public snapshots (by level and regime), public event lists, internal reports 1–9, ANPR CSV; normalisation per §6.2; endpoint schemas.
- **Acceptance**: fixture-based tests for every adapter using the real responses of §11; type-quirk tests (§3.5 items 1–3).

### Step 5 — Snapshot store and calendar

- **Deliverables**: content-addressed store (§6.3) with read/write and manifest listing; calendar builder (§6.4).
- **Acceptance**: dedup verified; store round-trip; calendar tests with fixture event lists.

### Step 6 — Snapshot orchestration and completeness

- **Deliverables**: fetch all snapshots for a calendar (parallel via the client), completeness verification and bisection (§6.5), inferred breakpoints.
- **Acceptance**: simulated snapshot provider test where a hidden change between breakpoints is found by bisection in `O(log n)` calls.

### Step 7 — Code resolver

- **Deliverables**: resolver per §6.6 (side rule, same-day alias chains, cadastral fallback).
- **Acceptance**: golden case 6 (all 20 same-day suppressions from the real pfun 98/105 fixtures) and the Sud Sardegna/Ogliastra side-rule example.

### Step 8 — Identity resolution and registry

- **Deliverables**: transition matcher per §6.7 for the three levels; registry (§5.3) with assignment, persistence and remap proposals.
- **Acceptance**: golden cases 1, 2, 3, 4 (identity parts), 5; registry stability test (two builds produce identical ids).

### Step 9 — Versions

- **Deliverables**: version builder (§6.9) including parent resolution and abbreviation derivation.
- **Acceptance**: golden cases 2, 3, 5, 10, 11, 12; I1–I3 unit tests.

### Step 10 — Variations and links

- **Deliverables**: grouping, participants with roles, links with kinds, dedup, dropping no-effect participations (§4.3).
- **Acceptance**: golden cases 1, 2, 4, 6, 9; I9, I10, I14.

### Step 11 — Internal enrichment

- **Deliverables**: crawls per §6.8 with caching and incremental mode; origin ids and act ids attached; public/internal disagreement detection.
- **Acceptance**: golden case 4 fully; Sassofeltrio same-origin reconstitution; Ogliastra/Medio Campidano new entities; degradation test with the internal API unavailable.

### Step 12 — Overrides

- **Deliverables**: loader, applier, obsolescence check (§6.10); `overrides/abbreviations.json` with the VG entry.
- **Acceptance**: golden case 7; obsolete-override test.

### Step 13 — Derived fields

- **Deliverables**: §7 computations.
- **Acceptance**: Quero → Quero Vas → Setteville chain; Sud Sardegna multiple successors; Fiume former Italian; Sassofeltrio active with no successors.

### Step 14 — ANPR cross-check

- **Deliverables**: join and classification (§6.11).
- **Acceptance**: golden cases 3 (warning) and 14 (info counts).

### Step 15 — Invariants

- **Deliverables**: I1–I14 as independent, individually testable checks; anomaly reporting (§8.2).
- **Acceptance**: a negative test for each invariant (a crafted dataset violating it is rejected).

### Step 16 — Emitters, meta and changes

- **Deliverables**: public emitters (§6.12, §9), inclusive dates, deterministic formatting, `meta.json`, `changes.json` with retroactive flagging, JSON Schemas in `dist/schema/`.
- **Acceptance**: byte-identical output across two runs on the same store; schema validation of all outputs; §4.4 example reproduced.

### Step 17 — Commands: bootstrap, update, rebuild, audit

- **Deliverables**: full orchestration per §10.1–§10.2 including additive vs retroactive classification.
- **Acceptance**: end-to-end test on a reduced world (e.g. Veneto + Sardinia + Venezia Giulia) with mocked SITUAS; incremental scenario adding a fusion; retroactive scenario producing a PR-classified result.

### Step 18 — GitHub Actions

- **Deliverables**: workflows of §10.3, `data-cache` branch handling, PR creation for retroactive changes, release and npm publish.
- **Acceptance**: dry-run on a fork; no publish when blocking anomalies exist.

### Step 19 — Documentation

- **Deliverables**: README (purpose, scope and perimeter, de iure dates, inclusive `valid_until`, file formats, id stability, consumer resolution contract of §7, update cadence, anomaly levels), CONTRIBUTING (how to add an override), CHANGELOG policy.
- **Acceptance**: every public field documented with type and semantics.

---

## 13. Decision log (do not change without discussion)

| # | Decision | Rationale |
|---|---|---|
| D1 | SITUAS snapshots are the source of truth; events only schedule snapshots and build genealogy | Robust to incomplete or undocumented events; completeness is enforced by bisection |
| D2 | ANPR is cross-check only | Holes, anachronisms, lag, off-by-one dates (verified) |
| D3 | ISTAT xlsx not used | Redundant with snapshot APIs |
| D4 | Entity = transitive closure of ISTAT `id ↔ id_origine` links; follow ISTAT for reconstitutions | Type changes create new typed ISTAT ids linked by origin; municipalities keep ids on reconstitution, provinces do not; do not second-guess |
| D5 | Own stable integer ids via registry; ISTAT origin id exposed | Undocumented source; database-friendly; never renumbered |
| D6 | Cadastral code is a version attribute | It can change within an entity (Siamanna) |
| D7 | Three name fields; split only on `/` for regions/UTS; use ISTAT fields for municipalities | `-` is ambiguous |
| D8 | Names taken from snapshots, which are chronological | Verified against pfun 104 and the internal API |
| D9 | Internal half-open intervals; public inclusive `valid_until` | Machine convenience inside, human readability and simple queries outside |
| D10 | No `ceded_at`, `macro_area`, `statute`, capital flags; `status` kept; `region_id` kept on municipalities | Not needed or derivable; `status`/`region_id` useful for quick checks |
| D11 | UTS field named `abbreviation`, always two uppercase letters; Venezia Giulia = `VG` (override, ANPR as source) | Abbreviations serve postal and other uses beyond vehicle plates; avoid a nullable field for a single case |
| D12 | `COD_PROV_STORICO` internal only | Needed only for invariant I7 |
| D13 | No `opened_by`/`closed_by` on versions; variations reference versions via participants | Many-to-many safe (several acts on the same date) |
| D14 | `predecessors`, `successors`, `current_successors` published as derived fields | Direct support for moving stored references to current territories |
| D15 | Same-day intermediate states are never published | Only end-of-day states are observable; handled by the alias resolver |
| D16 | Perimeter = SITUAS; nothing outside it is mentioned | Undocumented territories are out of scope |
| D17 | Parallel, adaptive, resumable HTTP client | Thousands of calls; unknown server limits |
| D18 | Weekly incremental updates; retroactive changes only via PR | Consumers rely on non-destructive, reviewed history changes |

---

## 14. Repository layout (proposed)

```
.
├── src/
│   ├── cli.ts
│   ├── config.ts
│   ├── dates/                 # calendar-date utilities
│   ├── http/                  # client, pool, retry, cache
│   ├── sources/
│   │   ├── situas-public/     # snapshots + event lists adapters
│   │   ├── situas-internal/   # reports 1–9 adapters
│   │   └── anpr/
│   ├── store/                 # snapshot store, event cache
│   ├── calendar/
│   ├── completeness/          # verification + bisection
│   ├── resolve/               # code resolver, aliases
│   ├── identity/              # transition matching, registry
│   ├── build/                 # versions, variations, links
│   ├── enrich/                # internal enrichment
│   ├── overrides/
│   ├── derive/                # derived fields
│   ├── crosscheck/            # ANPR
│   ├── invariants/            # I1–I14
│   ├── emit/                  # public JSON, meta, changes, schemas
│   └── model/                 # internal + public types, zod schemas
├── overrides/
│   └── abbreviations.json
├── registry/
├── dist/                      # published outputs (committed)
├── test/
│   ├── fixtures/              # real SITUAS/ANPR responses (§11.1)
│   │   ├── manifest.json
│   │   ├── anpr/
│   │   ├── situas-public/{snapshots,events}/<level>/
│   │   └── situas-internal/r<n>-<name>/
│   ├── helpers/fixtures.ts    # fixturePath(), mock transport
│   └── golden/
├── .github/workflows/
└── docs/
    ├── GENERATOR_IMPLEMENTATION_PLAN.md
    └── sources/               # API documentation notes (public and internal SITUAS)
```

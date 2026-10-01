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
Responses: `{ "items": [ ... ] }`. Dates as `DD/MM/YYYY`. Verified encoding quirk: a non-empty result is served as `application/json` whose body is a **JSON string containing the JSON document** (double-encoded); an empty result is served as `text/plain` with a plain `{"items":[]}`. The decoder parses once more when the first parse yields a string.

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
15. **Field names differ between endpoints**: pfun 100 carries the event code in `COD_VARIAZIONE_M` instead of `COD_VARIAZIONE`; pfun 104, 108 and 114 have no event code column (renames by definition, `CD`); internal r4 names the current region code `codice uts corrente`; r7/r8 give the event only as `<code>-<label>` (`ES-Estinzione`) and r8 the UTS type only as a label (`Città metropolitana`). Each adapter maps its own fields explicitly; there is no generic fallback between field names (D29). In particular:
    - the r8 UTS type label is converted with a closed table (the labels listed by r2); an unknown label is a schema violation;
    - for `<code>-<label>` values (r7/r8) the code is the text before the first `-`, validated against the vocabulary (§6.2);
    - a related territory named `Stato estero` with no code is a foreign state. It is allowed only in `AS`, `AN` and `CE` events (verified: `AS` in 98 and 112; `AN` in 100, 113 and 107; `CE` in 17 rows of 103, all on 1947-09-16, partial cessions abroad of surviving municipalities such as Bardonecchia, Gorizia and Trieste). It is never resolved by the code resolver (§6.6), never produces links and never appears as a related territory in the model: the row is flagged `abroad` and the participant gets `abroad: true` (§4.3, D31). In any other event (`AQ` included), or with a code, it is a schema violation.
16. **`COD_PROV_STORICO` absent in some periods**: pfun 64 on 1948-01-01 has no `COD_PROV_STORICO`; it is present in the 2024–2026 snapshots. Normalisation: `historicalCode = COD_PROV_STORICO ?? COD_UTS` for UTS rows and `historicalUtsCode = COD_PROV_STORICO ?? COD_UTS` (the row's own parent code) for municipality rows; before 1948 the historical code is the UTS code. The projection holds the **effective** value, so the field appearing or disappearing over time does not create false changes in equality and completeness checks (§6.5). The adapter reports the number of fallback rows (`info`), outside the projection. The fallback is checked by I7 (D29).
17. **Codes with suffix ≥ 800**: codes assigned retroactively to suppressed municipalities. They appear in every snapshot in which the municipality exists, and their prefix does **not** indicate membership: it may be a later province (`005801` Bagnasco d'Asti in Alessandria 006 before Asti existed; `095809` Siamanna in Cagliari 092 before Oristano; `093801` Vallenoncello in Udine 030 before Pordenone) or an earlier one (`001xxx` municipalities in the province of Aosta 007). Membership comes only from `COD_PROV`/`COD_UTS`. Verified: in the 1921, 1927-01-11 and 1927-01-12 snapshots, 36, 41 and 63 rows have a prefix different from their historical UTS code, all with suffix ≥ 800; in 1942 and 2024 none (D30).

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
    { "level": "province", "territory_id": 95, "istat_events": ["RN", "AQES", "CECS"], "abroad": false,
      "role": "changed", "version_before_id": 812, "version_after_id": 813 },
    { "level": "province", "territory_id": 146, "istat_events": ["CS"], "abroad": false,
      "role": "established", "version_before_id": null, "version_after_id": 901 },
    { "level": "municipality", "territory_id": 10704, "istat_events": ["RN"], "abroad": false,
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

Participant `abroad` (boolean): `true` when the counterpart of one of its events is a foreign state (`AS`, `AN` or `CE` with `Stato estero`, §3.5 item 15), otherwise `false`. It requires one of those events. A foreign counterpart never produces a link (D31).

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

`COD_PROV_STORICO` (UTS "historical code", i.e. the municipality code prefix) is kept in the internal model only and used by invariant I7. It is **not** published. Where SITUAS omits it (§3.5 item 16) the historical code falls back to the UTS code (`COD_UTS` of the row); before 1948 it is the UTS code. The fallback is not assumed correct: I7 verifies it.

---

## 6. Pipeline

```
fetch ─► normalise ─► snapshot store ─► calendar ─► snapshots + completeness (bisection)
      ─► internal crawl + identity graph ─► identity resolution ─► versions ─► variations & links
      ─► overrides ─► derived fields ─► ANPR cross-check ─► invariants ─► emit ─► changes
```

### 6.1 HTTP client (parallel, polite, resumable)

- Single client used by every adapter. Requests are grouped at **three scopes**, each with its own purpose:

  | Scope | Values | Used for |
  |---|---|---|
  | **Host** | `situas-servizi.istat.it` (public), `situas.istat.it` (internal), `www.anagrafenazionale.interno.it` (ANPR) | Worker pool, AIMD and rate limit: congestion is a property of the server, so each host has its own pool and token bucket. |
  | **Family** | `situas-public-snapshots` (pfun 44/46/68, 48/49/64, 51/50/61), `situas-public-reports` (event lists and counts), `situas-internal` (reports r1–r9), `anpr` | Circuit breaker. Heavy municipality snapshots can time out while light reports on the same host stay healthy, so they are separate families. |
  | **Endpoint** | one `pfun` id, one internal report number, the ANPR CSV | Permanent validation errors: a schema change concerns a single report. |

  The adapter declares the family and the endpoint of every request (one endpoint descriptor per `pfun`, internal report or the ANPR CSV); only the host is derived from the request URL.
- Worker pool per host with **configurable concurrency** (default 4, max 8).
- **Adaptive concurrency (AIMD)**: +1 worker after K consecutive fast successes (up to max); halve on 429, 5xx, timeout, connection reset or transient validation error. Nothing else changes the concurrency: permanent validation errors and requests refused because their endpoint is disabled neither halve it nor interrupt the streak of fast successes. A success is *fast* when its latency is at most a configurable fraction (default 0.25) of its endpoint-class timeout; a slow success resets the counter without halving. Failures of attempts started before the last halving do not halve again (one decrease per congestion episode).
- Token-bucket rate limit per host (configurable requests/second).
- Retries: up to 6 attempts, exponential backoff with full jitter; respect `Retry-After`.
- Timeouts: configurable per endpoint class (snapshots of municipalities are large; default 120 s; event/detail calls 30 s).
- **Circuit breaker**: after N consecutive failures on a family (see the scope table above), stop that family and report instead of hammering the server. Every failed attempt counts (429, 5xx, timeout, connection reset, transient validation error); a success resets the count. Permanent validation errors and requests refused because their endpoint is disabled neither count nor reset it. Once open, the circuit stays open for the rest of the run and requests fail immediately.
- **Encoding**: requests are built unencoded (§11.1); the client encodes every query parameter value strictly (RFC 3986: `encodeURIComponent` plus `!'()*`), both in public URLs and in the report URL inside the internal API body. Verified: unencoded values with spaces, `/` or apostrophes make the internal API answer `500 System Error`.
- `User-Agent` identifying the project with a contact URL.
- **Response cache** keyed by `sha256(method + normalised URL + body)`. Completed responses are written as soon as they arrive, so an interrupted run resumes without extra logic. Each entry stores `fetched_at` and the content hash.
- **No global TTL.** Freshness is a **per-call policy chosen by the caller**, never decided by the client: `cache: "prefer"` (use the entry if present), `"refresh"` (always refetch), or `{ maxAgeDays: n }`. The orchestrator (§10) decides which requests must be fresh:
  - requests parameterised with today's date (today's snapshots, event lists with `pdataa = today`) have new cache keys every day, so they are always fetched;
  - historical snapshots use `prefer`, because their URLs never change;
  - `audit` and `rebuild --refetch` use `refresh`;
  - the internal UTS/region events affected by new variations use `refresh`.

  A global TTL is rejected for three reasons: it makes builds non-deterministic, it triggers mass refetches when many entries expire together, and it changes data in the middle of a pipeline without anyone deciding it.
- **Changed content on refresh**: when a refreshed response differs from the cached one, the client keeps the previous content hash in the entry and emits a `changed` notification. The orchestrator treats it as a potential retroactive change (§10.2): data is never overwritten silently.
- **Response validation**: every response is validated by an endpoint-specific runtime schema (e.g. zod) that checks only required fields. There are two error classes, distinguished by where validation fails:
  - **Transient** (retried with the normal backoff, at most 2 extra attempts):
    - the body is not parseable JSON;
    - the content type is not among those accepted by the endpoint, e.g. an HTML maintenance page (public API: `application/json`; internal API: `application/json` or `text/plain`, see §3.3; ANPR: `text/csv`);
    - the expected envelope (`resultset` / `items`) is missing;
    - a snapshot or an internal list report (r1–r3) returns zero rows, which is impossible for those endpoints; a count response must have exactly one row (zero is a valid count). Public event lists and internal reports r4–r9 may be empty (an empty r4–r6 for a listed record is accepted by the client and becomes a blocking anomaly on that record, Step 7; D28).

    The 2 extra attempts are a separate budget inside the overall attempt limit. Each transient validation failure counts for the circuit breaker and halves the AIMD concurrency like a 5xx. If retries are exhausted it becomes a response error.
  - **Permanent `ResponseValidationError`** (no retry): the envelope is valid but rows violate the schema, e.g. a missing required field or an unparseable date or code. It disables **that endpoint** for the rest of the run (further requests to it fail immediately with `EndpointDisabledError`, without being sent) and produces a `blocking` anomaly with the request and offending rows. Neither error affects AIMD or the circuit breaker, and neither triggers `staleFallback` (D26). Other endpoints keep working, so a single run collects every problem; the run still ends with blocking anomalies (exit code 1).
  - Invalid responses of either class are **never cached**.
- **Degradation**: if the internal API family is unavailable, the run uses the last cached internal data and logs a `warning`. The client implements it as an opt-in per request (`staleFallback`): when the network fails (circuit open or retries exhausted, never a validation error or a disabled endpoint) and a cache entry exists, whatever its age or the cache policy, the entry is returned marked as stale and a `degraded` notification is emitted; without an entry the request fails. It becomes `blocking` only when a decision actually needs missing internal data (a new UTS/region entity, a municipality reconstitution, an unexplained UTS code change).

### 6.2 Normalisation

Per adapter, producing typed internal rows:
- Codes as zero-padded strings (region 2, UTS 3, municipality 6 chars).
- Numeric enums coerced from number-or-string.
- Dates from `DD/MM/YYYY` or `YYYY-MM-DDT00:00:00Z` → `YYYY-MM-DD`.
- `""`, `" "`, `"ND"` → `null`; strings trimmed and NFC-normalised.
- **Event code vocabulary**: every event row must carry a code from §2, and the code must belong to the set allowed for its endpoint (§3.2 table; internal reports accept every code of §2, and whether a `(level, code)` pair is meaningful is decided by the explicit rules of Step 11, D27). An unknown or unexpected code is a permanent `ResponseValidationError` (blocking): the vocabulary and the mapping to roles/links must be updated on purpose.
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

A foreign state counterpart (`Stato estero`, no code; allowed only in `AS`, `AN`, `CE`, §3.5 item 15) is never passed to the resolver: the adapters already turn it into the `abroad` flag.

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

### 6.8 Internal data (crawl and identity graph)

Internal data is **acquired before identity resolution** (UTS and region identity depend on it, §6.7) and **attached** during identity resolution and variation building.

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

The ANPR adapter already converts dates to the internal half-open convention: `validFrom = DATAISTITUZIONE`, `validTo = DATACESSAZIONE + 1 day`, or `null` when `DATACESSAZIONE = 9999-12-31`.

ANPR is a **non-blocking source**:
- **Row-level problems** (unparseable dates, cessation before institution, malformed codes): the adapter drops the row and returns an issue, which becomes an `info` anomaly.
- **Structural problems** (download failure, missing columns): the cross-check is skipped for the run with a `warning`.
- ANPR problems never raise a blocking `ResponseValidationError`.

Join ANPR rows to municipality versions by cadastral code plus date overlap. Classify discrepancies (never blocking):

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
- **I7** The municipality `istat_code` prefix equals the internal historical code of its UTS on the same dates (pre-1948: the UTS code), for codes with suffix < 800, at any date. Codes with suffix ≥ 800 (§3.5 item 17, D30): the prefix must be the code of a UTS that existed at some time in the dataset, otherwise blocking; a prefix different from the historical code of the UTS of membership is an `info` anomaly, one per version.
- **I8** `abbreviation` matches `^[A-Z]{2}$`.
- **I9** Every version boundary is referenced by at least one participant of a variation with the matching date: `version_after_id` for opened versions, `version_before_id` for closed ones. The only exception is versions starting on `1861-03-17` via `PV`. Every referenced version and entity exists and dates are coherent.
- **I10** No zero-length versions; no published participation without effect.
- **I11** Derived fields are consistent with versions and variations. A suppressed entity that is not former Italian has a non-empty `current_successors`.
- **I12** Reconstruction equals SITUAS: for every snapshot in the store (and every audit sample), the set of versions valid on that date, projected, equals the snapshot projection (after applying overrides).
- **I13** Today's reconstructed counts equal the SITUAS count endpoints for the three levels.
- **I14** Every event row from public lists and internal events is either represented in a variation or explicitly classified as dropped (no-effect), with a reason.
- **I15** A participant with role `ceded` or `annexed` always has `abroad: true`, and `abroad: true` appears only on participants with at least one `AS`, `AN` or `CE` event (§4.3, D31).

### 8.2 Anomaly levels

Anomalies go to `anomalies.json` with `level`, `code` (stable machine identifier), `message`, `context` (entity/version/variation ids, codes, dates, source rows).

| Level | Examples |
|---|---|
| `blocking` | Any invariant violation; unresolved code (§6.6); unexplained snapshot transition; missing internal data needed for a decision |
| `warning` | Inferred breakpoint; cadastral-based continuity without events; public/internal identity disagreement; name change without event; obsolete override; relevant ANPR divergences; current version of an active municipality with a code of suffix ≥ 800 (checks the assumption behind D30) |
| `info` | Dropped no-effect participations; ANPR gaps and off-by-one dates; use of cached internal data; historical UTS code fallbacks (§3.5 item 16); municipality versions whose 8xx code prefix differs from their UTS (I7) |

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
| Public count (`reportspooljsoncount`) | `situas-public/counts/<level>/pfun-<id>_<same params as the list request>.json` |
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
  "endpoint": "r5:uts-events",                 // or "snapshot:pfun-64", "events:pfun-98", "count:pfun-61", "anpr:archivio-comuni"
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

### 11.2 Fixtures to download (Step 4)

The design-time fixtures do not cover every adapter. Download the following **once**, through the Step 3 client (encoded, rate-limited). Store them byte-identical under the §11.1 paths, with `fetched_at` = actual download date and the listed `used_by`. Show the final list to the maintainer before committing.

| Request | `used_by` |
|---|---|
| pfun 44 and 48 on 1921-06-01 | golden-7 |
| pfun 46 and 49 on 1942-06-01 | golden-8 |
| pfun 48 and 51 on 1927-01-11; pfun 46, 49 and 50 on 1927-01-12 | golden-6, golden-16 |
| pfun 46 and 49 on 1947-12-31; pfun 68 and 64 on 1948-01-01 | golden-15 |
| pfun 68 on 2025-12-31 and 2026-01-01 | golden-4 |
| Event lists 100, 103, 106, 107, 108, 112, 113, 114, full range (`17/03/1861` → download date) | golden-1, golden-2, golden-4, golden-6, golden-15 |
| Counts for pfun 61, 64, 68 on the download date | golden-17 |
| r1, r2, r3 (full lists) | golden-4, golden-15 |
| r4 for Piemonte: every record listed by r1 with that name (compartment and region) | golden-15 |
| r5 for the province records of Sassari (090, type 1), Cagliari (092, type 1), Milano (015, type 1) | golden-4, golden-5 |
| r7 `reg_tipo=1&idprovv=6109&mcrvar=CS&id_regione_origine=14` | golden-15 |
| r8 `id_uts_origine=126&idprovv=6151&uts_tipo=1&mcrvar=ES` (Sud Sardegna 2026) | golden-4 |
| r8 `id_uts_origine=9&idprovv=6029&uts_tipo=1&mcrvar=ESCT` (Milano 2015) | golden-5 |

Type-quirk tests (§3.5 items 1–3) reuse these fixtures with `used_by` `quirk-1`/`quirk-2`/`quirk-3` added where relevant.

If a request in this table returns something that contradicts the expectations of §11.3, **stop and report**: do not adapt the expectations.

### 11.3 Golden cases

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
15. **1948 regime boundary**: compartments on 1947-12-31 and regions on 1948-01-01 with the same origin are the same entities with a new version (`type` compartment → region). The regions of 1871 (e.g. Piemonte, origin 14, `CS` act 6109) are linked to their predecessor compartment through r7 details.
16. **1927 regime boundary**: crossing from pfun 51/48/44 to pfun 50/49/46 does not create spurious versions. Only real changes of 1927-01-12 (new provinces, same-day suppressions of golden-6) produce versions.
17. **Counts (I13)**: reconstructed counts for the download date equal the three count fixtures.
18. **Partial cessions abroad (1947-09-16)**: the 17 `CE` rows of pfun 103 whose counterpart is `Stato estero` (e.g. Gorizia 031007, Trieste 032006, Bardonecchia 001022) produce participations with role `territory_changed`, `abroad: true` and no link; the municipalities stay `is_former_italian: false`.

---

## 12. Implementation steps

### 12.0 Global implementation decisions

Steps 1–3 are already implemented. Where the existing code differs from a **naming or structural detail** of this section (config keys, script names, error class names, module paths), the existing code wins: update this section to match it. Raise only **behavioural** conflicts.

These apply to every step. Anything not decided here or in §1–§11 that is **purely an implementation detail** (internal function names, file splitting inside a module) is left to the implementer. Anything that changes behaviour, outputs, dependencies or conventions must be asked.

**Stack and dependencies**

- Node ≥ 22.18, TypeScript strict, ESM.
- Runtime dependencies: only `zod` (v4, using its built-in JSON Schema export) and `csv-parse` (ANPR).
- Dev dependencies: `typescript`, `vitest`, `eslint` with `typescript-eslint`, `@eslint/js` and `eslint-config-prettier`, `prettier`, `@types/node`. No transpiler or TS runner (`tsx`, `ts-node`): Node runs the `.ts` sources directly.
- Adding any other dependency requires approval.
- Platform APIs to use: global `fetch`, `node:crypto` (SHA-256), `node:util` `parseArgs` (CLI), `node:fs/promises`.

**Running `.ts` directly** (Node type stripping):

- `engines.node` is `>=22.18`: 22.18.0 is the first Node 22 release with type stripping enabled by default. Older releases need `--experimental-strip-types`, which the scripts do not pass (`npm run cli` is `node src/cli.ts`).
- `erasableSyntaxOnly` is on in `tsconfig.json`: only syntax that can be erased is allowed (no `enum`, `namespace`, parameter properties or `import =`).
- Relative imports use the `.ts` extension (`./config.ts`, `allowImportingTsExtensions`); `tsc` rewrites them to `.js` in `lib/` (`rewriteRelativeImportExtensions`).

**Paths**

| Path | Content | Git |
|---|---|---|
| `src/` | Generator sources | committed |
| `lib/` | Compiled generator code | ignored |
| `dist/` | Published data and schemas | committed |
| `registry/` | Id registry | committed |
| `overrides/` | Curated corrections | committed |
| `.cache/http/` | Response cache | ignored |
| `.cache/store/` | Snapshot store; in CI it is the checkout of the `data-cache` branch | ignored |

**npm package**: publishes only `dist/` (data and JSON Schemas), `README.md` and `LICENSE`. The generator code is not published.

**Determinism**: build logic never reads the clock. "Today" comes from config (`dates.today`, set by `--today YYYY-MM-DD`, default the current date in `Europe/Rome`) and is passed explicitly. Only `generated_at` and `fetched_at` hold real timestamps. The `--today` flag is a Step 5 deliverable.

**Logging**: a minimal internal logger writing NDJSON to stderr, with levels `debug|info|warn|error` and `--verbose` to enable `debug`. No logging dependency. Logger and `--verbose` are Step 6 deliverables.

**Errors**: typed classes:
- HTTP (`src/http/`, Step 3):
  - `NetworkError`: connection-level failure reported by the transport (retried);
  - `TransientResponseError`: 2xx response unusable as a whole (retried within `transientValidationRetries`);
  - `HttpStatusError`: non-retryable status (4xx other than 429);
  - `RetriesExhaustedError`: every allowed attempt failed;
  - `CircuitOpenError`: the family circuit is open;
  - `ResponseValidationError`: permanent, rows violate the schema;
  - `EndpointDisabledError`: the endpoint was disabled by an earlier `ResponseValidationError`.
- `ResolutionError` (Step 8)
- `InvariantViolation` (Step 15)

Anomalies (§8.2) are data, not exceptions: collected in an `AnomalyCollector` passed through the pipeline.

**Request scopes** (§6.1): **host** for worker pool, AIMD and rate limit; **family** (`situas-public-snapshots`, `situas-public-reports`, `situas-internal`, `anpr`, declared by the adapter) for the circuit breaker; **endpoint** (declared by the adapter) for permanent validation errors. Timeouts are per endpoint class: municipality snapshots (`snapshot`) vs everything else (`default`).

**Config defaults** (`src/config.ts`; all overridable by config file and CLI flags):

| Key | Default |
|---|---|
| `http.concurrency` / `http.maxConcurrency` | 4 / 8 per host (hard maximum 8) |
| `http.aimdIncreaseAfter` | 20 consecutive fast successes |
| `http.aimdFastFraction` | 0.25 (of the endpoint-class timeout, §6.1) |
| `http.requestsPerSecond` | 5 per host |
| `http.maxAttempts` | 6 (full jitter, honour `Retry-After`) |
| `http.backoffBaseMs` / `http.backoffMaxMs` | 1 000 / 60 000 |
| `http.retryAfterMaxMs` | 300 000 (cap on a server-provided `Retry-After`) |
| `http.transientValidationRetries` | 2 |
| `http.timeouts.snapshotMs` / `http.timeouts.defaultMs` | 120 000 (municipality snapshots) / 30 000 |
| `http.circuitBreakerThreshold` | 10 consecutive failed attempts per family |
| `http.userAgent` | `italian-territories-generator (+https://github.com/andreacolzani/italian-territories)` |
| `update.lookbackDays` | 365 |
| `update.auditSamples` | 50 |
| `dates.start` | `1861-03-17` |
| `dates.today` | `null` (current date in `Europe/Rome`) |

### Step 1 — Scaffolding — DONE

- **Deliverables**: repository layout (§14), fixtures moved to the §11.1 layout with `manifest.json`, `test/helpers/fixtures.ts` (`fixturePath`, mock transport) and the manifest validation test, `package.json` scripts (`build`, `test`, `lint`, `typecheck`), `tsconfig` (strict), ESLint + Prettier, `vitest`, CLI entry (`src/cli.ts`) with the commands of §10.1 as stubs, config module (concurrency, timeouts, rate limit, paths, dates, lookback days).
- **Acceptance**: `npm run typecheck && npm test` pass (including manifest validation); CLI prints help.

### Step 2 — Calendar-date utilities and domain types — DONE

- **Deliverables**: pure date library (parse/format ISO, add/subtract days, compare, half-open ↔ inclusive conversion, `DD/MM/YYYY` conversion); internal domain types; public zod models of §4; JSON Schema generation.
- **Acceptance**: exhaustive unit tests including leap years, 1861-03-17 lower bound, conversion round-trips.

### Step 3 — HTTP client — DONE

- **Deliverables**: client per §6.1 (pool, AIMD and token bucket per host, retries, timeouts, circuit breaker per family, endpoints disabled by permanent validation errors, UA, response cache).
- **Acceptance**: tests with a mocked server covering 429/5xx/timeouts, `Retry-After`, concurrency limits, cache hits, resume after interruption.

### Step 4 — Source adapters and normalisation — DONE

- **Deliverables**: one adapter per call type, each returning normalised internal rows (§6.2).
  - `fetchSnapshot(level, date)` chooses the `pfun` from the regime of `date`. The regime boundaries (`1927-01-12`, `1948-01-01`) are SITUAS constants defined next to the regime → `pfun` table in the public adapters; they are not configurable.
  - `fetchEventList(level, pfun, from, to)`.
  - `fetchCount(pfun, params)`, with endpoint id `count:pfun-<id>`. The response is `{ "resultset": [ { "NUM_ROWS": n } ] }`; zero is a valid count.
  - Internal `r1`…`r9`.
  - `fetchAnpr()`, returning `{ rows, issues }` with half-open dates (§6.11).
  - Endpoint schemas, including the per-endpoint event code vocabulary (§6.2).
  - Download of the §11.2 fixtures via `fixtures:fetch` (`scripts/fixtures-fetch.ts`, through the HTTP client; bodies stored as served, internal ones double-encoded), with manifest entries.
  - Explicit field mapping per endpoint (§3.5 items 15–16, D29); `fetchSnapshot` reports the historical code fallbacks as `info`.
  - `fetchAnpr` raises `AnprFormatError` for structural problems (unparseable CSV, missing columns): not retried, not cached, never a `ResponseValidationError`.
- **Acceptance**:
  - fixture-based tests for every adapter (§11.1 and §11.2 fixtures);
  - type-quirk tests (§3.5 items 1–3);
  - an unknown event code yields `ResponseValidationError`;
  - ANPR malformed rows become issues, not errors;
  - for every fixture request, the endpoint id declared by the adapter equals `describeRequest(request).endpoint` (§11.1), and its family is the one of the §6.1 scope table;
  - internal decoders accept both double-encoded and plain JSON bodies;
  - on every real municipality snapshot fixture, the code prefix equals the effective `historicalUtsCode` for every row except codes with suffix ≥ 800 (§3.5 item 17).

### Step 5 — Snapshot store and calendar

- **Deliverables**:
  - **Row hashing**: a row hash is the SHA-256 (hex) of the canonical JSON of the projected row (keys sorted, no whitespace).
  - **`rows/<level>.ndjson`**: append-only, one `{ "hash", "row" }` per line, never duplicated.
  - **Manifest `snapshots/<level>/<date>.json`**: `{ level, date, pfun, fetched_at, content_hash, row_hashes (sorted), history: [{ fetched_at, content_hash }] }`. `history` is appended when a refresh changes the content.
  - **Normalised event lists and internal responses**: stored under `events/` and `internal/` with the same content-hash approach.
  - **Calendar builder** (§6.4) with provenance: `calendar.json` mapping each date to the list of sources that contributed it.
  - **`--today YYYY-MM-DD`** CLI flag setting `dates.today` (§12.0 Determinism).
- **Acceptance**: dedup verified; store round-trip; calendar tests with fixture event lists; regime boundaries always present; `--today` reaches the calendar builder; the clock is read only at the CLI boundary (default of `dates.today`) and for `generated_at` / `fetched_at`; no other build code reads it.

### Step 6 — Snapshot orchestration and completeness

- **Deliverables**:
  - parallel fetch of every `(level, date)` in the calendar;
  - completeness verification per level (§6.5);
  - NDJSON logger and the `--verbose` flag (§12.0 Logging), with the HTTP client notifications (`retry`, `concurrency`, `circuit-open`, `validation-error`, `changed`, `degraded`) logged.
- **Bisection rules**:
  - Search `[d_i + 1, d_{i+1} − 1]` for the first date whose snapshot differs from `S(d_i)`. After finding it, continue on the remaining sub-interval, which may hide further changes.
  - An inferred date is added to the **global** calendar, so all levels get snapshots on it.
  - Intervals never cross regimes, because boundaries are in the calendar.
- **Acceptance**: a simulated provider where hidden changes between breakpoints, including two in the same interval, are found in `O(log n)` calls each.

### Step 7 — Internal crawl and identity graph

- **Deliverables**: crawl per §6.8, using the cache and an incremental mode.
- **Regions and UTS**:
  - r1/r2 → r4/r5 for every listed record;
  - r7/r8 for every event except `PV`, `CD` and `RN`, which have no associated territories.
- **Municipalities**:
  - r3, then r6 per `(pro_com_t, comune)` pair;
  - each r6 response lists the codes and names the entity had over time; mark those pairs as covered and skip them;
  - deduplicate by `id_comune_origine`.
- **Identity graph** per level: union-find over `id ↔ id_origine` (§5.1) producing components with:
  - root id (the oldest record);
  - member typed records `(id, code, name, type)`;
  - merged event history.
- **Degradation**: missing internal data follows §6.1.
- **Empty event reports**: an empty r4/r5/r6 response for a listed record is a `blocking` anomaly `listed record without events` for that record; the client accepts the response and the endpoint stays enabled.
- **Event code summary**: the crawl saves the summary of the observed `(level, event code)` pairs, input to the Step 11 rules (D27).
- **Acceptance**:
  - Milano, Cagliari and Sassari components (roots 9, 59, 58);
  - Sassofeltrio single component;
  - Ogliastra and Medio Campidano 2026 as separate components;
  - incremental crawl touches only new pairs;
  - degradation test with the internal family unavailable.

### Step 8 — Code resolver

- **Deliverables**:
  - Per-level interval index: code → list of `(validFrom, validTo, row)`, built from the snapshot store.
  - `resolve(level, code, date, side)` per §6.6, returning `{ entityKey, version, path: "direct" | "alias" | "cadastral" }`.
  - Unresolved codes raise `ResolutionError`, converted to a `blocking` anomaly.
- **Acceptance**: golden-6 (all 20 same-day suppressions from the real pfun 98/105 fixtures; exactly one via `cadastral`) and the Sud Sardegna/Ogliastra side-rule example.

### Step 9 — Identity resolution and registry

- **Deliverables**:
  - transition matcher per §6.7, using the identity graph from Step 7;
  - registry (§5.3).
- **Registry file format**: `{ "kind", "next_id", "entries": { "<natural key>": <id> } }`, keys sorted.
- **Moved-key rule**: when an existing version key disappears and the same entity gets a new key whose interval overlaps it, **reuse the old id**. Record the remap in `registry/remaps.json` (`{ from_key, to_key, id, reason }`), log a `warning` and mark the run as retroactive (§10.2).
- **Acceptance**:
  - golden 1–5 (identity parts);
  - two builds on the same store produce identical ids;
  - moved-key scenario reuses the id and is classified retroactive.

### Step 10 — Versions

- **Deliverables**: version builder (§6.9), internally half-open:
  - parent resolution;
  - abbreviation derivation. Non-conforming abbreviations are allowed here and checked by I8 after overrides.
- **Acceptance**: golden 2, 3, 5, 10, 11, 12, 15, 16; I1–I3 unit tests.

### Step 11 — Variations and links

- **Deliverables**: grouping by act id, participants with roles, links with kinds, dedup, and dropping no-effect participations (§4.3).
  - Public rows are matched to internal events by `(date, entity resolved from the code at that date, event code)`, which provides `istat_act_id` and `description`.
  - Unmatched public rows keep `istat_act_id = null` and `description = null`.
  - Every `(level, event code)` pair has an explicit rule (role and links); a pair without a rule is a `blocking` anomaly (D27).
- **Acceptance**: golden 1, 2, 4, 6, 9, 18; I9, I10, I14; a pair without a rule is blocking.

### Step 12 — Overrides

- **Deliverables**: loader with zod schema, applier, obsolescence check (§6.10); `overrides/abbreviations.json` with the VG entry.
- **Acceptance**: golden-7; obsolete-override test; I8 passes on the real 1921 fixture only after the override.

### Step 13 — Derived fields

- **Deliverables**: the computations of §7.
- **Acceptance**:
  - Quero → Quero Vas → Setteville chain;
  - Sud Sardegna with multiple successors;
  - Fiume former Italian;
  - golden-18: municipalities with a partial cession abroad are not former Italian;
  - Sassofeltrio active with no successors.

### Step 14 — ANPR cross-check

- **Deliverables**: join and classification (§6.11). Any ANPR failure (`AnprFormatError`, download failure, exhausted retries, open circuit, HTTP errors) skips the cross-check with a single `warning` and never blocks (D22).
- **Acceptance**: golden 3 (`warning`) and 14 (`info` counts); a structurally broken CSV yields one `warning` and a successful run.

### Step 15 — Invariants

- **Deliverables**: I1–I15 as independent, individually testable checks; anomaly reporting (§8.2); the `warning` check for active municipalities whose current version has an 8xx code (D30).
- **Acceptance**:
  - a negative test for each invariant (a crafted dataset violating it is rejected); golden-17 for I13;
  - I15: a `ceded` or `annexed` participant with `abroad: false`, and an `abroad: true` participant without `AS`, `AN` or `CE`, are both rejected;
  - I7: a wrong `COD_PROV_STORICO` fallback (§3.5 item 16) makes I7 fail;
  - I7: an 8xx code whose prefix is the code of a UTS of another time is `info`; one whose prefix never was a UTS code is blocking; a mismatch with suffix < 800 is blocking at any date;
  - the 8xx `warning` fires for an active municipality whose current code has suffix ≥ 800.

### Step 16 — Emitters, meta and changes

- **Deliverables**:
  - public emitters (§6.12, §9) with inclusive dates and deterministic formatting;
  - `meta.json`;
  - JSON Schemas in `dist/schema/`;
  - `changes.json`: diff against the `dist/` of the previous commit. An item is `retroactive` if it touches any date before the previous `meta.generated_at` date, other than closing a version that was open.
- **Acceptance**: byte-identical output across two runs on the same store; schema validation of all outputs; §4.4 example reproduced.

### Step 17 — Commands: bootstrap, update, rebuild, audit, validate, diff

- **Deliverables**:
  - Full orchestration per §10.1–§10.2.
  - Exit codes: `0` success; `1` blocking anomalies; `2` retroactive changes (PR required); `3` source unavailable.
  - Run summary written to `.cache/last-run.json`, for the workflows.
- **Acceptance**:
  - end-to-end test on a reduced world (Veneto, Sardinia, Venezia Giulia) with the fixture transport;
  - incremental scenario adding a fusion (exit 0);
  - retroactive scenario (exit 2).

### Step 18 — GitHub Actions

- **Deliverables**: the workflows of §10.3:
  - `data-cache` branch checkout and push;
  - PR creation on exit code 2 (a pinned PR-creation action is allowed in workflows);
  - release and npm publish.
- **Acceptance**: dry-run on a fork; no publish on exit codes 1, 2 or 3.
- **Open points** (to discuss or implement in this step):
  - the automatic update must also update `CHANGELOG.md`. Releases created with the `GITHUB_TOKEN` do not trigger other workflows, so `update-changelog.yml` (manual releases only) is not enough: the update has to happen inside the release flow, or the release has to be created with a PAT/GitHub App;
  - decide how the workflows that commit to `main` (changelog, data releases) behave when `main` is protected (bypass for GitHub Actions, PAT/GitHub App, or PR).

### Step 19 — Documentation

- **Deliverables**:
  - README covering: purpose; scope and perimeter; de iure dates; inclusive `valid_until`; file formats; id stability; consumer resolution contract (§7); update cadence; anomaly levels.
  - README: for versions with an 8xx `istat_code` (§3.5 item 17), the code must not be used to derive the province; use `province_id`.
  - CONTRIBUTING: how to add an override and a fixture.
  - CHANGELOG policy.
- **Acceptance**: every public field documented with type and semantics.
- **Open points**: the CHANGELOG policy must update the changelog automatically only when the public outputs actually change.

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
| D19 | No global cache TTL; freshness is a per-call policy chosen by the orchestrator | Deterministic builds; retroactive changes detected by audit/rebuild and surfaced, never silently applied |
| D20 | 2xx responses failing validation: transient (limited retry) for broken envelopes, permanent blocking for schema violations; never cached | Gateway/maintenance glitches vs real source changes |
| D21 | Unknown or unexpected ISTAT event codes are blocking schema violations | The vocabulary drives roles and links; it must be extended deliberately |
| D22 | ANPR is a non-blocking source; its dates are converted to half-open in the adapter; any ANPR failure (format, download, exhausted retries, HTTP) skips the cross-check with a single `warning` (§6.11) | Cross-check only; one internal date convention everywhere |
| D23 | Internal data is crawled before identity resolution | UTS/region identity depends on it (union-find over `id ↔ id_origine`) |
| D24 | Minimal dependencies (`zod`, `csv-parse`); generator code not published to npm | Small attack surface; the npm package is a data package |
| D25 | Three request scopes: host (pool, AIMD, rate limit), family (circuit breaker), endpoint (permanent validation errors) | Congestion is per server; heavy snapshots must not trip light reports; a schema change concerns one report and the run should collect all problems |
| D26 | `ResponseValidationError` and `EndpointDisabledError` do not count for the circuit breaker (neither failure nor reset), do not reduce AIMD concurrency and never trigger `staleFallback`; AIMD and the circuit breaker react only to transport failures (429, 5xx, timeout, connection reset) and transient validation errors | A schema violation is neither congestion nor unavailability; stale data must not hide a blocking problem |
| D27 | Internal adapters accept every event code of §2; each `(level, event code)` pair needs an explicit role/link rule when building variations, and a pair without a rule is blocking | Per-level code sets are not documented by ISTAT; the vocabulary is closed by explicit rules, not by guessed sets |
| D28 | Empty responses are transient only for snapshots and internal lists r1–r3; counts have exactly one row and zero is valid; empty r4–r6 are accepted by the client and produce a blocking anomaly on the single record (Step 7) | Short event ranges and event/detail reports are legitimately empty; a listed record without events is a data problem of that record, not of the transport |
| D29 | Field differences between endpoints or periods are handled by explicit mappings per adapter; defaults for missing fields must be verified by an invariant | No silent guessing between field names; every fallback (e.g. `COD_PROV_STORICO ?? COD_UTS`) is checked (I7) |
| D30 | Municipality codes with suffix ≥ 800 are exempt from the strict I7 prefix rule: the prefix must be a UTS code of some time, differences are `info`; an active municipality with an 8xx current code is a `warning` | ISTAT assigns 8xx codes retroactively to suppressed municipalities with the prefix of a later or earlier province; membership comes from `COD_PROV`/`COD_UTS` only |
| D31 | A foreign state counterpart (`Stato estero`, no code) is allowed only in `AS`, `AN`, `CE`; it is never resolved and never produces links; the participant carries the public flag `abroad` | Cessions and annexations involve territories outside the perimeter (D16), which have no entity; the flag keeps the information without inventing one |

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
│   ├── invariants/            # I1–I15
│   ├── emit/                  # public JSON, meta, changes, schemas
│   └── model/                 # internal + public types, zod schemas
├── overrides/
│   └── abbreviations.json
├── registry/
├── dist/                      # published outputs (committed)
├── lib/                       # compiled generator code (gitignored)
├── .cache/                    # http/ and store/ local caches (gitignored)
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

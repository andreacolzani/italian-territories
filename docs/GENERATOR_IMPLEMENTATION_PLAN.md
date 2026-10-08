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

ISTAT event codes: `PV` first validity, `CS` establishment, `CSCT` establishment by type change, `AN` annexation from foreign state, `AQES` acquisition by extinction, `AQ` territory acquisition, `CE` territory cession, `CECS` cession for establishment of a new unit, `CD` rename, `AP` change of parent, `CDAP` rename + change of parent, `RN` renumbering, `RNAPUTS` renumbering after UTS change (undocumented by ISTAT), `VACST` change of statute type, `CT` change of UTS type without a new record (undocumented by ISTAT, internal UTS events only, §3.5 item 18), `ES` extinction, `ESCT` extinction by type change, `AS` cession to foreign state.

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
10. **Identity on reconstitution** (ISTAT): reconstituted municipalities keep their origin id (Sassofeltrio, id 4450, suppressed 1929, reconstituted 1947). Reconstituted provinces may keep it too (Caserta: origin 35, suppressed 1927-01-12, reconstituted 1945-09-01 with the new record `id_uts` 98 and origin 35) or get new ids (Ogliastra 2026 id 146 and Medio Campidano 2026 id 144 are new entities, not the 2005–2016 ones). The generator always follows ISTAT (D4): same origin, same entity with an uncovered period; new origin, new entity.
11. **Abbreviations are reused over time** (SU: Sud Sardegna until 2025-12-31, Sulcis Iglesiente from 2026-01-01; OT, VS, OG reused in 2026). Uniqueness holds only per date.
12. **Venezia Giulia (UTS 801, 1920–1923)**: ISTAT abbreviation is the full name `Venezia Giulia`; the published abbreviation is `VG` (override, §6.10).
13. **Bilingual names**: ISTAT names are chronological and consistent across snapshots, internal API and pfun 104 (checked: 1,725/1,725 municipalities in the 1921 snapshot match the last preceding rename). South Tyrol municipalities are bilingual since annexation (Italian part changes, e.g. 1923 Italianisation); Slovene bilingual names were mostly introduced by renames on 2009-01-29. Follow ISTAT as-is.
14. **`id_uts` vs `id_uts_origine`**: `id_uts` identifies a *typed* UTS record and changes on every type change (`ESCT`/`CSCT`); `RN` keeps it. `id_uts_origine` on the new record points to the record it continues. Verified: Milano CM `id_uts` 119 → origin 9 (the province); Cagliari CM `id_uts` 127 → origin 59 (2016), renumbered 292 → 318 in 2026 with the same `id_uts` 127; Sassari CM `id_uts` 143 → origin 58 (2026). Entity identity is therefore the **transitive closure** of `id_uts ↔ id_uts_origine` links (§5.1), never `id_uts` alone.
15. **Field names differ between endpoints**: pfun 100 carries the event code in `COD_VARIAZIONE_M` instead of `COD_VARIAZIONE`; pfun 104, 108 and 114 have no event code column (renames by definition, `CD`); internal r4 names the current region code `codice uts corrente`; r7/r8 give the event only as `<code>-<label>` (`ES-Estinzione`) and r8 the UTS type only as a label (`Città metropolitana`). Each adapter maps its own fields explicitly; there is no generic fallback between field names (D29). In particular:
    - the r8 UTS type label is converted with a closed table (the labels listed by r2); an unknown label is a schema violation. `Tipo Uts associato` may be blank only when the associated territory is `Stato estero` (verified: Cuneo, `CE` of 1947-09-16, act 2410); a blank label of any other associated territory is a schema violation;
    - for `<code>-<label>` values (r7/r8) the code is the text before the first `-`, validated against the vocabulary (§6.2);
    - a related territory named `Stato estero` with no code is a foreign state. It is allowed only in `AS`, `AN`, `CE` and `AQ` events, at every level (verified: `AS` in 98 and 112; `AN` in 100, 113 and 107; `CE` in 17 rows of 103, all on 1947-09-16, partial cessions abroad of surviving municipalities such as Bardonecchia, Gorizia and Trieste; `AQ` in r7, acquisitions of territory from abroad: Lombardia on 1866-11-20, act 3619, and Venezia Giulia on 1924-02-23, act 4307). It is never resolved by the code resolver (§6.6), never produces links and never appears as a related territory in the model: the row is flagged `abroad` and the participant gets `abroad: true` (§4.3, D31). In any other event, or with a code, it is a schema violation.
16. **`COD_PROV_STORICO` absent in some periods**: pfun 64 on 1948-01-01 has no `COD_PROV_STORICO`; it is present in the 2024–2026 snapshots. Normalisation: `historicalCode = COD_PROV_STORICO ?? COD_UTS` for UTS rows and `historicalUtsCode = COD_PROV_STORICO ?? COD_UTS` (the row's own parent code) for municipality rows; before 1948 the historical code is the UTS code. The projection holds the **effective** value, so the field appearing or disappearing over time does not create false changes in equality and completeness checks (§6.5). The adapter reports the number of fallback rows and their distinct UTS codes, outside the projection; they become one `info` anomaly per level (Step 6). The fallback is checked by I7 (D29).
17. **Codes with suffix ≥ 800**: codes assigned retroactively to suppressed municipalities. They appear in every snapshot in which the municipality exists, and their prefix does **not** indicate membership: it may be a later province (`005801` Bagnasco d'Asti in Alessandria 006 before Asti existed; `095809` Siamanna in Cagliari 092 before Oristano; `093801` Vallenoncello in Udine 030 before Pordenone) or an earlier one (`001xxx` municipalities in the province of Aosta 007). Membership comes only from `COD_PROV`/`COD_UTS`. Verified: in the 1921, 1927-01-11 and 1927-01-12 snapshots, 36, 41 and 63 rows have a prefix different from their historical UTS code, all with suffix ≥ 800; in 1942 and 2024 none (D30).
18. **`CT`, change of UTS type without a new record**: an event code missing from the ISTAT documentation, found only in the internal UTS events (r5). Verified (2026-10):
    - r5 of Bolzano/Bozen (021, type 2) and Trento (022, type 2) return one row each: `CT` "Cambio Tipologia di statuto", 1972-12-05, act 6102, "RICONOSCIMENTO DELL'AUTONOMIA PER LE PROVINCE DI TRENTO E BOLZANO/BOZEN", with the same `id_uts` (83 and 75) as the type 1 records; r2 lists both records of each UTS with the same origin id;
    - pfun 64 on 1972-12-04 and 1972-12-05 (94 rows each): for 021 and 022 only `TIPO_UTS` changes (1 → 2); code, name, region and abbreviation are unchanged;
    - among the r4/r5 histories of every r1/r2 record, `CT` appears only in those two rows; the public lists cannot carry it (closed vocabularies per endpoint); r6 was not checked (it needs the full municipality crawl).

    `CT` is part of the vocabulary of §2, accepted only by the internal reports, and is a change of attribute (the type) of the same entity (Step 11 rules).

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
  "origin": "istat",                // "istat" | "inferred"
  "description": "ISTITUITE LA CITTA' METROPOLITANA DI SASSARI ...",  // ISTAT text, nullable
  "participants": [
    { "level": "province", "territory_id": 95, "istat_events": ["AQES", "CECS", "RN"], "abroad": false,
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

Participant `role` is derived from the participant's **effect**, not from event codes alone. The effect is evaluated **per event** (Step 11): a closing event (`ES`, `ESCT`, `AS`) needs the entity's version ending on the date, an opening event (`CS`, `CSCT`, `AN`) the version starting on it, a change of attribute (`CD`, `AP`, `CDAP`, `RN`, `RNAPUTS`, `CT`, `VACST`) both; a territorial event needs the entity to exist around the date, and takes the version boundary of that date only when no other event of the same entity on that date (change of attribute, opening or closing, in any act) explains it already; otherwise it stays `territory_changed` without versions. Within one participant (same act) the role stays `changed`: e.g. a rename in one act and a cession of territory in another on the same day: only the variation of the rename references the boundary. `istat_events` lists the participant's events with an effect, sorted alphabetically.

| Role | Condition |
|---|---|
| `established` | `version_before_id = null`, `version_after_id ≠ null`, own event `CS`/`CSCT` |
| `annexed` | as above, own event `AN` |
| `suppressed` | `version_before_id ≠ null`, `version_after_id = null`, own event `ES`/`ESCT` |
| `ceded` | as above, own event `AS` |
| `changed` | both non-null, entity has own events |
| `territory_changed` | both null; only territorial events (`AQ`, `CE`, `AQES`, `CECS`) and no attribute change |
| `indirect` | both non-null, **no own event**: the version changed because of another participant (e.g. municipalities whose province changed region), or a change reported upstream without events (`inferred` variation, below) |

Participant `abroad` (boolean): `true` when the counterpart of one of its events is a foreign state (`AS`, `AN`, `CE` or `AQ` with `Stato estero`, §3.5 item 15), otherwise `false`. It requires one of those events. A foreign counterpart never produces a link (D31).

Participations with **no effect** (no version change, no link, not territorial) are dropped from public output and logged at `info` level (e.g. the same-day `AP` of a municipality suppressed on that day). An event without effect is dropped even when the same participant has other events with effect in the variation (golden-6: Finalborgo's `AP` and `ES` share act 2767; the participant is `["ES"]` and the `AP` row is dropped).

Version boundaries without an own event of the entity (I9):
- a boundary between contiguous versions where the province or region changes gets an `indirect` participant in the variation of that date in which an old or new parent (province or region) participates; with several, the first by natural key;
- otherwise, a boundary already reported upstream (`identity-cadastral-continuity`, `name-change-without-event`, `inferred-breakpoint`) gets an `inferred` variation (`origin: "inferred"`, no act id, one `indirect` participant);
- a UTS boundary where only the abbreviation changes, without an event, is a known case (abbreviations are not ISTAT acts, D34; e.g. Forlì-Cesena `FO` → `FC` and Pesaro e Urbino `PS` → `PU` on 1999-01-01): a `warning` (`abbreviation-change-without-event`) and an `inferred` variation, like the boundaries reported upstream;
- any other uncovered boundary is `blocking` (`version-boundary-unexplained`).

Link kinds (same level only; each link appears once even if ISTAT reports it from both sides):

| Kind | Meaning | Typical ISTAT source |
|---|---|---|
| `merged_into` | `from` ceases; its territory (or part of it) goes to `to` (new or existing) | ES with REL; AQES (from REL to subject); CS whose REL predecessor is suppressed the same day |
| `detached_into` | `from` survives and gives part of its territory to a **new** `to` | CECS; CS with a surviving REL predecessor; ESCT with scorporo when the subject continues (Sassari → Gallura) |
| `transferred_to` | `from` survives and gives part of its territory to an **existing** `to` | CE (subject → REL); AQ (REL → subject) |

Cessions abroad and annexations are expressed by roles (`ceded`, `annexed`) and have no link.

The kind follows from the effect: `merged_into` when `from` no longer exists on the date, otherwise `detached_into` when `to` did not exist the day before, otherwise `transferred_to`. Territory flows: subject → related for `ES`, `ESCT`, `AS`, `CE`, `CECS`; related → subject for `CS`, `CSCT`, `AN`, `AQES`, `AQ`; none for changes of attribute. A link between two states of the same entity is not a link (e.g. `ESCT` Sassari `090` → `312`).

Grouping: one variation per `(istat_act_id, date)`, across levels. When the act id is unknown (public rows without a matching internal event), the rows of one date and level are grouped into the **connected components** of the entities they mention (subject or related territory), with `istat_act_id = null`; such a group never joins a variation with an act id, whose events are exactly those matched to that act. `PV` never produces a variation: versions starting on 1861-03-17 with `PV` have no opening variation.

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

Files committed in `registry/`, one per kind: entities (`regions.json`, `provinces.json`, `municipalities.json`), versions (`region-versions.json`, `province-versions.json`, `municipality-versions.json`) and `variations.json`. Each maps a **natural key** to a stable integer id, plus a `next_id` counter per kind; `remaps.json` records the keys that changed (Step 9).

| Object | Natural key |
|---|---|
| Entity | `istat:<root origin id>` (root of the union-find chain, §5.1); fallback `nk:<level>:<first istat_code>:<first valid_from>` when no origin id is available yet (re-keyed when it becomes available) |
| Version | `<entity id>:<validFrom>` |
| Variation | `act:<istat_act_id>:<date>`; fallback `nk:<date>:<level>:<entity id>` (the smallest subject entity id of the group, §4.3); inferred `inferred:<date>:<level>:<entity id>` |

Rules:
- Ids are assigned on first appearance and **never reused or renumbered**.
- If a retroactive correction changes a natural key (e.g. a `validFrom` moves), the build does not silently create a new id: the remap is applied and recorded in `remaps.json`; a retroactive run reaches `main` only through a PR (§10.2).
- An `nk:` entity that gains its ISTAT origin id is re-keyed to `istat:<root>` with the same id; the correspondence goes into `remaps.json`, but it is **not** retroactive (only `istat_origin_id` changes, which is not a dated field).
- Re-keying goes from `nk:` to `istat:` only, **never back**: missing internal data must never change the id of a registered entity. A registered `istat:<root>` entity whose internal history is absent from the run (its key is not produced and none of its members is in any identity component of the run, e.g. an r6 missing from the store in an offline `rebuild`) is `internal-data-required` (`blocking`): the run never gives it an `nk:` key with a new id, and `dist/` and `registry/` are not written. The anomaly carries `cause`: `unavailable` when the history is missing because a request of the level could not be obtained (network, exhausted retries, open circuit, a report missing from the store in an offline `rebuild`), exit 3 when nothing else blocks; `absent` when every request succeeded and the history is not there, exit 1 (Step 17).
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
- **Circuit breaker** (D38): stop hammering a family (see the scope table above) while it is down, without losing the run to a blip. Every failed attempt counts (429, 5xx, timeout, connection reset, DNS failure, transient validation error); a success resets the count. Permanent validation errors and requests refused because their endpoint is disabled neither count nor reset it.
  - **Opening**: the circuit opens when the consecutive failures reach `circuitBreakerThreshold` **and** have lasted at least `circuitBreakerMinFailureMs` since the first of them **and** come from more than one request. A failure of a few seconds (e.g. a DNS resolution failing for 2 s while 8 requests are in flight) never opens it.
  - **Requests out of attempts**: a request that exhausts its attempts (or its transient validation retries) fails with `RetriesExhaustedError` only when its family works, i.e. some other request of the family succeeded after this request's first failure (e.g. repeated timeouts of a single heavy snapshot while the others answer). Otherwise the family may be down and the request waits for the family's verdict instead of failing, spending no further attempt: a success of another request gives it a new attempt; an opening holds it like every other request (wait and probe, below); a lost family fails it with `CircuitOpenError`. While requests wait, one of them at a time tries again every `backoffMaxMs`, so the failure streak keeps moving towards a verdict even when no other request is running (a sequential stage). The client notifies `request-held` once per request.
  - **A request failing alone** (no other request failed in the streak, e.g. a URL that always fails with no other traffic) never opens the circuit: when its own failures reach the opening condition (threshold and duration, about 4 minutes with the defaults), it fails with `RetriesExhaustedError` and the streak ends without judging the family. If other requests of the family fail meanwhile, the streak becomes the family's and follows the circuit.
  - **Open**: requests of the family are not sent and do not fail: they wait, spending no attempt. After a cooldown (`circuitBreakerCooldownMs`, doubled at every reopening up to `circuitBreakerMaxCooldownMs`) the circuit is **half-open**: a single request is sent as a probe. Its success closes the circuit and every waiting request goes on; its failure reopens it with the next cooldown. A probe that ends without a verdict (permanent validation error, non-retryable status) lets the next request probe at once. A success of a request sent before the opening also closes it; failures of such requests do not reopen it or double the cooldown.
  - **Lost**: once the open periods of the run add up to `circuitBreakerMaxOpenMs`, the family is given up for the rest of the run: every waiting and later request fails immediately with `CircuitOpenError`, and the run reports the source as unavailable (exit code 3). The last probe is scheduled at that limit, so a family is lost only after a failed probe. Elsewhere in this plan an "open circuit" as a cause of unavailability means a lost family.
  - The client notifies `circuit-open` (with the delay before the probe; also on reopening, `warning`), `circuit-closed` (`info`) and `circuit-lost` (`error`).
- **Encoding**: requests are built unencoded (§11.1); the client encodes every query parameter value strictly (RFC 3986: `encodeURIComponent` plus `!'()*`), both in public URLs and in the report URL inside the internal API body. Verified: unencoded values with spaces, `/` or apostrophes make the internal API answer `500 System Error`.
- `User-Agent` identifying the project with a contact URL.
- **Response cache** keyed by `sha256(method + normalised URL + body)`. Completed responses are written as soon as they arrive, so an interrupted run resumes without extra logic. Each entry stores `fetched_at` and the content hash.
- **No global TTL.** Freshness is a **per-call policy chosen by the caller**, never decided by the client: `cache: "prefer"` (use the entry if present), `"refresh"` (always refetch), `{ maxAgeDays: n }`, or `{ fetchedSince: date }` (use the entry only if it was fetched on that date or later). The orchestrator (§10) decides which requests must be fresh:
  - requests parameterised with today's date (today's snapshots, event lists with `pdataa = today`) have new cache keys every day, so they are always fetched;
  - historical snapshots use `prefer`, because their URLs never change;
  - `audit` uses `refresh`;
  - `rebuild --refetch` uses `{ fetchedSince: today }` for every request it must refresh (event lists, internal reports, ANPR, counts, every stored snapshot): what was downloaded from the run's `today` on counts as fresh, so a refetch interrupted (or ended with exit code 3) and run again the same day resumes where it stopped, and no request is sent twice in one run. It relies on the cache entry's `fetched_at`, never on the store manifest's, which records the first download of a content (D32);
  - internal reports (Step 7): lists r1–r3 on every `update`, r4/r5 of the records touched by new variations or newly listed, r6 of new pairs use `refresh`; `audit` refreshes all of them, `rebuild --refetch` too with the policy above. Every other internal report is read from the store without network.

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
- **Degradation**: if the internal API family is unavailable, the run uses the last stored internal data (the store copy, or the HTTP cache entry when the store has none) and reports a `warning` (Step 7). The client implements it as an opt-in per request (`staleFallback`): when the network fails (family lost by the circuit breaker or retries exhausted, never a validation error or a disabled endpoint) and a cache entry exists, whatever its age or the cache policy, the entry is returned marked as stale and a `degraded` notification is emitted; without an entry the request fails. It becomes `blocking` only when a decision actually needs missing internal data (a new UTS/region entity, a municipality reconstitution, an unexplained UTS code change).

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
- Persisted on an orphan branch `data-cache` (or as a compressed release asset). Also cached, with the same approach: normalised event lists (`events/`), internal API responses (`internal/`), the counts of the snapshot requests (`counts/`, I13) and the ANPR archive (`anpr/`): every source of the build is in the store (Step 17).
- Every manifest carries the `projection_version` of its projection (snapshots per level, event lists per endpoint, internal reports per report). Content comparisons (`history`, change detection, completeness) only involve manifests with the current version; a manifest with another version is never used by the build. Changing a projection bumps its version and requires `rebuild --refetch`, which is never a retroactive change (D32).
- A refresh with the same content writes nothing. Event-list change detection is **semantic**: the rows of a new list dated in `[from, to]` are compared with everything the store knows in that date range (for each date, the most recently fetched list covering it), not with a previous manifest (D32).
- A full rebuild must be possible from the store without network access (`rebuild` without `--refetch`), counts and ANPR included.

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

`resolve(level, code, date, side)` returns the **snapshot interval** identified by an ISTAT code: the maximal interval `[validFrom, validTo)` during which the code identifies the same projected snapshot row, built from the snapshots of the calendar dates. The resolver knows nothing of entities: Step 9 attaches intervals to entities.

1. `side = successor` → look up the code on `date`; `side = predecessor` → on `date − 1`.
2. If not found, apply **same-day aliases**: code-change events on `date` mapping the code of `date − 1` to the code of `date`; follow the chain towards the side. Sources:
   - municipalities: pfun 105 (`PRO_COM_T` is the code of `date − 1`, `PRO_COM_T_REL` the code of `date`; verified on Finalborgo: `PRO_COM_T` `010877` (D − 1), `PRO_COM_T_REL` `009813` (D): the suppression row's code `009813` resolves back to `010877`);
   - UTS and regions: internal events of one identity component (§5.1). `RN` carries only the new code (Nuoro `114` in 2026): the old code is the one of the same record's last earlier event. A type change pairs the `ESCT` and `CSCT` codes of the component on `date` (Sassari `090` → `312`).
3. For municipalities, fall back to the **cadastral code** of the event row (when present on both sides).
4. If still unresolved, or a step reaches more than one interval → `blocking` anomaly `code-unresolved` with full context.

Territorial events (`AQES`, `AQ`, `CE`, `CECS`): the subject and a surviving related territory are looked up on `date` (successor side); when the code does not exist there (not found after steps 1–3), they are looked up on `date − 1` (predecessor side), because the territory ceases that day. Verified on 1947-09-16: six municipalities ceded abroad (`AS`) give part of their territory to Italian municipalities the same day (e.g. Tenda `CE` → Limone Piemonte and `CECS` → Briga Alta; `AQ` Limone Piemonte ← Tenda), D33.

A foreign state counterpart (`Stato estero`, no code; allowed only in `AS`, `AN`, `CE`, `AQ`, §3.5 item 15) is never passed to the resolver: the adapters already turn it into the `abroad` flag.

Verified on real snapshots of `D − 1` and `D`: all 20 same-day suppressions resolve through aliases and the 15 same-day absorbing codes resolve directly; none needs the cadastral fallback (the cadastral case found at design time came from a comparison with ANPR, not with snapshots). The new code of a same-day code change of a municipality suppressed the same day (the pfun 105 `AP` rows of golden-6) never appears in a snapshot and does not resolve: those participations have no effect (§4.3).

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

**Type changes** (UTS and regions, D35): within one identity component, a `CSCT` on `d` pairs with the member whose interval ends on `d` (its code among the codes of the component's events), even when that member has an `ES` instead of an `ESCT` or no event at all (the compartments of 1948: Piemonte `ES` + `CSCT`; Venezia Tridentina `82`, no event, → Trentino-Alto Adige `04`, `CSCT`, golden-15). It is a type-change alias: one entity, a link between the two intervals (also when the code is the same), and the public `ESCT`/`CSCT` rows of the pair are explained. A pairing documented by an `ESCT` of the member or confirmed by the public lists (`ESCT` from → to in 106/112, or `CSCT` to ← from in 107/113) is silent; otherwise `warning` (`type-change-unconfirmed`). A `CSCT` with no such member, or with more than one, pairs with nothing.

**Abbreviation changes** without an event (UTS): `warning` (`abbreviation-change-without-event`) and an `inferred` variation (§4.3, D34).

**Name changes** between snapshots must correspond to a `CD`/`CDAP` event (pfun 104/105 for municipalities, 114/108 or internal for UTS/regions) or to a new entity; otherwise `warning` (known ISTAT inconsistencies exist, e.g. *Pettoranello del Molise* vs *di Molise*). A change of name along a type-change link (`ESCT`/`CSCT`, or a pairing inferred by the rule above) is explained by that event: the new typed record brings its name (1948: Emilia → Emilia-Romagna, Puglie → Puglia, Calabrie → Calabria, Venezia Tridentina → Trentino-Alto Adige/Südtirol); no `name-change-without-event`.

### 6.8 Internal data (crawl and identity graph)

Internal data is **acquired before identity resolution** (UTS and region identity depend on it, §6.7) and **attached** during identity resolution and variation building.

- **Source**: internal reports are read from the store first (§6.3) and fetched only when missing or when their refresh is mandatory (§6.1, Step 7); a history fetched in the run replaces the stored ones of the same ids.
- **Regions and UTS** (hundreds of calls, required): lists 1–2, events 4–5 for **every** listed `(code, name, type)` record (each typed record returns only its own events; the entity history is the union over all records of the same union-find component), details 7–8 for every event that can carry associated territories. Gives origin ids, `RN`/`AP`/territorial events, act ids and links.
- **Municipalities** (one-time crawl of ~10k light calls, then only new pairs): list 3, then report 6 for each `(pro_com_t, comune)` not covered by a known history; deduplicate by `id_comune_origine` (any historical pair returns the same history). Gives origin ids and act ids. Match internal events to public rows by `(date, code at that date, event code)`.
- **Event code summary**: the observed `(level, event code)` pairs (D27) are computed by every build and written as a build report (`.cache/reports/event-codes.json`), never stored as source data.
- **Report 9 (municipality details), only for ambiguous events**: after the municipality graph is built, r9 is crawled for the events of one component with the same date and event code under **more than one act** (e.g. Riola Sardo, two `CECS` of 1946-02-07, acts 5831 and 5841, golden-21), queried with the event row's own origin id, act and event. Store-first and stored like every internal report (a failure is aggregated per report like r7/r8 and leaves the event without details); downloaded only by `bootstrap`, `update` and `rebuild --refetch`: in an offline `rebuild` a missing r9 is `internal-data-unavailable` (`warning`) and the rows stay `variation-act-ambiguous` (D37). The associated territories of r9 are used **only** to match public rows to acts (Step 11); the related municipalities of a variation still come from the public rows. No other municipality event is detailed.

### 6.9 Version and attribute building

- Build versions per entity by collapsing consecutive days with identical published attributes (internally half-open).
- Parent references: municipality → UTS via `COD_PROV` (pre-1948) / `COD_UTS` (post-1948) resolved to entity ids on that date; UTS → region via `COD_COMP`/`COD_REG`; municipality `region_id` from its own region code, checked against the UTS region (I5).
  - The parent code is resolved **date by date** over the whole period of the row, to the entity that code identifies at the parent level on each date. A version therefore splits where the entity behind an unchanged parent code changes, and only there: attribute changes of the parent entity (§4.2) do not split it.
- UTS type pre-1948 is always `province`.
- UTS abbreviation: post-1948 `SIGLA_AUTOMOBILISTICA`; pre-1948 derived from `SIGLA_UTS` of the UTS's municipalities on that date (must be unanimous; otherwise `blocking`). Values not matching `^[A-Z]{2}$` must be covered by an override (§6.10), otherwise `blocking`.
  - Unanimity is checked on each date over the non-null `SIGLA_UTS` values; null values are ignored. A missing post-1948 `SIGLA_AUTOMOBILISTICA` is left to the overrides and to I8.
- **Undetermined fields**: a parent code that identifies no entity on some date, or a pre-1948 abbreviation that is missing or not unanimous, is a `blocking` anomaly (`version-parent-unresolved`, `abbreviation-underived`, one per version and cause). The field is null in the internal model and the version is kept, so later stages still run; I4/I8 report the null field, the checks depending on it skip the version, and the emitter refuses to publish it (Steps 15–16).

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

- Each file is an array of entries. The target period is inclusive (`date_to` is the last day covered, `null` = no end), like the public model (§4.1).
- **Fields**: a closed set, discriminated by `field`; v1 allows only the UTS `abbreviation` (value matching `^[A-Z]{2}$`). Adding a field is a deliberate extension of the schema and of the applier.
- **Loading**: keys are unique across files, and two overrides of the same level, field and code must not overlap in time. An unreadable or invalid file, a duplicate key or an overlap is a defect of the repository: the loader throws `OverrideFileError` instead of reporting an anomaly.
- **Day by day, before the merge** (D36): the version builder applies an override to the values of every day on which the UTS has the target code inside the target period, **before** contiguous days with equal fields are merged into versions. An override can therefore remove version boundaries (the overridden days merge with their neighbours), but it must never create one: a version boundary that exists only because of an override is `blocking` (`override-creates-boundary`). An abbreviation an override supplies is no longer undetermined (no `abbreviation-underived`). Overrides create no variation and change no version id beyond the merges they cause.
- Each run checks whether every override is still needed; an override that matches no day, or whose matched days all hold its value already (ISTAT fixed it), is reported as **obsolete** (`warning`, `override-obsolete`).
- I12 expects the override value on the days the override covered, the snapshot value elsewhere.
- Overrides in `overrides/abbreviations.json`: the `VG` abbreviation above (UTS 801 exists in `[1921-01-05, 1923-02-08)`, inside the target period) and `LT` for UTS 059 (Littoria) from 1934-10-26 to 1934-11-05: the `SIGLA_UTS` column is absent from the ISTAT responses of that period, and ISTAT reports `LT` for the same province from 1934-11-06 (source ISTAT); the override removes the version boundary of 1934-11-06.

### 6.11 ANPR cross-check

The ANPR adapter already converts dates to the internal half-open convention: `validFrom = DATAISTITUZIONE`, `validTo = DATACESSAZIONE + 1 day`, or `null` when `DATACESSAZIONE = 9999-12-31`.

ANPR is a **non-blocking source**:
- **Row-level problems** (unparseable dates, cessation before institution, malformed codes): the adapter drops the row and returns an issue, which becomes an `info` anomaly.
- **Structural problems** (download failure, missing columns): the cross-check is skipped for the run with a `warning`.
- ANPR problems never raise a blocking `ResponseValidationError`.

Join ANPR rows to municipality versions by cadastral code plus date overlap when both have one. When either has none (a version without a cadastral code, §3.5 item 3; an ANPR row without `CODCATASTALE`, e.g. San Siro `013934`, 1861–1928) the join falls back to the ISTAT code plus date overlap. A stretch of ANPR rows that the join leaves matching no version is retried by ISTAT code plus date overlap, whatever the cadastral codes: what it finds is joined, and the cadastral code becomes a compared attribute (e.g. Quintosole `015931`, 1869–1923: ANPR `L871`, the code of Vigentino merged into it in 1869; SITUAS `H138`). Every anomaly states the method (`matchedBy`: `cadastral` | `istat-code`). The same rule holds for both methods: consecutive rows of the join key (the cadastral code, or the ISTAT code for the fallback) are normal and are compared day by day; rows of the join key valid on the same day are ambiguous. On those days the version is not compared (`anpr-not-comparable`, `info`, no row is chosen); the rest of the version is compared normally.

Comparisons, on the overlap of each version and ANPR row:
- **ISTAT code**: equal.
- **Cadastral code** (only on a stretch retried by ISTAT code, the only joins where both sides have different ones): equal. A different code follows the rule of the history below: a code of an earlier time of the municipality is a lag (`info`, `anpr-lagging-cadastral`), of a later time an anachronism (`info`, `anpr-anachronistic-cadastral`), never in its history a `warning` (`anpr-divergent-cadastral`). The history is the municipality's own: a code of a municipality merged into it does not count.
- **Name**: `DENOMINAZIONE_IT` is uppercase; it must equal the official or the Italian name in uppercase (verified on 2025-12-31: 7,780 official and 116 Italian names, no divergence). Names equal after removing diacritics, making apostrophes uniform and removing the spaces around them, but different in the exact form (`Sampèire`/`SAMPEIRE`, `Antei Sant' Andrea`/`ANTEI SANT'ANDREA`), are `info` (`anpr-name-diacritics`); other spellings (`Farvengo`/`FARFENGO`, `Jonadi`/`IONADI`) are different names. A different name follows the rule of the history below: a name of an earlier time of the municipality is a lag (`info`, `anpr-lagging-name`), of a later time an anachronism (`info`, `anpr-anachronistic-name`), never in its history a `warning` (`anpr-divergent-name`).
- **Province**: `IDPROVINCIAISTAT` is the historical code (`COD_PROV_STORICO`: Milano `015`, not `215`); it must equal the historical code of the version's province on the same dates. Versions with an undetermined province (§6.9) are skipped.
- **ANPR lags and anachronisms**: a different ISTAT code or province is looked up in the municipality's own history (the ISTAT codes of its versions; the historical codes of their provinces). A value the municipality had **earlier** is an ANPR lag (§3.4, e.g. Sardinia 2026: Alghero still `090003` in `090`): `info` (`anpr-lagging-istat-code`, `anpr-lagging-province`). Otherwise, a value it has **later** is an anachronism (§3.4, e.g. Trentino 1920–23 in `022`): `info` (`anpr-anachronistic-istat-code`, `anpr-anachronistic-province`). A value that never appears in its history is a `warning` (`anpr-divergent-istat-code`, `anpr-divergent-province`).
- **`EX` region**: the ANPR row overlapping the entity's last version with the latest start has region `EX` iff the entity is former Italian. ANPR not marking `EX` an entity that is former Italian (e.g. Tenda) is `info` (`anpr-former-italian-missing`); ANPR marking `EX` an entity that is not former Italian is a `warning` (`anpr-former-italian-divergence`).
- **Dates**, comparing coverages (the versions of an entity; the rows of an ANPR key, i.e. cadastral code, or ISTAT code for rows without one), classified by direction: an entity no row matches is a missing entity; a difference of one day is an off-by-one date; otherwise, where ANPR covers **less** than SITUAS (a maximal period of existence no row covers, or more than one day at the start or end of a covered period) it is a missing period (`info`); where ANPR covers **more** (a stretch of rows matching no version, or more than one day before or after a period it shares with SITUAS) it is an unmatched period (`warning`), except for the known cases below. A stretch the retry by ISTAT code joins is not an unmatched period: it is compared like any other.
  - **Known cases of ANPR covering more** (`info`, aggregated per code), for a period before, after or between periods ANPR shares with SITUAS, checked in this order:
    1. `anpr-anachronistic-key`: ANPR uses a key (cadastral or ISTAT code) that the municipality takes at another time, while the municipality exists then under another key (e.g. a cadastral code assigned before or after the change SITUAS records);
    2. `anpr-cession-extended`: the period starts where the last version of a former Italian municipality ends (cession abroad), e.g. the 11 municipalities ANPR keeps until 1977-04-04 (probably the Treaty of Osimo) and SITUAS closes on 1947-09-16; SITUAS is followed (D16);
    3. `anpr-boundary-offset`: at most 365 days, adjacent to an establishment or reconstitution (the shared period starts there and the municipality has no version ending that day) or to a suppression (the shared period ends there and the municipality has no version starting that day): act date against administrative date.
  - Every other case stays `anpr-unmatched-period` (`warning`): keys no version uses, offsets longer than 365 days not following a cession, periods next to an internal version boundary.

Classify discrepancies (never blocking). Warnings are one anomaly per divergence, with full context; info anomalies are one per code, with the count and the list of items in `context`.

| Level | Cases |
|---|---|
| `info` | ANPR missing the entity (`anpr-missing-entity`) or covering less than SITUAS (`anpr-missing-period`, golden-3); one-day date differences (`anpr-date-off-by-one`); ANPR covering more than SITUAS in a known case (`anpr-anachronistic-key`, `anpr-cession-extended`, `anpr-boundary-offset`); ANPR rows split without attribute change (`anpr-split-rows`); days with ambiguous rows (`anpr-not-comparable`); names differing only in diacritics or apostrophes (`anpr-name-diacritics`); ISTAT codes, cadastral codes, provinces and names of an earlier or later time of the municipality (`anpr-lagging-istat-code`, `anpr-lagging-cadastral`, `anpr-lagging-province`, `anpr-lagging-name`, `anpr-anachronistic-istat-code`, `anpr-anachronistic-cadastral`, `anpr-anachronistic-province`, `anpr-anachronistic-name`); former Italian entities without `EX` (`anpr-former-italian-missing`); rows dropped by the adapter (`anpr-row-dropped`) |
| `warning` | ISTAT code, province or name never in the municipality's history, on periods ANPR covers (`anpr-divergent-istat-code`, `anpr-divergent-province`, `anpr-divergent-name`); cadastral code never in the municipality's history, on a stretch joined by the retry by ISTAT code (`anpr-divergent-cadastral`); ANPR covering more than SITUAS in no known case (`anpr-unmatched-period`); ANPR `EX` on an entity that is not former Italian (`anpr-former-italian-divergence`); cross-check skipped (`anpr-unavailable`) |

### 6.12 Emit

- Convert to the public model (§4): inclusive `valid_until`, drop internal-only fields, drop no-effect participations.
- Deterministic output: entities sorted by `id`, versions by `valid_from`, participants by `(level, territory_id)`, links by `(level, from, to)`; fixed key order; 2-space indentation; trailing newline; UTF-8 without BOM.

---

## 7. Derived fields

Computed after overrides, per level:

- **`status`**: `active` iff the last version is open.
- **Source of the links**: by date, from **every** variation of that date (same level only), whatever act references the version boundary: a cession (`AS`) and a partial transfer (`CE`) of the same day in different acts both count. The links of all those variations are joined without duplicates and sorted by linked entity id, then kind, then variation id. Participants without effect are ignored; participants matter only to read the role that closed the last version (below).
- **`predecessors`**: links whose `to` is this entity, from the variations dated on `valid_from` of the entity's **first** version.
- **`successors`**: links whose `from` is this entity, from the variations dated on the day after `valid_until` of the entity's **last** version. Empty for active entities. Intermediate closures (gaps such as Sassofeltrio 1929–1947) are ignored: an entity that is active again has no successors.
- **`current_successors`**: transitive closure over `successors` (following `merged_into` and `detached_into`) until reaching **active** entities of the same level; ids sorted ascending; entities already visited are not followed again. Empty for active entities.
  - Example: Quero (1866–2013) → Quero Vas (2013–2024) → Setteville ⇒ Quero's `current_successors = [Setteville]`.
- **`is_former_italian`**: `true` iff the entity is suppressed and every terminal path of its successor graph ends in an entity whose last version was closed with role `ceded` (cession abroad). An entity closed with `ceded` is a terminal point of the transitive computation even when it has links (D33): it is former Italian itself, and an entity merged into it is former Italian if all its paths end in ceded entities. Partial cessions of surviving entities do not count. `current_successors` is computed as above, regardless of this flag (Tenda, 1947: `is_former_italian = true`, `current_successors = [Briga Alta, Limone Piemonte]`, golden-19). Whether the last version was closed with `ceded` is read from the entity's participants whose `version_before_id` is that version.
- **Cycles**: a cycle among final closures (the `merged_into`/`detached_into` successors of suppressed entities) is a `blocking` anomaly `successor-cycle`, one per strongly connected component, with the entities involved; it is never treated as a path that does not end in a ceded entity.

Consumer contract (for the Laravel package): `is_former_italian` is evaluated first. Moving a stored reference to the current territory is
- impossible if `is_former_italian = true`: never migrated automatically; its `current_successors`, if any, are the parts of its territory that stayed Italian and may only be proposed under user supervision;
- the entity's current version if `status = active`;
- the only element of `current_successors` if it has exactly one;
- ambiguous (user supervision required) if it has more than one.

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
- **I15** A participant with role `ceded` or `annexed` always has `abroad: true`, and `abroad: true` appears only on participants with at least one `AS`, `AN`, `CE` or `AQ` event (§4.3, D31).

### 8.2 Anomaly levels

Anomalies go to `anomalies.json` with `level`, `code` (stable machine identifier), `message`, `context` (entity/version/variation ids, codes, dates, source rows).

| Level | Examples |
|---|---|
| `blocking` | Any invariant violation; unresolved code (§6.6); unexplained snapshot transition; missing internal data needed for a decision; `(level, event code)` pair without a rule (D27); version boundary created by an override (`override-creates-boundary`, §6.10); version boundary explained by no event, parent change or upstream warning (§4.3); cycle among the successors of suppressed entities (`successor-cycle`, §7) |
| `warning` | Inferred breakpoint; cadastral-based continuity without events; public/internal identity disagreement; name change without event; abbreviation change without event (`abbreviation-change-without-event`, §4.3); type change not confirmed by the public lists (`type-change-unconfirmed`, §6.7); obsolete override; relevant ANPR divergences (ISTAT code, province or name never in the municipality's history, cadastral code never in its history on a stretch joined by ISTAT code, ANPR covering more than SITUAS in no known case, `EX` on an entity that is not former Italian, §6.11); current version of an active municipality with a code of suffix ≥ 800 (checks the assumption behind D30); mandatory refresh of internal data replaced by older data; internal data unavailable with no copy (Step 7) |
| `info` | Dropped no-effect participations; establishments listing the subject itself as associated territory (`self-reference-ignored`, one aggregated anomaly, golden-20); ANPR gaps (ANPR covering less), ANPR covering more in a known case (a key of another time, after a cession, within 365 days of an establishment or suppression) and off-by-one dates, split or ambiguous rows, names differing only in diacritics, lagging or anachronistic ISTAT codes, cadastral codes, provinces and names, missing `EX` on former Italian entities (§6.11); historical UTS code fallbacks (§3.5 item 16); municipality versions whose 8xx code prefix differs from their UTS (I7) |

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
| `dist/changes.json` | Diff vs the previous release: added/updated/removed entities, versions and variations by id, each flagged `retroactive: true` when it changes the published state of a day before the previous release's `data_version`; updated and removed items carry `affected_from`, the first such day (Step 16) |
| `dist/meta.json` | `schema_version` (semver), `data_version` (`YYYY.MM.DD`, the today of the build that produced the data files: it identifies the data content), `generated_at`, per source family (§6.1) fetch time, content hash and number of stored responses, counts per level (entities, active, versions) and of variations, anomaly counts per level |
| `dist/schema/*.schema.json` | JSON Schemas of all files above |

Releases:
- git tag `data-YYYY.MM.DD`;
- GitHub Release with the `dist/` files attached;
- npm package with `dist/` (version `MAJOR.YYYYMMDD.PATCH`, where MAJOR follows `schema_version`).

A release is either a **data** release (new data files) or a **schemas** release (same data files, new JSON Schemas after a generator change, Step 16): a schemas release keeps the previous `data_version`, data files, `anomalies.json` and meta, changes only `schema_version` and `generated_at` and publishes an empty, non-retroactive `changes.json`. It increments the npm PATCH; its git tag must be distinguishable from the data release with the same `data_version` (Step 18).

---

## 10. Update strategy and GitHub Actions

### 10.1 CLI commands

| Command | Action |
|---|---|
| `bootstrap` | Full fetch and build from scratch. |
| `update` | Incremental update (below). |
| `rebuild [--refetch]` | Full rebuild from the store, offline: without `--today` the reference date is the `today` of `calendar.json` (it reproduces the last run with the current code). Without `--refetch` the run never goes to the network, structurally: its transport refuses every request with a programming error, and every stage reads only the store; a source missing from the store is unavailable (snapshots, event lists, counts and lists r1–r3 → exit 3; reports r4–r9 → `internal-data-unavailable`, `warning`; ANPR → `anpr-unavailable`), with a message asking for `update` or `rebuild --refetch`. `--refetch` refreshes all sources, every stored snapshot included, for the current date; what was already downloaded from that date on is reused (§6.1 `fetchedSince`), so an interrupted refetch run again the same day resumes where it stopped. |
| `audit --samples N` | Compare N random historical dates with fresh SITUAS snapshots; never publishes (exit 2 on discrepancies). |
| `validate` | Run all invariants on `dist/` (those needing unpublished data are `skipped`). |
| `diff <from> <to> [--out FILE]` | Produce `changes.json` between two published datasets (directories). |

### 10.2 Incremental update

Every update runs the whole pipeline (offline from the store wherever a source needs no refresh); there is no shortcut, because a new generator, an override or the registry can change the output as well as the sources.

1. Fetch public event lists with `pdatada` = previous run date (the `today` of `calendar.json`) **minus 365 days** (ISTAT often publishes past-dated events late) and diff them semantically against the store: rows dated in `[pdatada, pdataa]` are compared with everything the store knows in that range, not with the previous run's list, whose range differs (§6.3, D32). Refresh the internal lists r1–r3, the internal events of UTS/regions newly listed or whose code appears in added or removed event-list rows, r6 for new pairs and for the pairs whose code appears in added or removed rows (Step 7, Step 17).
2. Fetch the ANPR CSV and the counts of today's snapshots; both are stored (§6.3).
3. Build the calendar (§6.4): sources plus the `inferred` dates kept in `calendar.json`.
4. Run `audit` on `update.auditSamples` random historical dates (catches retroactive ISTAT corrections over time), between the calendar and the snapshots, so what it finds enters the same run (Step 17):
   - a sampled calendar date whose content changed is replaced in the store (`history`, D32);
   - a sampled date outside the calendar that differs from the stored snapshot of the previous calendar date `p` means ISTAT changed the history after it was stored: `p` is fetched again (a change is a correction on a calendar date, as above); if the fresh `p` still differs, `(p, d]` is bisected with fresh snapshots (as in Step 6) and the first differing date becomes `inferred`, stored. The sampled date itself never becomes a breakpoint.
5. Late events and audit corrections make the stored snapshots after them obsolete: every stored snapshot (calendar dates and probes, every level) from the earliest date of the added or removed event-list rows, of the changed calendar dates and of the `p` of the audit corrections, up to the previous run's today, is fetched again with `refresh` (same content → nothing written; different → `history`). Corrections and refreshes share `update.maxRefreshSnapshots`: above it nothing more is fetched and the run blocks (`refresh-too-large`, exit 1) asking for `rebuild --refetch`.
6. Fetch today's snapshots, verify completeness (stored intervals are read from the store, new ones fetched), rebuild, validate, emit. "Nothing changed" means the emitter finds the published files identical (`unchanged`): `dist/` is not touched and there is nothing to commit.
7. Classify the result:
   - **additive** (only new versions/variations after the previous generation date, closing of open versions, new entities) → commit and publish;
   - **retroactive** (anything touching earlier dates, registry remaps, audit discrepancies) → open a PR, **no publish** until merged.

   Events ISTAT publishes late (dated before the previous release's `data_version`) change days already published, so they make the run retroactive (PR), closings of open versions included (Step 16).

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
| pfun 51 on 1923-02-07 and 1923-02-08; pfun 50 on 1936-06-03 and 1936-06-04 (Step 8) | golden-6 |
| pfun 50 on 1929-05-13, 1929-05-14, 1947-11-24 and 1947-11-25; pfun 61 on 2021-06-16 and 2021-06-17 (Step 9) | golden-2 |
| pfun 50 on 1928-05-03, 1928-05-04, 1947-11-27 and 1947-11-28 (Step 9) | golden-3 |
| pfun 61 on 2025-12-31 and 2026-01-01; r5 for Gallura Nord-Est Sardegna (113, type 1) and Oristano (115, type 1) (Step 9) | golden-4 |
| pfun 64 on 2014-12-31 and 2015-01-01 (Step 9) | golden-5 |
| pfun 46 and 49 on 1929-05-13, 1929-05-14, 1947-11-24 and 1947-11-25; pfun 68 and 64 on 2021-06-16 and 2021-06-17 (Step 10) | golden-2 |
| pfun 46 and 49 on 1947-11-27 and 1947-11-28; pfun 68, 64 and 61 on 1974-08-20 and 1974-09-13 (Step 10) | golden-3 |
| pfun 68 and 61 on 2014-12-31 and 2015-01-01 (Step 10) | golden-5 |
| pfun 46 and 49 on 1936-06-04, 1939-10-21 and 1946-01-30; pfun 50 on 1939-10-21 and 1946-01-30 (Step 10) | golden-10 |
| pfun 44, 48 and 51 on 1920-10-15 and 1920-10-16 (Step 10) | golden-11 |
| pfun 68, 64 and 61 on 2009-01-28 and 2009-01-29 (Step 10) | golden-12 |
| pfun 44 on 1927-01-11 (Step 10) | golden-16 |
| pfun 46, 49 and 50 on 1947-09-15 and 1947-09-16 (Step 11) | golden-9, golden-18, golden-19 |
| pfun 44, 48 and 51 on 1923-02-07 and 1923-02-08 (Step 12; pfun 51 shared with golden-6) | golden-7 |
| r6 for Setteville (025075), Quero Vas (025070) and Alano di Piave (025002) (Step 11) | golden-1 |
| pfun 61 on 2013-12-27 and 2013-12-28; r6 for Quero (025042) and Vas (025064) (Step 13: Quero → Quero Vas → Setteville) | golden-1 |
| Event lists 100, 103, 106, 107, 108, 112, 113, 114, full range (`17/03/1861` → download date) | golden-1, golden-2, golden-4, golden-6, golden-15 |
| Counts for pfun 61, 64, 68 on the download date | golden-17 |
| pfun 68, 64 and 61 on the download date of the counts, 2026-10-01 (Step 15: I13 compares the reconstruction with the counts, I12 with the snapshots) | golden-17 |
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
3. **Siamanna** (`id_comune_origine` 10704; internal 6). Expect exactly the four versions of §4.4. The 1861–1928 Siamanna (095809, cadastral `null`) is a **different** entity. The SITUAS start date (1947-11-28) wins over ANPR (1947-12-13): ANPR covers less → `info` (`anpr-missing-period`).
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
14. **ANPR classification**: suppressed municipalities absent from ANPR (§3.4: about 490 at design time, mostly 1866–1873 and 1924) → `info` (`anpr-missing-entity`), never blocking. Fixed by the first full run (Step 17, 2026-10-06): 493; **491**, all suppressed, since the ISTAT-code join of ANPR rows without a cadastral code and the retry by ISTAT code (§6.11, 2026-10-08: San Siro and Quintosole are joined); asserted on the published release (`test/golden/golden-14.test.ts`, skipped while `dist/` holds no release).
15. **1948 regime boundary**: compartments on 1947-12-31 and regions on 1948-01-01 with the same origin are the same entities with a new version (`type` compartment → region). The regions of 1871 (e.g. Piemonte, origin 14, `CS` act 6109) are linked to their predecessor compartment through r7 details.
   - The internal events of the compartments do not always carry `ESCT`: Piemonte has `ES` (compartment) and `CSCT` (region), Venezia Tridentina (`82`, origin 22) has no event on 1948-01-01 and becomes Trentino-Alto Adige/Südtirol (`04`, `CSCT`, origin 22). Both are type changes of one entity (§6.7): a link between the two intervals, no `transition-unexplained`, no `identity-public-internal-mismatch`, and the `ESCT` rows of pfun 106 of that day are explained (no `identity-public-event-unmatched`).
16. **1927 regime boundary**: crossing from pfun 51/48/44 to pfun 50/49/46 does not create spurious versions. Only real changes of 1927-01-12 (new provinces, same-day suppressions of golden-6) produce versions.
17. **Counts (I13)**: reconstructed counts for the download date equal the three count fixtures.
18. **Partial cessions abroad (1947-09-16)**: the 17 `CE` rows of pfun 103 whose counterpart is `Stato estero` (e.g. Gorizia 031007, Trieste 032006, Bardonecchia 001022) produce participations with role `territory_changed`, `abroad: true` and no link; the municipalities stay `is_former_italian: false`.
19. **Cession with partial transfers on the same day (1947-09-16)**: Tenda (004820) gives part of its territory to Limone Piemonte (004110, `CE`/`AQ`) and to the new Briga Alta (004031, `CECS`/`CS`) and is ceded to France (`AS`) the same day (D33).
   - Expect: Tenda has role `ceded`, `abroad: true`, events `["AS", "CE", "CECS"]`, links `merged_into` Limone Piemonte and Briga Alta; `is_former_italian: true`, `current_successors = [Briga Alta, Limone Piemonte]`.
   - None of the six municipalities ceded that day with same-day transfers (Tenda, Briga Marittima, Castel Dobra, Merna, Opacchiasella, San Martino Quisca) produces `code-unresolved` (§6.6).
20. **Caserta (1945)**: the province of Terra del Lavoro, renamed Caserta in 1881 (`061`, origin 35), suppressed on 1927-01-12 and reconstituted on 1945-09-01 (`CS`, act 5390, record `id_uts` 98, origin 35), is one entity with an uncovered period, like Sassofeltrio (§3.5 item 10).
   - Expect: versions until 1927-01-11, no version from 1927-01-12 to 1945-08-31, `061 Caserta` from 1945-09-01; `istat_origin_id = 35`.
   - The r8 details of the 1945 `CS` list Caserta itself among the associated territories: in an establishment, an associated territory equal to the subject (same code, same identity component) is not a predecessor: it is not resolved, produces no link and is listed in the build's single aggregated `info` (`self-reference-ignored`, with the count and the items in `context`; 53 in the full run of 2026-10-06, mostly the `CSCT` of the regions of 1948 whose r7 details list the compartment with the same code); no `code-unresolved`. The 1945 variation links Napoli, Benevento and Campobasso (`CECS`) to Caserta.
21. **Ambiguous acts (Riola Sardo, 1946-02-07)**: Riola Sardo (`092092`, origin 7543) has two `CECS` of the same day in r6, acts 5831 (Baratili San Pietro reconstituted) and 5841 (Nurachi reconstituted), and pfun 103 has two `CECS` rows with related Baratili San Pietro (`092014`) and Nurachi (`092074`). The r9 details of the two events (crawled only because they are ambiguous, §6.8) list the associated territory of each act: each public row joins the act whose details contain its related code; no `variation-act-ambiguous`.

---

## 12. Implementation steps

### 12.0 Global implementation decisions

Steps 1–3 are already implemented. Where the existing code differs from a **naming or structural detail** of this section (config keys, script names, error class names, module paths), the existing code wins: update this section to match it. Raise only **behavioural** conflicts.

These apply to every step. Anything not decided here or in §1–§11 that is **purely an implementation detail** (internal function names, file splitting inside a module) is left to the implementer. Anything that changes behaviour, outputs, dependencies or conventions must be asked.

**Stack and dependencies**

- Node ≥ 22.18, TypeScript strict, ESM.
- Runtime dependencies: only `zod` (v4, using its built-in JSON Schema export) and `csv-parse` (ANPR).
- Dev dependencies: `typescript`, `vitest`, `eslint` with `typescript-eslint`, `@eslint/js` and `eslint-config-prettier`, `prettier`, `@types/node`, `ajv` (tests only, never at runtime: validation of the published files against the published JSON Schemas, Step 16). No transpiler or TS runner (`tsx`, `ts-node`): Node runs the `.ts` sources directly.
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
| `.cache/reports/` | Build reports that are neither data nor sources (e.g. `event-codes.json`, Step 7) | ignored |

**npm package**: publishes only `dist/` (data and JSON Schemas), `README.md` and `LICENSE`. The generator code is not published.

**Determinism**: build logic never reads the clock. "Today" comes from config (`dates.today`, set by `--today YYYY-MM-DD`, default the current date in `Europe/Rome`) and is passed explicitly. Only `generated_at` and `fetched_at` hold real timestamps. The `--today` flag is a Step 5 deliverable.

**Logging**: a minimal internal logger writing NDJSON to stderr, with levels `debug|info|warn|error` and `--verbose` to enable `debug`. No logging dependency. Logger and `--verbose` are Step 6 deliverables. Each line carries a wall-clock `time`: logs describe the run, never the data, so the logger is allowed to read the clock.

**Errors**: typed classes:
- HTTP (`src/http/`, Step 3):
  - `NetworkError`: connection-level failure reported by the transport (retried);
  - `TransientResponseError`: 2xx response unusable as a whole (retried within `transientValidationRetries`);
  - `HttpStatusError`: non-retryable status (4xx other than 429);
  - `RetriesExhaustedError`: every allowed attempt failed;
  - `CircuitOpenError`: the family was given up by the circuit breaker (open for `circuitBreakerMaxOpenMs` in total);
  - `ResponseValidationError`: permanent, rows violate the schema;
  - `EndpointDisabledError`: the endpoint was disabled by an earlier `ResponseValidationError`.
- `ResolutionError` (Step 8)
- `OverrideFileError` (Step 12): invalid or inconsistent override files (§6.10)
- `InvariantViolation` (Step 15)
- `EmitError` (Step 16): the emitter refuses to publish (an undetermined field, a blocking anomaly, a file violating its public model, an invalid previous release)

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
| `http.circuitBreakerMinFailureMs` | 60 000 (the failures must also last this long before the circuit opens) |
| `http.circuitBreakerCooldownMs` / `http.circuitBreakerMaxCooldownMs` | 60 000 / 600 000 (wait before a probe, doubled at every reopening) |
| `http.circuitBreakerMaxOpenMs` | 900 000 (total open time after which the family is lost for the run) |
| `http.userAgent` | `italian-territories-generator (+https://github.com/andreacolzani/italian-territories)` |
| `update.lookbackDays` | 365 |
| `update.auditSamples` | 50 |
| `update.maxRefreshSnapshots` | 300 (stored snapshots an update may fetch again, Step 17) |
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

### Step 5 — Snapshot store and calendar — DONE

- **Deliverables**:
  - **Row hashing**: a row hash is the SHA-256 (hex) of the canonical JSON of the projected row (keys sorted, no whitespace).
  - **`rows/<level>.ndjson`**: append-only, one `{ "hash", "row" }` per line, never duplicated. A last line without its newline (interrupted append) is cut on load; a line that does not match its hash is a store corruption.
  - **Manifest `snapshots/<level>/<date>.json`**: `{ level, date, pfun, projection_version, fetched_at, content_hash, adapter_stats, row_hashes (sorted, duplicates kept), history: [{ fetched_at, content_hash }] }`.
    - `content_hash` is the SHA-256 of the canonical JSON of the sorted `row_hashes`: only the normalised projection takes part, so changes to ignored fields are not changes.
    - `adapter_stats` is a generic object of adapter counters and sorted code lists (e.g. `historical_code_fallbacks` and `historical_code_fallback_uts_codes`, §3.5 item 16), excluded from `content_hash`.
    - A refresh with the same content writes nothing (`fetched_at` stays the date of the first fetch of that content; only a different `adapter_stats` is updated). A different content appends the replaced `{ fetched_at, content_hash }` to `history`.
    - `projection_version` per §6.3: a manifest with another version is replaced without `history` and is never returned to the build (D32).
  - **Normalised event lists and internal responses**: stored with the same approach.
    - Event lists: `events/rows/pfun-<id>.ndjson` and `events/lists/pfun-<id>/<from>_<to>.json` (`{ pfun, level, from, to, … }`). Change detection is **semantic**: the rows of a new list dated in `[from, to]` are compared with every row the store knows in the same range (for each date, the most recently fetched list covering it), not with a previous manifest, which has a different `from` because of the lookback window (§10.2). The put returns the `added` and `removed` rows.
    - Internal reports: `internal/rows/r<n>.ndjson` and `internal/reports/r<n>/<key>.json` (`{ report, endpoint, report_url, key, … }`), where `key` is the SHA-256 of the unencoded, normalised report URL (the form stored in the fixture manifest, §11.1).
    - Counts (added in Step 17): `counts/rows.ndjson` and one manifest per snapshot count request, `counts/pfun-<id>/<date>.json` (`{ pfun, date, … }`, one row `{ count }`).
    - ANPR (added in Step 17): `anpr/rows.ndjson` and one manifest `anpr/manifest.json` (`{ endpoint: "anpr:archivio-comuni", … }`). The stored projection drops the CSV `line`, which would change the hash of every following row at each insertion in the file; the issues of the dropped rows go into `adapter_stats.row_issues` (canonical JSON), so an offline rebuild reports the same `anpr-row-dropped`. Rows read back are sorted by cadastral code (rows without one last), ISTAT code, `validFrom`, canonical JSON, the order the cross-check iterates in; ANPR anomalies identify rows by their store row hash plus `{ istatCode, cadastralCode, validFrom, validTo }`, never by line.
    - Both follow the same rules (same content → nothing written, `history`, `projection_version` entries `counts` and `anpr`, D32).
  - **Calendar builder** (§6.4) with provenance: `calendar.json` in the store, `{ start, today, dates: { <date>: [sources] } }`. Sources are endpoint ids (`events:pfun-<id>`, `r4:region-events`, `r5:uts-events`, `r6:municipality-events`), `anpr:start`, `anpr:end` (half-open `validTo`, i.e. `DATACESSAZIONE + 1`), `regime`, `today` and `inferred` (bisection, Step 6; dropped when a published event covers the same date).
  - **`--today YYYY-MM-DD`** CLI flag, accepted by every command, setting `dates.today` (§12.0 Determinism). The CLI resolves the run date (flag, then `dates.today`, then the current date in Europe/Rome) and passes it to the command.
- **Acceptance**: dedup verified; store round-trip; calendar tests with fixture event lists; regime boundaries always present; `--today` reaches the calendar builder; the clock is read only at the CLI boundary (default of `dates.today`) and for `generated_at` / `fetched_at`; no other build code reads it.

### Step 6 — Snapshot orchestration and completeness — DONE

- **Deliverables**:
  - parallel fetch of every `(level, date)` in the calendar;
  - completeness verification per level (§6.5);
  - NDJSON logger and the `--verbose` flag (§12.0 Logging), with the HTTP client notifications (`retry`, `concurrency`, `circuit-open`, `circuit-closed`, `circuit-lost`, `request-held`, `validation-error`, `changed`, `degraded`) logged.
- **Bisection rules**:
  - Search `[d_i + 1, d_{i+1} − 1]` for the first date whose snapshot differs from `S(d_i)`. After finding it, continue on the remaining sub-interval, which may hide further changes.
  - An inferred date is added to the **global** calendar (source `inferred` in `calendar.json`), so all levels get snapshots on it.
  - Intervals never cross regimes, because boundaries are in the calendar (asserted).
  - Every snapshot obtained, bisection probes included, is stored (§6.3), so I12 and an offline rebuild see it.
- **Snapshot source**: the store first. A stored manifest of the current `projection_version` is used without network, unless the request must be refreshed (today, `audit` samples, `rebuild --refetch`), which bypasses the store and the HTTP cache (in `rebuild --refetch`, except the responses downloaded from its `today` on, §6.1). Otherwise the snapshot is fetched (`cache: prefer`) and stored.
- **Failures**: a snapshot that cannot be obtained does not stop the stage, so one run collects every problem. Failures only concern dates never stored or requests whose refresh is mandatory:
  - `snapshot-unavailable` (`blocking`, exit code 3): the source is unavailable, i.e. open circuit or retries exhausted on timeouts, connection errors, 5xx or 429;
  - `snapshot-request-rejected` (`blocking`, exit code 1): non-retryable HTTP status (4xx other than 429: 400, 401, 403, 404…), which is not unavailability;
  - `snapshot-schema-violation` (`blocking`, exit code 1): `ResponseValidationError` or `EndpointDisabledError`;
  - `completeness-unverified` (`blocking`): an interval whose check needs a missing snapshot;
  - any other error is a bug and propagates.

  The causes have distinct codes so that Step 17 maps them to exit codes without reading messages. With at least one failure the stage result is `blocked`: the pipeline stops before identity resolution, to avoid cascading anomalies.
- **Inferred breakpoints across runs**:
  - An inferred date whose snapshots (as currently stored or refetched) equal, at every level, those of the previous calendar date is no longer confirmed: its `inferred` source is removed (the date leaves the calendar unless another source keeps it), with an `inferred-breakpoint-removed` `info` anomaly, and no `inferred-breakpoint` warning is emitted for it. A date with a missing snapshot is kept.
  - When a published event (public list or internal event report) covers an inferred date, the source becomes that event's endpoint: `inferred` is dropped.
- **Anomalies**: `inferred-breakpoint` (`warning`), emitted by every run for each date still `inferred` in the final calendar and each level whose snapshot changes on it; `inferred-breakpoint-removed` (`info`); `historical-code-fallback` (`info`, §3.5 item 16), **one per level** with number of snapshots, total fallback rows, date range and the distinct UTS codes involved, computed from the manifests' `adapter_stats` so an offline rebuild reports the same.
- **Acceptance**: a simulated provider where hidden changes between breakpoints, including two in the same interval, are found in `O(log n)` calls each.

### Step 7 — Internal crawl and identity graph — DONE

- **Deliverables**: crawl per §6.8, using the cache and an incremental mode.
- **Source of internal reports**: the store first, as for snapshots (Step 6). A stored report of the current `projection_version` is used without network unless its refresh is mandatory; otherwise it is fetched (`cache: prefer`) and stored. The orchestrator (Step 17) decides which refreshes are mandatory (`mustRefresh`):
  - r1–r3 on every `update`;
  - r4/r5 for the records touched by new variations or newly listed;
  - r6 for new pairs;
  - everything for `audit` and `rebuild --refetch`, as for snapshots.
- **Regions and UTS**:
  - r1/r2 → r4/r5 for every listed record; r5 under an older code of the same `id_uts` (e.g. Cagliari 292 and 318, Nuoro 091 and 114) returns the same rows, merged without duplicates;
  - r7/r8 for every distinct event except `PV`, `CD` and `RN`, which have no associated territories, queried with the **event row's own** origin id and type (verified: r8 answers the Milano metropolitan city `CSCT` for `id_uts_origine=9`, not for its `id_uts` 119).
- **Municipalities**:
  - r3, then r6 per `(pro_com_t, comune)` pair, in code and name order (independent of whether the list came from the network or the store);
  - each r6 response lists the codes and names the entity had over time; mark those pairs as covered and skip them. Stored responses are read first, so an incremental crawl only sends requests for pairs no stored history covers;
  - deduplicate by `id_comune_origine`;
  - then r9 only for the ambiguous events (§6.8).
- **Fresh replaces stored**: a history fetched in the run replaces, for the same ids, the stored histories read for other records or pairs of the entity; it is never merged with them, so a row ISTAT corrected does not survive next to its correction.
- **Identity graph** per level: union-find over `id ↔ id_origine` (§5.1) producing components with:
  - root id (the oldest record);
  - member typed records `(id, code, name, type)`;
  - merged event history.

  Only the `id → id_origine` pointers of the internal reports are used, never inferences from public data. The root is the only end of the pointer chain and must be the oldest record (earliest first event); otherwise `identity-root-ambiguous` (`blocking`, falling back to the oldest record). A listed record whose origin id is not in the component of its events is `identity-record-inconsistent` (`blocking`).
- **Degradation** (§6.1):
  - using the store without a mandatory refresh produces no anomaly;
  - a mandatory refresh that fails because the source is unavailable falls back to the stored copy (or the HTTP cache entry when the store has none): `internal-data-stale` (`warning`), one per report with the list of requests;
  - data missing with no copy: `internal-data-unavailable` (`warning`), one per report; it becomes `blocking` only in Step 9, when a decision needs it;
  - rejected requests (4xx) and schema violations never fall back (D26): `internal-request-rejected` and `internal-schema-violation` (`blocking`), one per report.
- **Empty event reports**: an empty r4/r5/r6 response for a listed record is a `blocking` anomaly `listed-record-without-events` for that record; the client accepts the response and the endpoint stays enabled.
- **Event code summary**: the crawl computes the summary of the observed `(level, event code)` pairs (distinct events per code), input to the Step 11 rules (D27). It is computed by every build and written to `.cache/reports/event-codes.json` (`paths.reports`), never to the store, which holds source data only.
- **Acceptance**:
  - Milano, Cagliari and Sassari components (roots 9, 59, 58);
  - Sassofeltrio single component;
  - Ogliastra and Medio Campidano 2026 as separate components;
  - incremental crawl touches only new pairs;
  - degradation test with the internal family unavailable.

### Step 8 — Code resolver — DONE

- **Deliverables**:
  - Per-level interval index: code → list of `(validFrom, validTo, row)`, built from the snapshots stored for the calendar dates; consecutive equal rows of a code are merged. A code duplicated in one snapshot is a `blocking` anomaly (`snapshot-duplicate-code`) and is left out of that date.
  - `resolve(level, code, date, side)` per §6.6, returning `{ intervalKey, interval, path: "direct" | "alias" | "cadastral" }`. `intervalKey` is `<code>@<validFrom>` of the interval: it is not an identity (two consecutive intervals of the same entity have different keys); Step 9 maps intervals to entities.
  - Same-day aliases from pfun 105 (municipalities) and from the internal `RN`/type change events (UTS and regions).
  - Unresolved or ambiguous codes raise `ResolutionError`, converted to a `blocking` anomaly `code-unresolved`.
- **Acceptance**: golden-6 (all 20 same-day suppressions resolve through aliases on the real snapshots of `D − 1` and `D` and the real pfun 98/105 fixtures; none via `cadastral`); the cadastral fallback covered by a synthetic test; the Sud Sardegna/Ogliastra side-rule example.

### Step 9 — Identity resolution and registry — DONE

- **Deliverables**:
  - transition matcher per §6.7, using the identity graph from Step 7;
  - registry (§5.3).
- **Transition matcher** (per level, over the interval index of Step 8; every interval that closes or opens on a calendar date must be explained):
  - code changes (municipalities: pfun 105; UTS and regions: the internal `RN` and `ESCT`/`CSCT` aliases of §6.6) link the interval of the old code on `d − 1` to that of the new code on `d`;
  - the same code closed and reopened on `d` is the same territory, unless `ES` + `CS` on `d` reuse it, or a code change already links one of the two intervals (explicit evidence beats code equality, e.g. codes swapped on the same day);
  - otherwise a closed interval needs `ES`/`ESCT`/`AS` on `d` and an opened one `CS`/`CSCT`/`AN` on `d` (municipalities: pfun 98/100; UTS and regions: internal events; public 112/113 and 106/107 are cross-checks, `identity-public-event-unmatched` `warning`); events only count on dates where intervals open or close;
  - municipalities only: one closed and one opened interval with the same non-null cadastral code and no events are linked (`identity-cadastral-continuity`, `warning`; Step 11 creates the `inferred` variation); anything else is `transition-unexplained` (`blocking`);
  - an interval with several successors or predecessors keeps none of those links (`identity-transition-conflict`, `blocking`);
  - a name change along a link needs a `CD`/`CDAP` event on `d` (pfun 104/105, 114/108 or internal), otherwise `name-change-without-event` (`warning`); those links are returned as `renamesWithoutEvent`, so that Step 11 recognises the boundaries already reported.
- **ISTAT ids win** (§5.2): every internal event is resolved to its interval (side rule of §3.5 item 6), which takes the root of its component.
  - A chain whose intervals carry two roots is cut where the root changes (`identity-public-internal-mismatch`, `warning`); with intervals without events between the two roots the cut cannot be placed (`identity-split-undetermined`, `blocking`). Events of two components on one interval: `identity-origin-conflict` (`blocking`).
  - Chains with the same root are one entity: no anomaly when the earlier one ends with a suppression and the later one starts with an establishment (documented reconstitution, e.g. Sassofeltrio); `identity-public-internal-mismatch` (`warning`) otherwise; `identity-overlap` (`blocking`) if they overlap.
- **Entities without root** (key `nk:`):
  - regions and UTS: always `blocking` (`identity-origin-missing` with internal data complete, `internal-data-required` otherwise);
  - municipalities: `identity-origin-missing` (`warning`) when the municipality crawl is complete; with internal data incomplete, `internal-data-required` (`blocking`) only for an entity starting with `CS`/`AN` after the first calendar date (a possible reconstitution, §6.1), no anomaly otherwise.
- **Registry file format**: one file per kind (§5.3), `{ "kind", "next_id", "entries": { "<natural key>": <entry> } }`, keys sorted. Entries: entities `{ id, members }` (the ISTAT ids of the identity component, ascending; empty for `nk:` keys), versions `{ id, valid_to }` (half-open end), variations `{ id }`. New keys of one call get ids in a total, deterministic order independent of the input order: entities by first `validFrom`, then first ISTAT code, then natural key; versions by `validFrom`, then entity id; variations by date, then natural key. A natural key given twice in one call is a bug (error). Kinds: `region`, `province`, `municipality`, `<level>-version`, `variation`.
- **Remaps**: a key that changes keeps its id, the entry moves to the new key and the correspondence is appended to `registry/remaps.json` (`{ kind, from_key, to_key, id, reason, recorded_on }`, `recorded_on` = `dates.today`; the remaps of one run sorted by `kind`, then `from_key`). Reasons: `origin-id-available` (§5.3, not retroactive, `info`), `root-changed` and `key-moved` (retroactive, `warning`).
- **Moved-key rule**: when an existing version key disappears and the same entity gets a new key whose interval overlaps it (the old interval from the key and `valid_to`), **reuse the old id** (the earliest overlapping old key), record the remap, log a `warning` and mark the run as retroactive (§10.2).
- **Changed root**: when an identity component (Step 7) changes root between two runs but shares members with a registered entity whose key disappeared, **reuse its id** (the lowest when several), record the remap and mark the run as retroactive.
- **Missing internal data**: an `internal-data-unavailable` gap (Step 7) becomes `blocking` here only when a decision needs it (§6.1): `internal-data-required` above, and for every registered `istat:` entity whose history is absent from the run (no key produced, no member in any component; §5.3): one `blocking` `internal-data-required` per level listing `{ key, id, members }` of each, instead of an `nk:` key with a new id (changed in Step 17). Every `internal-data-required` (this one and the rootless entities above) has `context.cause`: `unavailable` when some internal request of the level (lists, events, details) failed because the source was unavailable (network, exhausted retries, open circuit, `NotInStoreError` in an offline `rebuild`), `absent` otherwise (every request succeeded, or failed with its own blocking `*-request-rejected`/`*-schema-violation`). The cause decides the exit code (Step 17). Re-keying is only `nk:` → `istat:` (`origin-id-available`); a root change keeps the id through the shared members (`root-changed`).
- **Acceptance**:
  - golden 1–5 (identity parts);
  - two builds on the same store produce identical ids;
  - moved-key scenario reuses the id and is classified retroactive.

### Step 10 — Versions — DONE

- **Deliverables**: version builder (§6.9), internally half-open:
  - parent resolution;
  - abbreviation derivation. Non-conforming abbreviations are allowed here and checked by I8 after overrides.
- **Parents**: the parent code of a row (`COD_PROV`/`COD_UTS`, `COD_COMP`/`COD_REG`) is resolved, on every date of the row, to the entity that code identifies at the parent level (from the Step 9 entities), so a version also splits where the parent entity behind an unchanged code changes. Regions are built first, then UTS, then municipalities.
- **Abbreviations**: `SIGLA_AUTOMOBILISTICA` from 1948; before, the `SIGLA_UTS` of the municipalities of the UTS on each date (null values ignored), which must be unanimous. A missing `SIGLA_AUTOMOBILISTICA` stays null without an anomaly here: an override may supply it, and I8 checks the result.
- **Undetermined fields**: a parent code identifying no entity (`version-parent-unresolved`) or a pre-1948 abbreviation missing or not unanimous (`abbreviation-underived`) is a `blocking` anomaly, one per version and cause. The field is null in the internal model (`provinceId`, `regionId`, `abbreviation` are nullable there) and the version is kept, so later stages still run.
- **Version ids**: assigned through the registry (`<entity id>:<validFrom>`, Step 9) after building.
- **Acceptance**: golden 2, 3, 5, 10, 11, 12, 15, 16; I1–I3 unit tests.

### Step 11 — Variations and links — DONE

- **Deliverables**: grouping by act id, participants with roles, links with kinds, dedup, and dropping no-effect participations (§4.3).
  - Public rows are matched to internal events by `(date, entity resolved from the code at that date, event code)`, which provides `istat_act_id` and `description`. An internal event belongs to the entity whose ISTAT origin id is the root of its identity component (§5.1); for regions and UTS its r7/r8 details add related territories.
  - Unmatched public rows keep `istat_act_id = null` and `description = null` and are grouped by connected components (§4.3).
  - Every `(level, event code)` pair has an explicit rule (role and links); a pair without a rule is a `blocking` anomaly (D27). Coverage is checked against the event code summary computed by the build (Step 7).
- **Rules** (`src/build/event-rules.ts`): per pair, the effect (closing, opening, change of attribute, territorial, first validity), the side identifying the subject and the related territory of a row (§3.5 item 6), and the direction of the territory flow (§4.3). Pairs: those of the public lists plus those observed in the internal histories of every region and UTS record (regions: `PV CS CSCT AN ES ESCT AS AQES AQ CE CECS CD VACST`; UTS: `PV CS CSCT AN ES ESCT AS AQES AQ CE CECS CD AP RN CT`; municipalities: `PV CS AN ES AS AQES AQ CE CECS CD AP CDAP RN RNAPUTS`).
- **Effect** per event, links, `indirect` participants, `inferred` variations and `version-boundary-unexplained`: §4.3. Territorial events fall back to `date − 1` (§6.6).
- **Accounting (I14)**: every event row (public lists and internal events) is represented in a variation or dropped with a reason: `first-validity` (`PV`), `no-effect` (`info` anomaly `participation-without-effect`), `unresolved` (`code-unresolved`), `unknown-entity` (`variation-entity-unknown`, `blocking`), `rule-missing` (`event-rule-missing`, `blocking`). A public row matching internal events of several acts joins the act whose details (r9 for municipalities, §6.8; r7/r8 for regions and UTS) list its related territory **by code**, when exactly one act does; otherwise (no related territory, no details, r9 unavailable, or several acts listing it) it stays unmatched (`variation-act-ambiguous`, `warning`; golden-21).
- **Variation ids**: assigned through the registry (§5.3) after building.
- **Acceptance**: golden 1, 2, 4, 6, 9, 18, 19 (variation part); I9, I10, I14 on the full worlds of two consecutive days; a pair without a rule is blocking.

### Step 12 — Overrides — DONE

- **Deliverables**: loader with zod schema, applier, obsolescence check (§6.10); `overrides/abbreviations.json` with the VG entry.
  - Overrides apply day by day, before the versions are merged (changed in Step 17, D36): they may remove version boundaries, never create one (`override-creates-boundary`, `blocking`); no override variations, so `origin` is `istat` or `inferred` (a new value can be added later as a compatible change).
  - I8 is implemented here as the definitive invariant (`src/invariants/`); Step 15 integrates it into the overall check.
- **Acceptance**: golden-7 (world 1921-06-01 → 1923-02-08, so the 801 version is closed inside the target period); obsolete-override test; I8 passes on the real 1921 fixture only after the override.

### Step 13 — Derived fields — DONE

- **Deliverables**: the computations of §7.
- **Acceptance**:
  - Quero → Quero Vas → Setteville chain;
  - Sud Sardegna with multiple successors;
  - Fiume former Italian;
  - golden-18: municipalities with a partial cession abroad are not former Italian;
  - golden-19: Tenda former Italian with `current_successors = [Briga Alta, Limone Piemonte]`;
  - Sassofeltrio active with no successors.

### Step 14 — ANPR cross-check — DONE

- **Deliverables**: join and classification (§6.11). Any ANPR failure (`AnprFormatError`, download failure, exhausted retries, open circuit, HTTP errors) skips the cross-check with a single `warning` and never blocks (D22).
- **Acceptance**: golden 3 (`warning`); every `info` case on synthetic data (golden-14 needs the full municipality world: its count is fixed and asserted in Step 17); a structurally broken CSV yields one `warning` and a successful run.
  - Ambiguity: consecutive rows of the join key are compared day by day; only the days on which rows of the join key overlap are `anpr-not-comparable`, with both methods.
  - Names: `Sampèire`/`SAMPEIRE` is `info` (`anpr-name-diacritics`); a name different even without diacritics is a `warning`.
  - ISTAT codes and provinces: a value of an earlier time of the municipality is a lag, of a later time an anachronism (both `info`), a value never in its history a `warning`. On the 2025-12-31/2026-01-01 world the 377 + 377 Sardinian divergences are `anpr-lagging-istat-code` and `anpr-lagging-province`.
  - `EX`: Tenda (former Italian, ANPR region `01`) is `info` (`anpr-former-italian-missing`); `EX` on an entity that is not former Italian is a `warning`.

### Step 15 — Invariants — DONE

- **Deliverables**: I1–I15 as independent, individually testable checks; anomaly reporting (§8.2); the `warning` check for active municipalities whose current version has an 8xx code (D30).
- **Null fields** (Step 10): I4 reports a null `provinceId`/`regionId` and I8 a null `abbreviation`; the checks that depend on those fields (I5, I7 and similar) skip the versions where they are null instead of adding derived anomalies.
- **Acceptance**:
  - a negative test for each invariant (a crafted dataset violating it is rejected); golden-17 for I13;
  - I15: a `ceded` or `annexed` participant with `abroad: false`, and an `abroad: true` participant without `AS`, `AN`, `CE` or `AQ`, are both rejected;
  - I7: a wrong `COD_PROV_STORICO` fallback (§3.5 item 16) makes I7 fail;
  - I7: an 8xx code whose prefix is the code of a UTS of another time is `info`; one whose prefix never was a UTS code is blocking; a mismatch with suffix < 800 is blocking at any date;
  - the 8xx `warning` fires for an active municipality whose current code has suffix ≥ 800.
- **Implementation notes** (decided with the maintainer):
  - The invariants run on the **internal model** (derived entities, half-open intervals, `role: null` participations). `checkInvariants(world, anomalies?)` returns one result per invariant, `passed`, `failed` or `skipped` (with the reason): an invariant whose data the world lacks (I2 `existence`; I7 `historicalCodes`; I12 `snapshots`, `historicalCodes` and `overrides`; I13 `counts`; I14 `accounts` and `variationIdOf`) is **never** reported as passed. `validate` on `dist/` (Step 17) reads the files back with the `src/dates/` conversions (no local conversion) and so runs with I2, I7, I12, I13 and I14 skipped. `assertInvariants(report)` throws `InvariantViolation` when one failed.
  - Each violation is a `blocking` anomaly with code `invariant-i<n>` and `context.invariant`. I1 reports order, overlaps, inverted intervals and entities without versions; the zero-length version is I10's. I3 compares the published fields only. I6 reports one anomaly per pair of entities sharing a value over a common period (the versions of one entity are I1's). I9's only exemption is the versions starting on the first calendar date. I10 also requires every variation to have a participation with effect; participants with `role: null` are the ones the emitter drops. I11 recomputes the derived fields with `deriveFields` and compares them field by field (one violation per entity and field), then applies the rule on suppressed entities without current successors. I14 also checks that the variation key resolves to a variation that exists, and that the drop reason is known.
  - I7: the UTS codes "of some time in the dataset" are exclusively those of the checked world: the codes of every version of every UTS and their historical codes. Test worlds covering a few dates pass the missing ones through the explicit, test-only `extraUtsCodes` parameter. The `info` anomaly is `municipality-8xx-prefix-of-another-uts`; the D30 `warning` is `active-municipality-8xx-code` (`checkActive8xxCodes`).
  - I12 compares every snapshot it is given (`storeSnapshotSets(store)` streams every stored one, probes included; audit samples use the same `SnapshotSet` shape), per level and date, projecting each version: the three names (split as the builder does), codes, type, cadastral code, the codes of its UTS and region **on that date**, the historical codes (§5.5) and the abbreviation. The expected abbreviation of a version is the value of the override applied to it, if any; else `SIGLA_AUTOMOBILISTICA` of the snapshot; before 1948 the one the municipality rows of the same snapshot report, derived with the builder's `municipalityAbbreviations` (null when not unanimous; not compared when the date has no municipality rows: `checkI12Detailed` and the I12 result of `checkInvariants` then carry `uncompared.abbreviation`, the number of versions and of dates left out). One anomaly per level and date, listing at most 20 differences with the total.
  - Fixtures downloaded for golden-17: pfun 68, 64 and 61 on 2026-10-01, the date of the count fixtures (§11.2).

### Step 16 — Emitters, meta and changes — DONE

- **Deliverables**:
  - public emitters (§6.12, §9) with inclusive dates and deterministic formatting;
  - `meta.json`;
  - JSON Schemas in `dist/schema/`;
  - `changes.json`: diff against the previous release. An item is `retroactive` if it changes the published state of any day before the previous `meta.data_version`; closing a version that was open changes only the days after its new end (implementation notes below).
  - a field that the public schema does not admit as null but is null internally (Step 10) stops the emitter with an error, whatever the anomalies.
- **Acceptance**: byte-identical output across two runs on the same store; schema validation of all outputs; §4.4 example reproduced.
- **Implementation notes** (decided with the maintainer):
  - `src/emit/`: `toPublicData` (internal → public; inclusive ends only here; `role: null` participations dropped; entities by `id`, versions by `valid_from`, participants by `(level, territory_id)` and links by `(level, from, to)` with levels in the order region, province, municipality; `istat_events` alphabetically), `toPublicAnomalies` (warnings then infos, by code, then by the canonical JSON of message and context), `emitDataset`, `computeChanges`, `buildMeta`/`sourceSummaries`, `loadPublishedDataset`. Every file is validated against its public model before anything is written; meta and changes have zod models too and their JSON Schemas are generated with the others (`dist/schema/meta.schema.json`, `changes.schema.json`). Anomaly codes are kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`).
  - `generated_at` is an input (the CLI reads the clock, the emitter never does). `emitDataset` returns the kind of release (files written atomically, `meta.json` always last):
    - `unchanged`: the four data files (regions, provinces, municipalities, variations) and the JSON Schemas are identical to the previous release: `dist/` is **not touched**; `anomalies.json` stays the one of the build that produced the release and `generated_at` is not renewed; the current anomalies go to the run summary (Step 17);
    - `schemas`: same data files, different schema files (a generator change): `dist/schema/`, an empty non-retroactive `changes.json` and `meta.json` are written, so the published schemas never lag behind the generator; the data files and `anomalies.json` stay those of the previous release, and so does its meta (`data_version`, which identifies the data content, sources, counts, anomaly counts) except `schema_version` and `generated_at`; `changes.json` goes from the previous release to the same `data_version` with the new `generated_at`. Step 17 treats it as an additive, non-retroactive release;
    - `data`: every file is written.
  - The previous release is an input (`null` for the first one: everything added, nothing retroactive); Step 17 decides where it comes from (`dist/` in the checkout, `git show`, `diff <from> <to>`).
  - Retroactivity by **days modified**, the reference being the previous `data_version`. `affected_from` of a version: the earlier `valid_from` when any field other than `valid_until` changed, otherwise the day after the earlier end (null = open), so closing an open version at `U` is additive iff `U + 1` is not before the reference; of a variation: the earlier date; of an entity (entity-level fields only, its versions are items of their own): the earliest date among the links added or removed, and for `status` the day after the end of the last version (old or new); `istat_origin_id`, `is_former_italian` and `current_successors` carry no date (`affected_from` null, not retroactive: they follow from dated items flagged on their own). Removed items: their first day; added items are retroactive iff their first day precedes the reference.
  - `meta.sources` per family `situas-public-snapshots`, `situas-public-reports` (stored event lists and counts), `situas-internal`, `anpr` (the stored archive, `manifests: 1`): `{ fetched_at, content_hash, manifests }`, the latest `fetched_at` of the store manifests of the current projection version, the SHA-256 of the canonical JSON of the sorted `[manifest key, content_hash]` pairs, their number; `null` for a family without stored responses. Every family comes from the store (Step 17), so an offline rebuild publishes the same summaries. `schema_version` starts at `1.0.0`.
  - Every output is validated with Ajv (dev dependency, tests only) against the JSON Schema published next to it (`test/helpers/json-schema.ts`; formats `date` and `date-time` defined with the generator's date rules): emitted datasets of the unit and golden tests, and the repository `dist/` once it holds a release.

### Step 17 — Commands: bootstrap, update, rebuild, audit, validate, diff — DONE

- **Deliverables**:
  - Full orchestration per §10.1–§10.2.
  - Exit codes: `0` success; `1` blocking anomalies; `2` retroactive changes (PR required); `3` source unavailable. Mapped from anomaly codes, never from messages: `snapshot-unavailable` → 3 (timeouts, connection errors, 5xx or 429 after exhausted retries, open circuit); `snapshot-request-rejected` (non-retryable 4xx) and `snapshot-schema-violation` → 1.
  - A `blocked` snapshot stage (Step 6) stops the pipeline before identity resolution.
  - Inferred breakpoints are kept in `calendar.json` across runs (source `inferred`): a calendar rebuilt from the sources must not lose them. Step 6 removes those no longer confirmed, and a published event on the same date replaces the `inferred` source.
  - Run summary written to `.cache/last-run.json`, for the workflows.
  - **`validate` on `dist/`**: implemented as a command that reads the published files back into the internal model (inclusive → half-open with the `src/dates/` conversions, no local conversion) and runs `checkInvariants` with I2, I7, I12, I13 and I14 reported as `skipped`, never as passed (they need unpublished data, snapshots, counts or event accounts).
- **Acceptance**:
  - **I12 timing**: measure the time I12 takes on the complete run (every stored snapshot, probes included) and report it to the maintainer, who decides whether it needs optimising. Also report `uncompared.abbreviation` of the I12 result.
  - **`sourceSummaries` timing**: measure the time `sourceSummaries` (Step 16, `meta.json`) takes on the complete store (it reads every snapshot manifest, the municipality ones holding thousands of row hashes each) and report it to the maintainer, who decides whether it needs optimising.
  - end-to-end tests on a declarative world (`test/helpers/world.ts`: two regions, four UTS, a dozen municipalities of Veneto and Sardinia from 2000-01-01, a fusion, a rename, a municipality without cadastral code, an override loaded from a temporary `overrides/`) whose transport answers every request in the raw formats of the real sources; a test checks that every kind of generated row has the field set of a real fixture row and decodes with the production adapters. The regime crossings are covered by the golden cases of Steps 6 and 10;
  - offline `rebuild` with a working transport: no request reaches it, exit 0, same data, I13 and ANPR from the store; without stored counts: `count-unavailable` (exit 3) asking for `update` or `rebuild --refetch`; without a stored snapshot: `snapshot-unavailable` (exit 3); without a stored internal report: `internal-data-unavailable` (`warning`), never fetched; when it is the history of a registered entity (Alghero's r6), also `internal-data-required` (`blocking`, `cause: unavailable`, exit 3): no id change, `dist/` and `registry/` not written (§5.3); an `update` whose requests all succeed while the history of a registered entity is absent (no longer listed in r3, not in the store): `internal-data-required` with `cause: absent`, exit 1, nothing written; the offline run context refuses every request with a programming error (`OfflineRequestError`, not retried, never degraded), and an offline mode requires an offline context;
  - audit: a change hidden between `p` and the sampled date `d` is placed on its own date, not on `d`;
  - incremental scenario adding a fusion (exit 0);
  - retroactive scenario (exit 2);
  - removed inferred breakpoint: an `inferred` date already published as a version boundary is no longer confirmed (Step 6) and leaves the calendar; the two versions it separated merge into one, and the run is classified as retroactive (exit 2).
  - golden-14 on the full run: the number of suppressed municipalities absent from ANPR (`anpr-missing-entity`) is reported to the maintainer, fixed in §11.3 and asserted.
  - the full run is executed by the maintainer; `.cache/last-run.json` holds every measure above (I12 time and `uncompared`, `sourceSummaries` time, offline build time, golden-14 count, count of every anomaly code).
  - ANPR counts are evaluated only on the full run: the test worlds cover a few days and lack the history the classification needs (a later province, a cession of 1947, the continuation of a suppressed municipality), so their counts are not significant. The count of every ANPR `warning` code (`anpr-divergent-*`, `anpr-unmatched-period`, `anpr-former-italian-divergence`) is reported to the maintainer, to decide whether to downgrade any of them to `info` (decided after the first full run: dates classified by direction, names by the history, the known cases of ANPR covering more as `info`, §6.11).

- **Implementation notes** (decided with the maintainer):
  - `src/commands/`: `acquire.ts` (event lists, internal crawl with the mandatory refreshes of the mode, ANPR, counts; every source stored and read back from the store), `audit.ts`, `refresh.ts` (stored snapshots), `build.ts` (identity → invariants, no network), `pipeline.ts` (`bootstrap`, `update`, `rebuild [--refetch]`, `audit`), `published.ts` (`validate`, `diff`), `exit-codes.ts`, `summary.ts`, `context.ts` (the runtime the CLI provides: transport, wall clock for `generated_at`, monotonic clock for timings). Stage order: event lists → internal crawl → ANPR → counts → calendar → audit (update) → refresh of stored snapshots (update; `rebuild --refetch`: all of them) → snapshots and completeness → build → emit.
  - **Exit codes**, by anomaly code (and, for `internal-data-required`, by its `context.cause`), never by message: `*-unavailable` (`snapshot-`, `event-list-`, `count-`, `internal-list-`) and `internal-data-required` with `cause: unavailable` → 3 when no other blocking anomaly is present (`completeness-unverified` follows them); `internal-data-required` with `cause: absent`, `*-request-rejected`, `*-schema-violation` and every other blocking anomaly → 1; the blocking anomalies are logged with their `cause` when they have one; else 2 when retroactive (`changes.json` retroactive, retroactive registry remaps, audit discrepancies), else 0. The internal crawl keeps its warnings for r4–r8; a list r1–r3 unavailable with no copy adds `internal-list-unavailable`. A missing event list blocks the build like a blocked snapshot stage.
  - **Effects by exit code**: 0 and 2 write `dist/` and `registry/`; 1 and 3 write neither; the store and `calendar.json` are always written; `.cache/last-run.json` (`paths.runSummary`) always: when the command throws (outcome `error`, exit 1), on SIGINT/SIGTERM (outcome `interrupted`, `signal`, then the process exits with 130/143) and on an uncaught exception or unhandled rejection anywhere in the process (outcome `error`, exit 1); the summary is written once, a later ending never overwrites it. Blocking anomalies are also logged (the first 50).
  - **Progress**: every stage logs `stage start` and `stage done` (with `completed`, `total`, `errors` when it counted requests); while a stage runs, a `progress` line every 30 s with the same counts (a timer, so a stage stalled on retries still reports). Counted: event lists, internal reports, snapshots (calendar dates and probes), audit samples, refreshed snapshots.
  - **Disabled endpoints**: one `http endpoint disabled` line with the cause when an endpoint is disabled; the other schema violations of requests in flight and the requests refused afterwards are not logged one by one; at the end one `requests refused by a disabled endpoint` line per endpoint with the count, also in the run summary (`disabled_endpoints`).
  - **`update`** without the state of a previous run (`calendar.json` in the store, a release in `dist/`) exits 1 asking to run `bootstrap`, which resumes from the cache; never an automatic bootstrap (a lost `data-cache` in CI must not trigger ~15,000 requests).
  - **Audit**: samples in `[start, today)` from a PRNG seeded with `today`; corrections per §10.2; `audit-discrepancy` warnings; `audit` alone writes the store and `calendar.json` (inferred dates kept for the next build), never `dist/`.
  - `time`, `level` and `msg` are reserved to the logger: `LogFields` forbids them in the types, and at run time a field never replaces them; a territorial level is logged as `territoryLevel`.
- **First release postponed** (2026-10-08): the full run (bootstrap and `rebuild --refetch` on the real sources) met the acceptance criteria, but the published model (§4, §9) is going to be revised before any release. Until then `dist/` and `registry/` are not committed (`.gitignore`, only their `.gitkeep`): no release and no registry with the current ids exist, so the revision starts from a clean state.

### Step 18 — GitHub Actions

- **Deliverables**: the workflows of §10.3:
  - `data-cache` branch checkout and push;
  - PR creation on exit code 2 (a pinned PR-creation action is allowed in workflows);
  - release and npm publish.
- **Schemas releases** (Step 16, §9): a release whose data files are unchanged and whose schemas changed keeps the previous `data_version` and increments the PATCH of the npm version (`MAJOR.YYYYMMDD.PATCH`, MAJOR following `schema_version`). The git tag scheme must distinguish it from the data release with the same `data_version`: today `data-YYYY.MM.DD` would collide (e.g. a suffix carrying the PATCH, to be decided in this step).
- **Acceptance**: dry-run on a fork; no publish on exit codes 1, 2 or 3; a schemas release gets its own tag and npm PATCH.
- **Open points** (to discuss or implement in this step):
  - the automatic update must also update `CHANGELOG.md`. Releases created with the `GITHUB_TOKEN` do not trigger other workflows, so `update-changelog.yml` (manual releases only) is not enough: the update has to happen inside the release flow, or the release has to be created with a PAT/GitHub App;
  - decide how the workflows that commit to `main` (changelog, data releases) behave when `main` is protected (bypass for GitHub Actions, PAT/GitHub App, or PR).

### Step 19 — Documentation

- **Deliverables**:
  - README covering: purpose; scope and perimeter; de iure dates; inclusive `valid_until`; file formats; id stability; consumer resolution contract (§7); update cadence; anomaly levels.
  - README: for versions with an 8xx `istat_code` (§3.5 item 17), the code must not be used to derive the province; use `province_id`.
  - README: the date of the last data update (`data_version` of `meta.json`), clearly visible near the top, updated automatically by every data release (the release flow of Step 18 writes it; a schemas release leaves it unchanged).
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
| D24 | Minimal dependencies (`zod`, `csv-parse`); generator code not published to npm; `ajv` only as a dev dependency for tests (JSON Schema validation of the published files), never at runtime | Small attack surface; the npm package is a data package |
| D25 | Three request scopes: host (pool, AIMD, rate limit), family (circuit breaker), endpoint (permanent validation errors) | Congestion is per server; heavy snapshots must not trip light reports; a schema change concerns one report and the run should collect all problems |
| D26 | `ResponseValidationError` and `EndpointDisabledError` do not count for the circuit breaker (neither failure nor reset), do not reduce AIMD concurrency and never trigger `staleFallback`; AIMD and the circuit breaker react only to transport failures (429, 5xx, timeout, connection reset) and transient validation errors | A schema violation is neither congestion nor unavailability; stale data must not hide a blocking problem |
| D27 | Internal adapters accept every event code of §2; each `(level, event code)` pair needs an explicit role/link rule when building variations, and a pair without a rule is blocking; coverage is checked against the pairs observed by the build (a build report, not stored data) | Per-level code sets are not documented by ISTAT; the vocabulary is closed by explicit rules, not by guessed sets |
| D28 | Empty responses are transient only for snapshots and internal lists r1–r3; counts have exactly one row and zero is valid; empty r4–r6 are accepted by the client and produce a blocking anomaly on the single record (Step 7) | Short event ranges and event/detail reports are legitimately empty; a listed record without events is a data problem of that record, not of the transport |
| D29 | Field differences between endpoints or periods are handled by explicit mappings per adapter; defaults for missing fields must be verified by an invariant | No silent guessing between field names; every fallback (e.g. `COD_PROV_STORICO ?? COD_UTS`) is checked (I7) |
| D30 | Municipality codes with suffix ≥ 800 are exempt from the strict I7 prefix rule: the prefix must be a UTS code of some time, differences are `info`; an active municipality with an 8xx current code is a `warning` | ISTAT assigns 8xx codes retroactively to suppressed municipalities with the prefix of a later or earlier province; membership comes from `COD_PROV`/`COD_UTS` only |
| D31 | A foreign state counterpart (`Stato estero`, no code) is allowed only in `AS`, `AN`, `CE`, `AQ` (an acquisition of territory from abroad, verified in r7); it is never resolved and never produces links; the participant carries the public flag `abroad` | Cessions and annexations involve territories outside the perimeter (D16), which have no entity; the flag keeps the information without inventing one |
| D32 | Store manifests carry a `projection_version` per projection; only manifests with the current version are compared or used; a version change requires `rebuild --refetch` and is never retroactive. A refresh with the same content writes nothing; event-list change detection is semantic (rows compared by date range with everything the store knows, not with a previous manifest) | A projection change is a change of the generator, not of the data: it must neither look like an ISTAT correction nor mix rows of different shapes |
| D33 | A cession abroad with partial transfers to Italian territories on the same day keeps its links (`merged_into`, the ceded entity ceases); the entity is former Italian (closed with `ceded`, a terminal point of `is_former_italian`); its `current_successors` are the parts that stayed Italian and are never used for automatic migration (§7) | Verified on 1947-09-16 (Tenda, Briga Marittima and four municipalities of Gorizia): the domestic flows are real and must not be lost, but the entity itself went abroad |
| D34 | A UTS version boundary where only the abbreviation changes, without an event, is a `warning` (`abbreviation-change-without-event`) with an `inferred` variation, never blocking | Abbreviations (vehicle plates) are not ISTAT acts: they change without events (Forlì-Cesena `FO` → `FC`, Pesaro e Urbino `PS` → `PU` on 1999-01-01) |
| D35 | Within one identity component, a `CSCT` on `d` pairs with the member whose interval ends on `d`, whatever its own events (`ESCT`, `ES` or none): a type-change alias, one entity; silent when documented by an `ESCT` or confirmed by the public lists, otherwise `warning` | ISTAT records the 1948 type changes of the compartments inconsistently (Piemonte `ES` + `CSCT`, Venezia Tridentina no event + `CSCT`), while pfun 106/107 show them as `ESCT`/`CSCT` |
| D36 | Overrides are applied to the values of every day before contiguous days are merged into versions; they may remove version boundaries but never create one (`override-creates-boundary`, blocking) | A correction must not invent history: it can only make the published data match what ISTAT reports on the neighbouring days (Littoria `LT` in 1934) |
| D37 | Report 9 (municipality event details) is downloaded only for the ambiguous events (one entity, same date and event code, several internal acts) and used only to match public rows to acts by related code; never for related territories or other checks | r9 for every municipality event would be tens of thousands of requests for data the public rows already give; the only gap it fills is which act a row belongs to (Riola Sardo 1946, golden-21) |
| D38 | The circuit breaker opens only after `circuitBreakerThreshold` consecutive failures of more than one request lasting at least `circuitBreakerMinFailureMs`; while open, requests wait and a single probe is sent after a cooldown doubled at every reopening; a family is lost for the run (exit 3) only after `circuitBreakerMaxOpenMs` of open time in total. A request out of attempts fails alone only if its family had a success after its first failure; otherwise it waits for the family's verdict (one waiting request retries every `backoffMaxMs`), and a request failing alone gives up at the opening condition without opening the circuit. `rebuild --refetch` refreshes with `fetchedSince: today` on the HTTP cache, so an interrupted refetch resumes the same day | With 8 requests in flight, a DNS failure of 2 s made 10 consecutive failures and lost a whole refetch (17 000 snapshots, over an hour); an outage must cost waiting, not the run, also when it lasts longer than a request's retries (30–60 s) or hits a sequential stage; a single broken URL must not cost its whole family; a resumed run must not download again what it already has |

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
│   ├── identity/              # identity graph, transition matching, registry
│   ├── build/                 # versions, variations, links
│   ├── enrich/                # internal crawl and enrichment
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

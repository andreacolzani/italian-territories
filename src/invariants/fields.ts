/** The published fields of a version (§4.2): what I3 compares, apart from the id and the interval. */
import type { Level } from '../model/common.ts';
import type { VersionByLevel } from '../model/internal.ts';

type AnyVersion = VersionByLevel[Level];

/** The published fields of a version of `level`, in a fixed order, for equality checks. */
export function publishedFields(level: Level, version: AnyVersion): readonly unknown[] {
  const names = [version.istatCode, version.officialName, version.italianName, version.foreignName];
  switch (level) {
    case 'region': {
      const v = version as VersionByLevel['region'];
      return [...names, v.type];
    }
    case 'province': {
      const v = version as VersionByLevel['province'];
      return [...names, v.type, v.abbreviation, v.regionId];
    }
    case 'municipality': {
      const v = version as VersionByLevel['municipality'];
      return [...names, v.cadastralCode, v.provinceId, v.regionId];
    }
  }
}

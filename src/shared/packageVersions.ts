interface PackageVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/**
 * Compare semver-shaped versions (including PI WEB's `MAJOR.YYYYMM.PATCH`
 * CalVer). Returns a negative number, zero, or a positive number, or
 * `undefined` when either version cannot be parsed.
 */
export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
  const left = parsePackageVersion(leftVersion);
  const right = parsePackageVersion(rightVersion);
  if (left === undefined || right === undefined) return undefined;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function parsePackageVersion(version: string): PackageVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u.exec(version.trim());
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

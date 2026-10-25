#!/usr/bin/env node
/**
 * Monitor PI SDK versions for breaking changes.
 *
 * Detects updates from npm for all @earendil-works/pi-* packages and flags
 * major/minor bumps that may require attention.
 *
 * Exit 0 = nothing to do.
 * Exit 1 = updates available (useful for CI / scheduled checks).
 *
 * Usage:
 *   node scripts/check-pi-sdk-versions.mjs              # JSON output for CI
 *   node scripts/check-pi-sdk-versions.mjs --report      # Human-readable report
 *   node scripts/check-pi-sdk-versions.mjs --fail        # Exit 1 on any update
 *
 * Background
 * ----------
 * Pi SDK releases have had packaging regressions that broke downstream
 * consumers (e.g. @earendil-works/pi-coding-agent@0.85.0 shipped a barrel
 * that statically imported the undeclared @earendil-works/pi-server, making
 * it impossible to load).
 *
 * This script — combined with the integrity test in src/server/piSdkIntegrity.test.ts
 * and the version-exclusion ranges in package.json peerDependencies — forms a
 * three-layer guard:
 *
 * 1. **peerDependencyRange** in package.json excludes known-bad versions.
 * 2. **piSdkIntegrity.test.ts** runs at test-time: if the barrel has a
 *    structural defect (missing exports, undeclared imports), the test fails
 *    with a clear message instead of silently corrupting sessions.
 * 3. **This script** is run on a schedule (GitHub Actions cron) to notify
 *    maintainers that a new version is published so they can review the
 *    changelog *before* it arrives via a dependency update.
 *
 * See docs/pi-sdk-monitoring.md for the full documentation.
 */

import https from "node:https";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * All @earendil-works packages that ship Pi SDK code and appear as
 * dependencies of PI WEB.  Keep this list in sync with package.json.
 */
const SDK_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
];

// ---------------------------------------------------------------------------
// Package.json reader
// ---------------------------------------------------------------------------

function readPackageJson() {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf-8");
  return JSON.parse(raw);
}

/**
 * Extract the currently constrained version for a package from
 * dependencies, devDependencies, and peerDependencies.
 */
function getConstrainedVersion(pkg, packageName) {
  const sources = ["dependencies", "devDependencies", "peerDependencies"];
  for (const src of sources) {
    const ver = pkg[src]?.[packageName];
    if (ver) return { version: ver, source: src };
  }
  return null;
}

// ---------------------------------------------------------------------------
// npm registry client (zero dependencies)
// ---------------------------------------------------------------------------

function npmGet(packageName) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      { headers: { accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`npm registry returned ${res.statusCode} for ${packageName}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data)));
      }
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${packageName} from npm`));
    });
  });
}

function npmLatest(packageName) {
  return npmGet(packageName).then((data) => {
    const distTags = data["dist-tags"] ?? {};
    const latestVersion = distTags["latest"];
    if (!latestVersion) {
      throw new Error(`No "latest" dist-tag for ${packageName}`);
    }
    const versions = Object.keys(data.versions ?? {}).sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va < vb) return -1;
        if (va > vb) return 1;
      }
      return 0;
    });
    return { latestVersion, latestTag: "latest", allVersions: versions, data };
  });
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

function parseSemver(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: version };
}

function bumpLevel(current, target) {
  const c = parseSemver(current);
  const t = parseSemver(target);
  if (!c || !t) return "unknown";
  if (t.major > c.major) return "major";
  if (t.minor > c.minor) return "minor";
  if (t.patch > c.patch) return "patch";
  return "none";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    report: args.includes("--report"),
    fail: args.includes("--fail"),
  };

  const pkg = readPackageJson();
  const results = [];
  let exitCode = 0;

  for (const packageName of SDK_PACKAGES) {
    try {
      const npmInfo = await npmLatest(packageName);
      const constrained = getConstrainedVersion(pkg, packageName);

      if (!constrained) {
        results.push({
          packageName,
          status: "not-found",
          message: "Not found in package.json dependencies",
        });
        continue;
      }

      // Extract numeric version from constraint (e.g. "^0.85.1" → "0.85.1")
      let constraintVer = constrained.version.replace(/[\^~>=<| ]/g, "").trim();
      const bump = bumpLevel(constraintVer, npmInfo.latestVersion);

      const result = {
        packageName,
        source: constrained.source,
        constrainedVersion: constrained.version,
        constraintVer,
        latestVersion: npmInfo.latestVersion,
        latestTag: npmInfo.latestTag,
        bump,
        totalVersions: npmInfo.allVersions.length,
        allVersions: npmInfo.allVersions,
      };

      if (bump === "none") {
        result.status = "up-to-date";
        result.message = "Already on latest version.";
      } else if (bump === "major") {
        result.status = "BREAKING";
        result.message = `Major version bump: ${constraintVer} → ${npmInfo.latestVersion}. Review changelog before upgrading.`;
        exitCode = 1;
      } else if (bump === "minor") {
        result.status = "minor";
        result.message = `Minor version bump: ${constraintVer} → ${npmInfo.latestVersion}. Check for API changes.`;
        exitCode = 1;
      } else {
        result.status = "patch";
        result.message = `Patch version bump: ${constraintVer} → ${npmInfo.latestVersion}. May be safe to update.`;
      }

      results.push(result);
    } catch (err) {
      results.push({
        packageName,
        status: "error",
        message: err.message,
      });
      exitCode = 1;
    }
  }

  if (flags.report) {
    console.log("\n=== PI SDK Version Monitor ===\n");

    for (const r of results) {
      if (r.status === "not-found") {
        console.log(`  ❌ ${r.packageName}: ${r.message}`);
        continue;
      }
      if (r.status === "error") {
        console.log(`  ⚠️  ${r.packageName}: ${r.message}`);
        continue;
      }
      if (r.status === "up-to-date") {
        console.log(`  ✅ ${r.packageName}: ${r.message} (${r.latestVersion})`);
        continue;
      }
      const icon = r.status === "BREAKING" ? "🔴" : r.status === "minor" ? "🟡" : "🟢";
      console.log(`  ${icon} ${r.packageName}: ${r.message} (${r.source}: ${r.constrainedVersion})`);
      console.log(`     → Latest available: ${r.latestVersion} (tag: ${r.latestTag})`);
      if (r.bump === "major") {
        console.log(`     → Total versions published: ${r.totalVersions}`);
      }
    }

    console.log();
  } else {
    console.log(JSON.stringify(results, null, 2));
  }

  if (flags.fail && exitCode === 1) {
    process.exit(1);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(2);
});

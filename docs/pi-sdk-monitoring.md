# PI SDK Version Monitoring

Guard rails to detect upstream Pi SDK updates and packaging defects
**before** they break production PI WEB sessions.

## Background: the 0.85.0 incident

The `@earendil-works/pi-coding-agent@0.85.0` release shipped a barrel that
statically imported `@earendil-works/pi-server`, an undeclared dependency.
The package could not be loaded at all — every `npm install` of PI WEB that
resolved 0.85.0 would fail at runtime with a cryptic "module not found" error.

The fix was:

1. Exclude 0.85.0 from the peer dependency range
   (`>=0.84.0 <0.85.0 || >=0.85.1`).
2. Develop against 0.85.1 (the fixed release).
3. Add an integrity test so future packaging defects fail fast.

We want to prevent a repeat with future version bumps (0.84→0.85 also
introduced breaking changes that affected PI WEB).

## The three-layer guard

### 1. `peerDependencyRange` in `package.json`

Known-bad versions are explicitly excluded from the range, so `npm install`
will never resolve them even if something else requests them.

### 2. `src/server/piSdkIntegrity.test.ts`

Runs during `npm test`.  Dynamically imports each SDK package and verifies:

- The barrel loads without an undeclared-import error.
- All exports that PI WEB depends on are present and are the expected type.
- The version is not in the known-bad set.

A structural defect fails this test with a clear message instead of
silently corrupting sessions at runtime.

### 3. `scripts/check-pi-sdk-versions.mjs` (this workflow)

Queries the npm registry for every monitored package, compares the latest
version against the constraint in `package.json`, and flags any **major** or
**minor** bump.

- **JSON output** (`node scripts/check-pi-sdk-versions.mjs`) — for CI / scripts.
- **`--report`** (`node scripts/check-pi-sdk-versions.mjs --report`) — human-readable.
- **`--fail`** — exits 1 on any update so CI can break the build.

The GitHub Actions workflow runs this every **Monday at 09:00 UTC** and, on
failure, creates or updates an issue labelled `sdk-monitor` so maintainers
can review the changelog *before* a version arrives via a dependency update.

## Monitored packages

| Package | Peer dependency range |
|---------|----------------------|
| `@earendil-works/pi-coding-agent` | `>=0.84.0 <0.85.0 \|\| >=0.85.1` |
| `@earendil-works/pi-agent-core` | `>=0.84.0` |
| `@earendil-works/pi-ai` | `>=0.84.0` |

## Alert levels

| Icon | Level | Action |
|------|-------|--------|
| 🟢 | up-to-date | No action needed. |
| 🟡 | minor | Minor version bump available. Review changelog, test, update if safe. |
| 🔴 | BREAKING | Major version bump. Review changelog carefully — likely API changes. |
| 🚫 | excluded | Latest version is excluded by peerDependencyRange. Wait for range update. |

## Adding a new monitored package

1. Add it to `SDK_PACKAGES` in `scripts/check-pi-sdk-versions.mjs`.
2. Ensure it appears in `package.json` dependencies or peerDependencies.
3. If a version should be excluded, add the exclusion range to peerDependencies.
4. Add exports to `piSdkIntegrity.test.ts`.

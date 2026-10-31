# Temporary code

Track compatibility migrations and dependency workarounds here so their removal conditions remain visible. Temporary code needs a concrete removal condition, not just a TODO.

## Compatibility support policy

Compatibility migrations remain supported for **at least two calendar months and four subsequent published stable releases** after the migration first ships. Both thresholds must be met before removal is eligible.

- Count from the publication date of the first stable release containing the migration, not its commit or merge date.
- Count four subsequent stable PI WEB releases; the introducing release and prereleases do not count.
- If two months pass with only one subsequent release, keep the migration.
- If four subsequent releases ship in three weeks, keep the migration.
- Meeting both thresholds permits a removal review; it does not automatically authorize removal. Decide the behavior for older inputs and provide upgrade guidance before removing support.

Dependency workarounds have a different lifetime: keep them until the supported dependency no longer needs the workaround. An upstream fix or a closed upstream issue alone is not enough; verify the published dependency and PI WEB's required version.

## Tracking and removal

For each new temporary workaround or migration:

1. Add an entry below with a stable ID, purpose, implementation and test paths, first shipped release/date where relevant, removal condition, and tracking links.
2. Mark its implementation with `TEMP(<id>): see docs/temporary-code.md`.
3. Review this register during release preparation. Record the first shipped stable version and publication date when an unreleased migration ships; assess removal conditions against published releases.
4. When removal is approved, remove the implementation, its marker, obsolete tests, and register entry together. Retain tests for behavior that remains supported.

Keep entries until removal is complete. Do not guess release dates or replace concrete conditions with “remove later.” Existing entries without source markers can be marked when their implementation is next changed.

The minimum support window is a floor, not permission to break a published API. Public plugin API removals also require an explicit compatibility/release decision. Normal runtime fallbacks, atomic-write temporary files, and support for valid historical session records are not temporary code merely because they mention compatibility.

Release baselines below were checked against containing Git tags and GitHub stable-release publication dates. Recheck release history before deciding that an entry is eligible for removal.

## Active entries

### macOS-pty-helper

- **Why:** node-pty 1.1.0 publishes macOS `spawn-helper` binaries without execute permissions. Terminal checks and creation restore those permissions.
- **Implementation:** [nodePtySpawnHelper.ts](../pi-web-plugins/terminal/server/nodePtySpawnHelper.ts), called by [nodePtyProvider.ts](../pi-web-plugins/terminal/server/nodePtyProvider.ts).
- **Tests:** [nodePtySpawnHelper.test.ts](../pi-web-plugins/terminal/server/nodePtySpawnHelper.test.ts).
- **First shipped:** unreleased.
- **Remove when:** PI WEB requires a stable node-pty version whose published macOS helpers have verified executable permissions. Verify both supported macOS architectures before removing the repair.
- **Tracking:** [PI WEB #391](https://github.com/jmfederico/pi-web/issues/391), [node-pty #850](https://github.com/microsoft/node-pty/issues/850).

### session-naming-config-migration

- **Why:** move legacy core `sessionNaming` settings into configuration owned by the removable session-naming Pi package without losing saved settings.
- **Implementation:** [configSessionNamingMigration.ts](../src/configSessionNamingMigration.ts), called by [config.ts](../src/config.ts).
- **Tests:** [configSessionNamingMigration.test.ts](../src/configSessionNamingMigration.test.ts).
- **First shipped:** unreleased; record the first stable version and publication date at release preparation.
- **Remove when:** both the two-calendar-month and four-subsequent-stable-release minimums have elapsed from first shipment, and the behavior for remaining legacy settings and manual upgrade guidance has been decided. Preserve users' unmigrated settings; do not silently discard them.
- **Tracking:** introduction commit `ad06af3b`; pending release note [.changeset/optional-automatic-session-naming.md](../.changeset/optional-automatic-session-naming.md). The changeset is consumed at release preparation; replace that link with the published release when recording first shipment.

### deprecated-agent-config

- **Why:** retain the old agent-directory inputs while users adopt `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`; warn about ignored command inputs. The old directory aliases still affect precedence and storage selection.
- **Implementation:** [config.ts](../src/config.ts) (`AGENT_SESSION_DIR_ENV_KEYS`, `effectiveAgentConfig`, `detectDeprecatedAgentInputs`, legacy agent validation), [agentProcessEnvironment.ts](../src/server/sessiond/agentProcessEnvironment.ts), and [deprecatedAgentInputsBanner.ts](../src/client/src/components/deprecatedAgentInputsBanner.ts). Runtime/status reports also carry the deprecation warnings.
- **Tests:** [config.test.ts](../src/config.test.ts), [deprecatedAgentInputsBanner.test.ts](../src/client/src/components/deprecatedAgentInputsBanner.test.ts).
- **First shipped:** [v1.202608.1](https://github.com/jmfederico/pi-web/releases/tag/v1.202608.1), 2026-08-11; deprecation introduced by `0085967e`.
- **Remove when:** the minimum support window has elapsed and handling of `PI_WEB_AGENT_DIR`, `PI_WEB_AGENT_SESSION_DIR`, `agent.dir`, `PI_WEB_AGENT_COMMAND`, and `agent.command` has been explicitly decided and documented. Do not silently redirect users to a different agent/session directory when an old alias disappears. Remove associated warnings and wire fields only after reviewing mixed-version components.

### session-pin-storage-migration

- **Why:** import pins from web-owned navigation preferences into daemon-owned `session-pins.json`. The destination's existence prevents re-import, including after users deliberately clear all pins.
- **Implementation:** [sessionPinStore.ts](../src/server/storage/sessionPinStore.ts) (`initialize` and `legacyFilePath`) and [navigationPreferenceStore.ts](../src/server/storage/navigationPreferenceStore.ts) (`sessionPinSnapshot`). Keep the live pin store; only its legacy import is temporary.
- **Tests:** [sessionPinStore.test.ts](../src/server/storage/sessionPinStore.test.ts), [navigationPreferenceStore.test.ts](../src/server/storage/navigationPreferenceStore.test.ts).
- **First shipped:** [v1.202610.9](https://github.com/jmfederico/pi-web/releases/tag/v1.202610.9), 2026-10-30; introduced by `ec645526`.
- **Remove when:** the minimum support window has elapsed and a manual upgrade path exists for users who still have only the old navigation file. Preserve existing destination state and do not silently lose pins on a direct upgrade.

### plugin-entrypoint-compatibility

- **Why:** keep browser API v4 and server API v3 plugins working alongside API v5, including adapters for their older activation and request contexts.
- **Implementation:** [plugin-api.ts](../src/plugin-api.ts), [server-plugin-api.ts](../src/server-plugin-api.ts), [registry.ts](../src/client/src/plugins/registry.ts), and [serverPluginRuntime.ts](../src/server/plugins/serverPluginRuntime.ts). Both runtimes emit deprecation warnings for the older entrypoints.
- **Tests:** [registry.test.ts](../src/client/src/plugins/registry.test.ts), [serverPluginRuntime.test.ts](../src/server/plugins/serverPluginRuntime.test.ts), [plugin-api.test.ts](../src/plugin-api.test.ts), [server-plugin-api.test.ts](../src/server-plugin-api.test.ts).
- **First shipped:** v5 and deprecation shipped in [v1.202610.5](https://github.com/jmfederico/pi-web/releases/tag/v1.202610.5), 2026-10-20; introduced by `0f6375d1`.
- **Remove when:** at least the minimum support window has elapsed, plugin-author migration guidance is available, and removal is explicitly approved as a public API compatibility change. Do not remove independently versioned capabilities just because the old entrypoint adapters are removed.

### runtime-theme-contributions

- **Why:** retain JavaScript-registered themes and theme pairs while plugins move to declarative `package.json` contributions. This also covers v5 plugins and is separate from old entrypoint support.
- **Implementation:** [registry.ts](../src/client/src/plugins/registry.ts) (runtime contribution registration and warnings), [plugin-api.ts](../src/plugin-api.ts) (deprecated runtime theme declarations).
- **Tests:** [registry.runtimeThemes.test.ts](../src/client/src/plugins/registry.runtimeThemes.test.ts).
- **First shipped:** declarative replacement and deprecation shipped in [v1.202610.9](https://github.com/jmfederico/pi-web/releases/tag/v1.202610.9), 2026-10-30; introduced by `0b39515f`.
- **Remove when:** the minimum support window has elapsed and the public API removal is approved with plugin-author guidance. Preserve saved theme IDs and document recovery for themes whose packages have not migrated.

### git-shortcut-aliases

- **Why:** preserve saved shortcuts for `core:view.git` and `core:workspace.refresh-git` after the actions moved into the Git plugin. Current action IDs take precedence over aliases.
- **Implementation:** [git-panel.ts](../pi-web-plugins/git/browser/git-panel.ts) (`shortcutAliases`); [keyboardShortcuts.ts](../src/client/src/keyboardShortcuts.ts) resolves them. The two historical aliases are the removal candidates, not necessarily the reusable alias mechanism.
- **Tests:** [pi-web-plugin.test.ts](../pi-web-plugins/git/pi-web-plugin.test.ts), [shortcutPreferences.test.ts](../src/client/src/shortcutPreferences.test.ts).
- **First shipped:** [v1.202608.1](https://github.com/jmfederico/pi-web/releases/tag/v1.202608.1), 2026-08-11; aliases introduced by `61f3cf8f`.
- **Remove when:** the minimum support window has elapsed and existing saved overrides can be migrated or users have an explicit manual path. Merely reading an alias does not persist a conversion, so elapsed time alone does not mean saved shortcuts have migrated.

### external-activity-warning-compatibility

- **Why:** interpret old daemon warnings as `recentlyActiveElsewhere` status and suppress the obsolete warning. Explicit modern status takes precedence.
- **Implementation:** [parsers.ts](../src/client/src/api/parsers.ts) (`isLegacyOtherInstanceActivityWarning` and its uses in session-status parsing).
- **Tests:** [parsers.test.ts](../src/client/src/api/parsers.test.ts).
- **First shipped:** [v1.202610.2](https://github.com/jmfederico/pi-web/releases/tag/v1.202610.2), 2026-10-13; introduced by `f685d2a2`.
- **Remove when:** the minimum support window has elapsed and supported mixed-version machines no longer require conversion from the warning to the status field. Check federated machine responses, not just the local daemon.

### leading-root-plugin-modules

- **Why:** accept old plugin-manifest module references beginning with `/` while keeping them relative to the application root, so nested deployments continue to work.
- **Implementation:** [external.ts](../src/client/src/plugins/external.ts) (`resolvePluginModuleUrl`) and [appUrl.ts](../src/client/src/appUrl.ts) (`appRelativePath`).
- **Tests:** [external.test.ts](../src/client/src/plugins/external.test.ts), [appUrl.test.ts](../src/client/src/appUrl.test.ts).
- **First shipped:** [v1.202607.1](https://github.com/jmfederico/pi-web/releases/tag/v1.202607.1), 2026-07-18; introduced by `c661fad7`.
- **Remove when:** the minimum support window has elapsed and supported manifest producers use application-relative references. Review remote-machine manifests and plugin-author guidance before rejecting the old form; update the URL convention in [AGENTS.md](../AGENTS.md) with the implementation.

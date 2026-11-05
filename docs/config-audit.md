# Configuration architecture audit

Pre-implementation baseline assessment against [config-architecture.md](config-architecture.md). The inventory and gaps below describe the code before the architecture implementation; see [config.md](config.md) for current supported behavior. Inventory covers core configuration, project/plugin settings, browser preferences, and runtime/bootstrap settings. Application state and Pi-owned settings are classified separately.

## Approved decisions after this audit

The architecture now resolves the main choices below; migration cautions in this audit describe existing behavior, not alternative target contracts.

- Paths: introduce a base setting; retain existing paths as additions.
- Plugins: explicit namespace with independently resolved enablement and top-level plugin-setting values; replace object/array values, not the entire plugin namespace.
- Revised container decision: the shared schema registry declares `uploads.defaultFolder`, `attachments.defaultFolder`, `sessionArchive.directory`, `pathAccess.allowedPaths`, and `defaultLocalization.language`/`formatLocale`/`timeZone`/`hourCycle` as independent settings. Retain their object representations and scopes; resolve leaves across defaults, writable config, applicable project config, and environment policy.
- Empty declared containers contribute no overrides; missing leaves inherit. This preserves the baseline project `uploads: {}` / `attachments: {}` folder inheritance, superseding the whole-object fallback concern below. Individual array/dictionary-valued settings replace completely; there is no generic recursive merge. `defaultTheme` remains one coherent atomic preference, `shortcuts` an atomic dictionary, and deprecated `agent` atomic.
- Existing container JSON environment names enforce only supplied leaves, including `pathAccess.allowedPaths`. Source/enforcement metadata uses leaf pointers; the archive-directory alias maps to `/sessionArchive/directory`.
- Environment lists: canonical JSON plus documented legacy shorthand per setting. Booleans: strict `true`/`false` (case-insensitive) or `1`/`0`; invalid explicit env fails startup.
- Updates/reset: one `set`/`unset` operation; no magic persisted values or changed omission semantics. Known leaf pointers (including `/defaultLocalization/language`) and root container resets are accepted. UI group resets remove only unlocked saved leaves in one request; API container resets overlapping enforced leaves are rejected to preserve hidden saved choices.
- Project-capable settings: project config overrides writable machine config, below environment enforcement. Explicit path additions remain additive.

The inventory and recommended migration order below remain historical baseline evidence. Their whole-object proposals for now-declared containers are superseded by these revised decisions, not current behavior.

## Summary

- No setting implements the complete target: the deployment-defaults file and uniform source/reset contracts do not exist yet.
- The core schema has 22 top-level settings. Nine have current nondeprecated environment overrides, counting the archive destination resolved outside the main effective-config resolver. The deprecated `agent.dir` also has environment aliases.
- Most missing environment overrides and the optional defaults layer can be added without changing existing configurations.
- Known incompatible conventions: project path concatenation, project plugin merging, permissive boolean environment parsing, and comma-separated allowed-host environment syntax if replaced with JSON-only parsing.
- Preserve the existing schema initially. Flattening/renaming nested settings is not necessary to introduce shallow source overlays and would itself require migration.

## Core inventory

All rows currently support the global file unless marked deprecated. “Additive” means existing valid configuration can retain its meaning; new defaults/enforcement UI work is still required. Listed object fields are the complete recognized fields except open plugin dictionaries.

| Setting | Type / fields | Current environment override | Assessment / migration |
| --- | --- | --- | --- |
| `installationName` | string | None | Additive. Add env and source/lock reporting; preserve empty-name fallback to `PI-WEB`. |
| `host` | string | `PI_WEB_HOST` | Env already wins. Settings shows a badge but still allows edits; make read-only when enforced. |
| `port` | integer | `PI_WEB_PORT`, fallback `PORT` | Env already wins. Preserve alias precedence and validation; make Settings read-only when enforced. |
| `allowedHosts` | **string array**, or `true` | `PI_WEB_ALLOWED_HOSTS` | Env already replaces. Existing syntax is comma-separated hosts or literal `true`; replacing it with JSON-only is breaking. Preserve legacy syntax alongside an explicit JSON form during migration. Settings currently remains editable. |
| `maxUploadBytes` | positive integer | `PI_WEB_MAX_UPLOAD_BYTES` | Env already wins. Consolidate validation: effective resolver throws on invalid env; separate `maxUploadBytes()` helper silently falls back. Add source metadata. |
| `spawnSessions` | boolean | `PI_WEB_SPAWN_SESSIONS` | Env wins; Settings already locks toggle. Invalid nonempty strings currently become `false`; strict validation changes that behavior. Preserve dependency: disabling spawn also prevents subsessions. |
| `subsessions` | boolean | `PI_WEB_SUBSESSIONS` | Same parsing/lock pattern as spawn. Depends on `spawnSessions`. |
| `askUser` | boolean | `PI_WEB_ASK_USER` | Same parsing/lock pattern as spawn. |
| `environmentFacts` | boolean | `PI_WEB_ENVIRONMENT_FACTS` | Env wins; same permissive boolean parsing. File loader supports it, but config API parser/serialization paths are inconsistent; fix round trips before layering. |
| `extensionDialogsTimeoutMs` | nonnegative integer; `0` means forever | None | Add env, preserving `0`. Loader supports it but config record serializer/API parser omit it; existing raw value can survive saves without being properly editable/resettable. |
| `defaultStreamingBehavior` | `steer` / `followUp` | None | Additive. Preserve its role as default send behavior, not a ban on explicit send actions. |
| `quietMode` | boolean | None | Additive. Currently gateway-global, not browser-local; do not silently change storage scope. |
| `shortcuts` | **dictionary**: action ID → string or `null` | None | Add env for entire dictionary. Preserve action aliases and `null` meaning disable a binding. Replacing dictionaries between sources is compatible with keeping built-in action defaults for unspecified actions. |
| `defaultTheme` | **object**: `themeId`, `auto` | None | Browser preference currently wins over file default. Add env enforcement ahead of browser preference without erasing saved browser values. Whole-object source replacement; no field merge. |
| `defaultLocalization` | **object**: `language`, `formatLocale`, `timeZone`, `hourCycle` | None | Currently inherited independently per field by browser preferences. File layering can replace the entire object, but env enforcement of a partial object needs an explicit contract; flattening into independent settings would require migration. |
| `pathAccess` | **object**: `allowedPaths` (**string array**) | None | Global addition is additive; project behavior is not. Today project and global lists concatenate/deduplicate. See project section. |
| `uploads` | **object**: `defaultFolder` | None | Add env. Project object currently shallow-overlays global object. With its one field, explicit `{}` currently inherits global; under whole-object replacement it would reveal built-in default instead. |
| `attachments` | **object**: `defaultFolder` | None | Same migration issue as `uploads`. |
| `sessionArchive` | **object**: `directory` | `PI_WEB_SESSION_ARCHIVE_DIR` | Env wins in `sessionArchiveDirectory()`, not the shared effective-config response. Centralize resolution/provenance; preserve destination-only behavior, index location, and no automatic archive migration. |
| `sessionNaming` | **retired** from core schema/API | None | File-only migration copies old defaults and saved tuning into the removable package if absent, then removes the writable key. Existing package config takes precedence; obsolete deployment-default entries require manual cleanup. Failures log errors, retain source data, and allow startup to continue. The package owns subsequent tuning and its JSON environment override. |
| `plugins` | **dictionary**: plugin ID → `{ enabled?, settings?, … }`; `settings` is an open **dictionary** | None | Whole-map source replacement is possible but differs from existing project plugin composition. Do not deep merge new defaults/writable/env sources. Preserve required-plugin constraints. See plugin section. |
| `agent` | **object**: deprecated `dir`, `command` | `PI_WEB_AGENT_DIR`, `PI_CODING_AGENT_DIR`; deprecated command env detected | Do not expand this deprecated namespace. `dir` still works; `command` is ignored with warning. Preserve deprecated alias precedence until explicit removal. Pi paths remain an external/bootstrap boundary. |

### Cross-cutting core gaps

- `envOverrides` currently reports only host, port, allowed hosts, spawn, subsessions, and ask-user booleans. It is not general provenance and omits upload limits, environment facts, and archive destination.
- File/API validation is duplicated. File-supported keys do not all survive API round trips consistently. Audit the serializers and hand-maintained Settings remainder before adding new sources.
- Settings drafts currently write explicit empty objects/lists and complete groups. They must distinguish unchanged/inherited, explicit empty, and reset before introducing deployment defaults.
- Gateway `PUT /api/config` replaces known file settings; selected-machine writes merge patches. Omitting a key from a selected-machine patch does not delete it. Add an explicit reset/removal operation without reinterpreting existing patch omission or valid `null` shortcut values.
- Built-in defaults are partly resolved at feature consumers rather than in one effective-config representation. Preserve behavior while consolidating; do not accidentally persist those defaults.

## Project configuration

`<project>/.pi-web/config.json` currently recognizes:

| Key | Type | Current composition | Migration assessment |
| --- | --- | --- | --- |
| `version` | optional literal `1` | Schema marker | Keep as schema metadata, not an enforced application setting. |
| `pathAccess.allowedPaths` | **string array** inside object | Union/deduplicate global then project | Replacement would remove globally available roots. Needs explicit migration, e.g. an extras setting preserving existing additive intent; never silently reinterpret existing lists. |
| `uploads.defaultFolder` | string inside object | Project shallow-overlays global | Preserve ordinary explicit project-folder overrides. Empty project object inheritance needs deliberate compatibility handling. |
| `attachments.defaultFolder` | string inside object | Project shallow-overlays global | Same as uploads. |
| `plugins.<id>.settings` | **dictionary**, arbitrary JSON values | Project setting keys override global; nested values replace | Not whole-`plugins` replacement. Retain as a documented legacy composition boundary during migration or introduce a versioned format. Project `enabled` is forbidden. |

Project resolution currently happens after global effective config. New environment enforcement must be applied after applicable project sources, not be overwritten by the existing project pass. Approved target precedence is environment → project → writable machine → deployment defaults → built-ins, preserving explicitly additive path composition.

## Plugin inventory

| Setting | Type / current behavior | Assessment / migration |
| --- | --- | --- |
| `plugins.<id>.enabled` | boolean; package `defaultEnabled`, otherwise `true` | Add env enforcement/provenance and deletion-based reset. Terminal is required and cannot be disabled by ordinary config; retain this invariant. Language plugins default disabled. |
| `plugins.<id>.settings` | Open **dictionary** of plugin-owned values | External plugins may contain arbitrary nested objects/arrays. Whole-map env JSON is possible; do not invent per-key types for opaque external settings. |
| `plugins.git.settings.workspaceDiscoveryHooks` | boolean, default `true` | Only bundled plugin-specific setting currently consumed. Project value overrides global. Share its validation/metadata if exposing individual env controls. |
| Workspace Tasks `.pi-web/tasks.json`: `version`, `tasks` | Version literal `1`; **array of objects** with `id`, `title`, `command`, optional `description`, `group`, `confirm` (default `false`) | Plugin-owned project file; no global merge. Keep outside core config layering unless a separate plugin migration is designed. |

Other bundled plugins consume no plugin-specific settings: info, updates, terminal, code highlight, Mermaid, files, language packs, workflows, and relays. Their enablement still follows the common plugin mechanism.

Plugin UI currently edits enablement only, using saved configuration rather than effective defaults; retain that sparse-write basis. It preserves existing settings but has no remove-override/reset action or environment lock support.

The approved namespace exception avoids whole-`plugins` replacement: plugin IDs coexist, enablement and top-level plugin-setting values resolve independently, and each individual object/array value replaces completely. This aligns with existing project setting-key composition. Apply that model consistently across new sources; do not recursively merge arbitrary plugin values.

Server plugin settings and project snapshots require a daemon restart; browser-only enablement requires a tab reload. Retain desired-versus-active reporting and fail-closed project parsing errors.

## Browser preferences

These currently use origin-scoped local storage, not per-deployment-prefix storage. None supports deployment environment enforcement yet. Adding optional defaults/enforcement can preserve existing choices if saved values remain untouched.

| Preference | Type / current behavior | Migration assessment |
| --- | --- | --- |
| Theme (`pi-web-app-theme`) | **Object**: `themeId`, `auto`; local → gateway default → built-in | Existing remove-to-reset is suitable. Add explicit enforcement metadata/resolution ahead of local storage. |
| Localization (`pi-web-localization`) | Partial **object**: language, format locale, time zone, hour cycle; fieldwise local → gateway → browser defaults | Preserve independent fields or migrate to flat settings. Whole-object browser replacement would change current behavior. Development pseudo-locale query remains a development override, not persisted config. |
| Enter behavior (`pi-web.promptEnterPreference`) | `auto`, `send`, `newline`; default `auto` adapts to device | Additive, but distinguish explicit adaptive `auto` from removing an override to inherit deployment defaults. |
| Attachment delivery (`pi-web:attachment-delivery`) | `inline` / `folder`; default inline | Additive; needs inheritance/reset and lock metadata. Keep browser ownership. |
| Navigation tabs (`pi-web:navigation-preferences`) | **Object**: `pinnedIds` (**string array**), `mobileCollapsed` boolean | Empty pins means all tabs, not none. Preserve sentinel and unavailable plugin IDs. Prefer independent settings if extending layering. |
| Panel widths (`pi-web:panel-sizes:v1`) | Versioned **object**: optional navigation/workspace widths | Existing per-side reset removes values. Preserve clamping and missing-value defaults; expose separate scalars if deployment-applicable. |
| Panel collapse (`pi-web:panel-collapse:v1`) | Versioned **object**: two booleans | Currently writes both fields. Separate scalars and removal-based reset avoid accidental object coupling. |
| Navigation section heights (`pi-web:navigation-section-sizes:v1`) | Versioned partial **dictionary**: projects/workspaces → numeric height | Existing per-field reset removes values. Missing means automatic layout; do not replace it with a persisted calculated height. |

Theme/localization defaults belong to the gateway, not the selected remote machine. Quiet mode and shortcuts are currently gateway-global settings, not browser preferences; preserve that scope unless intentionally migrated.

Browser parsers commonly discard malformed stored data and tolerate unavailable storage. Keep corrupt optional browser state distinct from invalid deployment policy; startup-fatal validation should not be applied blindly to local caches/preferences.

Prompt/ask drafts, transcript expansion/scroll state, cached sessions, image dimensions, tab navigation memory, and transcript caches are application state, not configuration. Exclude them from configuration reset.

Gateway `navigation-preferences.json` stores versioned project/workspace ordering with revision-controlled writes. Session pins migrate once into daemon-owned `session-pins.json`, preserving scoped IDs and revisions; see [the pin-storage upgrade](plugins.md#pin-storage-upgrade). Both files are shared application state, not browser tab preferences or user-editable configuration.

## Runtime/bootstrap inventory

These are mostly appropriate explicit bootstrap exceptions rather than missing file settings. Preserve their existing names and process ownership. Do not route selectors through the files or runtime they select.

| Input | Type / current behavior | Migration assessment |
| --- | --- | --- |
| `PI_WEB_RUNTIME` | `auto` / `node` / `bun`; empty means auto | Keep before application config; retain runtime selection and restart semantics. |
| `PI_WEB_PI_PACKAGE_DIR` | SDK path; explicit empty/invalid fails | Keep bootstrap; ordinary package/PATH discovery otherwise. Memoized SDK selection cannot be hot-swapped. |
| `PI_WEB_CONFIG`, `XDG_CONFIG_HOME` | Config path selectors | Keep existing fallback/cwd semantics. Add a separate optional defaults-file selector. |
| `PI_WEB_DATA_DIR` | Managed-state root path | Not user settings or resettable state contents. Changing it selects different state. |
| `PI_WEB_PROJECTS_FILE`, `PI_WEB_MACHINES_FILE`, `PI_WEB_PI_PACKAGE_DISMISSALS_FILE` | Registry/state file paths | Keep advanced state-location overrides; exclude stored records from config/reset. |
| `PI_WEB_SESSIOND_SOCKET` | Socket path; empty currently retained | Normalize/validate deliberately; currently differs from other empty-as-unset selectors. |
| `PI_WEB_SESSIOND_PORT` | TCP numeric string; `0` allows ephemeral bind | Preserve `0`; add explicit source-aware validation rather than relying on downstream binding errors. |
| `PI_WEB_SESSIOND_HOST` | Bind host string | Keep startup scope; empty currently retained. |
| `PI_WEB_SESSIOND_URL` | Client HTTP endpoint URL | Independent from daemon bind host/port; do not silently derive a new endpoint or change explicit client socket precedence. |
| `PI_WEB_SERVER_EXEC`, `PI_WEB_SESSIOND_EXEC` | Service command overrides | Installer/bootstrap inputs, not live user preferences. |
| `PI_WEB_OFFLINE`, `PI_OFFLINE` | Any nonempty string enables offline mode, even `false` / `0` | Strict boolean parsing is incompatible; preserve legacy aliases/semantics or explicitly deprecate them. |
| `PI_WEB_SKIP_VERSION_CHECK`, `PI_SKIP_VERSION_CHECK` | Nonempty switch; offline also suppresses checks | Keep distinct from offline: disabling update checks does not disable other background networking. Same parsing migration issue. |
| `PI_WEB_DOCKER_RUNTIME` | Descriptor: absent/empty/`0`/`false` false, otherwise true | Deployment fact; parsing differs from ordinary booleans and offline switches. |
| `PI_WEB_DOCKER_MODE` | `dev` / `runtime`, with path-based inference | Deployment descriptor; consolidate duplicated inference without changing fallbacks. |
| `PI_WEB_DOCKER_DEV_REPO_ROOT`, `PI_WEB_DOCKER_INSTALL_DIR` | Operational host/container paths | Keep deployment tooling ownership and mode-specific path meaning. |
| `PI_WEB_SESSION` | Generated nesting marker `1` | Runtime fact, not user configuration. |

Generated native service definitions persist only selected invocation environment values (config selector, SDK location, runtime preference), not arbitrary shell exports. Environment enforcement requires an explicit service-manager environment contract. Container/deployment scripts also have build/install inputs; these are not live application settings and should not be promised the application config-file API.

Sessiond captures an environment snapshot and later prepares a different agent-visible environment, removing `NODE_ENV`/`PORT` and exporting Pi locations/nesting facts. Resolution must use the intended snapshot consistently, not whichever ambient environment a consumer sees later.

## Pi-owned configuration boundary

Do not migrate these into PI WEB's generic overlays or apply PI WEB replacement semantics inside SDK-managed settings:

| Settings | Type / convention |
| --- | --- |
| Agent profile path | Deprecated `PI_WEB_AGENT_DIR` → `PI_CODING_AGENT_DIR` → deprecated `agent.dir` → Pi default. Preserve deprecation precedence. |
| Session path | Deprecated `PI_WEB_AGENT_SESSION_DIR` → `PI_CODING_AGENT_SESSION_DIR` → Pi `sessionDir` → Pi default. Preserve existing relative/tilde resolution. |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel` | Strings/enum, persisted through Pi SettingsManager. |
| `enabledModels` | **Array** of model patterns; project replacement and read-only workspace-controlled picker are intentional. |
| Warnings, including `anthropicExtraUsage` | **Dictionary** with SDK-managed field updates. |
| Packages/resource selections | **Arrays** of Pi-managed strings/objects; package manager owns persistence. |
| Project trust / `defaultProjectTrust` | Trust records/enum; separate server-enforced security boundary. |
| `httpIdleTimeoutMs` | Number or `disabled`; daemon-start activation; Bun enforcement unsupported. Preserve observable SDK fallback behavior. |
| Credentials/custom models | Pi-owned files/mechanisms; redact secrets and exclude from resets. |

Pi's SettingsManager deep-merges some nested objects. This is an ownership exception, not permission to deep-merge PI WEB configuration.

## Recommended migration order

1. Fix file/API round-trip gaps and introduce shared definitions, provenance, and explicit removal/reset operations. Preserve current parsing initially.
2. Add optional deployment defaults with top-level replacement. Keep existing writable files as explicit overrides; do not automatically copy effective defaults into them.
3. Add missing core env overrides, JSON container parsing, and uniform Settings locks. Preserve legacy aliases and allowed-host syntax; apply the explicit plugin/localization namespace rules.
4. Add browser enforcement without overwriting saved preferences; resolve localization fields independently, enforcing only supplied fields.
5. Introduce the path base/additions model and preserve existing project additions and plugin setting-key composition. Resolve enforced values after project participation.
6. Adopt strict case-insensitive boolean words plus `1`/`0`; explicitly migrate legacy invalid/presence-based values. Retain Pi and plugin-owned file boundaries.

## Evidence

- Core types: `src/shared/apiTypes.ts` (`PiWebConfigValues` and associated types).
- Load/resolve/save/parsing: `src/config.ts`.
- API validation, selected-machine allowlist, source flags: `src/server/configRoutes.ts`.
- Settings write construction: `src/client/src/components/settings/settingsConfigDraft.ts`.
- Existing editable overridden gateway inputs: `src/client/src/components/settings/SettingsGeneralPanel.ts`.
- Project schema and array/object composition: `src/server/workspaces/projectPiWebConfig.ts`.
- Plugin composition/activation: `src/server/plugins/projectPluginSettings.ts`, `src/server/piWebPluginCatalog.ts`.
- Plugin UI writes: `src/client/src/components/settings/settingsPluginConfig.ts`.
- Git setting: `pi-web-plugins/git/workspaceDiscoveryHooks.ts`.
- Task schema: `pi-web-plugins/workspace-tasks/config.ts`.
- Browser preferences: `src/client/src/theme.ts`, `localization/browser.ts`, `localization/service.ts`, `promptEnterBehavior.ts`, `attachmentPreferences.ts`, `navigationPreferences.ts`, and `appShell/*Controller.ts` (paths relative to `src/client/src/` after the first entry).
- Shared navigation state: `src/server/storage/navigationPreferenceStore.ts`.
- Bootstrap: `scripts/pi-web-launcher.sh`, `src/piRuntime.ts`, `src/sessiond/config.ts`, `src/sessiond/sessionDaemonClient.ts`, `src/cli.ts`, `src/server/piWebStatus.ts`.
- Daemon environment: `src/server/sessiond.ts`, `src/server/sessiond/agentProcessEnvironment.ts`.
- Pi ownership: `src/server/sessions/piSessionManagerGateway.ts`, `src/server/sessions/piSessionService.ts`, `src/server/piPackageService.ts`, `src/server/projectTrustRoutes.ts`, `src/server/sessiond/agentHttpDispatcher.ts`.

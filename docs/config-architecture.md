# Configuration architecture

Target architecture for implementation agents. This is an agreed design, not a statement that all current configuration paths implement it. See [config.md](config.md) for current supported behavior and [config-audit.md](config-audit.md) for the setting inventory and migration assessment.

## Sources and precedence

Highest priority first:

1. Environment variables: enforced deployment overrides.
2. Browser preferences: personal overrides, only for applicable preferences.
3. Project config: overrides machine settings for explicitly project-capable settings only.
4. Writable config file: saved machine settings.
5. Deployment defaults file: deployment-owned defaults; never written by PI WEB.
6. Built-in defaults.

Server settings omit the browser layer. An environment override for a browser preference takes precedence over its saved browser choice, including when the config key would otherwise supply only a default.

- Every PI WEB-owned server configuration setting must support an environment override.
- Use consistent, documented `PI_WEB_*` names; preserve existing supported names during migration.
- Keep the existing writable global config and `PI_WEB_CONFIG` selector.
- Select the optional deployment defaults file with `PI_WEB_DEFAULTS_CONFIG`, using the same schema and validators. There is no implicit defaults-file path; an explicitly selected missing/invalid file fails visibly.
- Keep project config explicitly scoped to supported settings. Project values override writable machine values but never environment enforcement. Explicit path-addition composition remains additive; resolve enforcement over the applicable project/machine contributions. Do not generalize project overrides to all settings.
- Each machine resolves its own configuration. Browser-only preferences belong to the browser; gateway-only settings remain on the gateway.

## Replacement and namespace semantics

For each schema-declared setting, the highest-priority supplied value replaces the entire lower-priority value. Choose the replacement boundary by the declared setting, not JSON depth: a top-level key is one setting unless explicitly declared as a namespace container.

- Scalars replace.
- Arrays replace; never concatenate implicitly.
- Object-valued settings replace entirely; never recursively merge their keys.
- Missing settings inherit. An individual array/dictionary-valued setting replaces entirely, including an explicit empty value.
- Namespace fields inherit independently across deployment defaults, writable config, applicable project config, and environment policy. An empty namespace `{}` contributes no overrides; missing leaves inherit.
- Prefer flat settings. Explicitly declared namespaces may contain independent settings; do not infer namespaces from arbitrary objects. This is not generic recursive merging.

Approved namespaces:

- Static containers: `uploads.defaultFolder`, `attachments.defaultFolder`, `sessionArchive.directory`, `pathAccess.allowedPaths`, and `defaultLocalization.language`, `.formatLocale`, `.timeZone`, `.hourCycle`. Keep the existing object representations and scopes. Empty project `uploads`/`attachments` objects preserve inherited folder defaults.
- Plugins: plugin IDs coexist; each plugin's `enabled` and each top-level plugin-specific setting resolve independently. An individual plugin setting's object/array value replaces completely. No recursive merging inside it. Preserve required-plugin and project-enablement constraints.

`sessionNaming` is retired from the core schema and API. The file loader alone recognizes old values to migrate them into the removable naming package's profile config. Publish the package file before removing the writable legacy key; preserve existing package files, unrelated config, symlinks, and permissions. Never edit deployment defaults. Log migration errors and retain source data for retry without blocking startup. The package alone consumes its environment override and subsequent tuning.

`defaultTheme` remains one atomic, coherent preference; `shortcuts` remains an atomic dictionary, and deprecated `agent` remains atomic. Their object shape does not make them namespaces.

Where extension is needed, define separate base and additions settings, resolve each independently, then combine using feature-specific rules. For paths, add a base setting and retain existing allowed-path settings as additions, preserving global/project additive intent. Use global `basePaths` for the base and existing `pathAccess.allowedPaths` for additions; project additions retain their existing location. Do not introduce generic append syntax.

Admins may enforce the base, additions, or both through environment variables. Enforcing the base alone leaves additions configurable. An enforced empty additions array disables additions within that setting's enforcement scope.

## Writes and reset

- Settings writes explicit overrides only, never a materialized copy of effective defaults.
- Machine settings write to the writable config; personal preferences write to browser storage.
- Never modify the deployment defaults file or environment from Settings.
- Reset removes an override, exposing the next applicable layer. Do not persist the current default as the reset value.
- Use one update operation carrying `set` values and an `unset` list of setting identifiers; saves and resets may share one request. Example: `{"set":{"installationName":"Office"},"unset":["/quietMode","/defaultLocalization/language"]}`.
- `unset` removes from the addressed writable scope only. It is not persisted as a tombstone. Omitted settings remain unchanged; `null`, empty objects, and empty arrays retain their normal data meanings.
- Use JSON pointers for known leaf settings and container resets, such as `/defaultLocalization/language` and `/defaultLocalization`. Escape pointer segments rather than splitting arbitrary plugin IDs/keys on dots. Reject conflicting set/unset targets and validate the complete update before writing. Keep existing API replacement/patch contracts until explicitly migrated.
- UI container-group resets remove only unlocked saved leaves in one request. API container resets that overlap any enforced leaf are rejected, preserving saved choices hidden by enforcement.
- Environment-controlled fields are read-only and identify the controlling variable.
- Preserve saved values hidden by enforcement so they return when enforcement is removed.
- Machine reset and browser reset are separate operations. Neither resets sessions, credentials, or registries.

## Resolution contract

- Share setting definitions and validation across file, environment, API, and Settings paths; avoid independent per-source rules.
- Record each setting's type, environment mapping, namespace membership, scope, default, browser applicability, exposure/redaction, and activation timing. Namespace containers may supply JSON; enforce only the independent settings explicitly supplied, not unspecified siblings.
- Report effective values and their sources to Settings without exposing secrets. Source and enforcement pointers address declared leaves, such as `/pathAccess/allowedPaths`, not their containers.
- Retain existing container JSON environment names (`PI_WEB_UPLOADS`, `PI_WEB_ATTACHMENTS`, `PI_WEB_SESSION_ARCHIVE`, `PI_WEB_PATH_ACCESS`, `PI_WEB_DEFAULT_LOCALIZATION`); only supplied leaves are enforced. The archive alias `PI_WEB_SESSION_ARCHIVE_DIR` maps to `/sessionArchive/directory`.
- Use JSON as canonical environment syntax for arrays and objects. Preserve documented, unambiguous legacy shorthand per setting, including comma-separated allowed hosts. Do not accept CSV generically: values such as paths may contain commas. Malformed JSON-form input must not fall back to shorthand.
- Environment booleans accept only `true`, `false`, `1`, and `0`; boolean words are case-insensitive. Invalid explicit environment values fail startup with source context, not silently select a fallback. Migrate existing permissive/presence-based switches explicitly.
- Distinguish unset, empty, `false`, and `0`. Validate supplied file/API values visibly; reject invalid updates without writing. Corrupt optional browser preferences may warn and be discarded rather than prevent application startup.
- Resolve environment overrides consistently in web/API and session-daemon consumers. Document required reloads or restarts.
- Server security restrictions must be enforced server-side. Browser preference enforcement controls normal application behavior, not user modifications to their browser.

## Plugin contract

Server plugins use host-supplied `context.settings` and optional `context.resolveProjectSettings(project, signal)`. They do not read PI WEB config files or parse its environment overrides. The host parses JSON, resolves layers, and supplies frozen snapshots; plugins own defaults and semantic validation of their setting keys/values. No settings UI or registered schema is required. Browser-only plugins do not yet have equivalent generic delivery. Do not build a schema framework or automatic form generator for this contract.

## Adding a core setting

1. Add its type to `PiWebConfigValues` and input kind to `PI_WEB_CONFIG_DEFINITIONS`. For a container field, update its namespace field list; individual array/dictionary values remain atomic.
2. Add explicit validation in `parsePiWebConfig` or a feature validator. Known container keys must be checked before projecting values; malformed policy must never become an empty override. Serialization and known-key removal derive from the definitions.
3. Decide gateway/machine scope and activation timing. Add machine-safe keys to `SELECTED_MACHINE_CONFIG_KEYS`; add project support explicitly only when appropriate.
4. Update the client response parser if browser consumers need the value. Add an editor only when useful; reuse the shared source/lock/reset helpers.
5. Test file/env validation, layer precedence, persistence/reset, and enforcement at the narrowest owning boundary. Update `docs/config.md`, its HTML reference, and the release fragment.

Keep feature-specific composition explicit. Do not introduce generic deep merging, reflection-driven forms, or a second plugin-owned config reader.

## Boundaries and migration

Application state (sessions and registries) is not configuration. Keep credentials protected and Pi-owned configuration under Pi's supported mechanisms. Config-file selection and process startup wiring require explicit bootstrap handling rather than circular resolution through the selected files. `serverPlugins.safeStart` remains separately loaded offline recovery state: it must work before plugin discovery and preserve fail-closed repair of malformed recovery values.

Migrate existing project merges, nested plugin settings, environment parsing, and browser defaults deliberately. Preserve compatibility or document intentional changes; this document does not authorize silently changing existing behavior.

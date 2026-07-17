# Assessment — Issue #62: `AuthStorage` export removed in Pi 0.80.8

## 1. Summary

Pi Web's session daemon crashes at ESM module initialization after
`@earendil-works/pi-coding-agent` is resolved at **0.80.8 or later**:

```
SyntaxError: The requested module '@earendil-works/pi-coding-agent'
does not provide an export named 'AuthStorage'
```

The crash is a hard, load-time failure (a static `import { AuthStorage } ...`
that no longer resolves), so Pi Web is completely unusable with any Pi in the
0.80.8+ line. The permissive peer/dev range `>=0.80.0 <1` lets npm resolve the
incompatible release.

**Root cause:** Pi 0.80.8 is a **major architectural refactor** of model/auth
plumbing ("Unified model runtime and provider authentication"), explicitly
listed under **Breaking Changes** in the upstream CHANGELOG. `AuthStorage` (and
its storage backends `FileAuthStorageBackend`, `InMemoryAuthStorageBackend`,
and the credential type exports) were **removed from the package's public
exports**. The class still exists internally but is no longer exported; the new
public surface is `ModelRuntime` (async) plus a synchronous compatibility
`ModelRegistry` facade with a different shape, and `readStoredCredential()` for
one-off reads.

**Recommendation (see §5):** Do **not** attempt a dual-API compatibility shim.
The change is a deep semantic refactor (sync → async, credential store contract
change, removal of `authStorage` from services, `ModelRegistry` constructor and
method-signature changes). A clean migration to the `ModelRuntime` API,
combined with pinning the supported Pi range to `>=0.80.8 <0.81`, is the correct
fix and warrants a Pi Web version bump via a changeset.

---

## 2. Where and how `AuthStorage` / `ModelRegistry` are used in `src/`

All usage is under `src/server/sessions/`. Production files (3) and test/support
files (5).

### Production code

**`authService.ts`** — the central auth wiring.
- `import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"`.
- `type ModelRegistryInstance = ReturnType<typeof ModelRegistry.create>`.
- `createModelRegistryForAgentDir(agentDir)`:
  `AuthStorage.create(join(agentDir, "auth.json"))` then
  `ModelRegistry.create(authStorage, join(agentDir, "models.json"))`.
- Constructor fallback: `ModelRegistry.create(AuthStorage.create())`.
- Reads/writes credentials through `this.modelRegistry.authStorage`:
  - `.set(providerId, { type: "api_key", key })` (saveApiKey)
  - `.logout(providerId)` (logoutProvider)
  - `.reload()` (refreshAuthState)
  - passes `this.modelRegistry.authStorage` into the OAuth login flow.
- Uses `this.modelRegistry.refresh()` (currently synchronous `void`).

**`oauthLoginFlowService.ts`** — OAuth login orchestration for the web UI.
- `import type { AuthStorage } from "@earendil-works/pi-coding-agent"`.
- `type OAuthLoginStorage = Pick<AuthStorage, "login">`.
- Calls `authStorage.login(providerId, callbacks)` where `callbacks` is the
  old `OAuthLoginCallbacks` shape: `signal`, `onAuth`, `onDeviceCode`,
  `onPrompt`, `onManualCodeInput`, `onSelect`, `onProgress`.

**`piSessionService.ts`** — session runtime factory + warnings.
- `import { AuthStorage, ..., ModelRegistry, ... }`.
- `type ModelRegistryInstance = ReturnType<typeof ModelRegistry.create>`.
- `createDefaultRuntimeFactory(authStorage: AuthStorage, modelRegistry, ...)`
  calls `createAgentSessionServices({ cwd, agentDir, authStorage, modelRegistry })`.
- Uses `createModelRegistryForAgentDir` fallback; passes
  `this.modelRegistry.authStorage` and `this.modelRegistry` into the runtime
  factory (around lines 605–612).
- `anthropicSubscriptionWarning()` reads
  `session.modelRegistry.authStorage.get("anthropic")` and inspects
  `credential.type` / `credential.key`.
- `PiAgentSession.modelRegistry: ModelRegistryInstance` is part of the internal
  session interface.

**`authProviderOptions.ts`** — provider enumeration (no direct SDK import; uses a
structural `AuthProviderModelRegistry` interface). Depends on the current
`ModelRegistry`/`AuthStorage` shape:
- `modelRegistry.authStorage.getOAuthProviders()` → `{ id, name }[]`
- `modelRegistry.authStorage.list()` → `string[]`
- `modelRegistry.authStorage.get(provider)` → `{ type } | undefined`
- `modelRegistry.getAll()` → `{ provider }[]`
- `modelRegistry.getProviderDisplayName(provider)`
- `modelRegistry.getProviderAuthStatus(provider)`

### Test / support code
- `authService.test.ts` — `AuthStorage.inMemory(...)`, `ModelRegistry.create(...)`,
  asserts `startOptions.authStorage`.
- `piSessionService.testSupport.ts` — `ModelRegistry.inMemory(AuthStorage.inMemory())`,
  `ModelRegistry.create(AuthStorage.inMemory())`.
- `piSessionService.promptQueue.test.ts` — `AuthStorage.inMemory({ anthropic: {...} })`,
  `ModelRegistry.inMemory(authStorage)`.
- `piSessionService.warnings.test.ts` — `AuthStorage.inMemory()`,
  `ModelRegistry.inMemory/create`, builds anthropic credentials via
  `authStorage.set(...)`.
- `oauthLoginFlowService.test.ts` — `Pick<AuthStorage, "login">` fake.
- `authProviderOptions.test.ts` — structural `AuthProviderModelRegistry` fake
  (no SDK import; must track whatever `authProviderOptions.ts` requires).

### Other pi-coding-agent imports (unaffected — still exported in 0.80.8)
`DefaultPackageManager`, `SettingsManager` (piPackageService, piWebPluginService,
piWebStatus), `createAgentSessionServices`, `createAgentSessionFromServices`,
`createAgentSessionRuntime`, `AgentSessionRuntimeDiagnostic`, `ResourceDiagnostic`.
These remain present; only the auth/model-registry construction path is broken.

---

## 3. What Pi 0.80.8 actually changed (verified against real tarballs)

Method: downloaded and extracted the real npm tarballs for
`@earendil-works/pi-coding-agent` 0.80.7, 0.80.8, 0.80.10 and
`@earendil-works/pi-ai` 0.80.7, 0.80.8 (into `/srv/dev/pi-inspect`) and diffed
the `.d.ts` surface. (Local `node_modules` was not installed in this worktree;
the last globally installed copy elsewhere is 0.80.6.)

### 3.1 Public export diff — `pi-coding-agent` index.d.ts (0.80.7 → 0.80.8)

Removed:
```
export { type ApiKeyCredential, type AuthCredential, type AuthStatus,
  AuthStorage, type AuthStorageBackend, FileAuthStorageBackend,
  InMemoryAuthStorageBackend, type OAuthCredential } from "./core/auth-storage.ts";
```
Added:
```
export { readStoredCredential } from "./core/auth-storage.ts";
export { type CreateModelRuntimeOptions, ModelRuntime,
  type ModelRuntimeAuthOverrides } from "./core/model-runtime.ts";
```
`ModelRegistry` is still exported, but its class shape changed (see §3.3).
0.80.10 (current `latest`) is **byte-identical** to 0.80.8 for `index.d.ts`,
`auth-storage.d.ts`, and `model-runtime.d.ts` — the new surface is stable.

### 3.2 Upstream CHANGELOG (0.80.8) — Breaking Changes (verbatim highlights)

- "Replaced the SDK's `CreateAgentSessionOptions.authStorage` and
  `modelRegistry` options with the async `modelRuntime` option. `AuthStorage`
  and its storage backends are no longer exported; use `ModelRuntime` (or a
  custom pi-ai `CredentialStore`), or `readStoredCredential()` for one-off
  reads of auth.json."
- "Replaced SDK request-auth assembly through
  `ModelRegistry.getApiKeyAndHeaders()` with `ModelRuntime.getAuth()`."
- "Changed extension-facing `ModelRegistry.refresh()` from synchronous `void`
  to `Promise<void>` because `models.json` loading is asynchronous. Extensions
  must await it before making synchronous registry reads."
- "Moved canonical dynamic catalog refresh to async `ModelRuntime.refresh()`."

### 3.3 The new API shape

**`ModelRuntime`** (`core/model-runtime.d.ts`, new) — the canonical async facade:
- `static create(options?: CreateModelRuntimeOptions): Promise<ModelRuntime>`
  where options include `credentials?: CredentialStore`, `authPath?`,
  `modelsPath?`, `modelsStore?`, `allowModelNetwork?`, etc.
- Provider/model reads: `getProviders()`, `getProvider(id)`, `getModels()`,
  `getModel()`, `getAvailable()` (async) / `getAvailableSnapshot()` (sync).
- Auth: `getAuth(providerId|model, overrides?)`, `checkAuth(providerId)`,
  `hasConfiguredAuth(providerId)`, `isUsingOAuth(providerId)`,
  `getProviderAuthStatus(providerId)`, `listCredentials()`,
  `setRuntimeApiKey`, `removeRuntimeApiKey`.
- Login/logout: `login(providerId, type, interaction): Promise<Credential>`,
  `logout(providerId): Promise<void>`.
- `refresh(): Promise<...>`, `registerProvider`/`unregisterProvider`.
- Implements pi-ai `Models`.

**`ModelRegistry`** (`core/model-registry.d.ts`, changed) — now a thin sync
compatibility facade **for extensions**, constructed from a `ModelRuntime`:
- `constructor(runtime: ModelRuntime)` — **no more `ModelRegistry.create(authStorage, ...)`
  and no more `ModelRegistry.inMemory(...)`**.
- **No `authStorage` property.** (This breaks `authProviderOptions.ts`,
  `authService.ts`, and `anthropicSubscriptionWarning`.)
- `refresh(): Promise<void>` (was sync `void`).
- Keeps `getAll`, `getAvailable`, `find`, `getProviderAuthStatus`,
  `getProviderDisplayName`, `getApiKeyForProvider`, `isUsingOAuth`,
  `hasConfiguredAuth`, `getApiKeyAndHeaders`, `registerProvider`, etc.
- **Dropped:** the whole `authStorage`-centric credential API
  (`get/set/list/logout/reload/getOAuthProviders`).

**`AuthStorage`** (`core/auth-storage.d.ts`, still exists internally, NOT
exported): now `implements CredentialStore` with an entirely different,
**async** method set — `read()`, `modify()`, `delete()`, `list()` returning
`Promise`s of pi-ai `Credential`/`CredentialInfo`. The old
`get/set/remove/has/login/logout/getApiKey/getOAuthProviders/setRuntimeApiKey`
synchronous methods are gone. `static create/inMemory/fromStorage` remain but
the class is unexported.

**`readStoredCredential(providerId, authPath?)`** — new synchronous one-off read
returning a pi-ai `Credential | undefined` (`{ type: "api_key", key?, env? }` or
`{ type: "oauth", ... }`). Useful for `anthropicSubscriptionWarning`.

**pi-ai 0.80.8 auth model** (`@earendil-works/pi-ai`, `auth/types.d.ts`,
`auth/credential-store.d.ts`):
- `CredentialStore` interface: `read`, `list`, `modify`, `delete` — all async.
- `Credential = ApiKeyCredential | OAuthCredential`; `CredentialInfo`.
- `InMemoryCredentialStore` class exported — the test seam that replaces
  `AuthStorage.inMemory(...)`.
- `AuthInteraction` interface replaces the old `OAuthLoginCallbacks`:
  `{ signal?, prompt(prompt: AuthPrompt): Promise<string>, notify(event: AuthEvent): void }`.
  `AuthPrompt` is a discriminated union (`text`/`secret`/`select`/`manual_code`);
  `AuthEvent` is `info`/`auth_url`/`device_code`/`progress`. This is a **complete
  reshaping** of the OAuth login callback contract used by
  `oauthLoginFlowService.ts`.
- `login(providerId, type, interaction)` now lives on `ModelRuntime`, not on a
  credential store, and returns a `Credential`.
- `Provider` objects (`getProviders()`) carry `{ id, name, auth: { apiKey?, oauth? } }`
  — this is the new source of truth for enumerating login providers, replacing
  `authStorage.getOAuthProviders()`.

### 3.4 Session services wiring change

`createAgentSessionServices` options and `AgentSessionServices`:
- 0.80.7: `{ cwd, agentDir?, authStorage?, settingsManager?, modelRegistry?, ... }`
  → services expose `authStorage` + `modelRegistry`.
- 0.80.8: `{ cwd, agentDir?, settingsManager?, modelRuntime?, ... }`
  → services expose `modelRuntime` (no `authStorage`, no `modelRegistry`).

So `piSessionService.ts`'s `createDefaultRuntimeFactory` must pass `modelRuntime`
instead of `authStorage` + `modelRegistry`.

---

## 4. Backwards-compatibility analysis (0.80.0–0.80.7 vs 0.80.8+)

A shim would need to bridge, simultaneously:

1. **Construction:** `ModelRegistry.create(authStorage, modelsPath)` /
   `ModelRegistry.inMemory(authStorage)` (old) vs
   `await ModelRuntime.create({ credentials, authPath, modelsPath })` then
   `new ModelRegistry(runtime)` (new). Old is sync; new is async. This alone
   forces `AuthService` / `PiSessionService` construction to become async or to
   pre-resolve a runtime, changing call sites either way.
2. **Credential access:** synchronous `authStorage.get/set/list/logout/reload/
   getOAuthProviders` (old) vs async `CredentialStore.read/modify/delete/list`
   + `ModelRuntime.getProviders()/login/logout/getProviderAuthStatus` (new).
   Sync→async cannot be shimmed transparently.
3. **OAuth login:** `authStorage.login(providerId, OAuthLoginCallbacks)` (old,
   rich callback object) vs `modelRuntime.login(providerId, type,
   AuthInteraction)` (new, `prompt`/`notify` contract). The
   `oauthLoginFlowService` maps SDK callbacks onto web-UI flow state; the two
   callback contracts are structurally different and would each need a distinct
   adapter.
4. **`refresh()`** sync vs async.
5. **Provider enumeration** (`authProviderOptions.ts`) built on
   `authStorage.getOAuthProviders()/list()/get()` — none of which exist in the
   new surface; must be rederived from `getProviders()` + `listCredentials()`.

A dual shim would therefore reimplement two full auth stacks behind a lowest-
common-denominator async interface, plus runtime detection of which export
exists — high complexity, high risk, and permanently carrying dead code for the
already-broken 0.80.0–0.80.7 line. This fails the "easy/clean" bar in the task.

**Conclusion:** backwards compatibility with 0.80.0–0.80.7 is **not easy** and
not worth it. Pi Web should target the new (0.80.8+) API and drop support for
0.80.0–0.80.7.

---

## 5. Recommendation

**Clean migration to the `ModelRuntime` API + range correction + version bump.**

Rationale:
- 0.80.8 is an explicit upstream breaking change; the export removal is
  intentional and permanent (confirmed identical in 0.80.10 `latest`).
- The old 0.80.0–0.80.7 surface and the new 0.80.8+ surface differ across
  construction, sync/async, credential access, OAuth login, and session
  services — there is no small adapter that spans both cleanly.
- Pinning down to a still-working old version is a dead end: users installing
  Pi Web get whatever Pi they have, and `latest` is already 0.80.10.

### Concrete migration shape (to be executed by the relay, not now)

1. **`authService.ts`**: hold a `ModelRuntime` (created via
   `ModelRuntime.create({ authPath, modelsPath })`), optionally expose a
   `ModelRegistry` wrapper for extension-facing reads. Replace credential
   operations:
   - `saveApiKey` → `runtime` credential `modify(providerId, async () => ({ type:"api_key", key }))`
     (via the runtime's credential store / `setRuntimeApiKey` is for ephemeral;
     persistence uses the `CredentialStore.modify` path).
   - `logoutProvider` → `runtime.logout(providerId)`.
   - `startOAuthLogin` → `runtime.login(providerId, "oauth", interaction)`.
   - refresh → `await runtime.refresh()`.
   - Construction becomes async (factory function returning a Promise, or an
     `init()` step) — propagate to `sessiond.ts`.
2. **`authProviderOptions.ts`**: rederive login/logout options from
   `runtime.getProviders()` (auth.apiKey / auth.oauth presence + names) and
   `runtime.listCredentials()` / `getProviderAuthStatus()`. Update the
   structural `AuthProviderModelRegistry`/`AuthProviderRuntime` interface and
   its test double.
3. **`oauthLoginFlowService.ts`**: reimplement against `AuthInteraction`
   (`prompt(AuthPrompt)` + `notify(AuthEvent)`) instead of `OAuthLoginCallbacks`.
   Map `AuthPrompt` kinds (`text`/`secret`/`manual_code`/`select`) to the web
   UI prompt/select shapes, and `AuthEvent` (`auth_url`/`device_code`/`progress`)
   to the existing flow-state fields. This is the largest single slice.
4. **`piSessionService.ts`**:
   - `createDefaultRuntimeFactory` passes `modelRuntime` to
     `createAgentSessionServices` instead of `authStorage` + `modelRegistry`.
   - `PiAgentSession` internal type: carry `modelRuntime` (or an adapted
     registry) instead of the old `modelRegistry.authStorage`.
   - `anthropicSubscriptionWarning`: replace
     `modelRegistry.authStorage.get("anthropic")` with
     `readStoredCredential("anthropic", authPath)` (sync, no `authStorage`
     needed) — cleanest fit for this synchronous check.
5. **`sessiond.ts`**: adapt to async auth construction (create the runtime,
   `await` init, then pass into `PiSessionService`). **This is session-daemon
   code → requires a manual `pi-web-web-sessiond.service` restart after the fix
   lands.**
6. **Tests / testSupport**: replace `AuthStorage.inMemory(...)` with pi-ai
   `InMemoryCredentialStore` (+ `await ModelRuntime.create({ credentials })`),
   and `ModelRegistry.create/inMemory(...)` accordingly. Update
   `authService.test.ts`, `piSessionService.testSupport.ts`,
   `piSessionService.promptQueue.test.ts`, `piSessionService.warnings.test.ts`,
   `oauthLoginFlowService.test.ts`, `authProviderOptions.test.ts`. Follow the
   testing-guide skill (esp. async construction, no over-mocking of SDK).

### Dependency range correction (§6)

- Change the three `@earendil-works/*` **peerDependencies** from
  `>=0.80.0 <1` to a range that excludes the unsupported line, e.g.
  `>=0.80.8 <0.81` (matching the current published minor). Keep the three
  `devDependencies` on a matching `^0.80.8` (or exact `0.80.8`/`0.80.10`).
- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are siblings
  released in lockstep with `pi-coding-agent` (coding-agent depends on
  `^0.80.x` of both); correct all three ranges together.
- Rationale for the upper bound `<0.81`: the auth refactor shows this line makes
  breaking changes within `0.80.x` patch releases, so a permissive `<1` is
  unsafe. Pin to the known-good minor window and widen deliberately after
  testing new releases.

### Release / changeset

- Add a **patch** (or minor, maintainer's call) `.changeset/*.md` for
  `@jmfederico/pi-web` describing the user-visible fix: "Fix session daemon
  crash with Pi 0.80.8+ by migrating to the new `ModelRuntime` API; require Pi
  `>=0.80.8`." Do **not** edit `CHANGELOG.md` directly (Changesets generates it).
- Actual npm publish is out of scope for the fix branch; the release skill
  (`npm-release-via-github-actions`) is only referenced so the changeset is
  release-ready.

---

## 6. Dependency range facts (current state)

`package.json`:
```
devDependencies:
  "@earendil-works/pi-agent-core": "^0.80.6",
  "@earendil-works/pi-ai": "^0.80.6",
  "@earendil-works/pi-coding-agent": "^0.80.6",
peerDependencies:
  "@earendil-works/pi-agent-core": ">=0.80.0 <1",
  "@earendil-works/pi-ai": ">=0.80.0 <1",
  "@earendil-works/pi-coding-agent": ">=0.80.0 <1",
```
No `dependencies`/`optionalDependencies` entries for these packages. The
permissive peer range `>=0.80.0 <1` is what lets consumers' npm resolve the
breaking 0.80.8/0.80.9/0.80.10 against a Pi Web build that expects the old
export.

Published versions (npm): 0.79.10, 0.80.1, 0.80.2, 0.80.3, 0.80.5, 0.80.6,
0.80.7, 0.80.8, 0.80.9, 0.80.10. `latest` = 0.80.10. The removal landed in
0.80.8 and persists through 0.80.10.

---

## 7. Verification artifacts

- Extracted SDK tarballs for inspection: `/srv/dev/pi-inspect/` (v0.80.7,
  v0.80.8, v0.80.10 of pi-coding-agent; pi-ai0807, pi-ai0808). These are
  scratch/inspection only and outside the repo.
- Key diffs reproduced in §3.1 (index exports), §3.3 (class shapes), §3.4
  (session services). 0.80.8 vs 0.80.10 `.d.ts` are identical for the affected
  files → the target API is stable.

## 8. Risks / call-outs for the fix

- **Session daemon restart required:** changes touch `sessiond.ts` and the
  session runtime path; a manual restart of the sessiond service is needed after
  the fix (per AGENTS.md).
- **Async construction ripple:** moving from sync `AuthStorage/ModelRegistry`
  construction to `await ModelRuntime.create(...)` changes `AuthService` /
  `PiSessionService` init and their call sites; keep the async boundary
  explicit and injected (code-quality-architecture skill).
- **OAuth flow contract change is the riskiest slice** — the web UI prompt/
  select/device-code mapping must be re-verified end to end.
- **No local `node_modules`** in this worktree; the relay's first implementation
  leg must `npm install` (pin to 0.80.8+) before it can typecheck/test. Note the
  `/tmp` quota issue observed during assessment — install in the worktree, not
  `/tmp`.

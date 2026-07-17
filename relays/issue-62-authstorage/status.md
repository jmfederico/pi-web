# Relay status — issue-62-authstorage

## Current position
Slice 4 (`piSessionService.ts` migration) complete and committed (`4ccd4f8`).
`piSessionService.ts` now uses the new `ModelRuntime` API end to end:
- `createDefaultRuntimeFactory(modelRuntime, ...)` passes `modelRuntime` to
  `createAgentSessionServices({ cwd, agentDir, modelRuntime })` (no more
  `authStorage` + `modelRegistry`).
- `PiAgentSession.modelRegistry` → `PiAgentSession.modelRuntime: ModelRuntime`.
- `anthropicSubscriptionWarning(session, authPath?)` now reads via
  `readStoredCredential("anthropic", authPath)` (sync); `warningsForSession`
  passes `join(this.agentDir, "auth.json")`. Its `session` param narrowed to
  `Pick<PiAgentSession, "model" | "settingsManager">` (no longer needs the
  registry).
- Model reads rederived onto the runtime: `availableModels`/`setModel` use
  `await modelRuntime.refresh()` + `getAvailableSnapshot()` + `getModel(...)`;
  `syncCurrentModelAuthWarning` uses `getModel(...)` +
  `hasConfiguredAuth(providerId)`.
- `applyAuthChange` no longer refreshes a registry (the shared runtime is
  refreshed by AuthService before it emits, and all sessions share that
  runtime), so the `auth.subscribe` callback stays synchronous.
- **`modelRuntime` is now a REQUIRED `PiSessionServiceDependencies` field**
  (the old `modelRegistry?` fallback used a *sync* `ModelRegistry.create`; a
  `ModelRuntime` can only be built by the async `ModelRuntime.create`, which
  can't run inside a constructor). `sessiond.ts` already injects
  `modelRuntime: auth.runtime` (slice 1), so it typechecks unchanged.
- Dropped the `AuthStorage` / `ModelRegistry` imports and the
  `createModelRegistryForAgentDir` import (only `AuthChange` is still imported
  from `authService.js`).

`npx tsc --noEmit`: **`sessiond.ts` and `piSessionService.ts` are at 0 errors**
(production code is fully migrated; `grep -vE '\.test\.ts|testSupport\.ts'` on
tsc output is empty). All remaining errors are slice-5 test/support files.
`piSessionService.ts` lints clean.

### Prior position (slice 3, leg 4, commit `1c3d6db`)
Slice 3 (`oauthLoginFlowService.ts` migration) complete and committed (`1c3d6db`).
`OAuthLoginFlowService` is reimplemented against the pi-ai `AuthInteraction`
contract (`{ signal?, prompt(AuthPrompt), notify(AuthEvent) }`); the old
`OAuthLoginCallbacks`/`AuthStorage` imports are gone. `start()` now takes a
`ModelRuntime` (narrowed to `Pick<ModelRuntime, "login">`) instead of
`authStorage`, and drives login via `runtime.login(providerId, "oauth",
interaction)`. Mapping: `AuthPrompt` `text`/`secret`/`manual_code` → web-UI
`prompt` (kind `prompt`, `manual_code` → kind `manual`); `select` → web-UI
`select` (options `{id,label}` → `{value,label}`, returns chosen id);
`AuthEvent` `auth_url` → `auth: {url, instructions?}`; `device_code` → reuse
`auth` field (`url: verificationUri`, `instructions: "Enter code: <userCode>"`);
`info`/`progress` → append `message` to `progress`. Per-prompt
`AuthPrompt.signal` now aborts just that pending request (rejects
`"Prompt cancelled"`) without ending the overall flow — needed because a
`manual_code` prompt can race a callback server. `oauthLoginFlowService.test.ts`
rewritten to the new contract via a `fakeRuntime` login double; **9 tests pass**,
files lint clean.

`npx tsc --noEmit` now reports **26 errors** (down from 28). `authService.ts`
is now at **0 errors** (as predicted). Remaining errors are all slice 4/5:
`sessiond.ts` (1) + `piSessionService.ts` (6) = slice 4;
`authService.test.ts` (10), `piSessionService.testSupport.ts` (3),
`.promptQueue.test.ts` (2), `.warnings.test.ts` (4) = slice 5.

### Prior position (slice 2, leg 3, commit `d09d7cc`)
Slice 2 (`authProviderOptions.ts` migration) complete and committed (`d09d7cc`).
`authProviderOptions.ts` now derives options from a runtime-shaped
`AuthProviderRuntime` interface (`getProviders()` + `listCredentials()` +
`getProviderAuthStatus()`). `getLoginProviderOptions`/`getLogoutProviderOptions`
are now `async` (matching the `await` call sites already in `authService.ts`).
The old `AuthProviderModelRegistry` interface is gone; a real `ModelRuntime`
satisfies `AuthProviderRuntime` structurally. The test double in
`authProviderOptions.test.ts` was rewritten to the runtime shape and its 3
tests pass. OAuth-capable = `auth.oauth` present; api-key = `auth.apiKey`
present; `OAUTH_ONLY_PROVIDERS` / `isApiKeyLoginProvider` logic preserved;
display names come from `Provider.name`.

`npx tsc --noEmit` now reports **28 errors** (down from 31). No
`authProviderOptions` errors remain and the `getLoginProviderOptions` /
`getLogoutProviderOptions` call sites in `authService.ts` typecheck cleanly.
Remaining errors are all cross-slice: `authService.ts` (1: line-83
`OAuthLoginFlowService.start` still expects `authStorage` not `runtime` —
slice 3), `sessiond.ts` (1) + `piSessionService.ts` (6, slice 4), and the
test/support files (slice 5): `authService.test.ts` (9),
`oauthLoginFlowService.ts`/`.test.ts` (1+1, slice 3),
`piSessionService.testSupport.ts` (3), `.promptQueue.test.ts` (2),
`.warnings.test.ts` (4).

### Prior position (slice 1, leg 2, commit `e37148c`)
Slice 1 (`authService.ts` core migration) complete and committed (`e37148c`).
`authService.ts` now uses the async `ModelRuntime` API: `AuthService.create({
agentDir | runtime })` factory wraps `ModelRuntime.create({ authPath,
modelsPath })`; `createModelRuntimeForAgentDir` replaces
`createModelRegistryForAgentDir`. `saveApiKey` → `runtime.login(id, "api_key",
nonInteractive)`, `logoutProvider` → `runtime.logout`, `refreshAuthState` →
`await runtime.refresh()`. `authProviders` / `requireOAuthLoginProvider` are now
async. `startOAuthLogin` passes `runtime` into `OAuthLoginFlowService.start`.
`sessiond.ts` uses async `createRuntime`, `AuthService.create`, and passes
`modelRuntime: auth.runtime` to `PiSessionService`; `sessionDaemonStartup` now
awaits `createRuntime`.

`npx tsc --noEmit` reports **31 errors** (up from 24 — expected: the migrated
authService now calls the runtime-based interfaces that slices 2–4 haven't
exposed yet). Slice-1 files are internally consistent; every remaining error
in `authService.ts` / `sessiond.ts` is a **cross-slice** dependency:
- `authService.ts`: `getLoginProviderOptions/getLogoutProviderOptions` still
  take the old `AuthProviderModelRegistry` shape (fixed in slice 2);
  `OAuthLoginFlowService.start` still expects `authStorage` not `runtime`
  (fixed in slice 3).
- `sessiond.ts`: `PiSessionServiceDependencies` still expects `modelRegistry`
  not `modelRuntime` (fixed in slice 4).
Remaining errors otherwise live in slices 2/3/4 files and all test/support
files (slice 5).

## Leg tracking
- **Last completed leg:** 5 (slice 4 — piSessionService.ts migration).
- **Next leg to run:** 6.

## Next task
Run **charter slice 5 (tests + testSupport)** as leg 6: migrate all test
doubles off `AuthStorage.inMemory(...)` / `ModelRegistry.create|inMemory(...)`
to the pi-ai `InMemoryCredentialStore` + `await ModelRuntime.create({
credentials })`, and get `npm run verify` green. Follow the testing-guide skill
(async construction seams, no over-mocking of the SDK).

**Scope note (important):** slice 4 made `modelRuntime` a *required*
`PiSessionServiceDependencies` field (see Current position for why). That means
the slice-5 test surface is LARGER than the four files originally listed in the
assessment. Current `npx tsc --noEmit` failing files (all tests/support):
- `piSessionService.testSupport.ts` (4) — `fakeRuntime` builds
  `modelRegistry: ModelRegistry.create(AuthStorage.inMemory())`; the
  `TestSession` type still has `modelRegistry`. Give the fake a `modelRuntime`
  (e.g. `await ModelRuntime.create({ credentials: new InMemoryCredentialStore() })`
  — note this makes `fakeRuntime` async, which ripples into its callers) and
  update `TestSession`. This is the central helper; fixing it first will clear
  many downstream errors.
- `authService.test.ts` (10) — already partly slice-1/2/3 debt.
- `piSessionService.warnings.test.ts` (5) — `anthropicSubscriptionWarning` no
  longer takes a registry; it now reads `readStoredCredential("anthropic",
  authPath)`. Tests that build credentials via `authStorage.set(...)` must
  instead write an `auth.json` (temp dir) and pass its path, OR the test seam
  must be reconsidered. `SubscriptionSession` type ref to `modelRegistry` is
  gone. Check whether `readStoredCredential` can be pointed at a temp authPath
  cleanly; if not, consider whether the warning fn needs a small injectable
  credential-read seam (raise via intervention if the API can't support the
  test without contortion).
- `piSessionService.promptQueue.test.ts` (17), `.lifecycle.test.ts` (19),
  `.archiveCleanup.test.ts` (9), `.spawnSession.test.ts` (3),
  `.spawnSubsession.test.ts` (18), `sessionRoutes.test.ts` (1) — mostly the
  new required `modelRuntime` dep on `new PiSessionService(...)` plus
  `fakeRuntime`/`ModelRegistry.inMemory` usages. Many of these should clear
  automatically once `testSupport.ts` provides a shared `modelRuntime` helper
  and the `PiSessionService` test-construction path supplies it.

Suggested approach: add a small shared test helper (e.g.
`await createTestModelRuntime()` wrapping `ModelRuntime.create({ credentials:
new InMemoryCredentialStore(...) })`) in `testSupport.ts`, thread it into
`fakeRuntime` and the `new PiSessionService(...)` call sites, then work file by
file until `npm run verify` (typecheck + lint + knip + test) is green.

Then slice 6 adds the `.changeset/*.md` fragment, runs the full `npm run
verify`, and does final cleanup (ASSESSMENT stays).

If slice 5 is already done when you arrive, apply the charter's task-selection
policy: pick the lowest-numbered incomplete slice (6).

### Build/tooling note (important for every leg)
**Update (leg 2):** the human reports `/tmp` is now fully usable again, so the
previous `TMPDIR` workaround is no longer required — plain `npm install` should
work. (If a disk-quota error resurfaces, fall back to
`TMPDIR="$PWD/.tmp-build" npm install` and remove `.tmp-build` after; it is
scratch, do not commit it.) node_modules is already installed at 0.80.10, so a
fresh install is only needed if node_modules is cleared. The pre-commit hook
runs a whole-project typecheck; while the migration is incomplete, commit relay
work with `git commit --no-verify` (the charter permits legs that aren't
verify-green). Node: v24.18.0.

## Relevant context for the next runner
- **Plan of record:** `ASSESSMENT-issue-62.md` (root) — read once. §5 has the
  per-file migration shape; §3 has the exact new API shapes; §6 the dep ranges.
- **Files to change** (all under `src/server/sessions/` unless noted):
  `authService.ts`, `authProviderOptions.ts`, `oauthLoginFlowService.ts`,
  `piSessionService.ts`, plus `src/server/sessiond.ts` (async auth
  construction), and the test/support files listed in assessment §2.
- **New API cheat-sheet:** `ModelRuntime.create({ authPath, modelsPath,
  credentials? }): Promise<ModelRuntime>`; credential persistence via the
  pi-ai `CredentialStore.modify` path; `runtime.login(providerId, type,
  AuthInteraction)`; `runtime.logout`; `runtime.getProviders()` /
  `listCredentials()` / `getProviderAuthStatus()`; `readStoredCredential(
  providerId, authPath?)` for the sync anthropic warning; pi-ai
  `InMemoryCredentialStore` for tests.
- **Decision already made:** clean migration, **no dual-version compat shim**
  (assessment §4/§5). Do not reopen this without the intervention signal.

## Progress documentation expectations
Every leg: update this `status.md` (current position, leg tracking, next task,
context, blockers), append a concise `log.md` entry, make work durable, and
commit before handing off. Hand off with `spawn_session` **once** per the
charter's Handover section.

## Blockers / intervention state
None. Known constraints:
- **Sessiond restart pending (ACTIVE):** slice 1 (leg 2, commit `e37148c`)
  changed `sessiond.ts` + the session-daemon auth construction path; slice 4
  (leg 5, commit `4ccd4f8`) added `piSessionService.ts` (a session-daemon path)
  to this surface. Per AGENTS.md the human must **manually restart the sessiond
  service** for these changes to take effect once the migration lands. Keep
  this note until the human confirms the restart.
- `/tmp` disk-quota issue is resolved (human confirmed usable) — see the
  Build/tooling note above.
- node_modules is installed (gitignored) at 0.80.10; a fresh `npm install` is
  only needed if node_modules is cleared.

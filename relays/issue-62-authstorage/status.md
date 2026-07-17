# Relay status — issue-62-authstorage

## Current position
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
- **Last completed leg:** 3 (slice 2 — authProviderOptions.ts migration).
- **Next leg to run:** 4.

## Next task
Run **charter slice 3 (`oauthLoginFlowService.ts` migration)** as leg 4. This
is the riskiest slice — verify the prompt/select/device-code/auth_url mapping
carefully. Concretely:
- Reimplement `oauthLoginFlowService.ts` against the pi-ai `AuthInteraction`
  contract (`{ signal?, prompt(prompt: AuthPrompt): Promise<string>,
  notify(event: AuthEvent): void }`) instead of the removed
  `OAuthLoginCallbacks` shape (`onAuth`/`onDeviceCode`/`onPrompt`/
  `onManualCodeInput`/`onSelect`/`onProgress`). Types live in
  `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts`.
- `AuthPrompt` is a discriminated union: `text` / `secret` / `select`
  (`options: { id, label, description? }[]`, returns the chosen option id) /
  `manual_code`. `AuthEvent` is `info` / `auth_url` (`{ url, instructions? }`)
  / `device_code` (`{ userCode, verificationUri, intervalSeconds?,
  expiresInSeconds? }`) / `progress`. Map these onto the existing web-UI flow
  state fields (see the current `oauthLoginFlowService.ts` prompt/select/
  device-code/auth_url handling).
- Change `OAuthLoginFlowService.start` to accept `runtime` (the
  `ModelRuntime`) instead of `authStorage`, and drive login via
  `runtime.login(providerId, "oauth", interaction)` where `interaction` is the
  adapter you build. `authService.ts` already calls
  `OAuthLoginFlowService.start({ ..., runtime: this.runtime })` (this is the
  line-83 tsc error). Also update `oauthLoginFlowService.test.ts`.
- After slice 3, `authService.ts` should reach 0 errors. `sessiond.ts` +
  `piSessionService.ts` (slice 4) and the remaining test/support files
  (slice 5) stay until their slices.

If slice 3 is already done when you arrive, apply the charter's task-selection
policy: pick the lowest-numbered incomplete slice (4 → 6). Slice 4 unblocks the
remaining `sessiond.ts` / `piSessionService.ts` cross-slice errors; slice 5
finalizes tests; slice 6 adds the changeset + final verify.

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
  changed `sessiond.ts` + the session-daemon auth construction path. Per
  AGENTS.md the human must **manually restart the sessiond service** for these
  changes to take effect once the migration lands. Keep this note until the
  human confirms the restart.
- `/tmp` disk-quota issue is resolved (human confirmed usable) — see the
  Build/tooling note above.
- node_modules is installed (gitignored) at 0.80.10; a fresh `npm install` is
  only needed if node_modules is cleared.

# Relay status — issue-62-authstorage

## Current position
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
- **Last completed leg:** 2 (slice 1 — authService.ts core migration + sessiond
  async construction).
- **Next leg to run:** 3.

## Next task
Run **charter slice 2 (`authProviderOptions.ts` migration)** as leg 3:
- Rederive login/logout provider options from `runtime.getProviders()`
  (`{ id, name, auth: { apiKey?, oauth? } }`) + `runtime.listCredentials()`
  (`{ providerId, type }[]`) / `runtime.getProviderAuthStatus(id)` instead of
  `authStorage.getOAuthProviders()/list()/get()` + `getAll()` +
  `getProviderDisplayName()`.
- The functions are already **called as async** from `authService.ts`
  (`await getLoginProviderOptions(this.runtime, authType)` etc.) — make them
  async and change their parameter type from `AuthProviderModelRegistry` to a
  runtime-shaped interface (e.g. `AuthProviderRuntime` = `Pick<ModelRuntime,
  "getProviders" | "listCredentials" | "getProviderAuthStatus">` or a
  structural equivalent). Update the structural interface + `authProviderOptions.test.ts`
  test double accordingly.
- See assessment §5.2 / §3.3 for the new API shapes. Provider display names come
  from `Provider.name`; OAuth-capable providers are those with `auth.oauth`,
  api-key providers those with `auth.apiKey` (respect the existing
  `OAUTH_ONLY_PROVIDERS` / `isApiKeyLoginProvider` logic).

If slice 2 is already done when you arrive, apply the charter's task-selection
policy: pick the lowest-numbered incomplete slice (3 → 6). Slices 3 and 4
unblock the remaining `authService.ts` / `sessiond.ts` cross-slice errors.

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

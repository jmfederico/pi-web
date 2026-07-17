# Relay status — issue-62-authstorage

## RELAY COMPLETE — goal reached (leg 7, slice 6)
All charter goal criteria (1–5) are met and committed on branch
`fix/issue-62-authstorage`. **No PR was opened, by design (out of scope).**
The relay is finished; no further leg was spawned.

**Surface to the human:**
- (a) `npm run verify` is fully GREEN (typecheck + lint + knip + 1390 tests,
  2 skipped).
- (b) **Sessiond restart is still PENDING** — slices 1 + 4 changed
  session-daemon paths (`sessiond.ts`, `piSessionService.ts`). The human must
  manually restart the sessiond service for the migration to take effect. Only
  the human clears this note.
- (c) No PR opened (explicitly out of scope for this relay).

Leg 7 (slice 6) added the changeset, re-verified green, confirmed goal
criteria, and confirmed no scratch files remain:
- **`.changeset/fix-pi-0-80-8-modelruntime-auth.md`** — a single `patch`
  fragment for `@jmfederico/pi-web` describing the user-visible fix (session
  daemon crash with Pi 0.80.8+ fixed by migrating to the new `ModelRuntime`
  auth APIs; Pi Web now requires Pi `>=0.80.8`). Per the `changeset-changelog`
  skill this repo uses **patch** for all non-breaking changes (CalVer: the
  `minor` slot is the release month, not feature size; `major` only on explicit
  request), so `patch` was chosen over the "minor is defensible" note. Commit
  `<this leg>`.
- Re-ran full `npm run verify`: GREEN.
- Double-checked `package.json`: peerDeps for the three `@earendil-works/*`
  packages are `>=0.80.8 <0.81`, devDeps are `^0.80.8` — correct.
- Confirmed no scratch files in the repo (no `probe*.mjs`, `.tmp-build/`,
  etc.). `ASSESSMENT-issue-62.md` intentionally stays (plan of record).
- Only `src` mention of the old API is an explanatory comment in
  `piSessionService.testSupport.ts` (documents what the seam replaced) — no
  live import/use.

## Prior position (slice 5, leg 6, commit `d0cc55c`)
Slice 5 (tests + testSupport) complete and committed (`d0cc55c`).
**`npm run verify` was fully GREEN** — typecheck + lint + knip + 1390 tests
pass (2 skipped). All production code and all test/support code are off the
removed `AuthStorage` / `ModelRegistry.create|inMemory` surface.

What slice 5 changed (all under `src/server/sessions/`):
- **`piSessionService.testSupport.ts`** (central helper): dropped
  `AuthStorage`/`ModelRegistry` imports; added pi-ai `InMemoryCredentialStore`.
  New seams: `createTestModelRuntime(credentials?)` (wraps
  `ModelRuntime.create({ credentials })`), a shared `testModelRuntime`
  (top-level `await createTestModelRuntime()` — the common no-auth catalog
  runtime), and `seedCredential(store, providerId, credential)` (writes via the
  `CredentialStore.modify` path). `fakeRuntime` session now carries
  `modelRuntime: testModelRuntime`; `testModel()` reads
  `testModelRuntime.getModel(...)`.
- Threaded `modelRuntime: testModelRuntime` into every `new PiSessionService(...)`
  (now a required dep) across `archiveCleanup`/`lifecycle`/`promptQueue`/
  `spawnSession`/`spawnSubsession`/`sessionRoutes` tests, importing
  `testModelRuntime` in each.
- **`piSessionService.promptQueue.test.ts`** auth-loss test rewritten: builds a
  live `InMemoryCredentialStore` + `createTestModelRuntime(credentials)`, and
  simulates auth changes via `credentials.delete/seedCredential` +
  `modelRuntime.refresh()` + `applyAuthChange(...)` (matching AuthService's
  real refresh-then-emit sequence). Removed the `modelRegistry` dep line.
- **`piSessionService.warnings.test.ts`**: `anthropicSubscriptionWarning` now
  reads `readStoredCredential("anthropic", authPath)`, so the test seam is a
  temp `auth.json` written per case (helper `anthropicAuthPath(...)`), passed
  as the 2nd arg. `SubscriptionSession` type narrowed to
  `Pick<PiAgentSession, "model" | "settingsManager">`. The "no credential"
  case points at a temp dir with no auth.json (deterministic).
- **`authService.test.ts`** fully reworked to the async `AuthService.create({
  runtime | agentDir })` + `InMemoryCredentialStore` model. `saveApiKey`/
  `logoutProvider`/`startOAuthLogin` are awaited; OAuth-complete test asserts
  `startOptions.runtime === runtime` and uses `vi.waitFor` for the async
  refresh; credential assertions go through `credentials.read(...)`.
- Lint fixes surfaced by running lint green for the first time this relay:
  `getLoginProviderOptions` made **synchronous** (it did no async work) and its
  call sites in `authService.ts` + `authProviderOptions.test.ts` de-awaited;
  `authRoutes.ts` handlers now `return await ...` (return-await rule);
  `authService.ts` api-key interaction uses `() => Promise.resolve(key)` /
  `notify: () => undefined`; test `modify` arrows use `() => Promise.resolve(...)`.

SDK behavior verified empirically before writing doubles (throwaway probe
scripts, since removed): `ModelRuntime.create({ credentials })` exposes 36
providers / 1072 models; `login(id, "api_key", interaction)` persists to the
store; `getModel("anthropic", "claude-sonnet-4-5-20250929")` resolves;
`hasConfiguredAuth` flips correctly across `delete`/`modify` + `refresh`;
`readStoredCredential(id, authPath)` reads a temp auth.json and returns
`undefined` for a missing file.

### Prior position (slice 4, leg 5, commit `4ccd4f8`)
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
- **Last completed leg:** 7 (slice 6 — changeset + final verify + cleanup). **FINAL LEG.**
- **Next leg to run:** none — relay complete, no handoff spawned.

## Next task
None — the relay goal is reached. If new work is needed (e.g. opening a PR),
that is a separate task outside this relay's charter.

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
- **Changeset skill:** `.agents/skills/changeset-changelog/SKILL.md` (and
  `changeset-changelog` in the skills list). Follow it for the fragment format.
- **The migration is done** — slice 6 is docs/changeset + confirmation only.
  No further source changes are expected; if you find yourself editing
  `src/`, re-check whether that's really in scope.
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
None blocking. Relay complete. Known constraints:
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

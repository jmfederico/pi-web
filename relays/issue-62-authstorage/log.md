# Relay log — issue-62-authstorage

Append-only. One concise entry per leg. Do not read end-to-end for orientation;
use `status.md`. Targeted lookups only.

---

## Leg 0 — Planning (assessment + relay packet)

**Did:**
- Read issue #62 and confirmed the crash: static `import { AuthStorage }` fails
  at ESM load with Pi 0.80.8+.
- Investigated all `AuthStorage`/`ModelRegistry` usage in `src/` (3 production
  files + 5 test/support files under `src/server/sessions/`; other
  pi-coding-agent imports unaffected).
- Downloaded and diffed real npm tarballs (pi-coding-agent 0.80.7/0.80.8/0.80.10
  and pi-ai 0.80.7/0.80.8) into `/srv/dev/pi-inspect` (scratch, outside repo) to
  establish the exact new export surface: `AuthStorage` and its backends removed
  from exports; new `ModelRuntime` (async) + `readStoredCredential`; changed
  `ModelRegistry` (constructed from a runtime, `refresh()` now async, no
  `authStorage`); pi-ai `CredentialStore`/`InMemoryCredentialStore`/
  `AuthInteraction` model. Confirmed 0.80.8 and 0.80.10 `.d.ts` are identical
  for the affected files (stable target).
- Wrote `ASSESSMENT-issue-62.md` (root).

**Decisions:**
- **Clean migration to `ModelRuntime`, no dual-version compat shim.** Rationale:
  sync→async, credential-store contract change, OAuth callback contract change,
  and session-services option change span both surfaces with no small clean
  adapter; 0.80.0–0.80.7 is already broken/superseded (`latest` = 0.80.10).
- **Dep range fix:** peerDeps `>=0.80.0 <1` → `>=0.80.8 <0.81` for all three
  `@earendil-works/*` packages; upper bound `<0.81` because this line ships
  breaking changes within `0.80.x`.
- Relay packet placed under `relays/issue-62-authstorage/` (committed; not in
  `package.json` `files`, so not published; `.pi-web/` is gitignored so not used).

**Artifacts changed:** `ASSESSMENT-issue-62.md`;
`relays/issue-62-authstorage/{charter,status,log}.md`.

**Status update:** last completed leg 0, next leg 1 = charter slice 0
(Bootstrap: install Pi 0.80.8+, correct dep ranges).

**Blockers:** none. Noted `/tmp` disk-quota issue (install in worktree) and the
pending sessiond restart for later daemon-path slices.

**Handoff:** Planning only — NOT auto-spawning the first implementation leg.
Assessment + relay plan are laid out ready to be kicked off by the user.

---

## Leg 1 — Slice 0 Bootstrap (deps + range correction)

**Did:**
- Corrected `package.json`: three `@earendil-works/*` devDependencies
  `^0.80.6` → `^0.80.8`; peerDependencies `>=0.80.0 <1` → `>=0.80.8 <0.81`.
- `npm install` in the worktree. The default `/tmp`-based node-gyp build of
  `node-pty` failed with "Disk quota exceeded" (/tmp is a 5.8G tmpfs at ~81%).
  Re-ran with `TMPDIR="$PWD/.tmp-build" npm install`, which succeeded (618
  packages, 0 vulnerabilities). Removed `.tmp-build` after.
- Confirmed installed versions: all three packages resolve to **0.80.10**
  (lockfile updated).
- Verified the new export surface via a node ESM check: `ModelRuntime` ✓,
  `readStoredCredential` ✓, `ModelRegistry` ✓, `AuthStorage` absent ✓, pi-ai
  `InMemoryCredentialStore` ✓.
- Ran `npx tsc --noEmit`: 24 errors, all in `src/server/sessions/` at the
  expected migration sites (removed `AuthStorage`, `ModelRegistry.create/inMemory`,
  `authStorage` on session-services options, `PiAgentSession.modelRegistry`).
  This matches assessment §2/§3 — the new surface resolves; only Pi Web's old
  usage is broken.

**Decisions:**
- Committed with `git commit --no-verify`: the pre-commit hook runs a
  whole-project typecheck which cannot pass until the migration lands. Charter
  explicitly permits non-verify-green legs. Documented this + the `TMPDIR`
  workaround in `status.md` so future legs don't rediscover them.
- Did not touch any `src/` migration code — kept strictly to slice 0 scope.

**Artifacts changed:** `package.json`, `package-lock.json` (commit `0fa9d0e`);
`relays/issue-62-authstorage/{status,log}.md`. `node_modules/` installed
(gitignored, not committed).

**Status update:** last completed leg 1, next leg 2 = charter slice 1
(`authService.ts` core migration → propagate async construction to `sessiond.ts`).

**Blockers:** none. Sessiond restart still pending (becomes relevant from leg 2
onward once `sessiond.ts` changes land).

**Handoff:** spawning leg 2 (slice 1).


---

## Leg 2 — slice 1: `authService.ts` core migration (commit `e37148c`)

**What I did:** migrated `src/server/sessions/authService.ts` off the removed
`AuthStorage` / `ModelRegistry.create` surface onto the async `ModelRuntime`
API, and propagated the async construction into the session daemon.

- `authService.ts`:
  - Imports `ModelRuntime` from `@earendil-works/pi-coding-agent` and
    `AuthInteraction` (type) from `@earendil-works/pi-ai`. Dropped
    `AuthStorage` / `ModelRegistry`.
  - `createModelRegistryForAgentDir` → `createModelRuntimeForAgentDir(agentDir)`
    returning `ModelRuntime.create({ authPath: <dir>/auth.json, modelsPath:
    <dir>/models.json })`.
  - Construction is now async: private constructor + static
    `AuthService.create({ agentDir? | runtime? | authFlows? })`. `runtime` dep
    replaces the old `modelRegistry` dep; no-agentDir fallback is
    `ModelRuntime.create({})`.
  - Public field `readonly runtime: ModelRuntime` replaces `modelRegistry`.
  - `saveApiKey` → `runtime.login(providerId, "api_key", interaction)` where
    `interaction` is a non-interactive `AuthInteraction` (`prompt: async () =>
    key`, `notify: () => {}`). Verified against pi-ai `envApiKeyAuth().login`,
    which calls `interaction.prompt({ type: "secret" })` and persists the
    returned `{ type:"api_key", key }` through `credentials.modify` inside
    `Models.login`. This is the credential-persistence path the assessment
    (§5.1) called for.
  - `logoutProvider` → `await runtime.logout(providerId)`.
  - `refreshAuthState` → `await runtime.refresh()` (no more `authStorage.reload()`
    — the file store is re-read by the runtime). Now async.
  - `authProviders` and `requireOAuthLoginProvider` became async, awaiting
    `runtime.refresh()` and the now-async `getLogin/LogoutProviderOptions`.
  - `startOAuthLogin` passes `runtime: this.runtime` into
    `OAuthLoginFlowService.start` (slice 3 will consume it via `runtime.login`).
- `sessiond.ts`: `createRuntime()` is now `async`; `new AuthService(...)` →
  `await AuthService.create({ agentDir })`; `PiSessionService` now receives
  `modelRuntime: auth.runtime` instead of `modelRegistry: auth.modelRegistry`.
- `sessiond/sessionDaemonStartup.ts`: `createRuntime` may now return
  `Runtime | Promise<Runtime>` and `runSessionDaemonStartup` `await`s it. The
  existing sync test doubles still satisfy the widened type.

**Decisions:**
- **saveApiKey via `runtime.login("api_key", …)`** rather than reaching for a
  raw `CredentialStore.modify`: the pi-ai `CredentialStore` is not exposed off
  `ModelRuntime` publicly, and the provider's own api-key `login` is the
  intended persistence entry point (it writes through `credentials.modify`).
  Feeding the key back through a non-interactive `AuthInteraction.prompt` keeps
  us on the supported public surface. This matches assessment §5.1's
  "credential persistence via the pi-ai CredentialStore.modify path" without
  depending on unexported internals.
- Kept `AuthService` construction async via a static factory (private ctor)
  rather than an `init()` method — cleaner async boundary, single valid
  construction path (code-quality-architecture skill).
- Did NOT touch `authProviderOptions.ts`, `oauthLoginFlowService.ts`,
  `piSessionService.ts`, or any test/support files — strictly slice 1 scope.
  The async call sites I introduced (`await getLoginProviderOptions(...)`,
  `runtime:` in `authFlows.start`, `modelRuntime:` in PiSessionService deps)
  deliberately point at the interfaces slices 2–4 will expose.

**Typecheck state:** `npx tsc --noEmit` = 31 errors (was 24 at slice 0). The
increase is expected and honest: the migrated authService now calls
runtime-based interfaces that slices 2/3/4 have not migrated yet. All remaining
`authService.ts` / `sessiond.ts` errors are cross-slice (authProviderOptions
shape → slice 2; OAuthLoginFlowService.start `runtime` param → slice 3;
`PiSessionServiceDependencies.modelRuntime` → slice 4). Test/support files
(slice 5) still import the removed `AuthStorage`.

**Artifacts changed:** `src/server/sessions/authService.ts`,
`src/server/sessiond.ts`, `src/server/sessiond/sessionDaemonStartup.ts`
(commit `e37148c`); `relays/issue-62-authstorage/{status,log}.md`.

**Status update:** last completed leg 2, next leg 3 = charter slice 2
(`authProviderOptions.ts` migration).

**Blockers:** none. **Sessiond restart now ACTIVE-pending** — slice 1 changed
`sessiond.ts` and the daemon auth construction path; the human must manually
restart the sessiond service once the migration lands (noted in status.md).
Also: human confirmed `/tmp` is usable again, so the `TMPDIR` install
workaround is no longer required (status.md updated).

**Handoff:** spawning leg 3 (slice 2).

## Leg 3 — slice 2: authProviderOptions.ts migration (commit d09d7cc)

**Did:** Migrated `src/server/sessions/authProviderOptions.ts` off the removed
`authStorage`-centric surface onto the new `ModelRuntime` API.
- Replaced the `AuthProviderModelRegistry` structural interface (which required
  `authStorage.getOAuthProviders()/list()/get()`, `getAll()`,
  `getProviderDisplayName()`) with a runtime-shaped `AuthProviderRuntime`
  interface exposing `getProviders()` (`{ id, name, auth: { apiKey?, oauth? } }`),
  `listCredentials()` (`Promise<{ providerId, type }[]>`), and
  `getProviderAuthStatus(id)`. Kept it structural (not `Pick<ModelRuntime,...>`)
  so the test can supply a lightweight double; verified the real `ModelRuntime`
  satisfies it (call sites in `authService.ts` typecheck clean).
- Made `getLoginProviderOptions` / `getLogoutProviderOptions` `async` to match
  the `await` call sites already present in `authService.ts` (leg 2).
- Login options: OAuth options from providers with `auth.oauth`; api-key options
  from providers with `auth.apiKey` filtered through the unchanged
  `OAUTH_ONLY_PROVIDERS` / `isApiKeyLoginProvider` logic. Display names now come
  from `Provider.name` (replacing `getProviderDisplayName`). Logout options
  derived from `listCredentials()`, mapping provider id -> name via
  `getProviders()`.
- Rewrote the `authProviderOptions.test.ts` double to the runtime shape (a
  `getProviders` array with per-provider `auth`, a `listCredentials` promise,
  `getProviderAuthStatus`); made the two option-building tests async. All 3
  tests pass.

**Decisions:** `AuthProviderInfo.auth` typed as `{ apiKey?: unknown; oauth?:
unknown }` — presence is all this module needs, and `unknown` keeps the double
trivial while remaining assignable-from the real `ProviderAuth`. Structural
interface (not `Pick<ModelRuntime>`) chosen for testability per
code-quality-architecture (injectable seam, no SDK construction in unit test).

**Verify state:** `npx tsc --noEmit` 31 -> 28 errors. No `authProviderOptions`
errors; `getLogin/LogoutProviderOptions` call sites in `authService.ts` clean.
Remaining 28 are cross-slice: `authService.ts` line-83 `OAuthLoginFlowService.
start` still expects `authStorage` (slice 3); `sessiond.ts`(1)+`piSessionService.
ts`(6) slice 4; test/support files slice 5.

**Artifacts:** `src/server/sessions/authProviderOptions.ts`,
`src/server/sessions/authProviderOptions.test.ts`; status.md updated; committed
`d09d7cc` with `--no-verify` (migration not yet verify-green, permitted).

**Handoff:** spawning leg 4 (slice 3, oauthLoginFlowService.ts). Sessiond
restart from leg 2 still pending — carried forward, not cleared.

## Leg 4 — slice 3: oauthLoginFlowService.ts migration (commit `1c3d6db`)

**What:** Reimplemented `OAuthLoginFlowService` against the pi-ai
`AuthInteraction` contract and rewrote its test.

- `start()` now takes `runtime: Pick<ModelRuntime, "login">` instead of
  `authStorage: Pick<AuthStorage, "login">`; login driven via
  `runtime.login(providerId, "oauth", interaction)`. Resolves the
  `authService.ts` line-83 tsc error (authService.ts now at 0 errors).
- Built a single `AuthInteraction` adapter (`{ signal, prompt, notify }`)
  replacing the six `OAuthLoginCallbacks` (`onAuth`/`onDeviceCode`/`onPrompt`/
  `onManualCodeInput`/`onSelect`/`onProgress`).
- **Mapping decisions (verified carefully — riskiest slice):**
  - `prompt(AuthPrompt)` dispatches on `type`: `select` → `waitForSelect`
    (options `{id,label,description?}` → CommandOption `{value:id,label}`,
    resolves chosen id); `manual_code` → web-UI prompt kind `manual`;
    `text`/`secret` → web-UI prompt kind `prompt`. Old code special-cased
    `onManualCodeInput` with a hardcoded message; now the provider supplies the
    `manual_code` message, which is more correct.
  - `notify(AuthEvent)`: `auth_url` → `auth:{url,instructions?}`; `device_code`
    → reuse `auth` field (`url: verificationUri`, instructions
    `"Enter code: <userCode>"`) exactly as the old `onDeviceCode` did;
    `info`+`progress` → append `message` to `progress` (old code only had
    `onProgress`; `info` folds in naturally).
  - Old `OAuthPrompt.allowEmpty`/`placeholder` handling: the new `AuthPrompt`
    has no `allowEmpty`, so interactive prompts are always required
    (`allowEmpty:false`); `select` keeps `allowEmpty:true`. Placeholder still
    forwarded when present.
- **New behavior:** per-prompt `AuthPrompt.signal` now aborts just that pending
  request (rejects `"Prompt cancelled"`, clears the interaction from state)
  without ending the overall flow — the documented `manual_code`-vs-callback
  race. Added `bindPromptSignal` + a dedicated test for it.
- **Test:** rewrote `oauthLoginFlowService.test.ts` with a `fakeRuntime`
  `login` double (returns a stub oauth credential). Replaced the old
  device-code-via-onDeviceCode coverage with an explicit `notify` device_code
  test and a per-prompt-signal-abort test. 9 tests pass; both files lint clean.

**tsc:** 28 → 26 errors. `authService.ts` = 0. Remaining: slice 4
(`sessiond.ts` 1, `piSessionService.ts` 6) and slice 5 test/support files
(`authService.test.ts` 10, `.testSupport.ts` 3, `.promptQueue.test.ts` 2,
`.warnings.test.ts` 4).

**Status:** updated (current position, leg tracking → last leg 4 / next leg 5,
next task = slice 4). Committed with `--no-verify` (migration not yet
verify-green, per charter).

**Blockers:** none. Sessiond-restart-pending note still ACTIVE (unchanged;
this slice did not touch the daemon path, but slice 1 did). Handing off to
leg 5 (slice 4).

---

## Leg 5 — slice 4: piSessionService.ts migration (commit `4ccd4f8`)

**What:** Migrated `src/server/sessions/piSessionService.ts` to the new
`ModelRuntime` API.
- `createDefaultRuntimeFactory` now takes a `ModelRuntime` and passes
  `modelRuntime` to `createAgentSessionServices({ cwd, agentDir, modelRuntime })`
  (dropped the `authStorage` + `modelRegistry` args).
- `PiAgentSession.modelRegistry: ModelRegistryInstance` → `modelRuntime:
  ModelRuntime`. Removed the `ModelRegistryInstance` type alias and the
  `AuthStorage`/`ModelRegistry` SDK imports; added `type ModelRuntime` +
  `readStoredCredential` imports and `join` from node:path. `authService.js`
  import reduced to just `AuthChange` (dropped `createModelRegistryForAgentDir`).
- `anthropicSubscriptionWarning(session, authPath?)`: reads via
  `readStoredCredential("anthropic", authPath)`; param narrowed to
  `Pick<PiAgentSession, "model" | "settingsManager">`. `warningsForSession`
  passes `join(this.agentDir, "auth.json")`.
- Model reads rederived onto the runtime: `availableModels`/`setModel` →
  `await modelRuntime.refresh()` + `getAvailableSnapshot()` + `getModel(...)`;
  `syncCurrentModelAuthWarning` → `getModel(...)` +
  `hasConfiguredAuth(providerId)`.
- `applyAuthChange` no longer refreshes a registry (shared runtime is refreshed
  by AuthService before emit; all sessions share it), keeping the subscribe
  callback synchronous.

**Decision:** made `modelRuntime` a **required** `PiSessionServiceDependencies`
field rather than keeping an optional `modelRegistry?`-style fallback. The old
fallback built a registry synchronously in the constructor; `ModelRuntime` can
only be created by the async `ModelRuntime.create`, which cannot run in a
constructor. `sessiond.ts` already injects `modelRuntime: auth.runtime` (slice
1), so production wiring is unaffected. Consequence: the slice-5 test surface is
wider than the four files the assessment listed — every `new
PiSessionService(...)` in tests now needs `modelRuntime`, and `fakeRuntime`/the
`TestSession` type in `testSupport.ts` must expose `modelRuntime`. Documented in
status.md "Next task".

**Result:** `npx tsc --noEmit` — `sessiond.ts` and `piSessionService.ts` at 0
errors; all production code migrated (tsc output filtered to non-test/support
files is empty). Remaining errors are slice-5 test/support only:
authService.test (10), testSupport (4), warnings (5), promptQueue (17),
lifecycle (19), archiveCleanup (9), spawnSession (3), spawnSubsession (18),
sessionRoutes (1). `piSessionService.ts` lints clean. Committed `--no-verify`
(migration not yet verify-green, per charter).

**Blockers:** none. **Sessiond-restart-pending note still ACTIVE** — this slice
added `piSessionService.ts` (a session-daemon path) to the pending-restart
surface; do not clear the note. Handing off to leg 6 (slice 5: tests +
testSupport).

## Leg 6 — slice 5 (tests + testSupport migration) — commit `d0cc55c`

**What:** Migrated all test doubles + `piSessionService.testSupport.ts` off the
removed `AuthStorage.inMemory` / `ModelRegistry.create|inMemory` surface to the
pi-ai `InMemoryCredentialStore` + async `ModelRuntime.create({ credentials })`.
`npm run verify` is now **fully green** (typecheck + lint + knip + 1390 tests,
2 skipped) — the migration goal (charter criteria 1, 2, 5) is met; only the
changeset (criterion 4) remains for slice 6.

**Files changed (all `src/server/sessions/`):**
- `piSessionService.testSupport.ts`: new seams `createTestModelRuntime`,
  shared `testModelRuntime` (top-level await), `seedCredential`; `fakeRuntime`
  and `testModel` moved onto `modelRuntime`; dropped AuthStorage/ModelRegistry.
- `archiveCleanup`/`lifecycle`/`promptQueue`/`spawnSession`/`spawnSubsession`/
  `sessionRoutes` tests: injected `modelRuntime: testModelRuntime` into every
  `new PiSessionService(...)` (now required) + imported the shared runtime.
- `promptQueue.test.ts` auth-loss test: live `InMemoryCredentialStore` +
  `createTestModelRuntime(credentials)`, driving changes through
  `delete`/`seedCredential` + `refresh()` + `applyAuthChange(...)`.
- `warnings.test.ts`: `anthropicSubscriptionWarning` seam is now a temp
  `auth.json` read via `readStoredCredential(id, authPath)`; type narrowed.
- `authService.test.ts`: reworked to async `AuthService.create` +
  `InMemoryCredentialStore`; awaits async ops; OAuth-complete uses `vi.waitFor`.

**Decisions:**
- Used a single shared `testModelRuntime` (top-level `await` in testSupport, an
  allowed ESM pattern here) for the no-auth catalog case so the many
  `PiSessionService` constructions and `fakeRuntime` sessions inject it
  synchronously — avoided making `fakeRuntime` itself async (which would have
  rippled through ~90 call sites). Auth-dependent tests build a dedicated
  per-test runtime via `createTestModelRuntime(credentials)`.
- `anthropicSubscriptionWarning` seam: chose the on-disk temp `auth.json` +
  `readStoredCredential` path (matches production exactly) rather than adding a
  new injectable credential-read seam. Clean; no intervention needed.
- Made `getLoginProviderOptions` **synchronous** (it did no async work) to
  satisfy `require-await`; de-awaited its 2 call sites in `authService.ts` and
  the test. Also fixed pre-existing lint debt from earlier slices surfaced now
  that lint ran green for the first time: `authRoutes.ts` return-await,
  `authService.ts` api-key interaction (`() => Promise.resolve(key)` /
  `notify: () => undefined`).
- Verified SDK behavior empirically with throwaway probe scripts (removed)
  before writing doubles: providers/models catalog, api-key login persistence,
  `getModel`, `hasConfiguredAuth` across store mutations + refresh, and
  `readStoredCredential` against a temp auth.json.

**Verification:** `npm run verify` green. Pre-commit hook (whole-project
typecheck + knip + eslint + related vitest) passed — committed normally
(no `--no-verify` needed since the tree is verify-green).

**Blockers:** none. **Sessiond-restart-pending note still ACTIVE** — unchanged
this leg but slices 1 + 4 touched session-daemon paths; only the human clears
it after restarting the sessiond service. Handing off to leg 7 (slice 6:
changeset + final verify + cleanup; the finish line — no PR).

## Leg 7 (slice 6 — changeset + final verify + cleanup) — RELAY COMPLETE
- **Added changeset** `.changeset/fix-pi-0-80-8-modelruntime-auth.md`: single
  `patch` fragment for `@jmfederico/pi-web` describing the user-visible fix
  (session daemon crash on Pi 0.80.8+ fixed by migrating auth to the new
  `ModelRuntime` credential APIs; Pi Web now requires Pi `>=0.80.8`). Did NOT
  edit `CHANGELOG.md`.
- **Bump type decision:** chose `patch`, not `minor`. status.md floated that a
  minor was "defensible" (narrowed Pi range), but the `changeset-changelog`
  skill is explicit for this CalVer repo: `patch` for all non-breaking changes,
  never `minor` (the minor slot = release month), `major` only on explicit user
  request. The fix is non-breaking to Pi Web consumers, so `patch` is correct.
- **Re-ran `npm run verify`:** fully GREEN — typecheck + lint + knip + 188 test
  files, 1390 passed / 2 skipped.
- **Goal criteria confirmed:** (1) no live `AuthStorage`/`ModelRegistry.create|
  inMemory`/`.authStorage`/`modelRegistry` use in `src/` — only remaining match
  is an explanatory comment in `piSessionService.testSupport.ts`; (2) auth
  surfaces all on new APIs (slices 1–5); (3) `package.json` peerDeps for the
  three `@earendil-works/*` = `>=0.80.8 <0.81`, devDeps = `^0.80.8` (verified);
  (4) changeset added this leg; (5) verify green.
- **Cleanup:** confirmed no scratch files in the repo (no `probe*.mjs`,
  `.tmp-build/`). `ASSESSMENT-issue-62.md` intentionally kept (plan of record).
- **No PR opened** (explicitly out of scope for this relay).
- **STOP per charter:** goal reached, so no next leg was spawned. Surfaced to
  the human: (a) verify green, (b) sessiond restart STILL PENDING (slices 1+4
  touched session-daemon paths; only the human clears that note after
  restarting the sessiond service), (c) no PR by design.
- Committed status/log/changeset.

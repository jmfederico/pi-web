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

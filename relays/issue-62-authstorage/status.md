# Relay status — issue-62-authstorage

## Current position
Bootstrap (slice 0) complete and committed (`0fa9d0e`). Deps are installed in the
worktree at **0.80.10** (all three `@earendil-works/*`), `package.json` ranges
corrected, and the new export surface is confirmed resolvable
(`ModelRuntime`, `readStoredCredential` present; `AuthStorage` gone; pi-ai
`InMemoryCredentialStore` present). `npx tsc --noEmit` now reports **24 errors**,
all in `src/server/sessions/` at the expected migration sites (no crash — the
removed `AuthStorage` import and `ModelRegistry.create/inMemory` calls). The
migration itself has not started.

## Leg tracking
- **Last completed leg:** 1 (slice 0 Bootstrap — deps + range correction).
- **Next leg to run:** 2.

## Next task
Run **charter slice 1 (`authService.ts` core migration)** as leg 2:
- Move `authService.ts` to `ModelRuntime` (async construction via
  `ModelRuntime.create({ authPath, modelsPath })`), migrate
  `saveApiKey` / `logoutProvider` / `refreshAuthState` / credential access off
  the removed `authStorage`/`ModelRegistry.create` surface (see assessment §5.1
  for the concrete mapping).
- Propagate the now-async construction to `src/server/sessiond.ts`.
- **Sessiond path:** this slice touches session-daemon code → note in
  status/handoff that a manual sessiond restart will be needed once landed.
- Slice 1 depends only on slice 0 (done). The tree will still not fully
  typecheck after this leg (slices 2–4 remain); that is expected — leave an
  honest status.

If slice 1 is already done when you arrive, apply the charter's task-selection
policy: pick the lowest-numbered incomplete slice (2 → 6).

### Build/tooling note (important for every leg)
Installs and any native rebuild must set `TMPDIR` to a path inside the worktree,
e.g. `TMPDIR="$PWD/.tmp-build" npm install` (remove the dir after). `/tmp` is a
5.8G tmpfs at ~81% and node-gyp's `node-pty` build fails there with "Disk quota
exceeded". `.tmp-build` is scratch — do not commit it. The pre-commit hook runs
a whole-project typecheck; while the migration is incomplete, commit relay work
with `git commit --no-verify` (the charter permits legs that aren't verify-green).
Node: v24.18.0.

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
- **Sessiond restart pending** once slices touching `sessiond.ts` / session
  runtime land (starts with slice 1/leg 2) — the human must manually restart the
  sessiond service; keep this note current when it applies.
- `/tmp` disk-quota issue is real — see the Build/tooling note above; always set
  `TMPDIR` into the worktree for installs/native rebuilds.
- node_modules is installed (gitignored) at 0.80.10; a fresh `npm install` is
  only needed if node_modules is cleared.

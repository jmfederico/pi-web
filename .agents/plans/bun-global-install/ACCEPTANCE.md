# ACCEPTANCE (frozen, r2) — pi-web over Bun, global install parity

Frozen at SPEC review time (r2, 2026-08-27). Criteria are verbatim and **r2-revised**: every criterion is observable (no `available()`-style internals), reachable with the SPEC's r2 designs (D2 launcher discovery, D3 launcher-mediated runtime prerequisite, D4 shared loader), and testable under CI ordering (`npm test` runs before `npm run build` — no test may depend on `dist/`). Weaken only via SPEC revision, never during execution.

Run matrix uses an isolated environment: `BUN_INSTALL=$TMP/bun-global-test`, packed branch tarball, and PATH variants **with and without node** (`/tmp-style` stub dirs with bun+coreutils / node+coreutils). All servers boot on temp ports/data dirs and are killed by explicit PID.

## A1 — npm regression fixed, one loader (P1, D4)
- Hermetic ESM regression test green: real `backend.ts` transpiled (`ts.transpileModule`) into a tmpdir package with a fake `node_modules/node-pty`; spawning `process.execPath` on an ESM probe, `new NodePTYBackend()` **without arguments** reports `available(): true` (exit 0). The test does not inject a require function and does not run under vite-node.
- Shared loader in place: `NodePTYBackend` and `nodePtyNativeModule.ts` both call the same exported `loadNodePtyModule()`; a test (or import graph assertion) shows no second independent node-pty loader exists.
- Backend factory fallback: on a bun-like global without `Bun.Terminal`, `createDefaultBackend()` returns the node backend (or an explicitly-unavailable backend), never a bun backend whose `create()` throws.

## A2 — Launcher contract (P2, D1+D2)
- Isolated `bun add -g <branch tarball>` exits 0; installed `bin/` contains the three launchers, and the real tarball lists `dist/bin/*.sh` (`buildContents.test.ts` layout assertion).
- With **node absent from PATH**: `pi-web --version` prints the version (exit 0) — resolved via PATH or candidate paths.
- With **neither runtime discoverable** (no bun/node in PATH **nor** at candidate paths): exit 127 with an actionable message naming `PI_WEB_RUNTIME`.
- `PI_WEB_RUNTIME=bun` forces bun (clear error if absent/incapable); `PI_WEB_RUNTIME=node` forces node (error if absent); invalid value exits 2.
- Capability gate: a stub bun **without** `Bun.Terminal` in `auto` falls through to node when node is available, and produces a clear error when forced.
- `--print-runtime` prints exactly `bun` or `node`, exits 0 only when the resolved runtime passes the capability/floor gate, and never passes the flag through to the JS entry.
- Launcher reached through a symlink chain resolves the real entry correctly; controller tests run from an **installed-shaped tmpdir tree** (never the repo layout); stub bun/node shims make resolution observable without real runtimes.

## A3 — Terminals E2E on the bun install (P4, G1)
- Boot installed sessiond under bun (`PI_WEB_DATA_DIR` temp, `PI_WEB_SESSIOND_PORT` temp): `GET /terminals` → `[]`; `POST /terminals {cwd}` → terminal created, `exited:false`, and shell output is observable through the attach stream (real PTY via `BunPTYBackend`).
- Boot installed server under bun (`PI_WEB_PORT`, `PI_WEB_HOST=127.0.0.1`): `GET /` → HTTP 200; `GET /api/projects` → 200 `[]`.
- Both shut down on SIGTERM without orphaning.

## A4 — npm path stays green (P4, G2)
- Existing npm global smoke (`npm run smoke:package-install`) passes unchanged with launcher bins; it exercises the **fixed** Node backend (terminal smoke uses `process.execPath`).
- With node-pty installed+built, creating a terminal through the installed package under node works — the F1 `ReferenceError` is gone (observable via the smoke's PTY output assertion, not via `available()`).

## A5 — Production services runtime-aware (P3, D3, G3)
- `pi-web install` preflight accepts a machine with **only bun** in **both** selection branches: (a) manager PATH contains the global bin dir → `named-command` selected, `runtime` prerequisite satisfied via `--print-runtime` (no `node-version` failure); (b) manager PATH lacks it → `bundled-entrypoint` selected with the launcher path. Both branches exercised with a transient-unit probe (`systemd-run` / launchd LaunchAgent environment), stub runtimes at candidate paths proving D2 discovery under a manager-like PATH.
- Rendered unit `ExecStart` invokes the launcher (absolute path), `serviceDoctor` parses it without drift errors, and the runtime is decided at start (verified by flipping `PI_WEB_RUNTIME` via unit `Environment=` without reinstalling).
- On a node-only machine the rendered plan behaves exactly as today (node selected; floor 22.19.0 enforced inside the launcher).

## A6 — Honest diagnostics (P3, D4, G4)
- `doctor` under **bun** (no node-pty in install): exit 0 for the terminal-runtime section; reports bun runtime and `Bun.Terminal` capability; no npm-reinstall advice.
- `doctor` under **node** without node-pty: still fails that section with adapted npm advice — not weakened; and its verdict now comes from the **same** loader the backend uses (the r1-state contradiction "doctor ✓ while terminals ✗" is structurally impossible).
- Version report shows per-component runtime.
- Backend factory fallback (A1 third bullet) observable in doctor: old bun without `Bun.Terminal` → doctor reports the capability failure and the effective backend, not a silent dead terminal.

## A7 — Surface & release hygiene (P4/P5)
- `install.sh` contains the bun alternative with corrected trust-policy reasoning; `docs/install.html` documents both paths + `PI_WEB_RUNTIME` + upgrade/refresh note; README unchanged (pointer only); docs do **not** recommend `bun add -g --bun`.
- `npm run verify` green (typecheck, lint, knip, tests); P2 gate also includes knip before P5.
- Changeset is `minor` and explicitly documents the auto-prefer-bun behavior change, `PI_WEB_RUNTIME`, and the re-run-`pi-web install` refresh note (SPEC §7).
- New smokes run in CI-compatible isolated dirs; no writes to `~/.bun`, `~/.pi-web`, or the live services.
- Planning artifacts (`.agents/plans/bun-global-install/`) committed by P1.

## Evidence receipts
Each criterion records command + exit code + key output in the PR description (same format as the verification session of 2026-08-27). What cannot be executed (none expected) goes to a manual checklist, never silently skipped.

## Revision history
- **r2 (2026-08-27):** A1 rewritten (old bullet 1 — "doctor reports ✓" — never tested the F1 fix; doctor's loader predates the branch and passed with terminals broken). A2 expanded for D2 discovery (candidates, capability gate, `--print-runtime`, installed-shaped test trees). A5 expanded to cover both selection branches with manager-environment probes. A4/A6 reworded to observable behavior and shared-loader invariant. Frozen criteria are r2-verbatim; weaken only via SPEC revision.

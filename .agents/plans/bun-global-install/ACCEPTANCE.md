# ACCEPTANCE (frozen, r2.1) — pi-web over Bun, global install parity

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
- Rendered unit `ExecStart` invokes **a launcher and never an interpreter**: either the absolute bundled launcher path or the bare `pi-web-*` command name (the named form is what keeps PATH-stable runtime selection under fnm/nvm, whose multishell dirs are per-version). `serviceDoctor` parses it without drift errors, and the runtime is decided at start (verified by flipping `PI_WEB_RUNTIME` via unit `Environment=` without reinstalling).
- On a node-only machine the rendered plan behaves exactly as today (node selected; floor 22.19.0 enforced inside the launcher).
- **r2.1:** A named `pi-web-*` command is only selected when it is byte-identical to the launcher shipped by the running package (`cmp -s` in the same authoritative check, before any execution). Observed while verifying this criterion: the pre-launcher release's bin entry is the JavaScript entrypoint, so probing it with `--print-runtime` started a real session daemon and the probe died on its 15 s timeout. Selecting such a command also silently re-freezes the runtime at install time, defeating D1. The bundled-launcher fallback stays available, so no configuration loses a working service path.
- **r2.4:** byte identity alone does not identify an installation — a second PI WEB install ships a launcher with the same content, and running *that* file boots that install's code. The named command is therefore accepted only when it is byte-identical **and** reports the shipped launcher's directory as its own (`<cmd> --print-launcher`), with `cmp -s` always sequenced before any execution. Both the selection probe and the runtime prerequisite carry the guard, because the runtime prerequisite is the check that executes the command.

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

| Criterion | Status | Receipt |
|---|---|---|
| A1 | met | `src/server/terminals/nodePtyLoader.test.ts` (transpile + spawn `process.execPath`, green in the suite); single `loadNodePtyModule()` consumer test; commit `9e06407`. |
| A2 | met | `scripts/launchers.test.mjs` controller matrix on an installed-shaped tree; `src/buildContents.test.ts` packed-launcher/exec-bit assertion; `npm run smoke:bun-install` logs `bun-installed pi-web 1.202608.2 runs on bun with node absent from PATH` (exit 0). |
| A3 | met | `npm run smoke:bun-install` exit 0: `bun session daemon (pid …) served a terminal through Bun.Terminal` and `bun web/API and session daemon both reported runtime=bun and served / + /api/projects`. The terminal assertion now requires `[ -t 0 ] && [ -t 1 ]` inside the session (a pipe would echo the same bytes) and fails if any descendant of the daemon survives shutdown or `DELETE /terminals/:id`. |
| A4 | met | `npm run smoke:package-install` exit 0 (`Installed-package plugin API and PTY smoke tests passed with npm 12.0.1.`), including the Node-backed PTY marker assertion. Required fixing the harness's inherited `npm_config_prefix` leak first (SPEC P4). |
| A5 | met (Linux) | `src/nativeServices/*` suites (incl. the `cmp -s` + `--print-launcher` ownership ordering and the no-PATH-advice-on-identity-failure case) + real `pi-web doctor` against live units (parses without drift, ~0.5 s after the identity guard); transient-unit probe returns `bun` for the bundled launcher in 50 ms. macOS launchd half of the matrix: **not executed** — no macOS host here; stays a manual pre-merge item (SPEC §7.1). |
| A6 | met | `src/server/diagnostics/terminalRuntime.test.ts` (bun-with-capability, bun-without-capability, node paths) + `src/shared/piWebStatusParsing.test.ts` and `src/server/piWebStatus.test.ts` (a `/runtime` report must name `sessiond` before it can fill that slot) + real `pi-web doctor` printing `runtime: bun` / `terminals: Bun native PTY (Bun.Terminal)` with no npm advice. |
| A7 | met | `install.sh` behavioral tests (`src/installScript.test.ts`, 5 cases incl. exit 2 on unknown installer); docs sections listed in SPEC P4; changeset `minor`; both smokes confined to `mkdtemp` roots (no writes to `~/.bun`, `~/.pi-web`, or live services). CI step for `smoke:bun-install` added but **never executed** — the fork records no runs and the upstream run for this head is parked at `action_required` (approval needs admin rights this account lacks). |

## Revision history
- **r2.4 (2026-08-28, post-review):** strictly additive. A5: identity guard extended from `cmp -s` to `cmp -s` + `--print-launcher` ownership proof on both the selection probe and the executing runtime prerequisite; A5's ExecStart clause restated to say "a launcher, absolute or named" because the named strategy in the same criterion contradicts "absolute path" and is the shape this project's own host needs. Launcher: entrypoint existence now precedes `--print-runtime`, so a probe can never report a runtime for a launcher whose code is missing; fixed runtime candidates are baked into the launcher at build time rather than hard-coded in the template. A6: a session daemon runtime report is accepted only when it names `sessiond`. No criterion was relaxed.
- **r2 (2026-08-27):** A1 rewritten (old bullet 1 — "doctor reports ✓" — never tested the F1 fix; doctor's loader predates the branch and passed with terminals broken). A2 expanded for D2 discovery (candidates, capability gate, `--print-runtime`, installed-shaped test trees). A5 expanded to cover both selection branches with manager-environment probes. A4/A6 reworded to observable behavior and shared-loader invariant. Frozen criteria are r2-verbatim; weaken only via SPEC revision.

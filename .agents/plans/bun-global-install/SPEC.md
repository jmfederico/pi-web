# SPEC: Run pi-web on Bun — global install parity (finish `feature/native-bun-pty`)

Status: **reviewed (r2) — ready to execute**
Branch: `feature/native-bun-pty` (work continues on this branch; no GitHub issues exist for this unit)
Created: 2026-08-27 · Revised: 2026-08-27 (r2 — post-review corrections; see §8)
Evidence base: empirical verification session of 2026-08-27 (isolated `BUN_INSTALL` installs of the branch tarball; findings below are reproduced facts, not assumptions) + r2 source verification against this branch (line refs as of 2026-08-27).

---

## 1. Problem (evidence-backed)

| # | Finding | Evidence |
|---|---------|----------|
| F1 | **Regression (Node-only):** `NodePTYBackend` loads node-pty with bare `require("node-pty")` inside an ESM module (`src/server/terminals/backend.ts:284`). `require` is undefined in Node ESM → `ReferenceError` → silently caught → terminals dead for **every npm-installed user on Node**. Observable symptom: `create()` throws "node-pty module is not available" at `POST /terminals` (`available()` is not called in production code — only tests). `main` used a static `import * as pty` (worked). Vitest passes because vite-node injects a `require` shim. Bun ESM supports `require`, so bun installs are broken by F2, not F1. | Hermetic proof: `node /tmp/esmreq.mjs` → `ReferenceError: require is not defined`; stub node-pty under Node ESM → backend unusable; vitest green under vite-node |
| F2 | **Bun installs never run on Bun:** bins are symlinks to files with `#!/usr/bin/env node`. Without node in PATH: `env: 'node': No such file or directory`. With node: process runs under Node → `BunPTYBackend` never activates. `bun add -g --bun` does **not** change bin shape (verified: same symlinks) — docs must not recommend `--bun`. | Isolated `bun add -g` of the packed branch; bin inspection of the `--bun` variant |
| F3 | **node-pty silently unusable under bun installs:** bun runs node-pty's install script per its **trust policy** only when node+build tools exist; otherwise no binary, zero warnings. node-pty 1.1.0 ships no Linux prebuilds. | Installs with (a) node+gcc → `build/Release/pty.node` created; (b) no node → no binary, no warning; (c) node without gcc/python → no binary, no warning |
| F4 | **Production locked to Node:** `servicePlan.ts` `bundled-entrypoint` hardcodes `command: "node"` (`src/nativeServices/servicePlan.ts:313`; literal type at `:43`) and both `named-command` and `bundled-entrypoint` strategies attach `nodeRequirement` (`:492-495`, node ≥ 22.19.0 probed by literally running `node -e …` in the service-manager environment, `serviceProbe.ts:435-437`). `pi-web install` cannot produce bun services or pass preflight on a bun-only machine. | Source-verified r2 |
| F5 | **Diagnostics runtime-blind:** `doctor`'s node-pty check (own loader, `src/server/diagnostics/nodePtyNativeModule.ts`, `createRequire` — predates this branch) runs even under Bun and fails with exit 1 recommending an npm reinstall; under Node it reports ✓ **while the backend is broken** (F1) because it uses a *different* loader. Two loaders with independent resolution = this drift. | `bun <installed>/dist/cli.js doctor` → `✗ node-pty native module loadable`, exit 1; r2 confirmed doctor ✓ + terminals ✗ coexist on Node |
| F6 | **Service environment is not the user environment:** the authoritative probe runs as a manager unit (`systemd-run` transient unit / launchctl-bootstrapped LaunchAgent, `serviceProbe.ts:55-80,145-165`), so any PATH lookup inside services sees the **manager PATH** — launchd: `/usr/bin:/bin:/usr/sbin:/sbin` (never `~/.bun/bin`, `/opt/homebrew/bin`); systemd user: distro default, session-imported on desktops, not on headless. PATH-only runtime discovery inside launchers is unsound for the service surface. | Source-verified r2 (probe execution mechanism); launchd/systemd PATH facts |

Consequence: the feature's stated goal — *pi-web fully working after `bun add -g @jmfederico/pi-web`, without installing or compiling node-pty* — is not met, and F1 additionally breaks the existing npm path.

## 2. Goal & non-goals

**Goal**
- G1: `bun add -g @jmfederico/pi-web` (the `--bun` variant works identically — launchers make it redundant) yields a fully working `pi-web`, `pi-web-server`, `pi-web-sessiond` — CLI, web server, session daemon and **terminals** — with or without Node installed, without requiring node-pty.
- G2: The npm global path keeps working end-to-end (terminals fixed there via F1).
- G3: `pi-web install` (systemd/launchd) installs services that run under whichever runtime is available/preferred, **with runtime discovery that works in the manager environment** (F6), and honest preflight checks.
- G4: Diagnostics tell the truth per runtime (which runtime each component uses; node-pty checks only when relevant; doctor and backend share **one** loader — F5 drift eliminated).

**Non-goals**
- Windows install support (launchers are bash; services are systemd/launchd; the existing smoke test already requires POSIX).
- Making *dev* workflow (`npm run dev`, tsx watch) run under Bun (unchanged; can be explored later). `bun src/cli.ts` in a checkout enters the runtime-aware paths but is not a supported target beyond doctor/version honesty.
- Re-publishing node-pty with Linux prebuilds or changing node-pty itself.
- Bundling the server into a single executable.

## 3. Key design decisions

### D1 (chosen): POSIX bash launchers replace the bin targets

`package.json` `bin` entries point to generated `dist/bin/<name>.sh` launchers (`pi-web.sh` → `../cli.js`, `pi-web-server.sh` → `../server/index.js`, `pi-web-sessiond.sh` → `../server/sessiond.js`). Each launcher resolves its own real path through symlinks (portable bash loop, no `readlink -f` dependency), picks a runtime (D2), and `exec`s the real entry file with it. `exec` = process replacement, zero overhead, single process. Launchers implement two preflight flags (D3) and nothing else that bypasses `exec`:
`--print-launcher` prints the directory of the launcher itself — which installation owns this file —
without starting a runtime or validating anything, so it is safe for a probe that has not yet decided
the file is trustworthy; `--print-runtime` resolves and verifies a runtime and prints `bun` or `node`,
exiting 0 only if the same command would really start. Both flags short-circuit before `exec` and
never reach application JS. The entrypoint existence check runs **before** `--print-runtime` succeeds:
a launcher whose code is missing must not certify a runtime for a launch that would then fail.

Rationale for `auto` = **prefer bun**: there is no reliable way to detect the installer (npm vs bun), and the user goal requires bun-installed packages to run on bun. Preferring bun is also strictly more robust for terminals (zero native deps via `BunPTYBackend`). Machines with only Node are unaffected (no bun found). Machines with both flip to Bun — intentional, documented behavior change with an escape hatch; called out in the changeset and doctor output.

| `PI_WEB_RUNTIME` | Behavior |
|---|---|
| unset / `auto` | bun (with `Bun.Terminal` capability, else fall through to node), else node (≥ 22.19.0 floor), else fail with actionable message naming `PI_WEB_RUNTIME` (exit 127) |
| `bun` | require bun with `Bun.Terminal` capability (clear error, exit 1, if missing or incapable) |
| `node` | require node ≥ 22.19.0 (floor check inside launcher; clear error if absent/old) |
| other value | exit 2 with usage message |

### D2 (chosen, r2): deterministic runtime discovery inside the launcher

Discovery must not depend on the manager PATH (F6). Resolution order:

1. `PI_WEB_RUNTIME` forced (`bun`/`node` — see table above).
2. `PATH` lookup (covers interactive CLI and dev usage).
3. **Fixed candidate paths**: bun — `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, `/usr/bin/bun`; node — `/usr/bin/node`, `/usr/local/bin/node`, `/opt/homebrew/bin/node`.
4. No runtime → exit 127 with an actionable message naming `PI_WEB_RUNTIME` and the override env var.

Capability gate at selection time: choosing bun requires `Bun.Terminal` (verified with `"$BUN" -e 'process.exit(typeof Bun.Terminal === "function" ? 0 : 1)'` — one extra bun startup, ~30 ms, selection time only); in `auto` a capability failure falls through to node; a forced `bun` without capability is a clear error. Choosing node verifies the 22.19.0 floor with a small inline `-e` script. This also fixes the latent launchd+brew-node PATH problem for node-only users (candidate 3), and ensures terminals are never silently dead on a bun without `Bun.Terminal` (matches the backend-factory fallback in §4.3).

Rejected alternatives (r2 elimination): resolve everything at install time and bake the interpreter path into `ExecStart` (duplicates selection policy in two places — DRY violation; kills "runtime decided at start"; path moves need reinstall; escape hatch stops working without unit edits); bake the user PATH into unit `Environment=` (leaks interactive PATH into units; probe honesty requires replicating it; drift); resolve inside JS (chicken-and-egg — no runtime, no JS); login shells / profile sourcing / `bash -lc` (non-interactive profile side effects, non-deterministic shims); trusting manager environment import (launchd never, systemd headless no); separate `pi-web-bun` package/bin (fragments UX); `#!/usr/bin/env bun` shebang (breaks npm-only); postinstall shebang rewriting (bun blocks untrusted postinstalls); sh+JS polyglot header (fights tsc pipeline).

### D3 (chosen, r2): single `runtime` prerequisite, verified through the launcher

Both `named-command` **and** `bundled-entrypoint` production strategies (F4 — the SPEC r1 fixed only the latter; on desktop Linux the manager PATH contains the global bin dir, so the probe selects `named-command` first) get one prerequisite kind `runtime`, whose shell check executes the resolved launcher with `--print-runtime` (`<named-command-abs-path> --print-runtime`, or the bundled launcher path). The launcher is the single source of truth for selection policy and floors (22.19.0 / `Bun.Terminal`); `node-version` checks retire for these strategies (`serviceProbe.nodeVersionCheckScript` logic moves into the launcher). `configured-override` keeps empty prerequisites (user's explicit command, their responsibility; doctor prints it as-is). Probes stay honest because they execute the exact binary the unit will run — and for a name resolved
through the service `PATH`, "exact" is proved inside the same authoritative check: `cmp -s` against the
launcher this package ships (before any execution), then `<cmd> --print-launcher` to confirm the bytes
come from *this* installation rather than a second copy that ships an identical launcher (r2.4). Both
the selection probe and the executing `runtime` prerequisite carry that guard, because a check that
runs later could otherwise exec a file the earlier check never vetted.

### D4 (chosen, r2): one node-pty loader, shared by backend and doctor

Extract `loadNodePtyModule()` (via `createRequire(import.meta.url)`) into a single module consumed by **both** `NodePTYBackend` and the doctor check (`nodePtyNativeModule.ts` keeps only formatting/verdict logic on top of it). The r1 evidence drift (F5: doctor ✓ while backend ✗) came from having two independent loaders; without D4 it can recur.

Launcher sketch (template, one per bin; `TARGET` varies; generated into `dist/bin/` at build):

```bash
#!/usr/bin/env bash
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case $SOURCE in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
# resolve_runtime(): PI_WEB_RUNTIME → PATH → fixed candidates (D2)
#   + capability/floor gate per D2 table
if [ "${1:-}" = "--print-runtime" ]; then
  runtime="$(resolve_runtime)" && echo "$runtime" && exit 0
fi
exec "$RUNTIME" "$SCRIPT_DIR/TARGET" "$@"
```

Node and Bun both resolve module imports relative to the file's real path, so dependency resolution stays correct under both.

## 4. Interface changes

1. `package.json`: `bin` → `dist/bin/pi-web.sh`, `dist/bin/pi-web-server.sh`, `dist/bin/pi-web-sessiond.sh` (exec bits preserved by tar; `files` already ships `dist/`). Fix stray blank line after `optionalDependencies`.
2. New env var `PI_WEB_RUNTIME` (`auto|bun|node`): read by launchers only (running `node dist/cli.js` directly bypasses it — documented as a bin-level concern); valid as a unit `Environment=` override. Documented in config docs.
3. `doctor` / version report: prints the active runtime (bun/node) per context; node-pty native check + macOS spawn-helper check **only under Node runtime**, with the verdict derived from the **shared loader** (D4); under Bun, checks `typeof Bun.Terminal === "function"` (capability over version floor). Reinstall advice adapts: npm advice under Node; under Bun advise nothing unless the backend itself is unavailable.
4. Terminal backend factory fallback: `createDefaultBackend()` currently picks `BunPTYBackend` whenever the Bun runtime is detected (`backend.ts:39-55`) even if `Bun.Terminal` is missing → dead `create()`. Change to: Bun runtime **and** `BunPTYBackend.available()` → bun; else `NodePTYBackend` (needs D4; under bun node-pty will usually be absent → unavailable with clear surfaced error, which doctor reports).
5. `servicePlan.ts`: strategy type `bundled-entrypoint.command` literal `"node"` (`:43`) becomes the launcher path; `bundled-entrypoint` renders the launcher (`:313`); `runtimeRequirement` (D3) replaces `nodeRequirement` for `named-command` and `bundled-entrypoint` (`:492-495`); update strategy rendering and `serviceDoctor` parsing/lines/tests. Dev plan unchanged.
6. `install.sh`: keeps npm as the blessed default; adds a commented bun alternative (`bun add -g @jmfederico/pi-web`). Reasoning corrected (r2): whether bun runs node-pty's install script is governed by **bun's trust policy** (F3), not by node-pty being optional; if a bun user wants node-pty anyway, document `bun pm trust node-pty` (optional, not required by this feature).
7. Docs site (`docs/install.html` — user-facing; documentation-guide skill applies at implementation time): bun install section (plain `bun add -g`; do **not** recommend `--bun`) + `PI_WEB_RUNTIME` reference + upgrade note (§7). README stays a pointer.
8. Changeset: promote `.changeset/native-bun-pty.md` from `patch` to `minor`; describe terminal-backend work, bun global install support, auto runtime preference behavior change, `PI_WEB_RUNTIME`, and the reinstall-to-refresh note (§7).

## 5. Phases

### P1 — Fix NodePTYBackend loader + unify doctor loader (unblocks everything; regression)
- [x] D4: extract shared `loadNodePtyModule()` (createRequire-based); `NodePTYBackend` and `nodePtyNativeModule.ts` both consume it; `pty = null` failure mode preserved.
- [x] Backend factory fallback per §4.4 (bun without `Bun.Terminal` → node backend, else unavailable with surfaced error).
- [x] Hermetic regression test (test-first): `ts.transpileModule()` the **real** `backend.ts` (typescript devDep, precedent `buildContents.test.ts`) → write the self-contained ESM output to a tmpdir package layout with a fake `node_modules/node-pty` → spawn `process.execPath` on a tiny ESM probe → zero-arg `new NodePTYBackend()` → `available(): true`. This is the only design that satisfies all constraints: CI runs `npm test` **before** `npm run build` (no `dist/` dependency), the repo has node-pty installed (in-repo tests pass trivially under vite-node's require shim — the reason the bug survived), and DI/injected-require tests pass with the broken code.
- [x] Commit planning artifacts (`.agents/plans/bun-global-install/`) so the contract is visible to review/CI.
- [x] Gate: targeted terminals suite + diagnostics suite + `npm run typecheck`.

### P2 — Runtime launchers + `PI_WEB_RUNTIME` (D1 + D2)
- [x] Launcher template in `scripts/`; build emits 3 launchers into `dist/bin/` (chmod +x); wire into existing build script and `prepack` flow. Repoint `package.json` `bin`; blank-line cleanup.
- [x] Fixed candidate paths are injected by `build-launchers.mjs` (arrays in the template) rather than
  written into the template by hand, so the launcher under test and the launcher we ship cannot drift
  and no test has to know where this machine keeps its runtimes.
- [x] Controller-level tests spawn launchers from an **installed-shaped tmpdir tree** (bin/, dist/cli.js stub, dist/server/*.js stubs, stub bun/node executables on a controlled PATH — the repo layout has no `../cli.js` TARGET, so repo-root spawning tests the wrong thing): bun-preferred, node fallback, forced `PI_WEB_RUNTIME`, invalid value → 2, missing-runtime 127 message naming `PI_WEB_RUNTIME`, candidate-path resolution with minimal PATH (manager-like), capability gate (stub bun without `Bun.Terminal` → falls to node / clear error), `--print-runtime` output and exit codes, symlink-chain resolution, exec-bit preservation through the real tarball.
- [x] Layout assertion in `src/buildContents.test.ts`: `npm pack --dry-run` lists the three `dist/bin/*.sh` bins.
- [x] Gate: full terminals suite + typecheck + lint + `npm run knip`.

### P3 — Runtime-aware production plan & doctor (D3)
- [x] `servicePlan.ts`: type + rendering + prerequisite changes per §4.5; **both** strategies get `runtimeRequirement`; retire `node-version` for them; `configured-override` unchanged. Update plan-rendering and `serviceDoctor` output/parsing/tests (doctor now prints the launcher-mediated runtime verdict).
- [x] `doctor`: runtime-aware node-pty/spawn-helper checks (§4.3) derived from the shared loader; bun capability check; runtime printed in report; reinstall advice per runtime.
- [x] `piWebVersionReport`: surface component runtime.
- [ ] **NOT VERIFIED** — how today's brew-node ARM macOS preflight behaves via the launchd probe PATH (D2 candidates are expected to fix it). No macOS host in this environment; captured as a manual checklist item in the PR (see §7.1).
- [x] Gate: native-services test suites + typecheck.

### P4 — Install surface & smoke coverage
- [x] `install.sh` bun alternative (§4.6): `PI_WEB_INSTALLER=npm|bun`, npm stays the default branch and keeps `--allow-scripts=node-pty`, bun branch is bare `bun add -g @jmfederico/pi-web`, unknown value exits 2 before either package manager runs. Comments cover `Bun.Terminal`, `bun pm trust node-pty`, and why `--bun` is not used. Covered by `src/installScript.test.ts` (source surface + three behavioral runs with stubbed `npm`/`bun`/`pi-web`).
- [x] Docs (documentation-guide skill; README stays a pointer). There is **no `docs/architecture.md` in this repo** — the plan's "`architecture.md` §9" target does not exist, so the canonical homes are: `docs/config.md` + `docs/config.html` → new **JavaScript runtime** section (`config#runtime`) plus the `PI_WEB_RUNTIME` matrix row; `docs/install.html` → new **Install with Bun** section (`install#bun-install`, TOC entry, requirements bullet, `PI_WEB_INSTALLER=bun` in the one-liner, upgrade callout); `docs/faq.html` → the node-pty article now says it applies to Node.js processes only and links to the Bun path, and the doctor article describes the runtime/terminal-backend report. README grew by one clause only.
- [x] `scripts/smoke-package-install.mjs`: bun global smoke (`npm run smoke:bun-install`) — packed tarball installed with `bun add -g` into an isolated `BUN_INSTALL`, PATH **without node or npm**, then installed `pi-web --version`, `pi-web-sessiond --print-runtime` = `bun`, session daemon on a temp port creating a real PTY (list → create → WebSocket attach and read the marker back → delete), web/API + daemon on a temp data dir both reporting `runtime=bun` while serving `/` and `/api/projects`, and clean SIGTERM shutdown of both. Existing npm smoke kept as the Node regression path (it still exercises the fixed `NodePTYBackend` through `process.execPath`).
- [x] Fixed a hermeticity defect found while running the npm smoke: the inner npm inherited `npm_config_*` from the outer `npm run`, so `npm install --global --prefix <temp>` resolved against the **real** version-manager prefix (a same-version install then no-ops; on a different version it would have overwritten the user's global PI WEB). npm children now get a scrubbed environment with `HOME`, `npm_config_prefix`, and `npm_config_cache` pointed inside the temp root.
- [x] CI: `smoke:bun-install` added to the package-smoke job on Linux behind `oven-sh/setup-bun@v2` (`bun-version: latest`, because the runner image's copy is not guaranteed to provide `Bun.Terminal`). **Unexecuted:** the fork records zero workflow runs, and the upstream run queued for this PR head is parked at `action_required` awaiting a collaborator with admin rights (approve returns 403 from this account).
- [x] Changeset promoted to `minor` with the behavior-change and upgrade wording (§4.8, §7).
- [x] Gate: `npm run verify` + both smokes green locally (§7.2).

### P5 — Hardening & PR
- [x] `npm run verify` green at `7f5f325`: typecheck, lint, knip clean; 346 files / 3463 tests passed, 9 skipped. `npm run build` and `npm run pack:dry` green (packed tree lists the three `dist/bin/*.sh`).
- [x] Changeset promoted to minor with behavior-change + upgrade notes (§4.8) — shipped in P4 (`bfae5d7`).
- [x] Manual matrix executed and recorded in the PR description (§7.3): npm/node, bun-only, bun+node auto → bun, `PI_WEB_RUNTIME=node`, forced `bun` on an incapable bun, no-runtime 127, manager-unit probe, live doctor/version.
- [x] Docs corrected against the implementation while collecting receipts (§7.3, §8 r2.3): the candidate-path lookup applies to **both** runtimes, Bun first (`~/.bun/bin/bun` included), which is what makes `auto` pick Bun on a minimal service PATH.
- [ ] macOS launchd + brew-node preflight: **not executed** (no host). Manual checklist item for the reviewer.
- [ ] New CI step `smoke:bun-install`: **not executed here**; this PR's CI run is its first execution.
- [x] PR opened from `feature/native-bun-pty` with the matrix and receipts.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Machines with **both** runtimes switch from node → bun (behavior change) | `PI_WEB_RUNTIME=node` escape hatch; changeset + doctor surface the active runtime; manual matrix covers it |
| Long-running server stability under Bun less battle-tested | Escape hatch; installed-package smoke covers boot + terminal HTTP E2E (the repo has **no browser E2E suite** — coverage is smoke + manual matrix, nothing more is claimed); doctor reports runtime so support can diagnose |
| Launcher candidate list is a bounded heuristic (D2) | Documented `PI_WEB_RUNTIME` override; doctor prints the resolved runtime; PATH still consulted first |
| Launcher adds bash dependency | POSIX install targets already assume bash/sh (services, install.sh); Windows explicitly unsupported |
| Probe honesty drift (plan checks ≠ what the unit runs) | D3 makes the prerequisite execute the launcher itself in a manager unit (`systemd-run`/LaunchAgent), so preflight tests the real dispatch path |
| A PATH-resolved `pi-web-*` command belongs to a **different** PI WEB installation (observed 2026-08-28: probing the previous release's entrypoint started a real session daemon and timed out the authoritative probe) | The named command is accepted only when byte-identical to the shipped launcher (`identicalTo` + `cmp -s`, checked before execution); otherwise the plan execs the bundled launcher path, and doctor prints which file it chose and why |
| `knip`/lint flagging new script files | Follow repo skill conventions; `scripts/*.mjs` is already a knip entry; ignore lists only if genuinely false positives |

## 7. Migration & upgrade

- `pi-web install` always re-renders and replaces units (`replaceServices`, `serviceInstall.ts:69`). Users with **previously installed units** (ExecStart `node <entrypoint>` from older versions) must re-run `pi-web install` after upgrading to refresh definitions; until then doctor flags the definition mismatch. Called out in the changeset and in doctor output.
- The `auto` → prefer-bun flip affects services only after that refresh; the manual matrix includes the refreshed-bun-services case.
- `PI_WEB_RUNTIME` can be set persistently for services via unit `Environment=` without reinstalling.

## 7.1 P3 verification record (Linux/x64, bun 1.4.1, node v24.19.0)

- Launcher matrix run against the built `dist/bin/*.sh`: PATH with both → `bun`; node only → `node`; bun only → `bun`; neither → exit **127** (also for `--print-runtime`, so probe and service agree); `PI_WEB_RUNTIME=node` with both → `node`; forced `bun` with no capable bun → exit 1 naming `Bun.Terminal`; stub bun without `Bun.Terminal` + good node → `node`.
- The generated `runtime` prerequisite executed through `/bin/bash -lc` returns `bun` in 50 ms for the bundled launcher, exit 1 when the named command is absent, and 0 via an npm-style bin symlink into the package (the global-install shape).
- **Regression found and fixed during verification:** the first version of D3's named-command probe executed whatever `command -v pi-web-sessiond` resolved to. On this machine that is the published pre-launcher entrypoint (`#!/usr/bin/env node` + sessiond code), which ignored `--print-runtime`, tried to claim the live data directory, and never exited — `pi-web doctor` hung for the probe's full 15 s and reported an infrastructure failure. Fixed by the `identicalTo` guard (ACCEPTANCE A5 r2.1); the same doctor invocation now finishes in 0.5 s and reports the chosen launcher.
- systemd `--user` transient-unit context observed directly: `$HOME` is the **manager's** home, not the caller's (so a sandboxed `HOME` does not move the unit search paths or the launcher's `~/.bun/bin/bun` candidate), and `$PATH` inherits the user manager's environment, which here already contains fnm and `~/.bun/bin`. D2's candidate list is therefore still required for headless/launchd sessions, where neither is true.
- **Not verified (no macOS host available):** the brew-node ARM macOS launchd preflight behaviour before/after this change. Stays a manual checklist item before merge (SPEC §9).

## 7.2 P4 verification record (Linux/x64, bun 1.4.1, node v24.19.0, npm 12.0.1)

- `npm run smoke:bun-install` — green, three checks logged: installed `pi-web 1.202608.2` ran on bun **with node absent from PATH**; the installed session daemon served a terminal through `Bun.Terminal` (created, echoed over the attach stream, deleted); web/API and session daemon both reported `runtime=bun` while serving `/` and `/api/projects`. Both processes exited on SIGTERM and no `bun` process survived the run.
- `npm run smoke:package-install` — green with the scrubbed npm environment: installed-package plugin-API baseline match, declaration artifacts, example compatibility floor, consumer type-checks in both module modes, and a Node-backed PTY (`node-pty` built by the install) served the marker.
- Two harness defects had to be fixed before either result meant anything: the inherited `npm_config_prefix` (§P4 checkbox) and `exitCode === null` for signal-killed children, which made a clean SIGTERM shutdown look like a hang and would have masked real hangs the same way.
- `install.sh` behavioral coverage runs `sh install.sh` against stub `npm`/`bun`/`pi-web` and asserts which argv each saw: default → npm with the scoped flag and no bun call; `PI_WEB_INSTALLER=bun` → `bun add -g @jmfederico/pi-web` and no npm call; `PI_WEB_INSTALLER=deno` → exit 2 with no install and no `pi-web install`.
- `npm run verify`: typecheck, lint, knip clean; 346 files / 3463 tests passed, 9 skipped.
- **Still not verified:** macOS launchd + brew-node preflight (no macOS host, §7.1) and the CI job itself — the queued upstream run needs a collaborator's approval (`action_required`; 403 from this account), so neither smoke has runner evidence.

## 7.3 P5 manual matrix (Linux/x64, bun 1.4.1, node v24.19.0, npm 12.0.1, built `dist/bin/*.sh`)

| Cell | Command | Observed |
|---|---|---|
| npm/node install path | `npm run smoke:package-install` | exit 0 — plugin-API baseline match, consumer type-checks, Node-backed PTY served the marker through the installed package |
| bun-only machine, node absent from PATH | `npm run smoke:bun-install` | exit 0 — installed `pi-web --version`, session daemon terminal over `Bun.Terminal`, web/API + daemon `runtime=bun`, both stopped on SIGTERM, no process left |
| bun+node, `auto` | `dist/bin/pi-web-sessiond.sh --print-runtime` | `bun` |
| pin node on a bun machine | `PI_WEB_RUNTIME=node dist/bin/pi-web-server.sh --print-runtime` | `node` |
| require bun | `PI_WEB_RUNTIME=bun dist/bin/pi-web.sh --print-runtime` | `bun` |
| invalid value | `PI_WEB_RUNTIME=deno dist/bin/pi-web.sh --print-runtime` | exit 2 — `pi-web: PI_WEB_RUNTIME=deno is not valid. Use auto, bun or node.` |
| nothing discoverable | `env -i PATH=/usr/bin:/bin HOME=/nonexistent … --print-runtime` | exit 127 with the actionable message naming `PI_WEB_RUNTIME` |
| forced bun, incapable bun, no node | stub bun that fails the `Bun.Terminal` probe | exit 1 — `PI_WEB_RUNTIME=bun requires bun with Bun.Terminal, but none was found in PATH or the usual install locations.` |
| auto, incapable bun, no node | same stub | exit 127 (incapable bun never selected) |
| manager-context probe | `systemd-run --user --pipe --wait` on the bundled launcher | `bun`, finished success in 69 ms |
| doctor on the running checkout under bun | `dist/bin/pi-web.sh doctor` | `pi-web CLI runtime: bun`, `runtime: bun`, `✓ terminals: Bun native PTY (Bun.Terminal)`, no npm advice; named-command identity guard printed the bundled-launcher fallback note for the older published global command |

## 8. Revision history

- **r2.3 (2026-08-28, P5 addendum).** §7.3 records the executed manual matrix. Collecting it corrected one documentation claim: candidate-path discovery covers Bun as well (`~/.bun/bin/bun` first, then the system locations), tried before Node.js, so `auto` selects Bun even when the service environment has no `PATH` entry for it (`7f5f325`).
- **r2.4 (2026-08-28, post-review).** A5 identity guard extended to prove installation *ownership* (`--print-launcher`) on both the selection probe and the executing runtime prerequisite; launcher gained `--print-launcher`, moved the entrypoint check ahead of `--print-runtime`, stopped expanding `$HOME` bare, and takes its fixed candidate list from the build instead of the template. §7.4 records the review findings, the fixes, and their receipts. No behavior claim in §1–§6 changed.
- **r2.2 (2026-08-28, P4 addendum).** §7.2 records the install-surface evidence. Two corrections to the plan text: this repo has **no `docs/architecture.md`**, so the runtime documentation lives in `docs/config.md`/`config.html` (`config#runtime`) and `docs/install.html` (`install#bun-install`) instead of the target the P4 checkbox named; and the P4 smoke work found the npm smoke itself was not hermetic (inherited `npm_config_prefix` aimed the inner global install at the real version-manager prefix), which is now fixed and is a precondition for trusting A4.
- **r2.1 (2026-08-28, implementation addendum).** §7.1 records the P3 evidence, including the stale-named-command hazard found while executing the A5 matrix and the `identicalTo` guard added for it (§6, ACCEPTANCE A5). No decision changed: D3 still verifies through the launcher, now only after proving the named command *is* that launcher.
- **r2 (2026-08-27) — post-review corrections.** B1: A1 acceptance redesigned (the doctor ✓ criterion never tested the F1 fix — doctor's loader predates the branch); P1 test replaced with the transpile+spawn ESM design; D4 shared loader added. B2: D3 added — `runtime` prerequisite for both production strategies (r1 fixed only `bundled-entrypoint`; named-command carries `nodeRequirement` at `servicePlan.ts:492-493` and is selected first on desktop-PATH machines). B3: F6 + D2 added — probe runs as a manager unit, so PATH-only launcher discovery was unsound; deterministic discovery + `--print-runtime` adopted after eliminating bake-at-install and environment-import alternatives. Line refs corrected (313/350→350 region/492-495/43); F1 marked Node-only; `available()`-based wording replaced with observable behavior; "E2E under bun verified in this repo" claim removed (no browser E2E suite exists); §4.6 reasoning fixed (bun trust policy, not optionality); migration section added; dev-mode-under-bun scoped in non-goals. Retracted during review: the `case $SOURCE` quoting concern (case words are not word-split/globbed — safe).
- **r1 (2026-08-27)** — initial draft from the verification session.

## 9. Open questions
- None blocking. (Bun min-version resolved by capability check; changeset severity **minor** — flag during review if patch preferred. The brew-node ARM macOS preflight question is an observation task inside P3, not a decision.)

## 7.4 Post-review hardening (r2.4, Linux/x64, bun 1.4.1, node v24.19.0)

An adversarial review of `d7e377b` returned BLOCK on eight findings. Each was checked against the code
before acting; all eight reproduced. Changes, and what now proves them:

| Finding | Verified symptom | Fix | Receipt |
|---|---|---|---|
| A5 identity was installable, not ownership-proof | `cmp -s` passes for a byte-identical launcher from a second install; `ENTRY` resolves relative to the *executed* file, so the probe prints `bun` and the unit boots the other release | `<cmd> --print-launcher` must report the shipped launcher's directory; guard added to the executing `runtime` prerequisite as well, which also closes the re-resolution hole where the `runtime` check used to `command -v` the name again with no identity gate | `serviceProbe.test.ts` ordering assertions (`cmp -s` before `--print-launcher` before `--print-runtime`); manual two-installation fixture: self → `bun`, shadowed by an identical copy → exit 1 with nothing executed |
| `--print-runtime` could certify a runtime for a launcher whose code was missing | launcher printed `bun` and exited 0 before the `ENTRY` check | entry check moved ahead of the flag; parity with the real command | `launchers.test.mjs` "reports the same verdict as the real command" (missing entry → probe exits 127, real command prints no marker) |
| `$HOME` unquoted under `set -u` printed `HOME: unbound variable` | status was still 127, message was noise | candidates bake `${HOME:-/nonexistent}/.bun/bin/bun`, launcher never expands `$HOME` bare | `launchers.test.mjs` "reports a missing runtime without a shell error when HOME is unset" |
| Tests skipped silently on hosts without system node/bun | `node:fs` existence skips meant the matrix could run zero cases | candidate lists come from fixtures; `/usr/bin` and `/bin` stay on the PATH as the bash fallback; host inspection removed from the test file | 21/21 cases now run unconditionally (previously some skipped) |
| Sessiond could adopt a runtime report about the wrong component | `parsePiWebRuntimeComponent` never checked `component`, so a payload labelled `web` filled the sessiond slot | `parseSessiondRuntimeComponent` requires `component: "sessiond"`; used by both the status reader and the daemon client | `piWebStatusParsing.test.ts`, `piWebStatus.test.ts` ("rejects a session daemon runtime report that describes another component") |
| A3 proved bytes travelled, not that a PTY was attached; shutdown proved only the direct child | `printf` works through a pipe; `stopService` polled `exitCode` of the leader, so an orphaned `Bun.spawn` shell or a `sleep` grandchild passed | shell reports its own descriptors (`t\"\"tyyes` so the echoed command cannot fake it); `stopService` snapshots descendants before `SIGTERM` and fails on survivors; `DELETE /terminals/:id` must empty the daemon's tree | `npm run smoke:bun-install` exit 0 with the new assertions |
| Docs claimed an incapable Bun still runs PI WEB; changeset claimed a startup crash | the launcher never selects a Bun without `Bun.Terminal`; F1 swallowed `ReferenceError` at construction, so terminals were dead but the process ran | wording corrected in `config.md`/`config.html`/`install.html` and the changeset; the impossible `PI_WEB_RUNTIME=node` on a Bun-only host example replaced | text review + `grep` for the retired claims |
| `install.sh` exit 2 asserted only through the error message | a `cd` failure could produce a non-zero, message-matching exit | fixture stubs write their exit status; behaviour tests assert `2` (unknown installer) and `0` (happy paths) | `installScript.test.ts` |

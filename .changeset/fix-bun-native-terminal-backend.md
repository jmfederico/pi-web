---
"@jmfederico/pi-web": patch
---

Implement native `Bun.Terminal` backend for the required Terminal plugin, lazy-load `node-pty` instead of static import, and separate terminal backends into the plugin's own backend module.

## What changed

- **`pi-web-plugins/terminal/server/ptyRuntime.ts`** — Plugin-local runtime detector (mirrors `src/shared/piWebRuntime.ts` with the same capability checks), keeping the single source of truth enforced by a parity test.
- **`pi-web-plugins/terminal/server/nodePtyModule.ts`** — Plugin-local node-pty loader via `createRequire`, matching the shared host loader (SPEC D4/F5). Each tree keeps exactly one loader.
- **`pi-web-plugins/terminal/server/ptyBackend.ts`** — Backend abstraction with two implementations:
  - `BunPTYBackend` — uses `Bun.Terminal` + `Bun.spawn` (detached/setsid for job control).
  - `NodePTYBackend` — lazy-loads `node-pty`; throws a recovery-action error on missing binding instead of crashing the daemon.
  - `createDefaultBackend()` — auto-selects Bun backend under Bun with `Bun.Terminal`, falls back to node-pty otherwise.
- **`pi-web-plugins/terminal/server/terminalService.ts`** — Replaced static `import * as pty from "node-pty"` with backend abstraction. Terminals created through `backend.create()` / `backend.write()` / `backend.resize()` / `backend.kill()` / `backend.attach()`. Constructor accepts optional `backend` override for testing.
- **`src/server/terminals/nodePtyLoader.test.ts`** — Extended SPEC D4 test: now asserts each tree (src + plugin) has exactly one node-pty loader, and that the Terminal plugin server is free of static node-pty imports.
- **`pi-web-plugins/terminal/server/ptyBackend.test.ts`** — New 18 tests covering: factory selection (Bun with/without Terminal, Node), `BunPTYBackend` (create, spawn failure cleanup, output streaming with multi-byte UTF-8 split reassembly, exit handling, write/resize/delegate, kill idempotency, dispose), `NodePTYBackend` (injectable module, output/exit wiring, delegate calls, unavailable binding throws recovery error, dispose), and detector parity with the canonical shared runtime detector.
- **`pi-web-plugins/terminal/package.test.ts`** — Updated expected plugin server files list to include the new backend modules.
- **`src/server/diagnostics/terminalRuntime.ts`** — Under Bun, the node-pty diagnostic check is now non-blocking: a missing optional dependency build does not prevent `pi-web install` from succeeding (Bun.Terminal handles PTY natively).
- **`src/server/diagnostics/terminalRuntime.test.ts`** — Updated two tests to verify the new non-blocking behavior under Bun.
- **`src/server/diagnostics/nodePtyNativeModule.ts`** — Recovery advice is now installation-layout aware: a bun global install (`/install/global/node_modules` tree) gets the `bun add node-pty && bun pm trust node-pty` flow instead of the npm reinstall command that would create a second, conflicting install.
- **`src/server/diagnostics/nodePtyNativeModule.test.ts`** — Four new tests for the layout-aware advice (bun vs npm lines, path detection including Windows separators, default layout from module location).
- **`pi-web-plugins/terminal/server/terminalService.test.ts`** — Three new service-level tests with an injected fake backend: create/write/resize/kill routing by backend id, command-run completion from backend exit, and replay buffering of backend output.

## Why

- The r1 daemon crash: a missing optional `node-pty` killed the required Terminal plugin at static import time, even under Bun where the plugin never uses it. The docs and design (SPEC D4/F5) state that Bun terminals use `Bun.Terminal` natively — the backend was partially implemented (commit `55681a1e`) but lost during a merge conflict resolution.
- This change brings back the Bun.Terminal backend, making the plugin never import `node-pty` statically. Under Bun the backend auto-selects `BunPTYBackend` and no `node-pty` install/build is needed. Under Node the backend lazily loads `node-pty` and provides a clear recovery message on failure.
- The node-pty diagnostic check under Bun is now non-blocking: a missing optional dependency build does not prevent `pi-web install` from succeeding.

## Verification

- 375 test files pass (3813 tests).
- Both bun and node smoke tests succeed with the built plugin (`dist/pi-web-plugins/terminal/terminalService.js`).
- Lint and typecheck clean.
- SPEC D4 structural invariant verified: one loader per tree, plugin server free of static node-pty imports.
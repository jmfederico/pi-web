---
"@jmfederico/pi-web": minor
---

PI WEB now runs natively on Bun. Install the package with `bun add -g @jmfederico/pi-web` and the
installed commands start on Bun: terminal sessions use Bun's own PTY API, so no `node-pty` native
binary has to be built or approved. Node.js stays fully supported, and installing with npm keeps
working exactly as before — each PI WEB command chooses its runtime when it starts, so the package
manager you used does not lock you in.

A machine that has both runtimes now prefers Bun when it can start PI WEB on it. Set
`PI_WEB_RUNTIME=node` on the services to keep them on Node.js, or `PI_WEB_RUNTIME=bun` to require
Bun instead of falling back. A Bun build without the native terminal API is never started by the
launchers: `auto` selects Node.js instead, and `PI_WEB_RUNTIME=bun` says so and stops. `pi-web doctor` and `pi-web version` report the runtime each process
actually selected and the terminal backend that implies, and the session daemon no longer warns
about a missing `node-pty` installation when nothing on that process needs it.

Fixes a regression where terminals in the globally installed session daemon and web server were
dead on Node.js: `node-pty` was loaded with a bare `require("node-pty")` inside an ES module, where
`require` is undefined, and the resulting `ReferenceError` was swallowed at construction so every
`POST /terminals` failed with "node-pty module is not available". `node-pty` is now loaded through a
CommonJS require built from the entry file — the same loader `pi-web doctor` uses, so the two can no
longer disagree.

Upgrading from the previous release: services installed by name (`pi-web install` writes them that
way) follow the upgraded package automatically. Units written by an older release that exec an
interpreter path directly keep that shape until you re-run `pi-web install`, and `pi-web doctor`
points them out.

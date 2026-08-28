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
Bun instead of falling back. A Bun build without the native terminal API still runs PI WEB, with
terminals served by `node-pty`. `pi-web doctor` and `pi-web version` report the runtime each process
actually selected and the terminal backend that implies, and the session daemon no longer warns
about a missing `node-pty` installation when nothing on that process needs it.

Fixes a regression where the globally installed session daemon and web server crashed on startup
with `require is not defined` in a `type: module` package; `node-pty` is now loaded through a
CommonJS require built from the entry file.

Upgrading from the previous release: services installed by name (`pi-web install` writes them that
way) follow the upgraded package automatically. Units written by an older release that exec an
interpreter path directly keep that shape until you re-run `pi-web install`, and `pi-web doctor`
points them out.

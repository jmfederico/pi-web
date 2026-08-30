---
"@jmfederico/pi-web": minor
---

PI WEB now runs natively on Bun. Install the package with `bun add -g @jmfederico/pi-web` and the
installed commands start on Bun: terminal sessions use Bun's own PTY API, so no `node-pty` native
binary has to be built or approved. Node.js stays fully supported, and installing with npm keeps
working exactly as before — `PI_WEB_RUNTIME` pins either runtime wherever you want it. Running PI WEB
on Bun is maintained on a best-effort basis by the community: issues that only reproduce when running
on Bun are fixed as community effort allows.

The runtime a PI WEB command starts on follows the package manager that installed it: a `bun add -g` installation runs
on Bun whenever that Bun can boot PI WEB, and npm installations keep running on Node.js. `PI_WEB_RUNTIME=bun` requires
Bun instead of falling back, `PI_WEB_RUNTIME=node` never selects Bun, and `pi-web doctor` and `pi-web version` report the
runtime each process actually selected. A Bun build without the native terminal API is never started: with no usable
Node.js the command stops and names the fix (`bun upgrade`, or reinstalling with npm), and with a usable Node.js it
starts there with a warning that terminals need the trusted `node-pty` build. The session daemon no longer warns about
a missing `node-pty` installation when nothing on that process needs it.

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

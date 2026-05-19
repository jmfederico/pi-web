# Pi Web

[![CI](https://github.com/jmfederico/pi-web/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jmfederico/pi-web/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@jmfederico/pi-web)](https://www.npmjs.com/package/@jmfederico/pi-web)
[![Node.js](https://img.shields.io/node/v/@jmfederico/pi-web)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi Coding Agent](https://img.shields.io/badge/Pi-Coding%20Agent-6f42c1)](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)

Website: <https://pi-web.dev/>

![Pi Web](docs/assets/pi-web-banner.png)

**Run AI coding agents on your own machine or server, keep them alive in real workspaces, and control everything from a browser.**

Pi Web is a web control plane for [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Add your repositories once, open project workspaces and git worktrees, start agent sessions inside them, and come back later without losing the work. Your browser becomes the cockpit; your server becomes the persistent development environment. Start on your laptop, check in from your phone, and continue from an iPad or another machine whenever that is the device you have at hand.

![Pi Web demo](docs/assets/pi-web-demo.gif)

With Pi Web you can:

- launch and supervise multiple coding-agent sessions in parallel;
- keep sessions running when your browser disconnects or the UI restarts;
- organize agent work by project, workspace, branch, experiment, or review;
- use git worktrees to isolate concurrent features and fixes;
- chat with Pi Coding Agent through a realtime web UI;
- move fluidly between laptop, phone, tablet, and desktop without moving the development environment;
- turn any server, desktop, or remote dev box into an agent-first development hub.

## Why use Pi Web?

Agentic development works best when agents are not trapped inside a single local terminal. They need stable environments, access to real repositories, and room to work across branches and tasks. Humans need the opposite: a clear place to supervise, redirect, review, and decide.

Pi Web connects those two worlds. The work stays in the server-side environment while you move between devices: laptop for deep focus, phone for a quick check-in, tablet for review, desktop when you are back at a desk. It is not trying to recreate the old desktop IDE in a browser; it is a control surface for persistent, parallel, human-in-the-loop agent work.

## Core model

Pi Web organizes work into three levels:

```text
Project     a folder on the server
Workspace   a git worktree, or the project folder for non-git projects
Session     a chat with Pi Coding Agent running inside a workspace
```

This maps naturally to real development work:

- add a project once;
- use worktrees to separate branches, features, experiments, and reviews;
- start one or more agent sessions inside each workspace;
- leave sessions running even when the browser disconnects or the UI restarts.

## Features

- Add and list server-side projects.
- Discover git worktrees automatically with `git worktree list --porcelain`.
- Support non-git folders as single-workspace projects.
- Start, resume, archive, and restore Pi sessions per workspace.
- Chat with Pi Coding Agent through realtime WebSocket events.
- Keep active agent runtimes alive across browser disconnects and web/API restarts.
- Explicitly stop or abort active session work.
- View live session status: streaming, compaction, bash activity, token usage, cost, model, and context usage.
- Send prompts, shell input, and supported commands through the Pi SDK path.
- Reuse your existing Pi auth and model configuration from `~/.pi/agent`.
- Extend the UI with trusted plugins that add actions, workspace panels, and workspace-label metadata. See [Plugin API](docs/plugins.md) for LLM-friendly plugin-building docs.

## Architecture

Pi Web uses a split-process architecture so agent runtimes are not owned by the browser-facing dev server.

```text
Browser UI
   │
   ▼
Fastify Web/API process
   │ HTTP + WebSocket proxy
   ▼
Session daemon
   │
   ▼
Pi Coding Agent SDK
```

### Session daemon

The session daemon owns active Pi session runtimes. It is intended to be long-lived so sessions can survive browser disconnects and web/API restarts.

### Web/API/UI server

The web process serves the API and browser UI. In development it can autoreload freely while active sessions continue running in the daemon.

## State model

Pi Web keeps its own state intentionally small:

- Projects: `~/.pi-web/projects.json`
- Workspaces: discovered from git worktrees, not stored
- Sessions and chat history: Pi's default JSONL session storage
- Active session runtimes and WebSockets: memory in the session daemon

## Plugins

Pi Web production installs can load trusted local UI plugins without rebuilding Pi Web. Plugins are browser-side ES modules that can add action-palette actions, workspace panels, and workspace-label metadata. They do not run in the session daemon and are not sandboxed.

The supported package shape is intentionally singular: `piWeb.plugins` entries with explicit `id` and `module`, plus a browser module that exports `{ apiVersion: 1, name, activate }`. The bundled `pi-web-plugins/info` plugin is the canonical minimal real example, and `pi-web-plugins/pi-web` demonstrates a dynamic status panel.

A useful prompt for AI agents:

```text
Build a Pi Web plugin for this project. Goal: <describe the UI behavior>.
Before coding, read https://pi-web.dev/plugins.html and https://pi-web.dev/plugins.md.
Create it under ~/.pi-web/plugins/<plugin-id> using the documented Pi Web v1 plugin API.
Validate with /pi-web-plugins/manifest.json and explain reload/debug steps.
Do not modify Pi Web itself.
```

Reload the browser tab after adding or editing a plugin. If `PI_WEB_DATA_DIR` is set, use `$PI_WEB_DATA_DIR/plugins` instead of `~/.pi-web/plugins`. Check discovery with:

```bash
curl http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

See the full [Plugin API](docs/plugins.md) for contribution types, package metadata, and troubleshooting.

## Install

Recommended install uses npm plus systemd user services:

```bash
npm install -g @jmfederico/pi-web

# Recommended on servers: keep user services running after logout/reboot.
sudo loginctl enable-linger "$USER"

pi-web install
```

`loginctl enable-linger` is optional for local desktop use, but recommended on servers. It lets the user systemd manager start at boot and continue running after you log out, so Pi Web remains available without an active SSH/login session.

This writes and starts:

- `~/.config/systemd/user/pi-web-sessiond.service`
- `~/.config/systemd/user/pi-web.service`

The generated services run through `bash -lc` so they see a shell environment similar to running `pi` from your terminal.

To check whether lingering is enabled:

```bash
loginctl show-user "$USER" -p Linger
```

Open <http://127.0.0.1:8504>.

Useful commands:

```bash
pi-web status
pi-web logs
pi-web restart
pi-web doctor
pi-web uninstall
```

One-line install is also available for users who prefer it:

```bash
curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/install.sh | sh
```

Pi Web is also published as a Pi package. Installing it through Pi exposes a `/pi-web` command inside Pi:

```bash
pi install npm:@jmfederico/pi-web
```

Then in Pi:

```text
/pi-web install
/pi-web status
/pi-web logs
/pi-web restart
/pi-web doctor
```

The Pi command is a convenience wrapper around the same service installer. `/pi-web logs` shows the last 100 journal lines; use `pi-web logs` in a shell when you want to follow logs continuously.

Advanced users may run the binaries however they prefer:

```bash
pi-web-sessiond
PI_WEB_PORT=8504 pi-web-server
```

## Development quick start

```bash
npm install
npm run dev
```

Open the Vite URL, usually <http://localhost:8505>.

During development, the static marketing/docs site is also served by the Vite dev server at <http://localhost:8505/site/>.

For the recommended split development setup, run these in separate terminals:

```bash
npm run dev:sessiond
npm run dev:web
npm run dev:client
```

You can restart `dev:web` or `dev:client` without stopping active Pi sessions.

## Production-style run from a checkout

```bash
npm run build
npm run start:sessiond
PI_WEB_PORT=8504 npm start
```

## Packaging and publishing

```bash
npm run verify
npm run pack:dry
npm publish --access public
```

`prepack` builds `dist/` before npm creates the tarball, and `prepublishOnly` runs verification before publishing. Releases can also be published by the GitHub Actions npm workflow when a GitHub release is published.

Pi Web uses a single-line CalVer-inspired npm version: `MAJOR.YYYYMM.SEQUENCE`, for example `1.202605.1`. The major number signals breaking-change eras; the middle number is the release month; the final number increments for additional releases in that month. Older major eras may be deprecated rather than maintained in parallel.

Pi Web declares `@earendil-works/pi-coding-agent` as a peer dependency (`>=0.74.0 <1`) and a development dependency for local builds. This keeps published installs flexible: npm 7+ installs the peer automatically, and users can upgrade the Pi package within the compatible range without Pi Web pinning a separate copy.


The web server defaults to `127.0.0.1:8504`. Set `PI_WEB_HOST=0.0.0.0` only when you intentionally want to bind directly on all interfaces.

The session daemon defaults to a private Unix socket at:

```text
~/.pi-web/sessiond.sock
```

Environment variables:

- `PI_WEB_PORT` / `PORT` — web server port. Defaults to `8504`.
- `PI_WEB_HOST` — web server bind host. Defaults to `127.0.0.1`.
- `PI_WEB_DATA_DIR` — Pi Web data directory. Defaults to `~/.pi-web`.
- `PI_WEB_SESSIOND_SOCKET` — Unix socket path used by both the daemon and web process when `PI_WEB_SESSIOND_URL` is not set. Defaults to `$PI_WEB_DATA_DIR/sessiond.sock`.
- `PI_WEB_SESSIOND_PORT` — optional TCP port for the daemon. If unset, the daemon listens on the Unix socket instead.
- `PI_WEB_SESSIOND_HOST` — daemon TCP bind host when `PI_WEB_SESSIOND_PORT` is set. Defaults to `127.0.0.1`.
- `PI_WEB_SESSIOND_URL` — daemon URL used by the web process when connecting over TCP, for example `http://127.0.0.1:3001`. If you set `PI_WEB_SESSIOND_PORT`, set this for the web process too.
- `PI_WEB_PROJECTS_FILE` — optional override for the projects storage JSON file. Defaults to `$PI_WEB_DATA_DIR/projects.json`.

## systemd user services

A practical local or server setup is two user services:

- `pi-web-sessiond.service` runs `npm run start:sessiond` without autoreload.
- `pi-web-ui-dev.service` runs `npm run dev:web` and `npm run dev:client` for API reloads and Vite HMR.

Example units:

```ini
# ~/.config/systemd/user/pi-web-sessiond.service
[Unit]
Description=Pi Web session daemon

[Service]
Type=simple
WorkingDirectory=/srv/dev/pi-web
ExecStart=/bin/bash -lc 'exec npm run start:sessiond'
Restart=no

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/pi-web-ui-dev.service
[Unit]
Description=Pi Web UI dev server
After=pi-web-sessiond.service
Wants=pi-web-sessiond.service

[Service]
Type=simple
WorkingDirectory=/srv/dev/pi-web
ExecStart=/bin/bash -lc 'trap "kill 0" EXIT; npm run dev:web & npm run dev:client & wait'
Restart=no

[Install]
WantedBy=default.target
```

On servers, enable persistent user services so the user systemd manager starts at boot and remains running after logout:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

After creating or changing units:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-web-sessiond.service
systemctl --user enable --now pi-web-ui-dev.service
```

Useful logs:

```bash
journalctl --user -u pi-web-sessiond.service -f
journalctl --user -u pi-web-ui-dev.service -f
```

If code affecting the session daemon changes, restart it manually:

```bash
systemctl --user restart pi-web-sessiond.service
```

## Current limitations

- Assumes trusted users and trusted server paths.
- Not a sandbox, permission model, or secure multi-tenant platform.
- Some Pi TUI slash-command behavior is not yet represented exactly in the web UI.
- Workspaces are discovered from existing git worktrees; UI-driven worktree management is a natural next step.

## Vision

Pi Web is the beginning of an agent-first development environment:

- agents run persistently on servers;
- humans connect through the browser;
- work is organized by projects, workspaces, and sessions;
- the UI grows around the needs of agentic development rather than the habits of local IDEs.

The goal is simple: make it practical to run more development remotely, in parallel, with agents as first-class participants and humans focused on direction, judgment, and review.

## License

MIT © 2026 Federico Jaramillo Martinez. See [LICENSE](LICENSE).

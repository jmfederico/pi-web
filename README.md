# Pi Web

![Pi Web](docs/assets/pi-web-banner.png)

A web control plane for remote, agentic software development with [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

Pi Web lets you run coding agents on a server, organize their work by project and workspace, and steer sessions from a browser. Your laptop becomes a window into persistent development environments instead of the place where all development has to happen.

## Why use Pi Web?

Modern AI development does not need to be constrained by a local IDE, a single terminal, or a laptop that must stay open. Agents can work in long-lived server environments, across multiple repositories and worktrees, while humans supervise, steer, review, and organize the work through a web UI.

Pi Web is for developers who want:

- persistent remote agent sessions;
- browser access to server-side development environments;
- project and workspace organization for many concurrent tasks;
- git-worktree-based workflows for parallel feature development;
- a human-in-the-loop interface designed around agents first;
- a foundation for adding terminals, file trees, git views, planning docs, kanban boards, review queues, deployment controls, and other workflow surfaces.

It is not trying to recreate the old desktop IDE in a browser. It is a control surface for agent-driven development.

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

## Install

Recommended install uses npm plus systemd user services:

```bash
npm install -g pi-web
pi-web install
```

This writes and starts:

- `~/.config/systemd/user/pi-web-sessiond.service`
- `~/.config/systemd/user/pi-web.service`

The generated services run through `bash -lc` so they see a shell environment similar to running `pi` from your terminal.

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
curl -fsSL https://raw.githubusercontent.com/earendil-works/pi-web/main/install.sh | sh
```

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

The web server defaults to `127.0.0.1:8504`. Set `PI_WEB_HOST=0.0.0.0` only when you intentionally want to bind directly on all interfaces.

The session daemon defaults to a private Unix socket at:

```text
~/.pi-web/sessiond.sock
```

Environment variables:

- `PI_WEB_PORT` / `PORT` — web server port. Defaults to `8504`.
- `PI_WEB_HOST` — web server bind host. Defaults to `127.0.0.1`.
- `PI_WEB_SESSIOND_SOCKET` — Unix socket path used by both the daemon and web process when `PI_WEB_SESSIOND_URL` is not set. Defaults to `~/.pi-web/sessiond.sock`.
- `PI_WEB_SESSIOND_PORT` — optional TCP port for the daemon. If unset, the daemon listens on the Unix socket instead.
- `PI_WEB_SESSIOND_HOST` — daemon TCP bind host when `PI_WEB_SESSIOND_PORT` is set. Defaults to `127.0.0.1`.
- `PI_WEB_SESSIOND_URL` — daemon URL used by the web process when connecting over TCP, for example `http://127.0.0.1:3001`. If you set `PI_WEB_SESSIOND_PORT`, set this for the web process too.

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

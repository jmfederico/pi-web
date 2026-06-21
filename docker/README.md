# PI WEB Docker

PI WEB has two Docker modes:

- **Runtime/server mode** builds a local image from npm packages and runs split `sessiond` + `web` services. This is for users and servers.
- **Development mode** builds from this checkout and runs the same split shape while letting the web/API/client services autoreload. This is for hacking on PI WEB.

No prebuilt image or registry is required in either mode.

## Trust model: read this first

The Docker setup is for trusted single-user or trusted-admin environments. It is not a sandbox and it is not suitable for untrusted multi-tenant use.

By design, the runtime containers get deliberate host access so PI WEB agents can work on real server paths:

- `/var/run/docker.sock` is mounted into the containers. The Docker socket is root-equivalent on the host.
- `/srv`, `/opt`, and `/home` are mounted read/write.
- `/` is mounted read-only at `/host` for inspection.
- `hostexec` can start a temporary privileged helper container and run explicit commands in the host namespaces. Commands run as the container user by default, and `hostexec --root` can still run explicit administrative commands as root.

Only install this on machines where the PI WEB user, the selected workspaces, and the browser/API clients are trusted. Review scripts before piping them to `sh` if you do not already trust this repository.

The web port is bound to `127.0.0.1` by default. Do **not** expose PI WEB directly to the public internet. For remote access, use one of:

- an SSH tunnel;
- a VPN/private network address such as Tailscale, NetBird, or WireGuard;
- an authenticated reverse proxy that you operate and trust.

## Runtime install/update

Prerequisites:

- Docker Engine with the Compose plugin (`docker compose`) or `docker-compose`;
- a user that can talk to the Docker daemon;
- `curl` or `wget` for the one-liner installer.

Install or update with the same command:

```bash
curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/docker/install.sh | sh
```

The one-liner is idempotent. Each run refreshes Docker assets from the requested Git ref, writes host-specific `.env` values, rebuilds the local image from npm with `--pull --no-cache`, and recreates the split services without deleting persistent data.

Defaults:

- install directory: `~/.local/share/pi-web-docker` (or `$XDG_DATA_HOME/pi-web-docker`);
- persistent data: `<install-dir>/data`, mounted at `/data`;
- browser URL: <http://127.0.0.1:8504>;
- npm packages: latest `@jmfederico/pi-web` and latest Pi Coding Agent package unless pinned.

Updating recreates the Docker `sessiond` container. Active Pi agent runtimes in this Docker install may stop, so update while sessions are idle. Persisted PI WEB state, Pi config, and session history under the data directory are kept.

Useful runtime commands:

```bash
cd ~/.local/share/pi-web-docker

docker compose ps
docker compose logs -f web
docker compose logs -f sessiond
docker compose restart web
docker compose restart sessiond
```

To stop the runtime without deleting data:

```bash
cd ~/.local/share/pi-web-docker
docker compose down
```

Do not run `docker compose down -v` unless you intentionally want to remove Compose-managed volumes. The default persistent PI WEB data is a bind mount, but avoiding `-v` keeps the update/stop flow conservative.

### Installer options

The installer accepts flags and equivalent environment variables:

```bash
curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/docker/install.sh \
  | sh -s -- \
      --install-dir ~/.local/share/pi-web-docker \
      --data-dir ~/.local/share/pi-web-docker/data \
      --bind-address 127.0.0.1 \
      --port 8504 \
      --pi-web-version latest \
      --pi-version latest
```

Common environment variables written to `.env`:

| Variable | Purpose |
| --- | --- |
| `PI_WEB_UID`, `PI_WEB_GID` | user/group used by the runtime containers |
| `DOCKER_GID` | extra group used for Docker socket access |
| `PI_WEB_DOCKER_DATA_DIR` | persistent data bind mount |
| `PI_WEB_BIND_ADDR`, `PI_WEB_PORT` | host bind address and port |
| `PI_WEB_VERSION` | npm version/range for `@jmfederico/pi-web` |
| `PI_VERSION` | npm version/range for `@earendil-works/pi-coding-agent` |
| `PI_WEB_OPENSUSE_IMAGE` | openSUSE base image used for the runtime build |
| `PI_WEB_NODEJS_MAJOR` | Node.js major package to install, defaulting to `22` |
| `PI_WEB_NODEJS_REPO` | Node.js zypper repository URL, `auto`, or `disabled` |
| `PI_WEB_EXTRA_ZYPPER_PACKAGES` | extra openSUSE packages installed during the image build |
| `PI_WEB_IMAGE` | local image tag to build and run |
| `HOSTEXEC_IMAGE` | helper image used by `hostexec` |

Host-derived IDs are refreshed on rerun unless you explicitly override them. User-facing values such as data directory, bind address, port, image names, upload limit, base image, Node.js settings, extra packages, and version pins are preserved from an existing `.env` unless you pass a flag or environment override.

### Base image and tooling

The Docker runtime and development images are openSUSE Tumbleweed based by default. They install Node.js 22, npm, `npx`, and Corepack through zypper, using the openSUSE Node.js build service repository when needed for the selected architecture. The image also includes common agent/development tools such as Git/Git LFS, GitHub CLI, OpenSSH, Python with pip/virtualenv and headers, native build tooling, `jq`, `ripgrep`, `fd`, `fzf`, `bat`, ShellCheck, archive tools, network utilities, and the Docker CLI.

Install extra distro packages without writing a hook by setting a whitespace-delimited package list:

```bash
PI_WEB_EXTRA_ZYPPER_PACKAGES="go rustup kubernetes-client" \
  curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/docker/install.sh | sh
```

You can also pass installer flags such as `--opensuse-image`, `--nodejs-major`, `--nodejs-repo`, and `--extra-zypper-packages`, or edit the generated `.env` and rerun the installer.

### Custom image hooks

The runtime image can be extended without changing PI WEB's Dockerfile. Put local Bash scripts ending in `.sh` under:

```text
~/.local/share/pi-web-docker/custom-image.d/
```

The installer preserves that directory, includes the `*.sh` files in the Docker build context, and runs each script as `root` during the image build in lexical order. Use this for optional tools such as `glab`, `kubectl`, cloud CLIs, or language toolchains that you do not want in the default image.

Example:

```bash
mkdir -p ~/.local/share/pi-web-docker/custom-image.d
cat >~/.local/share/pi-web-docker/custom-image.d/10-extra-tools.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
zypper --gpg-auto-import-keys --non-interactive refresh
zypper --non-interactive install --no-recommends glab kubernetes-client
zypper clean --all
EOF
chmod +x ~/.local/share/pi-web-docker/custom-image.d/10-extra-tools.sh
curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/docker/install.sh | sh
```

Keep credentials out of these scripts. Authenticate tools after the container starts so secrets live in the persistent `/data` mount, for example through `/data/home` and `/data/config`.

For Docker development from this checkout, use the equivalent local directory:

```text
docker/custom-image.d/
```

Files in that development hook directory are ignored by Git except for the placeholder that keeps the directory available to Docker builds.

### Version pinning

Pin npm package versions when you want repeatable rebuilds:

```bash
curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/docker/install.sh \
  | sh -s -- --pi-web-version 1.202606.4 --pi-version 0.79.1
```

You can also edit `.env` in the install directory:

```dotenv
PI_WEB_VERSION=1.202606.4
PI_VERSION=0.79.1
```

Then rerun the one-liner to rebuild/recreate with those pins. Use `latest` again when you want the runtime to track the newest npm releases.

To pin the Docker asset templates themselves, fetch the installer from a specific Git branch, tag, or commit and pass the same ref as the asset source:

```bash
ref=<git-ref>
curl -fsSL "https://raw.githubusercontent.com/jmfederico/pi-web/$ref/docker/install.sh" \
  | sh -s -- --asset-ref "$ref"
```

## Localhost binding and remote access

The runtime listens on `0.0.0.0:8504` inside the container but publishes it to `127.0.0.1:8504` on the host by default.

For SSH access from your laptop:

```bash
ssh -L 8504:127.0.0.1:8504 user@server
# open http://127.0.0.1:8504 locally
```

For a trusted VPN/private interface, bind to that private address:

```bash
curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/docker/install.sh \
  | sh -s -- --bind-address 100.x.y.z --port 8504
```

If you use a reverse proxy, keep the container bound to localhost or a private address and put authentication/TLS at the proxy. Avoid `--bind-address 0.0.0.0` unless another trusted layer restricts access.

## `hostexec` examples

`hostexec [--root] <command...>` is the only host command bridge provided by this Docker setup. It intentionally does not abstract package managers or detect distributions. By default, commands run as the same numeric user/group as the PI WEB container. Use `--root` only for administrative host commands.

Run it from a PI WEB session, a PI WEB terminal, or by execing into the runtime container:

```bash
hostexec uname -a
hostexec systemctl status docker
hostexec --root zypper refresh
hostexec --root sh -lc 'zypper refresh && zypper dup -y'
hostexec --root apt-get update
```

From the host shell, for a quick smoke test:

```bash
cd ~/.local/share/pi-web-docker
docker compose exec web hostexec uname -a
```

`hostexec` starts a temporary privileged helper container through the mounted Docker socket, enters the host namespaces with `nsenter`, and runs exactly the command you passed. Treat it like privileged host access even when the final command drops back to the container user.

## Development Docker setup

Use this mode when developing PI WEB from this checkout. It bind-mounts the source tree, keeps dependencies in a Docker volume, stores PI WEB/Pi data in the same host data directory as runtime mode by default, and preserves the split runtime model:

- `sessiond` runs `npm run start:sessiond` as the long-lived owner of Pi agent runtimes;
- `web` runs `npm run dev:web` and `npm run dev:client` so API, plugin, and Vite changes can autoreload without restarting `sessiond`.

From the repository root:

```bash
export PI_WEB_UID=$(id -u)
export PI_WEB_GID=$(id -g)
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
# Optional; this is also the default dev data path.
export PI_WEB_DOCKER_DATA_DIR=${PI_WEB_DOCKER_DATA_DIR:-$HOME/.local/share/pi-web-docker/data}
mkdir -p "$PI_WEB_DOCKER_DATA_DIR"

docker compose -f docker/compose.dev.yml up --build
```

If you already ran the runtime installer, you can reuse its `.env` so dev mode gets the same UID/GID, Docker group, ports, and data directory:

```bash
docker compose --env-file "$HOME/.local/share/pi-web-docker/.env" \
  -f docker/compose.dev.yml up --build
```

Open the Vite UI at <http://127.0.0.1:8505>. The dev API is published on <http://127.0.0.1:8504>.

Useful development commands:

```bash
docker compose -f docker/compose.dev.yml ps
docker compose -f docker/compose.dev.yml logs -f web
docker compose -f docker/compose.dev.yml restart web
docker compose -f docker/compose.dev.yml restart sessiond
docker compose -f docker/compose.dev.yml down
```

Restart `sessiond` manually after changes that affect `src/server/sessiond.ts`, daemon ownership, or session-daemon-only code paths. Restarting only `web` is enough for ordinary API/client/plugin development reloads.

The dev setup intentionally has the same Docker socket and broad host mounts as the runtime setup. The same trust warnings apply.

On startup, a short `data-init` service creates the shared `/data` subdirectories and gives them to `PI_WEB_UID:PI_WEB_GID`. This handles the common Flatcar/Docker case where a missing bind-mount directory is created as root by the Docker daemon.

### Sharing runtime and development state

Runtime and dev mode both use `/data` inside the containers. By default they now point at the same host directory:

```text
$HOME/.local/share/pi-web-docker/data
```

Pi session files are therefore shared at:

```text
$HOME/.local/share/pi-web-docker/data/pi-agent/sessions/
```

Set `PI_WEB_DOCKER_DATA_DIR=/some/path` for both modes if you want that shared data somewhere else.

Use this shared directory to switch between runtime and dev mode, not to run both at the same time. Stop one Compose stack before starting the other so two session daemons do not share the same socket/state directory concurrently.

For sessions to appear under the same workspace in both modes, use the same project path in PI WEB. On Flatcar, prefer host-mounted paths such as `/home/core/<repo>`, `/srv/<project>`, or `/opt/<project>`. The dev container also exposes this checkout as `/workspace` so the PI WEB dev server can run from it, but sessions started against `/workspace` are organized under that different working-directory path and will not line up with runtime sessions for `/home/core/<repo>`.

When `package-lock.json` changes, rebuild the dev image and recreate the `node_modules` volume so the bind-mounted checkout sees the new dependency tree:

```bash
docker compose -f docker/compose.dev.yml down
docker volume rm pi-web-dev_node_modules
docker compose -f docker/compose.dev.yml up --build
```

## Local checkout validation

For installer validation from a checkout without starting containers:

```bash
PI_WEB_DOCKER_SKIP_COMPOSE=1 \
PI_WEB_DOCKER_ASSET_DIR="$PWD/docker" \
PI_WEB_DOCKER_HOME="$(mktemp -d)" \
sh docker/install.sh
```

For Compose validation:

```bash
docker compose -f docker/compose.yml config
docker compose -f docker/compose.dev.yml config
docker build --check -f docker/Dockerfile docker
docker build --check -f docker/Dockerfile.dev .
```

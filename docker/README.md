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
- `hostexec` can start a temporary privileged helper container and run explicit commands in the host namespaces.

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
| `PI_WEB_IMAGE` | local image tag to build and run |
| `HOSTEXEC_IMAGE` | helper image used by `hostexec` |

Host-derived IDs are refreshed on rerun unless you explicitly override them. User-facing values such as data directory, bind address, port, image names, upload limit, and version pins are preserved from an existing `.env` unless you pass a flag or environment override.

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

`hostexec <command...>` is the only host command bridge provided by this Docker setup. It intentionally does not abstract package managers or detect distributions.

Run it from a PI WEB session, a PI WEB terminal, or by execing into the runtime container:

```bash
hostexec uname -a
hostexec systemctl status docker
hostexec zypper refresh
hostexec sh -lc 'zypper refresh && zypper dup -y'
hostexec apt-get update
```

From the host shell, for a quick smoke test:

```bash
cd ~/.local/share/pi-web-docker
docker compose exec web hostexec uname -a
```

`hostexec` starts a temporary privileged helper container through the mounted Docker socket, enters the host namespaces with `nsenter`, and runs exactly the command you passed. Treat it like running a privileged host command.

## Development Docker setup

Use this mode when developing PI WEB from this checkout. It bind-mounts the source tree, keeps dependencies and PI WEB data in Docker volumes, and preserves the split runtime model:

- `sessiond` runs `npm run start:sessiond` as the long-lived owner of Pi agent runtimes;
- `web` runs `npm run dev:web` and `npm run dev:client` so API, plugin, and Vite changes can autoreload without restarting `sessiond`.

From the repository root:

```bash
export PI_WEB_UID=$(id -u)
export PI_WEB_GID=$(id -g)
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)

docker compose -f docker/compose.dev.yml up --build
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

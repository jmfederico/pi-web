# PI WEB Safe Tunnel

PI WEB includes a local Safe Tunnel UI and server-side bridge for exposing a local PI WEB through the PI WEB Safe Tunnels service.

The connector stays optional. Users who never open or enable Safe Tunnel do not need to install or run `pi-web-tunnel`, and PI WEB does not store connector credentials in PI WEB config.

## Local bridge and connector ownership

- The browser UI is the **Expose Safely** action plus **Settings → Safe Tunnel**.
- Settings → Safe Tunnel has a read-only **Current tunnel** card separated from the login form. It shows connector-owned slug/public URL metadata, machine id, connector config path, local PI WEB URL, runtime state, and copy/open actions without exposing connector credentials. The form below it is explicitly a new/re-register action: when current tunnel metadata exists, the form calls out that it will not edit the current card until approval succeeds, does not prefill the slug from the current registration, and preserves user-edited fields across status refreshes.
- The PI WEB web/API process serves local routes under `/api/safe-tunnel/*`.
- The bridge shells out to the connector for `status`, `login`, `start`, and `stop`.
- Connector secrets live in the connector config, normally `~/.config/pi-web-tunnel/config.json`; PI WEB reads `pi-web-tunnel status --json` for redacted config/runtime state, optional non-secret slug/public URL metadata, and capped/sanitized connector output.

## Connector config and local target

`pi-web-tunnel login` and `pi-web-tunnel register-machine` persist the local PI WEB target as `localPiWebUrl` in the connector config. `login` also persists the non-secret machine slug and public URL returned by hosted registration so Settings → Safe Tunnel can display the current registration without exposing the machine token. The default local target is `http://127.0.0.1:8504`; use `--local-pi-web-url http://127.0.0.1:<port>` when PI WEB is running on another local port.

`pi-web-tunnel start` fetches the hosted tunnel configuration, then applies the connector-owned `localPiWebUrl` to the frp `localIP`/`localPort` before writing `frpc.toml`. This lets source-tree and packaged PI WEB instances expose non-default local ports without storing a per-machine local URL in the hosted service. `pi-web-tunnel status --json` is the bridge contract for current tunnel metadata: it reports redacted connector-owned config/machine metadata, `frpc` path configured/not configured, PID/frpc-config runtime metadata, and the capped current connector log tail when available, without returning `machineToken` or generated frp config contents. The PI WEB bridge consumes that structured status instead of parsing generated `frpc.toml` for normal operation. When PI WEB starts the connector, it creates a tracked start operation, truncates the private `connector.log` for the new launch, tees connector/frpc stdout and stderr into the operation plus that log, and returns capped ANSI-stripped log tails in status/operation responses. Because the connector start command remains foreground until `frpc` exits, an early `frpc` exit updates the tracked operation with final exit code/signal and captured output.

The connector's foreground start/stop behavior and future user-service install design are documented in [safe-tunnel-connector-service.md](safe-tunnel-connector-service.md).

## Connector command defaults

Packaged/production PI WEB checks for `pi-web-tunnel` on `PATH` first. If it is unavailable, the Safe Tunnel bridge reports the connector as installable and waits until the user starts a Safe Tunnel operation before installing anything. Users who never open/use Safe Tunnel do not install the connector package.

Override the connector executable with:

```bash
PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND=/absolute/path/to/pi-web-tunnel
```

When this command override is set, PI WEB treats it as authoritative and does not auto-install a managed connector if the command is unavailable.

Source-tree development uses the first-party workspace connector instead. When `PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND` is unset and `scripts/pi-web-tunnel-dev.sh` exists, the bridge uses that script before falling back to `pi-web-tunnel`. `pi-web install --dev` also writes the same script path into the development service environment.

The wrapper runs:

```bash
npm --prefix /srv/dev/pi-web run --silent tunnel:connector -- "$@"
```

so bridge calls execute `/srv/dev/pi-web/packages/tunnel-connector/src/cli.ts` through the local npm workspace rather than a wrapper in `/srv/dev/pi-web-tunnels`.

## Production on-demand install

For packaged PI WEB installs, the bridge has a managed npm install path for `@jmfederico/pi-web-tunnel` with bin `pi-web-tunnel`. `GET /api/safe-tunnel/status` only checks and reports availability; it does not run npm. `POST /api/safe-tunnel/login`, `start`, or `stop` call the installer only when the connector command is not already available and auto-install is enabled.

Default managed install locations:

- Linux/macOS: `$XDG_DATA_HOME/pi-web/safe-tunnel-connector`, or `~/.local/share/pi-web/safe-tunnel-connector`.
- Windows: `%LOCALAPPDATA%\\pi-web\\safe-tunnel-connector`, or `%USERPROFILE%\\AppData\\Local\\pi-web\\safe-tunnel-connector`.

Runtime-only environment overrides:

| Env var | Purpose |
| --- | --- |
| `PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND` | Use this connector executable and disable managed auto-install fallback. |
| `PI_WEB_SAFE_TUNNEL_CONNECTOR_AUTO_INSTALL=false` | Disable managed on-demand install; status remains unavailable if no connector command works. |
| `PI_WEB_SAFE_TUNNEL_CONNECTOR_INSTALL_DIR=/path` | Install the managed connector package into a custom npm prefix. |
| `PI_WEB_SAFE_TUNNEL_CONNECTOR_PACKAGE=@jmfederico/pi-web-tunnel@version` | Install a specific connector package spec instead of `@jmfederico/pi-web-tunnel`. |
| `PI_WEB_SAFE_TUNNEL_CONNECTOR_BIN=pi-web-tunnel` | Resolve a different bin name from the managed install prefix. |
| `PI_WEB_SAFE_TUNNEL_CONNECTOR_NPM_COMMAND=/path/to/npm` | Use a specific npm executable for managed install. |

Connector credentials still live only in the connector's private config file; the managed install directory contains package code and npm metadata, not machine tokens.

## Useful development commands

```bash
# From /srv/dev/pi-web:
npm run tunnel:connector -- --help
scripts/pi-web-tunnel-dev.sh status --json

# Run PI WEB dev normally; the bridge will prefer scripts/pi-web-tunnel-dev.sh.
npm run dev:web
```

Run the hosted Safe Tunnels stack from `/srv/dev/pi-web-tunnels` when you need a local Control API, edge, and relay. The connector command used by PI WEB should still point at the PI WEB repo's wrapper (`/srv/dev/pi-web/scripts/pi-web-tunnel-dev.sh`) or an installed `pi-web-tunnel` binary.

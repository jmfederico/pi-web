# Safe Tunnel connector service-install design

Status: design for the PI WEB-owned `pi-web-tunnel` connector package. The connector currently implements foreground `start`/`stop`; the `pi-web-tunnel service ...` subcommands below are the intended user-service wrapper shape, not implemented CLI commands yet.

This document defines how `pi-web-tunnel` should install and manage a user-scoped background connector on Linux and macOS. It does not require root privileges for the MVP.

## Goals

- Run the connector under the logged-in user account that owns the local PI WEB instance.
- Keep PI WEB itself bound to `127.0.0.1`; only the connector opens outbound connections.
- Let the OS service manager handle login startup, restart-on-failure, and stop signaling.
- Keep machine tokens, relay credentials, auth cookies, and generated frp config out of service definitions; they stay in the connector config/credential files with private permissions.
- Use explicit executable/config paths so service startup does not depend on an interactive shell, `PATH`, or shell profile files.

## Non-goals

- No system-wide/root service install in MVP.
- No Windows service design in this milestone.
- No boot-before-login guarantee by default. Linux `loginctl enable-linger` can be documented later as an opt-in deployment choice.

## Current foreground connector behavior

Today `pi-web-tunnel start` stays attached, fetches tunnel configuration from the Control API, writes `frpc.toml` and `connector.pid` into the connector config directory with private file modes, launches/supervises `frpc`, and handles `SIGTERM`/`SIGINT` by stopping `frpc` before exiting. `pi-web-tunnel stop` reads the PID file and signals that foreground connector process.

`login`/`register-machine` persist `localPiWebUrl` in the connector config. On `start`, the connector applies that local target to the Control API-issued frp TOML (`localIP`/`localPort`) before writing it, so a local PI WEB running on a non-default port can be exposed without storing per-machine local URLs in the hosted service.

## Future CLI shape

Service management should be a connector CLI subcommand group:

```text
pi-web-tunnel service install [--config <path>] [--now]
pi-web-tunnel service uninstall
pi-web-tunnel service start
pi-web-tunnel service stop
pi-web-tunnel service status
```

The installer should resolve the connector executable to an absolute path and write that path into the service definition. In packaged PI WEB installs this may be an installed `pi-web-tunnel` binary or PI WEB's managed connector install under the Safe Tunnel connector npm prefix. Source-tree development can point at `scripts/pi-web-tunnel-dev.sh`, but production service files should prefer a stable installed executable.

The installer should also write an explicit config path into the service definition, using the same discovery rules as `pi-web-tunnel config-path` unless `--config <path>` is supplied.

The service manager should invoke the foreground connector command:

```text
<absolute-pi-web-tunnel> --config <absolute-config-path> start
```

`pi-web-tunnel service start` and `service stop` should delegate to the platform service manager instead of implementing a separate daemonizer.

## Linux: systemd user service

Use a user unit at:

```text
${XDG_CONFIG_HOME:-~/.config}/systemd/user/pi-web-tunnel.service
```

Template:

```ini
[Unit]
Description=PI WEB Safe Tunnel connector
Documentation=https://github.com/jmfederico/pi-web

[Service]
Type=simple
ExecStart=<absolute-pi-web-tunnel> --config <absolute-config-path> start
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=30s
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

Install flow:

1. Create the user unit directory if needed.
2. Write the unit file without secrets.
3. Run `systemctl --user daemon-reload`.
4. Run `systemctl --user enable pi-web-tunnel.service`.
5. If `--now` is supplied, run `systemctl --user start pi-web-tunnel.service`.

Uninstall flow:

1. Run `systemctl --user disable --now pi-web-tunnel.service` if the unit exists.
2. Remove the unit file.
3. Run `systemctl --user daemon-reload`.

Status should use `systemctl --user status pi-web-tunnel.service` or machine-readable `is-active`/`is-enabled` calls and combine that with connector config/tunnel status.

## macOS: LaunchAgent

Use a LaunchAgent at:

```text
~/Library/LaunchAgents/dev.pi-web.tunnel.plist
```

Label:

```text
dev.pi-web.tunnel
```

Template shape:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.pi-web.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>&lt;absolute-pi-web-tunnel&gt;</string>
    <string>--config</string>
    <string>&lt;absolute-config-path&gt;</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>&lt;home&gt;/Library/Logs/pi-web-tunnel/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>&lt;home&gt;/Library/Logs/pi-web-tunnel/stderr.log</string>
</dict>
</plist>
```

Install flow:

1. Create `~/Library/LaunchAgents` and `~/Library/Logs/pi-web-tunnel` if needed.
2. Write the plist without secrets.
3. Run `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/dev.pi-web.tunnel.plist`.
4. Run `launchctl enable gui/<uid>/dev.pi-web.tunnel`.
5. If `--now` is supplied, run `launchctl kickstart -k gui/<uid>/dev.pi-web.tunnel`.

Uninstall flow:

1. Run `launchctl bootout gui/<uid>/dev.pi-web.tunnel` if the job is loaded.
2. Remove the plist.
3. Leave connector config and logs in place unless the user explicitly removes them.

Status should use `launchctl print gui/<uid>/dev.pi-web.tunnel` and combine that with connector config/tunnel status.

## Security and robustness requirements

- Do not embed machine tokens, relay tokens, auth cookies, or generated frp config contents in unit/plist files.
- Validate paths before rendering service files. Do not execute through a shell.
- Use XML escaping for LaunchAgent values.
- Keep service definitions user-scoped and reject root/system install unless a later ADR adds that mode.
- Prefer restart/backoff over hard network-online ordering because user-session network availability differs across distributions and macOS.
- Add stronger systemd sandboxing only after connector/frpc packaging and writable paths are finalized.

## Implementation plan

1. Add pure renderers for the systemd unit and LaunchAgent plist, with unit tests for path insertion and escaping.
2. Add a service-manager command planner that returns the platform commands to run; unit-test without invoking `systemctl` or `launchctl`.
3. Add the global `--config <path>` option before writing service definitions that depend on it.
4. Add `pi-web-tunnel service ...` commands around the existing foreground `start`/`stop` behavior.
5. Add platform smoke tests later on Linux and macOS hosts that have the relevant service manager available.

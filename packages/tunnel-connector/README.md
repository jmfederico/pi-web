# @jmfederico/pi-web-tunnel

Local `pi-web-tunnel` CLI package for PI WEB Safe Tunnels.

The connector owns local tunnel credentials and foreground `frpc` supervision. PI WEB invokes it as an optional command instead of importing connector internals, so users who do not enable Safe Tunnel do not need to run it.

## Common commands

```bash
pi-web-tunnel login --control-api-url https://control.tunnels.pi-web.dev \
  --machine-name "My dev box" \
  --machine-slug my-dev-box \
  --local-pi-web-url http://127.0.0.1:8504 \
  --frpc-path /absolute/path/to/frpc
pi-web-tunnel status
pi-web-tunnel status --json
pi-web-tunnel start
pi-web-tunnel stop
```

Source-tree development from the PI WEB checkout should use `scripts/pi-web-tunnel-dev.sh` or `npm run tunnel:connector -- <command>` so workspace imports resolve from TypeScript source.

## Status output

`pi-web-tunnel status --json` prints the connector-owned machine-readable status contract for PI WEB. It includes the discovered config path/state, non-secret local target and machine metadata (`controlApiBaseUrl`, `machineId`, optional `machineSlug`/`publicUrl`), whether an `frpc` executable path is configured, PID-file runtime state (`stopped`, `running`, `stale`, or `unknown`), the private `frpc.toml` path/existence, and a capped ANSI-stripped tail of the current `connector.log` when that file exists. PI WEB's tracked start operation truncates `connector.log` for each new launch before capturing connector/frpc output, and keeps the operation open until the foreground connector command exits so early `frpc` failures have final exit state and output. Status output never includes `machineToken`.

## Local target behavior

`login` and `register-machine` persist `localPiWebUrl` in the connector config. `login` also persists the non-secret machine slug and public URL returned by registration for local status/UI display; the machine token remains private to the connector config. `start` fetches the hosted frp TOML, applies the connector-owned local target to `localIP`/`localPort`, writes the resulting `frpc.toml` with private permissions, and then launches `frpc`. This keeps local machine URLs out of PI WEB config and avoids requiring hosted persistence when a local PI WEB uses a non-default port.

In the source checkout, connector service-install design notes live in `../../docs/safe-tunnel-connector-service.md`.

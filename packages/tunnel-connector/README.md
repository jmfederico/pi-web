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
pi-web-tunnel start
pi-web-tunnel stop
```

Source-tree development from the PI WEB checkout should use `scripts/pi-web-tunnel-dev.sh` or `npm run tunnel:connector -- <command>` so workspace imports resolve from TypeScript source.

## Local target behavior

`login` and `register-machine` persist `localPiWebUrl` in the connector config. `start` fetches the hosted frp TOML, applies the connector-owned local target to `localIP`/`localPort`, writes the resulting `frpc.toml` with private permissions, and then launches `frpc`. This keeps local machine URLs out of PI WEB config and avoids requiring hosted persistence when a local PI WEB uses a non-default port.

In the source checkout, connector service-install design notes live in `../../docs/safe-tunnel-connector-service.md`.

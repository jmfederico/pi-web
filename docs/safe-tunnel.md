# Experimental PI WEB Safe Tunnel

Safe Tunnel exposes the running PI WEB instance through **PI WEB Tunnels**. Enable it, approve access through the service, and PI WEB manages the tunnel and its public URL. The only advanced setting selects a different tunnel service API for development testing.

> **Protect the public ingress.** Safe Tunnel does not authenticate PI WEB users. The tunnel service must enforce appropriate authentication and access control for every HTTP and WebSocket request before you expose your instance.

## Make Safe Tunnel available

Set the global config key to the JSON boolean `true`:

```json
{
  "safeTunnel": true
}
```

Global config lives at `$PI_WEB_CONFIG`, `$XDG_CONFIG_HOME/pi-web/config.json`, or `~/.config/pi-web/config.json`. Alternatively, set `PI_WEB_SAFE_TUNNEL=1` in the web/API service environment. Restart **web/API**, not the session daemon.

Availability is gateway-local and separate from enabled intent. Making the feature available does not start a tunnel. Without opt-in, the Settings entry and API routes are absent, and PI WEB performs no Safe Tunnel state, timer, network, download, or child-process work.

A non-empty `PI_WEB_SAFE_TUNNEL` value overrides config: `1` and case-insensitive `true` enable availability; every other non-empty value disables it. An empty value falls back to config. Any non-empty `PI_WEB_OFFLINE` or `PI_OFFLINE` setting makes Safe Tunnel unavailable. The config key accepts only JSON booleans and is not supported in project-local or selected-machine config.

## Enable and disable

1. Open **Settings → Safe Tunnel**, or choose **Manage Safe Tunnel** from the action palette.
2. Confirm that the tunnel service protects the public ingress.
3. Choose **Enable Safe Tunnel**.
4. If approval is needed, open the displayed approval page and follow its instructions.
5. Wait for the panel to show the running status and public URL.

PI WEB infers the machine identity and local browser target, installs the pinned tunnel executable when needed, and reuses a valid saved registration for the selected service. Credentials stay in web/API and its private state; the browser receives approval details and bounded progress/status fields.

Choose **Disable Safe Tunnel** to cancel pending approval/startup, save disabled intent, stop heartbeats, and stop the exact child PI WEB launched. If stopping fails, the panel reports the failure and Disable remains available to retry.

### Account restrictions and recovery

- **Rejected or revoked machine credential:** PI WEB stops the tunnel and marks the registration rejected. Choose Enable again to request fresh approval.
- **Payment required or suspended account:** PI WEB preserves the registration and stops the tunnel. Resolve the restriction in the linked service dashboard, then choose Enable to retry.
- **Permanently deactivated account:** the panel reports that state explicitly; local re-approval is not presented as a remedy.

An account restriction stays visible even if stopping the child also fails. During initial registration, a restriction may occur before a credential exists; retrying after resolution may require fresh approval.

## Test against the development service

Disable a running tunnel first. Under the panel's advanced settings, set **Tunnel service API URL** to your development service API, then choose Enable. The production default is `https://api.tunnels.pi-web.dev`. The panel restores the saved service URL; clear the field to return to production on the next Enable.

A different service requires its own registration and approval. PI WEB must not send one service's saved machine credential to another service. This is a single selected-service flow, not a registry of development and production accounts.

API URLs must use HTTPS, with plain HTTP allowed only for literal loopback development addresses (`127.0.0.0/8` or `[::1]`). They must not contain credentials, a query, or a fragment. The development service must implement the same approval, account-access, and secure relay protocol as production. This setting is not a general-purpose tunnel-provider integration.

Machine name, slug, local target, and executable path are managed by PI WEB rather than editable tunnel settings.

## Local target and the browser entrypoint

PI WEB selects the target from its running deployment, never from the incoming Enable request:

- **Packaged/server mode:** use the active web/API TCP listener, including its configured host and port.
- **Development mode:** `PI_WEB_BROWSER_URL` declares the local browser entrypoint. `npm run dev:web` and the Docker development stack point it at the Vite listener (`http://127.0.0.1:8505`), so the tunnel exposes the hot-reloading UI rather than the API-only listener.

A socket-only web/API listener needs a declared browser entrypoint; there is no user-supplied tunnel target override.

Client serving follows the same explicit deployment choice. With `PI_WEB_BROWSER_URL` unset, web/API serves the built `dist/client` and fails startup if it is missing. With the variable set, web/API serves no client and answers non-API browser requests with a pointer to the development UI.

## Browser host trust

Safe Tunnel API reads require a trusted `Host`. Enable and Disable additionally require marked JSON requests and an independently trusted browser `Origin`. These provenance checks do not replace ingress authentication.

PI WEB trusts localhost, literal IP addresses, the configured listener hostname, exact global `allowedHosts` entries, and the **exact registered tunnel hostname**. Registration does not grant trust to sibling provider hostnames. For additional LAN or reverse-proxy DNS names, configure exact names through `allowedHosts` or `PI_WEB_ALLOWED_HOSTS` and restart web/API. Vite's `allowedHosts: true` and leading-dot patterns do not grant broad Safe Tunnel API trust.

Registered-host browser origins must use HTTPS, except that HTTP is accepted for loopback development names and addresses. Configured-host and registered-host provenance rules remain separate.

The split development stack loads the exact saved public hostname into Vite's HTTP and proxied application-WebSocket checks at startup. After first registration, or if the saved hostname changes or is removed, manually restart Vite (`npm run dev:client`) to update those checks; refreshing the browser alone is not enough. HMR remains disabled, and registration changes do not automatically restart Vite. No session-daemon restart is needed. **Settings → General → Additional allowed hosts** displays the saved hostname as managed read-only state; PI WEB does not write it into the editable `allowedHosts` list.

## Storage and restart behavior

Private state lives at `$PI_WEB_DATA_DIR/safe-tunnel/config.json` (`PI_WEB_DATA_DIR` defaults to `~/.pi-web`). It stores enabled intent, the selected service, inferred target, and registration/credentials. On POSIX, the directory is restricted to `0700` and the atomically replaced state file to `0600`; treat it as a secret on every platform.

While running, PI WEB writes private `frpc.toml` and `frps-roots.pem` files beside that state. Graceful web/API shutdown stops the owned child and removes those generated files without changing enabled intent. It does not maintain raw child-output logs.

If availability and saved intent remain enabled, the next web/API startup makes one restore attempt. Heartbeats begin after startup and use a bounded service-directed interval. An unexpected child exit stays stopped; there is no automatic child-restart loop. After correcting an ordinary runtime failure, Disable and Enable again, or restart web/API. Account restriction recovery follows the separate rules above.

Turning availability off and restarting makes the feature dormant while preserving intent. Re-enabling availability later permits another restore attempt. No session-daemon restart is required.

## Supported platforms and tunnel safety

Managed installation supports **Linux arm64 and Linux x64**. Other platforms report `unsupported_platform`; there is no executable-path bypass.

PI WEB downloads the pinned official `fatedier/frp` release **0.69.1**, verifies archive and executable sizes and SHA-256 digests, and installs it beneath `$PI_WEB_DATA_DIR/safe-tunnel/frpc/versions/0.69.1/<platform>-<architecture>/frpc`.

The service configuration must select one exact HTTP proxy and hostname, a DNS relay over secure WebSocket (`wss`) on port `443`, TLS, the empty frp user, and the saved machine credential metadata. PI WEB supplies its own relay trust roots and local target, rejects extra routes and downgraded transport, and launches the child directly without a shell or inherited web-process environment.

Control API and artifact requests are bounded, timed out, and cancellable. Browser responses exclude machine tokens, generated TOML, artifact URLs, provider response bodies, and raw child output. PI WEB relies on the service to issue independent, unguessable credentials and keep secrets out of public metadata, and on DNS/TLS, the pinned artifact source, and operating-system security.

## Local browser API

These gateway-local routes exist only while Safe Tunnel is available:

| Method and path | Purpose |
| --- | --- |
| `GET /api/safe-tunnel/status` | Read safe configuration, runtime/account status, and active operation. |
| `POST /api/safe-tunnel/enable` | Start approval and startup; body `{}` uses production, or `{ "controlApiUrl": "https://dev-api.example.com" }` selects the development service. |
| `POST /api/safe-tunnel/disable` | Cancel enablement, save disabled intent, and stop the tunnel. |
| `GET /api/safe-tunnel/operations/:operationId` | Poll approval/startup progress and outcome. |

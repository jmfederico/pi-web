# Experimental PI WEB Safe Tunnel

Safe Tunnel is an experimental, gateway-local way to make the running PI WEB reachable through a selected tunnel ingress. It is completely unavailable by default. An operator must first opt the web/API process into availability and then separately choose **Enable Safe Tunnel**. The MVP registers one machine, builds one constrained HTTP tunnel, and owns one `frpc` child.

> **Protect the public ingress.** A tunnel can make PI WEB reachable outside its local network. Safe Tunnel does not authenticate PI WEB users. Use it only when the selected hosted or self-hosted ingress enforces appropriate authentication and access control for every HTTP and WebSocket request.

## Make Safe Tunnel available

Set the global config key to the JSON boolean `true`:

```json
{
  "safeTunnel": true
}
```

Global config lives at `$PI_WEB_CONFIG`, `$XDG_CONFIG_HOME/pi-web/config.json`, or `~/.config/pi-web/config.json`. `safeTunnel` is gateway-only: it is not accepted in project-local or selected-machine config.

Alternatively, set the web/API service environment:

```sh
PI_WEB_SAFE_TUNNEL=1
```

A non-empty `PI_WEB_SAFE_TUNNEL` value takes precedence over the config file in both directions. `1` and case-insensitive `true` enable availability; `0`, `false`, and every other non-empty value disable it. An empty value is treated as unset. The config-file value must be a JSON boolean; strings, numbers, and `null` are rejected rather than coerced.

Restart the **web/API process** after changing the config key or environment. Availability is a startup snapshot owned by web/API, not `sessiond`, so no session-daemon restart is required.

Any non-empty `PI_WEB_OFFLINE` or `PI_OFFLINE` setting overrides both opt-in mechanisms and keeps Safe Tunnel unavailable. Without active opt-in, PI WEB does not construct the production Safe Tunnel graph, read or write its state, register its routes or lifecycle, start timers, make network or artifact requests, or launch a child. Direct Safe Tunnel API probes receive the same generic `404` as any unknown API route, and the Settings entry is absent.

## Trust browser API hosts

Safe Tunnel serves status and operation reads only when the request `Host` is trusted. Enable and Disable additionally require a valid browser `Origin`; the request `Host` and `Origin` must each establish trust independently. These checks contain a gateway-local browser API; they do not replace ingress user authentication.

PI WEB trusts `localhost`, literal IP addresses (including direct loopback and LAN access), the exact configured web listener hostname, exact names in the global `allowedHosts` array, and the public ingress saved by a successful Safe Tunnel registration.

For a LAN DNS name or reverse proxy, add each browser-facing DNS name—and any different DNS name to which the proxy rewrites `Host`—as an exact `allowedHosts` entry without a scheme or port. `PI_WEB_ALLOWED_HOSTS` supplies the same exact names as a comma-separated list. Preserve the browser `Origin` and `Host` headers when practical. The Vite-only `allowedHosts: true` mode and leading-dot subdomain patterns do not trust arbitrary DNS names for Safe Tunnel requests. Restart web/API after changing this startup-snapshot list.

A saved registration automatically trusts its public hostname for request `Host` checks. For mutations, `Origin` must equal the normalized registered origin, including its scheme and effective port. Non-loopback registered public origins must use HTTPS; plaintext is accepted only for literal-loopback development origins.

## Availability and desired state are separate

| Control | Meaning | Default |
| --- | --- | --- |
| Global availability (`safeTunnel` / `PI_WEB_SAFE_TUNNEL`) | Whether this web/API process may expose or run Safe Tunnel | Unavailable |
| Durable desired state (**Enable Safe Tunnel** / **Disable Safe Tunnel**) | Whether an available Safe Tunnel should be running | Disabled |

Making the feature available does not start a tunnel. Turning availability off and restarting leaves durable desired state untouched while making the feature dormant.

## Enable, approve, inspect, and disable

After opting in and restarting:

1. Open **Settings → Safe Tunnel**, or run **Manage Safe Tunnel** from the action palette.
2. Confirm that the selected ingress provides the authentication and access control your deployment requires.
3. Choose **Enable Safe Tunnel**. The normal flow sends no advanced overrides. PI WEB infers the local target from its active TCP listener, derives a machine name and collision-resistant slug, and uses `https://api.tunnels.pi-web.dev` as the Control API.
4. If registration is needed, open the displayed provider approval page and follow its instructions. The panel polls one operation through preparation, approval, registration, and startup. Private machine credentials stay in web/API and its local state; the browser receives only approval fields and PI WEB-authored progress.
5. When startup succeeds, the panel shows the public URL and running status.

PI WEB reuses a valid saved registration. If a heartbeat reports that the Control API rejected or revoked its credential, PI WEB marks that registration rejected, stops its owned child, and shows a fixed approval-required status. The next Enable starts a replacement approval flow. If rejection is first discovered while fetching tunnel configuration, Enable fails and the saved registration is marked rejected; choose Enable again to start replacement approval.

Choose **Disable Safe Tunnel** to cancel an in-progress enable operation, persist disabled intent, cancel the periodic heartbeat, and stop only the exact child PI WEB launched. Browser status and operation responses use a small fixed set of PI WEB-authored fields and error categories. They do not include machine tokens, generated TOML, provider response bodies, artifact URLs, or raw child output.

## Durable state and restart behavior

PI WEB stores private Safe Tunnel state at:

```text
$PI_WEB_DATA_DIR/safe-tunnel/config.json
```

`PI_WEB_DATA_DIR` defaults to `~/.pi-web`. The state contains desired intent, the local target, an optional advanced `frpc` path, private machine credentials and their active/rejected status, the Control API location, and non-secret machine/public URL metadata. It does not contain process IDs, raw diagnostics, heartbeat history, or generated tunnel configuration. On POSIX systems, PI WEB restricts the directory to `0700` and atomically replaced state file to `0600`; treat the file as a secret on every platform.

While the child is running, PI WEB generates `frpc.toml` and `frps-roots.pem` in the same private directory. It discards child output rather than maintaining a tunnel log. A graceful web/API shutdown stops the exact owned child and removes those generated files without changing enabled intent.

If availability remains on, the next web/API start reads enabled intent and makes one tunnel start attempt. Periodic heartbeats continue at a bounded provider-directed interval and do not add history to durable state. An unexpected child exit remains stopped; a failed start is reported with the fixed `runtime_failed` category. PI WEB does not run an automatic child-restart loop. After correcting the cause, use **Disable Safe Tunnel** and then **Enable Safe Tunnel**, or restart web/API for another intent-restore attempt.

To make the feature dormant, turn availability off and gracefully restart web/API. The old process stops its child; the new process performs no Safe Tunnel state, timer, network, artifact, or child work. Re-enabling availability later preserves the prior intent and makes one restore attempt.

## MVP responsibility and trust boundary

PI WEB owns these boundaries:

- **Ingress authentication remains an operator requirement.** Tunnel transport is not evidence that the public endpoint authenticates users.
- **Browser routes are gateway-local and host-bound.** Reads require a trusted `Host`; mutations also require the explicit JSON marker and an independently trusted `Origin`.
- **Control API credentials use protected transport.** Production and self-hosted Control API URLs must use HTTPS. Plain HTTP is accepted only for literal loopback development endpoints in `127.0.0.0/8` or `[::1]`; names such as `localhost` are not exceptions.
- **The tunnel is structurally constrained.** PI WEB accepts one expected HTTP proxy, requires the saved public origin and hostname, regenerates the local target from PI WEB-owned desired state, requires relay TLS, and rejects extra proxies or provider-selected local targets.
- **External requests are bounded and cancellable.** Control API and managed-artifact requests have response-size limits and timeouts. Disable and shutdown cancel work at their owned boundaries.
- **Known credentials stay private.** PI WEB omits the credential fields it holds from browser responses and stores durable credentials in its private data directory.

The MVP trusts the configured Control API and credential issuer to generate independent, unguessable credentials and to keep secrets out of public metadata. It also relies on DNS, HTTPS/TLS and configured CA trust, Node.js and operating-system primitives, and the official pinned `frpc` artifact source to honor their documented contracts. PI WEB validates response shape, direct credentials, and the tunnel structure it launches; it does not try to detect transformed or encoded credentials in otherwise public provider values, independently verify DNS/TLS, or protect its private directory from a hostile process running as the same service account. Contract failures may stop the flow with a fixed PI WEB-authored error.

## Managed `frpc` support

The managed flow pins one official `fatedier/frp` release, **0.69.1**, for exactly these Node platform/architecture pairs:

| Platform | Architecture | Managed support |
| --- | --- | --- |
| Linux | `arm64` | Pinned official archive and executable |
| Linux | `x64` (x86-64/amd64) | Pinned official archive and executable |

PI WEB downloads the selected archive over HTTPS only when Enable needs it, verifies the pinned archive and executable sizes and SHA-256 digests, extracts the expected executable, and installs it privately beneath:

```text
$PI_WEB_DATA_DIR/safe-tunnel/frpc/versions/0.69.1/<platform>-<architecture>/frpc
```

There is no managed fallback to another release. Every other platform/architecture fails as `unsupported_platform` before download. On those systems, an operator may provide a user-supplied **absolute** executable path under the advanced disclosure. That path bypasses managed download and integrity verification, but not PI WEB's single-proxy configuration or relay TLS requirements. The operator owns that binary's provenance, compatibility, permissions, and updates. PI WEB launches it directly without a shell or inherited web-process environment and owns only the returned child.

## Advanced development and self-hosting overrides

Leave every advanced field blank for the normal flow. Overrides are sent only on the next Enable request:

| Field | Behavior |
| --- | --- |
| Control API URL | Uses production by default. A self-hosted URL must satisfy the HTTPS/literal-loopback policy and contain no credentials, query, or fragment. |
| Machine name / slug | Replaces inferred identity. The slug must be one lowercase DNS label. |
| Local PI WEB URL | Replaces the listener-derived target. It must be an `http://` origin with an explicit port and no credentials, path, query, or fragment. Point it only at the intended PI WEB listener. |
| `frpc` path | Uses the absolute executable directly instead of managed acquisition. |

A saved self-hosted Control API or `frpc` override remains in effect when its field is left blank. Explicit Control API/name/slug changes request replacement registration; local-target or `frpc`-path changes can reuse a valid registration.

## Local browser API

These gateway-local routes exist only while Safe Tunnel availability is active. Every route applies the trusted-Host contract; mutation routes also require the marked JSON same-origin request contract.

| Method and path | Purpose |
| --- | --- |
| `GET /api/safe-tunnel/status` | Read redacted desired state, registration/runtime status, and the active operation. |
| `POST /api/safe-tunnel/enable` | Start one approval-through-child-start operation. The normal body is `{}`; optional overrides are under `advanced`. |
| `POST /api/safe-tunnel/disable` | Cancel enablement, persist disabled intent, cancel heartbeat work, and stop the owned child. |
| `GET /api/safe-tunnel/operations/:operationId` | Poll PI WEB-authored approval/startup progress and terminal outcome. |

## Development and service ownership

Safe Tunnel runs only in the PI WEB web/API process:

```sh
npm run dev:web
```

It does not run in `sessiond` and needs no separate connector package, command, service, PID file, or connector-owned config path. Restart web/API after changing availability; do not restart the long-lived session daemon for this feature.

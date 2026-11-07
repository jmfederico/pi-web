---
"@jmfederico/pi-web": patch
---

Add one `hostAccess` policy for production and development: restrict access to local addresses and listed hostnames, or explicitly allow any hostname. Configure it in General settings or with JSON `PI_WEB_HOST_ACCESS`.

New and existing installations keep a persistent decision warning until a policy is supplied. Until then, production hostname restrictions remain off and development keeps its legacy `allowedHosts` behavior, without rewriting configuration or locking out existing DNS access. Once chosen, the shared policy replaces the legacy development-only control. Restart web/API and the development UI server if running after changes; a separate notice compares the full policy with the running web/API snapshot. No session-daemon restart is needed.

Reject malformed Host headers and cross-origin browser mutations and WebSocket upgrades regardless of hostname policy. Requests without Origin remain supported for CLI and Fleet clients. These checks are not authentication: reverse proxies must preserve public Host and Origin, authenticate traffic, and restrict direct backend access. Allowing any hostname, or leaving the decision unresolved, lacks application-level DNS-rebinding protection.

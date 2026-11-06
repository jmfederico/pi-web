---
"@jmfederico/pi-web": patch
---

Protect all web/API routes and WebSocket upgrades with host validation, and reject foreign or malformed browser origins on WebSocket upgrades and HTTP methods other than GET, HEAD, and OPTIONS. Requests without Origin remain supported for CLI and Fleet clients.

Before upgrading custom DNS deployments, add their hostnames to `allowedHosts`, which previously applied only to the Vite development UI. Reverse proxies must preserve the original Host (including nonstandard ports) and Origin, authenticate HTTP and WebSocket traffic, and restrict direct backend access and unrecognized public hosts. Restart web/API to apply host changes (also Vite for dev UI); no session-daemon restart is needed for this fix.

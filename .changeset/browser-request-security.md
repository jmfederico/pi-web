---
"@jmfederico/pi-web": patch
---

Add one `hostAccess` policy for production and development: restrict access to local addresses and listed hostnames, or explicitly allow any hostname. Configure it in General settings or with `PI_WEB_HOST_ACCESS`. A persistent notice prompts new and existing installations to choose; until then, production hostname restrictions remain off and development retains its legacy `allowedHosts` behavior. Allowing any hostname or leaving the decision unresolved lacks application-level DNS-rebinding protection.

Reject malformed Host headers and cross-origin browser mutations and WebSocket upgrades regardless of hostname policy. These checks do not replace authentication or restricted backend access.

**Upgrade guidance:** Reverse proxies must preserve public Host (including nonstandard ports) and browser Origin unchanged. Restart web/API and the development UI server, if running, after changing the policy; no session-daemon restart is needed for this change. See [browser request security](https://pi-web.dev/config#browser-request-security) for configuration, proxy requirements, and restart details.

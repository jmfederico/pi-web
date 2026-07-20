---
"@jmfederico/pi-web": patch
---

Isolate extension-defined model providers and login flows between live session runtimes while keeping profile credentials durable, shared, and synchronized after login, refresh, logout, or external edits. Restart `pi-web-sessiond.service` after upgrading to apply the new runtime ownership model.

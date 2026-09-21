---
"@jmfederico/pi-web": patch
---

Make browser API v4 `context.peer` requests and channels independent of workspace-provider ownership, so dual-entry plugins can use exact-package protocols without claiming a workspace. Owner-backed `context.backend` is removed.

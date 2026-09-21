---
"@jmfederico/pi-web": patch
---

Replace browser plugin API v2 with v4 and server plugin API v1 with v3. Migrate plugins to the dependency-aware activation, start, lifetime, and disposal lifecycle; exact typed capabilities; and exact-package `peer` requests/channels. Server plugins receive a persistent data-directory path for managing their own storage and can use live workspace authority and host-governed Pi sessions. Owner-backed requests and private Terminal composition fields are removed.

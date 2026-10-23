---
"@jmfederico/pi-web": patch
---

Report `httpIdleTimeoutMs` as unsupported on Bun instead of logging that it was applied. Preserve the requested value in diagnostics, leave native fetch and proxy behavior unchanged, and retain the existing Undici configuration on Node.js.

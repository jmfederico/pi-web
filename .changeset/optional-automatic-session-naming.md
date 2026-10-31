---
"@jmfederico/pi-web": patch
---

Move automatic session naming into a removable bundled Pi package, usable in both PI WEB and the TUI. Remove the package to use another naming extension. Migrate naming tuning into package-owned configuration and remove the old writable core key. Core configuration APIs reject the retired setting. Migration failures log errors, retain source data, and allow startup to continue. Update the web UI when extensions rename sessions.

---
"@jmfederico/pi-web": patch
---

Report the JavaScript runtime and engine version for both the Web/UI process and the session daemon in the Info panel, and add the browser and its version to the copyable diagnostics. Copied diagnostics now replace the home directory with `~` and the username elsewhere with `<user>`, so a pasted report does not disclose the system account. The panel keeps showing real paths.

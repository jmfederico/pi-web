---
"@jmfederico/pi-web": patch
---

The installed PWA now registers its own scoped service worker, shipped with the client build and resolved relative to the deployment prefix. Registration is best-effort: PI WEB keeps working normally when service workers are unavailable or blocked.

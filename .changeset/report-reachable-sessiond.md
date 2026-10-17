---
"@jmfederico/pi-web": patch
---

Report a running session daemon as soon as it is reachable instead of waiting out the status cache. A status read that found the daemon still starting was cached for a full minute, so the web/UI could keep showing the daemon as unavailable after it was already serving sessions.

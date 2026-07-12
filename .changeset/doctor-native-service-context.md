---
"@jmfederico/pi-web": patch
---

Validate install and doctor service requirements in the real systemd or launchd manager context before changing native services, with plan-specific PATH guidance and safe probe cleanup. Thanks to @blain3white for the original report, reproduction, and diagnosis.

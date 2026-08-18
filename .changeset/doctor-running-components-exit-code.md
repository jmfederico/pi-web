---
"@jmfederico/pi-web": patch
---

Make `pi-web doctor` exit nonzero when an installed Web/UI or session daemon component is unavailable or stale (restart needed), instead of only reporting it in the version section. Machines with no PI WEB services installed keep the previous informational behavior.

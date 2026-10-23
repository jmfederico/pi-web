---
"@jmfederico/pi-web": patch
---

Fix `/pi-web` commands and standalone services failing to find Pi libraries after installing through Pi. Reuse the existing Pi installation instead of installing a separate engine, and allow Pi upgrades and downgrades without an upper version restriction.

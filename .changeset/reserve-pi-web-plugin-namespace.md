---
"@jmfederico/pi-web": major
---

Reserve `pi-web` and `pi-web.*` plugin ids for PI WEB-owned bundled plugins and move the required Terminal plugin to `pi-web.terminal`. Third-party plugins using the reserved namespace must choose a new id; existing `core:*` Terminal navigation aliases remain supported.

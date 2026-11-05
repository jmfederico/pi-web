---
"@jmfederico/pi-web": patch
---

Keep an explicit enabled-models list persisted verbatim instead of collapsing it to "no scope" when it happens to cover the whole current catalog. The catalog churns on every background refresh, so the accidental full-coverage comparison could delete `enabledModels` from settings and silently enable every model a later refresh discovers.

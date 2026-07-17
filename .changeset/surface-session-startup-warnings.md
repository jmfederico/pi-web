---
"@jmfederico/pi-web": patch
---

Surface live session startup warnings in the web UI. A pinned banner at the top of the session view now shows resource and runtime diagnostics (skills, prompts, themes, and extension load errors) plus the Anthropic subscription-auth billing notice, recomputed from the current runtime so they stay accurate across browser reloads. The Anthropic billing notice can be dismissed, which durably suppresses it through the underlying agent's own warning setting.

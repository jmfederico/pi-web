---
"@jmfederico/pi-web": patch
---

Restore session-daemon startup and authentication on supported Pi `>=0.80.8 <0.81` releases by migrating model and credential handling to `ModelRuntime`. Login options now follow each provider's interactive API-key and OAuth capabilities, OAuth prompts retain their input, selection, and device-code semantics, committed OAuth login remains truthful when cancellation races the final refresh, and unsupported multi-step API-key setup fails safely instead of storing malformed credentials. PI WEB now requires Node.js `>=22.19.0`.

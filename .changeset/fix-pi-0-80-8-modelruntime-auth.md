---
"@jmfederico/pi-web": patch
---

Restore session-daemon startup and authentication on supported Pi `>=0.80.8 <0.81` releases by migrating model and credential handling to `ModelRuntime`. Provider discovery now reloads model configuration and reports only complete usable credentials. Login options follow each provider's executable API-key and OAuth capabilities: multi-step API-key setup is supported, legacy one-secret clients fail safely before storing malformed credentials, and OAuth prompts retain their input, selection, and device-code semantics. A committed login remains successful through late cancellation or notification failures. Failed realtime delivery now closes only the affected socket so its browser can reconnect while healthy peers keep receiving events. PI WEB now requires Node.js `>=22.19.0`.

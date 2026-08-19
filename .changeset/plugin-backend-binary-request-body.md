---
"@jmfederico/pi-web": patch
---

Add an opt-in raw binary request body mode for plugin workspace backends: browser entries can call `context.backend.requestBinary(operation, body)` with a bounded (1 MiB) `Uint8Array` that reaches the owning provider's new `WorkspaceProvider.requestBinary()` callback as opaque bytes — held in memory only, never logged or persisted — while results remain bounded JSON. This lets sensitive payloads such as secrets travel to paired server modules without appearing in JSON envelopes, and it pairs with the `execFile()` stdin payload for handoff to receiver commands. The mode works locally and through machine federation with the same revision pairing and explicit compatibility errors.

---
"@jmfederico/pi-web": patch
---

Allow agents to message sessions across all projects on the same machine with the global `crossProjectSessionMessages` setting or `PI_WEB_CROSS_PROJECT_SESSION_MESSAGES` environment override. It defaults to off, still requires session messaging to be enabled, and takes effect after restarting the session daemon.

Keep archived transcripts read-only when archival races with session-message delivery.

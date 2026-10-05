---
"@jmfederico/pi-web": patch
---

Fix Pi extension commands that rewind or fork conversations silently doing nothing, including follow-up callbacks on the forked session. Discover live forks and pending questions after reconnect without moving other viewers or replacing their drafts. Offer prepared input for explicit use. Recover the current conversation branch even when a browser misses live updates, and close obsolete extension questions on reload. Bind extension idle/reload actions and report unsupported new/switch-session actions instead of pretending they succeeded.

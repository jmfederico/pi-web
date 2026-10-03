---
"@jmfederico/pi-web": patch
---

Fix Pi extension commands that rewind or fork conversations silently doing nothing. Keep the chat transcript, selected session, and prompt draft synchronized with extension-driven changes. Bind extension idle/reload actions and report unsupported new/switch-session actions instead of pretending they succeeded.

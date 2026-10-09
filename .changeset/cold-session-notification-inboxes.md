---
"@jmfederico/pi-web": patch
---

Return empty notification inboxes for persisted sessions after a session-daemon restart without starting their agents. Distinguish missing conversations from internal read failures, and clear confirmed stale conversation selections while preserving unsent drafts.

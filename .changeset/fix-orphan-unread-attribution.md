---
"@jmfederico/pi-web": patch
---

Clean up orphan unread completions in the background after project/workspace removal or new completions, preventing permanently stuck indicators. Cleanup is coalesced with a one-minute delay and skips empty catalogs; ordinary reads do not trigger workspace scans. Re-adding a project first clears historical orphan unread state. Session and project files are preserved. Project add/remove operations now require the session daemon.

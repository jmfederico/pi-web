---
"@jmfederico/pi-web": patch
---

Silently retry temporary conversation and session-list network failures when returning to the app or reconnecting, including on iPad and iPhone. Clear recovered refresh errors without hiding failed user actions, and offer Retry only when refresh recovery fails. Refresh after page restoration or connectivity returns without showing a reconnecting banner.

---
"@jmfederico/pi-web": patch
---

Clicking a web push notification now opens the specific conversation session that triggered it, instead of just the app root. When PI WEB is already open, the notification navigates the existing window to the session. When closed, the new window restores the session automatically.

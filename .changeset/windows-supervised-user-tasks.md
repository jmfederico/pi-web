---
"@jmfederico/pi-web": patch
---

Add non-elevated Windows user tasks that supervise the web server and session daemon, recover clean exits and crashes, and support daemon-only restart for plugin changes. Tasks run in the signed-in user session; explicit stop disables automatic recovery until start.

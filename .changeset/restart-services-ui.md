---
"@jmfederico/pi-web": patch
---

Add a Restart action that confirms the selected services and runs the existing restart command in the gateway's maintenance terminal. Show a simple activity warning for daemon restarts, and link hostname-policy notices to web restart confirmation. Only offer per-service restarts when a targeted command is available; never substitute a full restart.

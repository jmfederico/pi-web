---
"@jmfederico/pi-web": patch
---

Persist the session throughput indicator across session daemon restarts. Average output tokens/second (overall and model rates) are now stored in `$PI_WEB_DATA_DIR/throughput.json` and reloaded on startup, so the indicator no longer resets to nothing after a sessiond restart or crash. The in-flight turn at the time of a crash is not persisted; it is folded into the totals on the next `agent_end`.

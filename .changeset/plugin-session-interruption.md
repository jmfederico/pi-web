---
"@jmfederico/pi-web": patch
---

Let plugins interrupt current session work or close its runtime to discard an unused, memory-only session. Closing preserves any saved conversation. Server plugins can require session-lifecycle v2; browser plugins can use the optional sessions.abort and sessions.close helpers. Existing lifecycle and catalog APIs remain supported. Neither operation persistently pauses sessions or stops descendants.

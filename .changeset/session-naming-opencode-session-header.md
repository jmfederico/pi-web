---
"@jmfederico/pi-web": patch
---

Fix session naming against OpenCode Go models. Automatic naming requests now carry the Pi session id, so OpenCode's required `x-opencode-session` routing header is sent instead of failing with `400 MissingSessionID`; naming falls back to the first request text as before when generation fails.

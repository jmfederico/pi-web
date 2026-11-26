---
"@jmfederico/pi-web": patch
---

Fix automatic session naming with OpenCode Go models. Naming requests now send the session id that OpenCode requires, instead of failing with `400 MissingSessionID` and falling back to the first request text.

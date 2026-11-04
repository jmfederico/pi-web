---
"@jmfederico/pi-web": patch
---

Keep the session activity indicator on "running tool" while a tool streams its output, instead of replacing it with the raw tool_execution_update runtime event name, and leave it unchanged when a session entry is appended mid-turn.

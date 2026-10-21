---
"@jmfederico/pi-web": patch
---

Expose detached session history reads with a default 100-message target page (expanded backward to a user turn boundary) and a streaming active-branch metadata index, plus safe parent session IDs and archive timestamps. The index scales with entry count but omits message bodies. Transcript lines over 16 MiB fail explicitly without modifying the source file.

---
"@jmfederico/pi-web": patch
---

Stream in-flight assistant replies immediately when opening or reconnecting to a session mid-turn. The chat now seeds the partial message (text, thinking, and in-progress tool calls) and continues streaming live updates on top of it, replacing the blocking "Catching up…" placeholder and the end-of-turn transcript reload. Sessions still open normally against remote machines or session daemons that predate this feature: the snapshot is fetched as a progressive enhancement and its absence no longer blocks the transcript.

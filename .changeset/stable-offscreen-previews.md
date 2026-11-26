---
"@jmfederico/pi-web": patch
---

Keep rendered previews, such as Mermaid diagrams, in place when they scroll out of view. Previously they reverted to source offscreen and re-rendered on return, changing their height and making the chat jump.

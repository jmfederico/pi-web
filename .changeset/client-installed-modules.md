---
"@jmfederico/pi-web": patch
---

Load the main web client's Markdown, stylesheet, and localization libraries from installed packages instead of shipping another copy in the client bundle. Production installs no longer need a separate copy of the bundled CodeMirror editor.

---
"@jmfederico/pi-web": patch
---

Restore project, workspace, and session URLs without waiting for plugin modules to load. Routes that name a workspace tool now also restore their selection immediately and wait for plugins only to resolve the tool, so opening a session link on a slow connection no longer blocks on every plugin download.

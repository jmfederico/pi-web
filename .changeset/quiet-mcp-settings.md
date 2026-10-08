---
"@jmfederico/pi-web": patch
---

Add MCP settings for the selected machine and workspace, with persistent enable/disable controls and explicit connection checks showing tools and errors. Restart the updated session daemon to load the new API; subsequent configuration changes apply to new sessions or after `/reload` in idle sessions.

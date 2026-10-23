---
"@jmfederico/pi-web": patch
---

Add MCP settings for the selected machine and workspace, with persistent enable/disable controls and explicit connection checks showing tools and errors. Use the shared settings layout alongside session authentication, keeping workspace configuration and login/logout tied to their own machine and session. Honor Pi’s minimal project overrides and OAuth client-registration rules. Restart the updated session daemon to load the new API; subsequent configuration changes apply to new sessions or after `/reload` in idle sessions.

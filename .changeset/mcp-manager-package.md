---
"@jmfederico/pi-web": patch
---

Add a removable MCP manager package. Its thin Pi extension loads configured servers in both the TUI and PI WEB; its web plugin provides Global, Project, and Session controls, setup guidance, and clear save feedback. Session choices survive resume and are copied to forks and agent-created sessions. Pi retains connection, authentication, and native `mcp.json` ownership.

Add capability-based APIs for private, inheritable session state and read-only project trust, so plugins can integrate with sessions without feature-specific core routes.

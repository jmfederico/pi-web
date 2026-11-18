---
"@jmfederico/pi-web": patch
---

Fix MCP sign-in when an iPad copies the loopback callback URL without its `http://` prefix. Restore the current callback's scheme before submitting the pasted URL, while preserving OAuth validation.

---
"@jmfederico/pi-web": patch
---

Let application tabs request their package backend without selecting a project or workspace, and let hosted companion agent tools request that same machine-local backend. Backends can route onward through PI WEB-managed remote transport; existing workspace peers remain unchanged. Update the web/API and safely restart affected session daemons to use the new capabilities.

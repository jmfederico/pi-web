---
"@jmfederico/pi-web": patch
---

Add machine-wide plugin backend handlers and host-managed requests to the same plugin on registered remote machines, using PI WEB's existing HTTP endpoint without project or workspace selection. Existing workspace peers remain supported. Update both hosts and safely restart their session daemons to use the new transport.

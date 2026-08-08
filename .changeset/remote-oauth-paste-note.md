---
"@jmfederico/pi-web": patch
---

Guide remote OAuth logins in the web UI: when the browser cannot reach the runtime's localhost redirect, the provider login dialog now explains that the redirect page will fail and asks you to paste the full redirect URL, so logging in from a federated machine or a remote gateway no longer relies on discovering the manual paste path.

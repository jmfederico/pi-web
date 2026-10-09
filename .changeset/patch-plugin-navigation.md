---
"@jmfederico/pi-web": patch
---

Add opt-in patch navigation for browser plugins, preserving unchanged sessions and unrelated panel state while keeping complete destinations as the default. Opening a Relay from a session label no longer reloads the current chat. Keep chat loading and live updates working when a navigation patch clears or changes the session URL, and reject malformed plugin navigation arguments without changing the current view.

---
"@jmfederico/pi-web": patch
---

Add a packet-backed `dispatch_relay` tool that generates handovers and initializes explicit Relay membership and predictable names before a new session starts. Relay preparation and handoff now use the dedicated tool, with saved `status.md` as the actual baton rather than a separate prompt. Expose an extension dispatch bridge with public metadata and inherited model/thinking settings.

Add Relay-owned session-list row indicators that open the exact saved packet on the session's machine and workspace, including custom packet locations inside the workspace. Membership comes from saved metadata, not titles or handover prose.

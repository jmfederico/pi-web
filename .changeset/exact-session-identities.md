---
"@jmfederico/pi-web": major
---

Require exact, full session IDs in browser URLs, plugin navigation, and PI WEB session API lookups. Session-ID prefixes no longer resolve active, starting, persisted, or archived conversations. Update abbreviated bookmarks and integrations to use the complete ID returned by session listing or creation; shortened IDs now report a missing session instead of selecting a prefix match. Short IDs displayed in labels remain display-only.

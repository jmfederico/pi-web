---
"@jmfederico/pi-web": patch
---

Move relay preparation prompt files (relay.md, relay-worktree.md) out of pi-packages/relays/prompts into the new relays-autoinstall package, where they are shipped as autoinstall-only content rather than bundled plugin resources. This avoids package collision when installing PI WEB on Bun.
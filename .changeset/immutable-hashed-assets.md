---
"@jmfederico/pi-web": patch
---

Serve content-hashed client assets under `assets/` with an immutable one-year cache policy so reloads skip revalidating them. The app shell and other static files keep revalidating, so new releases are still picked up on the next load.

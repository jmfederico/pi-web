---
"@jmfederico/pi-web": patch
---

Fix the session daemon crashing on startup with Pi (`@earendil-works/pi-coding-agent`) 0.80.8 and newer. Pi removed the `AuthStorage` API in 0.80.8, which caused Pi Web to fail at module load. Authentication, OAuth login, API-key save/logout, provider listing, and the Anthropic subscription warning now run on Pi's new `ModelRuntime` credential APIs. Pi Web now requires Pi `>=0.80.8`.

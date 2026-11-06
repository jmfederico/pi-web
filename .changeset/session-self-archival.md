---
"@jmfederico/pi-web": patch
---

Add `archive_self` so agents can end their run and archive their own session while preserving its transcript. Archival conditions stay in user instructions, including for scheduled tasks; the scheduler does not infer when to archive.

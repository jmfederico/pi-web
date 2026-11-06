---
"@jmfederico/pi-web": patch
---

Add `archive_self` so agents can end their run and request archival of their own session once idle, preserving its transcript. New conversation work cancels the request. Archival conditions stay in user instructions, including for scheduled tasks; the scheduler does not infer when to archive.

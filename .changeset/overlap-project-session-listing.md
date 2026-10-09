---
"@jmfederico/pi-web": patch
---

Reduce repeat project-switch latency by loading the remembered workspace's session list alongside workspace discovery. Confirm the fresh workspace path before using prefetched sessions, and retain cached workspace rows while discovery completes.

---
"@jmfederico/pi-web": patch
---

Load browser plugin modules in parallel instead of one at a time to reduce startup delays on high-latency links. A required Terminal plugin still loads alone first, and plugins still register in manifest order.

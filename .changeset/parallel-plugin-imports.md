---
"@jmfederico/pi-web": patch
---

Load browser plugin modules in parallel instead of one at a time, so startup costs a few round trips instead of one per plugin module on high-latency links. A required Terminal plugin still loads alone first, and plugins still register in manifest order.

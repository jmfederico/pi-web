---
"@jmfederico/pi-web": patch
---

Isolate extension-defined model providers between live session runtimes while keeping profile credentials durable and shared. Restart `pi-web-sessiond.service` after upgrading to apply the new runtime ownership model.

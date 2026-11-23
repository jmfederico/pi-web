---
"@jmfederico/pi-web": patch
---

Disable routine HTTP access logs by default in web and sessiond while keeping application diagnostics. Set `httpAccessLog` to enable structured completion records, and use `logLevel` to set the minimum severity. The gateway returns an `x-request-id` that also identifies requests to its local daemon.

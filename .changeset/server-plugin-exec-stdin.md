---
"@jmfederico/pi-web": patch
---

Let server plugins pipe a bounded stdin payload to spawned commands through the host-owned `execFile()` helper, so sensitive values can reach receiver commands without appearing in argv or environment blocks. The payload is capped (1 MiB by default), never logged, and the host zeroes its retained copy once the command settles.
